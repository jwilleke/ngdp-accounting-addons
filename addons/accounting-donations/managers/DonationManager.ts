/**
 * DonationManager — the donations add-on's one door (D-036): in-kind gifts
 * and pledges in this add-on's own database, and the form choices it adds.
 * Money always goes through the accounting add-on's managers; this one only
 * reads the ledger (receipts paying a pledge) through LedgerManager.
 *
 * Every write: ask the decision point for `donation-record`, write the audit
 * record and wait for it (on-failure: refuse), then change the rows.
 */
import { randomUUID } from 'node:crypto';
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';

export type DonationsHost = Pick<AddonHost, 'actorOf' | 'addonAuditEventName'>;

/** The caller: ngdpbase's ApiContext satisfies this, as it does LedgerManager's. */
export interface DonationsActor {
  enforceDeny(permission: string, decision: Decision): Promise<never>;
  actingUsername(): string;
  readonly ipAddress: string | undefined;
  readonly subject: ActorContext | null;
}

export interface DonationsDb {
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T;
}

/** The slice of the accounting add-on's LedgerManager this one calls. */
export interface LedgerLike {
  currencyCode(): string;
  listFunds(actor: DonationsActor): Promise<{ id: string; name: string; active: boolean }[]>;
  listDocuments(actor: DonationsActor, kind: 'receipt', filter?: { includeVoided?: boolean }): Promise<{
    id: string; number: string | null; date: string; status: 'posted' | 'voided';
    lines: { amount: number; status: 'posted' | 'voided'; details: Record<string, Record<string, unknown>> }[];
  }[]>;
  toFormOptions(options: Record<string, string>, viewer?: unknown): Promise<{ value: string; label: string }[]>;
}

/** A refusal the caller can fix. Named LedgerError so the forms show it on the field, as the ledger's are. */
export class DonationError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface InKindGift {
  id: string; donorPersonId: string | null; donorName: string; date: string; description: string;
  status: 'posted' | 'voided'; voidReason: string | null; createdBy: string; createdAt: string;
}

export type PledgeSchedule = 'once' | 'monthly' | 'quarterly' | 'yearly';
const SCHEDULES: readonly PledgeSchedule[] = ['once', 'monthly', 'quarterly', 'yearly'];

export interface Pledge {
  id: string; donorPersonId: string | null; donorName: string; amount: number; fundId: string;
  startDate: string; endDate: string | null; schedule: PledgeSchedule; memo: string;
  status: 'open' | 'cancelled'; cancelReason: string | null;
  /** Posted gift lines that name this pledge. */
  given: number;
  remaining: number;
  createdBy: string; createdAt: string;
}

export interface DonationOptions {
  host: DonationsHost;
  db: DonationsDb;
  ledger: LedgerLike;
  recordAudit: (record: Record<string, unknown>) => Promise<void>;
  decide: (subject: ActorContext | null, request: { action: string }) => Promise<Decision>;
  /** Chart codes a gift may use (configuration). */
  categories: () => string[];
  formatMoney: (minor: number) => string;
  now?: () => Date;
  newId?: () => string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown, field: string, { required = false, max = 500 } = {}): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DonationError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new DonationError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw new DonationError(400, `${field} is required`);
  if (trimmed.length > max) throw new DonationError(400, `${field} is longer than ${max} characters`);
  return trimmed === '' ? undefined : trimmed;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new DonationError(400, `${field} must be a date as YYYY-MM-DD`);
  }
  return value;
}

interface InKindRow { id: string; donor_person_id: string | null; donor_name: string; date: string; description: string; status: 'posted' | 'voided'; void_reason: string | null; created_by: string; created_at: string }
interface PledgeRow { id: string; donor_person_id: string | null; donor_name: string; amount: number; fund_id: string; start_date: string; end_date: string | null; schedule: PledgeSchedule; memo: string; status: 'open' | 'cancelled'; cancel_reason: string | null; created_by: string; created_at: string }

export default class DonationManager {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: DonationOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  // ── In-kind gifts ──────────────────────────────────────────────────────

  /** A gift of goods or services: the donor, the date and a description, never a value. */
  async recordInKind(actor: DonationsActor, input: { donorName: string; donorPersonId?: string; date: string; description: string }): Promise<InKindGift> {
    await this.authorize(actor, 'donation-record');
    const user = actor.actingUsername();
    const gift: InKindGift = {
      id: this.newId(), donorName: text(input.donorName, 'donorName', { required: true, max: 200 }) as string,
      donorPersonId: text(input.donorPersonId, 'donorPersonId', { max: 64 }) ?? null, date: isoDate(input.date, 'date'),
      description: text(input.description, 'description', { required: true, max: 500 }) as string,
      status: 'posted', voidReason: null, createdBy: user, createdAt: this.stamp()
    };
    await this.audit(actor, { action: 'inkind-record', severity: 'low', resource: gift.id, resourceType: 'donations-inkind', metadata: { date: gift.date, description: gift.description } });
    this.options.db.transaction(() => {
      this.options.db.prepare(`INSERT INTO accounting_donations_inkind (id, donor_person_id, donor_name, date, description, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, 'posted', ?, ?)`).run(gift.id, gift.donorPersonId, gift.donorName, gift.date, gift.description, user, gift.createdAt);
    })();
    return gift;
  }

  async voidInKind(actor: DonationsActor, id: string, reason: string): Promise<InKindGift> {
    await this.authorize(actor, 'donation-record');
    const why = text(reason, 'reason', { required: true }) as string;
    const gift = this.inKind(id);
    if (gift.status === 'voided') throw new DonationError(409, 'this in-kind gift is already voided');
    await this.audit(actor, { action: 'inkind-void', severity: 'medium', resource: id, resourceType: 'donations-inkind', reason: why, metadata: {} });
    this.options.db.transaction(() => {
      this.options.db.prepare("UPDATE accounting_donations_inkind SET status = 'voided', void_reason = ? WHERE id = ? AND status = 'posted'").run(why, id);
    })();
    return this.inKind(id);
  }

  /** In-kind gifts, newest first. Needs ledger-read: it names donors. */
  async listInKind(actor: DonationsActor, filter: { includeVoided?: boolean } = {}): Promise<InKindGift[]> {
    await this.authorize(actor, 'ledger-read');
    return (this.options.db.prepare(`SELECT * FROM accounting_donations_inkind ${filter.includeVoided ? '' : "WHERE status = 'posted'"}
      ORDER BY date DESC, created_at DESC`).all() as InKindRow[]).map(toInKind);
  }

  // ── Pledges ────────────────────────────────────────────────────────────

  /** A promise to give, kept outside the ledger; gifts that pay toward it name it. */
  async createPledge(actor: DonationsActor, input: { donorName: string; donorPersonId?: string; amount: number; fundId: string; startDate: string; endDate?: string; schedule?: string; memo?: string }): Promise<Pledge> {
    await this.authorize(actor, 'donation-record');
    const user = actor.actingUsername();
    if (typeof input.amount !== 'number' || !Number.isSafeInteger(input.amount) || input.amount <= 0) throw new DonationError(400, 'amount must be a whole number of cents, more than 0');
    const fundId = text(input.fundId, 'fundId', { required: true, max: 64 }) as string;
    const fund = (await this.options.ledger.listFunds(actor)).find(f => f.id === fundId);
    if (!fund) throw new DonationError(404, 'fundId: unknown fund');
    if (!fund.active) throw new DonationError(409, `fundId: fund '${fund.name}' is closed`);
    const startDate = isoDate(input.startDate, 'startDate');
    const endDate = input.endDate === undefined || input.endDate === '' ? null : isoDate(input.endDate, 'endDate');
    if (endDate && endDate < startDate) throw new DonationError(400, 'endDate cannot be before startDate');
    const schedule = (input.schedule ?? 'once') as PledgeSchedule;
    if (!SCHEDULES.includes(schedule)) throw new DonationError(400, `schedule must be one of ${SCHEDULES.join(', ')}`);
    const id = this.newId();
    const createdAt = this.stamp();
    const donorName = text(input.donorName, 'donorName', { required: true, max: 200 }) as string;
    const donorPersonId = text(input.donorPersonId, 'donorPersonId', { max: 64 }) ?? null;
    const memo = text(input.memo, 'memo', { max: 2000 }) ?? '';
    await this.audit(actor, { action: 'pledge-create', severity: 'low', resource: id, resourceType: 'donations-pledge', metadata: { amount: input.amount, fundId, startDate, endDate, schedule } });
    this.options.db.transaction(() => {
      this.options.db.prepare(`INSERT INTO accounting_donations_pledges (id, donor_person_id, donor_name, amount, fund_id, start_date, end_date, schedule, memo, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(id, donorPersonId, donorName, input.amount, fundId, startDate, endDate, schedule, memo, user, createdAt);
    })();
    return (await this.listPledges(actor)).find(p => p.id === id) as Pledge;
  }

  async cancelPledge(actor: DonationsActor, id: string, reason: string): Promise<Pledge> {
    await this.authorize(actor, 'donation-record');
    const why = text(reason, 'reason', { required: true }) as string;
    const row = this.pledgeRow(id);
    if (row.status === 'cancelled') throw new DonationError(409, 'this pledge is already cancelled');
    await this.audit(actor, { action: 'pledge-cancel', severity: 'medium', resource: id, resourceType: 'donations-pledge', reason: why, metadata: {} });
    this.options.db.transaction(() => {
      this.options.db.prepare("UPDATE accounting_donations_pledges SET status = 'cancelled', cancel_reason = ? WHERE id = ? AND status = 'open'").run(why, id);
    })();
    return (await this.listPledges(actor, { includeCancelled: true })).find(p => p.id === id) as Pledge;
  }

  /** Pledges with what has been given toward each (posted gift lines naming it), newest first. Needs ledger-read. */
  async listPledges(actor: DonationsActor, filter: { includeCancelled?: boolean } = {}): Promise<Pledge[]> {
    await this.authorize(actor, 'ledger-read');
    const given = new Map<string, number>();
    for (const receipt of await this.options.ledger.listDocuments(actor, 'receipt')) {
      for (const line of receipt.lines) {
        const pledgeId = line.status === 'posted' ? line.details.gift?.pledgeId : undefined;
        if (typeof pledgeId === 'string') given.set(pledgeId, (given.get(pledgeId) ?? 0) + line.amount);
      }
    }
    return (this.options.db.prepare(`SELECT * FROM accounting_donations_pledges ${filter.includeCancelled ? '' : "WHERE status = 'open'"}
      ORDER BY start_date DESC, created_at DESC`).all() as PledgeRow[]).map(r => toPledge(r, given.get(r.id) ?? 0));
  }

  /** Whether a gift may name this pledge: it exists and is open. For the gift kind's validator. */
  pledgeIsOpen(id: string): boolean {
    const row = this.options.db.prepare('SELECT status FROM accounting_donations_pledges WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status === 'open';
  }

  // ── Form choices ───────────────────────────────────────────────────────

  /**
   *   gift-categories  the chart's donation categories   ledger-record (through LedgerManager)
   *   open-pledges     open pledges, with what is left   ledger-read
   */
  async toFormOptions(options: Record<string, string> = {}, viewer?: unknown): Promise<{ value: string; label: string; amount?: number }[]> {
    if (options.list === 'gift-categories') {
      const allowed = new Set(this.options.categories());
      return (await this.options.ledger.toFormOptions({ list: 'categories', kind: 'in' }, viewer)).filter(c => allowed.has(c.value));
    }
    if (options.list === 'open-pledges') {
      try {
        return (await this.listPledges(viewerActor(viewer))).map(p => ({
          value: p.id, amount: p.remaining, label: `${p.donorName} · ${this.options.formatMoney(p.amount)} pledged · ${this.options.formatMoney(p.remaining)} left`
        }));
      } catch {
        return [];
      }
    }
    return [];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async authorize(actor: DonationsActor, action: string): Promise<void> {
    const decision = await this.options.decide(actor.subject, { action });
    if (!decision.permit) await actor.enforceDeny(action, decision);
  }

  private async audit(actor: DonationsActor, record: { action: string; severity: string; resource: string; resourceType: string; reason?: string; metadata: Record<string, unknown> }): Promise<void> {
    const who = actor.subject
      ? this.options.host.actorOf(actor.subject)
      : { user: 'unknown', ipAddress: actor.ipAddress, metadata: { actorMissing: true } };
    const { metadata: whoMetadata, ...fields } = who as { user: string; actor?: string; ipAddress?: string; metadata: Record<string, unknown> };
    await this.options.recordAudit({ ...record, eventType: this.options.host.addonAuditEventName('donation-record'), ...fields,
      ipAddress: fields.ipAddress, metadata: { ...whoMetadata, ...record.metadata } });
  }

  private inKind(id: string): InKindGift {
    const row = this.options.db.prepare('SELECT * FROM accounting_donations_inkind WHERE id = ?').get(id) as InKindRow | undefined;
    if (!row) throw new DonationError(404, 'unknown in-kind gift');
    return toInKind(row);
  }

  private pledgeRow(id: string): PledgeRow {
    const row = this.options.db.prepare('SELECT * FROM accounting_donations_pledges WHERE id = ?').get(id) as PledgeRow | undefined;
    if (!row) throw new DonationError(404, 'unknown pledge');
    return row;
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

/** A page render's viewer as a caller, for reading only, as LedgerManager.viewerActor does. */
function viewerActor(viewer: unknown): DonationsActor {
  const username = (viewer as { username?: unknown } | null | undefined)?.username;
  return {
    ipAddress: undefined, subject: (viewer ?? null) as ActorContext | null,
    actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
    enforceDeny: async (permission: string) => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
}

const toInKind = (r: InKindRow): InKindGift => ({
  id: r.id, donorPersonId: r.donor_person_id, donorName: r.donor_name, date: r.date, description: r.description,
  status: r.status, voidReason: r.void_reason, createdBy: r.created_by, createdAt: r.created_at
});

const toPledge = (r: PledgeRow, given: number): Pledge => ({
  id: r.id, donorPersonId: r.donor_person_id, donorName: r.donor_name, amount: r.amount, fundId: r.fund_id,
  startDate: r.start_date, endDate: r.end_date, schedule: r.schedule, memo: r.memo, status: r.status, cancelReason: r.cancel_reason,
  given, remaining: Math.max(0, r.amount - given), createdBy: r.created_by, createdAt: r.created_at
});
