/**
 * DonationManager — the donations add-on's one door (D-036): in-kind donations
 * and pledges in this add-on's own database, and the form choices it adds.
 * Money always goes through the accounting add-on's managers; this one only
 * reads the ledger (receipts paying a pledge) through LedgerManager.
 *
 * Every write: ask the decision point for `donation-record`, write the audit
 * record and wait for it (on-failure: refuse), then change the rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import { donationsFor, renderStatement, type StatementContent, type StatementWording } from './statement.js';
import type { ActorContext, AddonHost, Decision, IdentityManager, OrganizationManager } from '@jwilleke/ngdpbase-types';

/**
 * A stored page as a PDF (ngdpbase ExportManager.htmlToPdf), or null when the
 * site has no PDF provider (`PDF_UNAVAILABLE`): then the email carries the page
 * alone. Any other failure is thrown.
 */
export async function pdfOf(exporter: { htmlToPdf(ctx: ActorContext, html: string): Promise<Buffer> } | null | undefined, ctx: ActorContext, html: string): Promise<Buffer | null> {
  if (!exporter) return null;
  try {
    return await exporter.htmlToPdf(ctx, html);
  } catch (err) {
    if ((err as { code?: string }).code === 'PDF_UNAVAILABLE') return null;
    throw err;
  }
}

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
  /** The caller's own receipts and refunds (D-037, ledger-self). */
  ownDocuments(actor: DonationsActor, kind: 'receipt' | 'refund'): ReturnType<LedgerLike['listDocuments']>;
  listDocuments(actor: DonationsActor, kind: 'receipt' | 'refund', filter?: { includeVoided?: boolean }): Promise<{
    id: string; number: string | null; date: string; status: 'posted' | 'voided'; bounced?: boolean;
    lines: { id: string; amount: number; status: 'posted' | 'voided'; receiptLineId: string | null; details: Record<string, Record<string, unknown>> }[];
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

export interface InKindDonation {
  id: string; donorPersonId: string | null; donorName: string; date: string; description: string;
  status: 'posted' | 'voided'; voidReason: string | null; createdBy: string; createdAt: string;
}

export type PledgeSchedule = 'once' | 'monthly' | 'quarterly' | 'yearly';
const SCHEDULES: readonly PledgeSchedule[] = ['once', 'monthly', 'quarterly', 'yearly'];

export interface Pledge {
  id: string; donorPersonId: string | null; donorName: string; amount: number; fundId: string;
  startDate: string; endDate: string | null; schedule: PledgeSchedule; memo: string;
  status: 'open' | 'cancelled'; cancelReason: string | null;
  /** Posted donation lines that name this pledge. */
  given: number;
  remaining: number;
  createdBy: string; createdAt: string;
}

/**
 * A donor: an ngdpbase contact, a person or an organization (ngdpbase #1930). The
 * `@id` is kept with the name, because a deleted account deletes its person.
 */
export interface Donor { type: 'person' | 'organization'; id: string; name: string }

/** Core's contact doors (ngdpbase v5.22.0). Every call takes the caller's context first. */
export interface Contacts { persons?: IdentityManager | null; organizations?: OrganizationManager | null }

/** A new donor: a person (given and family name) or an organization (name), with what a statement needs. */
export interface NewDonor {
  type: 'person' | 'organization';
  name?: string; givenName?: string; familyName?: string; email?: string;
  streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string; addressCountry?: string;
  /** A person's organization, as `organization|<@id>` from the donor list, and their role there. */
  organization?: string; role?: string;
}

/** One donor's year, for the Donation Statements page. */
export interface DonorYear {
  donor: Donor; total: number; deductible: number; donationCount: number; inKindCount: number;
  /** The standing statement for the year, if issued; needsReissue when the donations have changed since. */
  statement: { id: string; issuedAt: string; emailedTo: string | null; needsReissue: boolean } | null;
}

export interface IssuedStatement {
  id: string; donor: Donor; year: number; html: string; sha256: string; total: number; deductible: number; donationCount: number;
  status: 'issued' | 'superseded'; supersededBy: string | null; reissueReason: string | null;
  emailedTo: string | null; emailedAt: string | null; issuedBy: string; issuedAt: string;
}

export interface DonationOptions {
  host: DonationsHost;
  db: DonationsDb;
  ledger: LedgerLike;
  recordAudit: (record: Record<string, unknown>) => Promise<void>;
  decide: (subject: ActorContext | null, request: { action: string }) => Promise<Decision>;
  /** Chart codes a donation may use (configuration). */
  categories: () => string[];
  formatMoney: (minor: number) => string;
  /** Core's contact doors; looked up when used, so they may arrive after this manager. */
  contacts?: () => Contacts;
  /** The statement's organization and wording (configuration). */
  wording?: () => StatementWording;
  /** ngdpbase's EmailManager, to send statements, as the caller. */
  email?: () => { sendTo(ctx: ActorContext, to: string, subject: string, text: string, html?: string, options?: { attachments?: { filename: string; contentType: string; content: Buffer }[] }): Promise<void> } | null | undefined;
  /** Told after every committed write; index.ts bumps the `DonationManager` cache topic (ngdpbase caching guide: the owner bumps). */
  changed?: () => Promise<void>;
  /** ngdpbase's ExportManager, to send each statement as a PDF (#51). */
  pdf?: () => { htmlToPdf(ctx: ActorContext, html: string): Promise<Buffer> } | null | undefined;
  /** The caller's own ngdpbase person, as its `@id`, for a donor's own view (D-037); read as the caller (IdentityManager.getByUserIdentifier, ngdpbase #2018: their own under profile-manage). */
  personOf?: (actor: { readonly subject: ActorContext | null; actingUsername(): string }) => Promise<string | null>;
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

  // ── In-kind donations ──────────────────────────────────────────────────────

  /** A donation of goods or services: the donor, the date and a description, never a value. */
  async recordInKind(actor: DonationsActor, input: { donorName: string; donorPersonId?: string; date: string; description: string }): Promise<InKindDonation> {
    await this.authorize(actor, 'donation-record');
    const user = actor.actingUsername();
    const donation: InKindDonation = {
      id: this.newId(), donorName: text(input.donorName, 'donorName', { required: true, max: 200 }) as string,
      donorPersonId: text(input.donorPersonId, 'donorPersonId', { max: 64 }) ?? null, date: isoDate(input.date, 'date'),
      description: text(input.description, 'description', { required: true, max: 500 }) as string,
      status: 'posted', voidReason: null, createdBy: user, createdAt: this.stamp()
    };
    await this.audit(actor, { action: 'inkind-record', severity: 'low', resource: donation.id, resourceType: 'donations-inkind', metadata: { date: donation.date, description: donation.description } });
    this.options.db.transaction(() => {
      this.options.db.prepare(`INSERT INTO accounting_donations_inkind (id, donor_person_id, donor_name, date, description, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, 'posted', ?, ?)`).run(donation.id, donation.donorPersonId, donation.donorName, donation.date, donation.description, user, donation.createdAt);
    })();
    await this.written();
    return donation;
  }

  async voidInKind(actor: DonationsActor, id: string, reason: string): Promise<InKindDonation> {
    await this.authorize(actor, 'donation-record');
    const why = text(reason, 'reason', { required: true }) as string;
    const donation = this.inKind(id);
    if (donation.status === 'voided') throw new DonationError(409, 'this in-kind donation is already voided');
    await this.audit(actor, { action: 'inkind-void', severity: 'medium', resource: id, resourceType: 'donations-inkind', reason: why, metadata: {} });
    this.options.db.transaction(() => {
      this.options.db.prepare("UPDATE accounting_donations_inkind SET status = 'voided', void_reason = ? WHERE id = ? AND status = 'posted'").run(why, id);
    })();
    await this.written();
    return this.inKind(id);
  }

  /** In-kind donations, newest first. Needs ledger-read: it names donors. */
  async listInKind(actor: DonationsActor, filter: { includeVoided?: boolean } = {}): Promise<InKindDonation[]> {
    await this.authorize(actor, 'ledger-read');
    return (this.options.db.prepare(`SELECT * FROM accounting_donations_inkind ${filter.includeVoided ? '' : "WHERE status = 'posted'"}
      ORDER BY date DESC, created_at DESC`).all() as InKindRow[]).map(toInKind);
  }

  // ── Pledges ────────────────────────────────────────────────────────────

  /** A promise to give, kept outside the ledger; donations that pay toward it name it. */
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
    await this.written();
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
    await this.written();
    return (await this.listPledges(actor, { includeCancelled: true })).find(p => p.id === id) as Pledge;
  }

  /** Pledges with what has been given toward each (posted donation lines naming it), newest first. Needs ledger-read. */
  async listPledges(actor: DonationsActor, filter: { includeCancelled?: boolean } = {}): Promise<Pledge[]> {
    await this.authorize(actor, 'ledger-read');
    const given = new Map<string, number>();
    for (const receipt of await this.options.ledger.listDocuments(actor, 'receipt')) {
      for (const line of receipt.lines) {
        const pledgeId = line.status === 'posted' ? line.details.donation?.pledgeId : undefined;
        if (typeof pledgeId === 'string') given.set(pledgeId, (given.get(pledgeId) ?? 0) + line.amount);
      }
    }
    return (this.options.db.prepare(`SELECT * FROM accounting_donations_pledges ${filter.includeCancelled ? '' : "WHERE status = 'open'"}
      ORDER BY start_date DESC, created_at DESC`).all() as PledgeRow[]).map(r => toPledge(r, given.get(r.id) ?? 0));
  }

  /** Whether a donation may name this pledge: it exists and is open. For the donation kind's validator. */
  pledgeIsOpen(id: string): boolean {
    const row = this.options.db.prepare('SELECT status FROM accounting_donations_pledges WHERE id = ?').get(id) as { status: string } | undefined;
    return row?.status === 'open';
  }

  // ── Year-end donation statements (D-036) ──────────────────────────────────

  /** Each donor with donations or in-kind donations in a year, their totals and their statement's standing. Needs ledger-read. */
  async yearOverview(actor: DonationsActor, year: number): Promise<DonorYear[]> {
    await this.authorize(actor, 'ledger-read');
    const y = statementYear(year);
    const out: DonorYear[] = [];
    for (const donor of (await this.donorsOfYear(actor, y)).values()) {
      const content = await this.contentFor(actor, donor, y);
      const row = this.currentStatement(donor.id, y);
      out.push({
        donor, total: content.total, deductible: content.deductible, donationCount: content.donations.length, inKindCount: content.inKind.length,
        statement: row ? { id: row.id, issuedAt: row.issued_at, emailedTo: row.emailed_to, needsReissue: changed(row, content) } : null
      });
    }
    return out.sort((a, b) => a.donor.name.localeCompare(b.donor.name));
  }

  /** What a donor's statement would say now, without issuing it. Needs ledger-read. */
  async previewStatement(actor: DonationsActor, donorValue: string, year: number): Promise<string> {
    await this.authorize(actor, 'ledger-read');
    const content = await this.contentFor(actor, await this.donor(actor, donorValue), statementYear(year));
    return renderStatement(content, this.wording(), this.options.formatMoney, this.stamp().slice(0, 10));
  }

  /**
   * Issue the year's statements: to one donor, or to every donor with donations in
   * the year who has none yet. Each is stored exactly as issued, with its
   * fingerprint. With `email`, each is sent to the donor's email on file.
   */
  async issueStatements(actor: DonationsActor, input: { year: number; donor?: string; email?: boolean }): Promise<{ issued: number; emailed: number; notEmailed: string[] }> {
    await this.authorize(actor, 'statement-issue');
    const year = statementYear(input.year);
    const donors = input.donor ? [await this.donor(actor, input.donor)] : [...(await this.donorsOfYear(actor, year)).values()];
    const pending: { donor: Donor; content: StatementContent }[] = [];
    for (const donor of donors) {
      if (this.currentStatement(donor.id, year)) {
        if (input.donor) throw new DonationError(409, `donor: ${donor.name} already has a ${year} statement; reissue it instead`);
        continue;
      }
      const content = await this.contentFor(actor, donor, year);
      if (content.donations.length || content.inKind.length) pending.push({ donor, content });
    }
    await this.audit(actor, { eventType: 'statement-issue', action: 'statement-issue', severity: 'high', resource: `statements:${year}`, resourceType: 'donations-statement',
      metadata: { year, count: pending.length, donors: pending.map(p => p.donor.id), email: input.email === true } });
    let emailed = 0;
    const notEmailed: string[] = [];
    for (const { donor, content } of pending) {
      const id = this.insertStatement(actor, content);
      if (input.email) {
        const sent = await this.sendStatement(actor, id);
        if (sent) emailed++; else notEmailed.push(donor.name);
      }
    }
    if (pending.length) await this.written();
    return { issued: pending.length, emailed, notEmailed };
  }

  /** Reissue a statement, with a reason: a new one is stored, and the old one is marked superseded by it. */
  async reissueStatement(actor: DonationsActor, statementId: string, reason: string, options: { email?: boolean } = {}): Promise<IssuedStatement> {
    await this.authorize(actor, 'statement-issue');
    const why = text(reason, 'reason', { required: true }) as string;
    const old = this.statementRow(text(statementId, 'statementId', { required: true }) as string);
    if (old.status !== 'issued') throw new DonationError(409, 'statementId: this statement was already reissued');
    const donor: Donor = { type: old.donor_type, id: old.donor_id, name: old.donor_name };
    const fresh = await this.contentFor(actor, { ...donor, name: (await this.donorOrNull(actor, donor)) ?? donor.name }, old.year);
    await this.audit(actor, { eventType: 'statement-issue', action: 'statement-reissue', severity: 'high', resource: old.id, resourceType: 'donations-statement', reason: why,
      metadata: { year: old.year, donor: donor.id, totalBefore: old.total, totalAfter: fresh.total } });
    const id = this.newId();
    this.options.db.transaction(() => {
      this.options.db.prepare("UPDATE accounting_donations_statements SET status = 'superseded', superseded_by = ?, reissue_reason = ? WHERE id = ? AND status = 'issued'").run(id, why, old.id);
      this.insertStatement(actor, fresh, id);
    })();
    if (options.email) await this.sendStatement(actor, id);
    await this.written();
    return this.getStatementRow(id);
  }

  /** An issued statement, exactly as stored. Needs ledger-read. */
  async getStatement(actor: DonationsActor, statementId: string): Promise<IssuedStatement> {
    await this.authorize(actor, 'ledger-read');
    return this.getStatementRow(statementId);
  }

  /** Issued statements, newest first; superseded ones only when asked. Needs ledger-read. */
  async listStatements(actor: DonationsActor, filter: { year?: number; includeSuperseded?: boolean } = {}): Promise<IssuedStatement[]> {
    await this.authorize(actor, 'ledger-read');
    const where = [filter.includeSuperseded ? '' : "status = 'issued'", filter.year ? 'year = ?' : ''].filter(Boolean);
    return (this.options.db.prepare(`SELECT id FROM accounting_donations_statements ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY issued_at DESC`)
      .all(...(filter.year ? [statementYear(filter.year)] : [])) as { id: string }[]).map(r => this.getStatementRow(r.id));
  }

  // ── A donor's own view (D-037) ──────────────────────────────────────────

  /**
   * The signed-in donor's own donations, by year, newest first: their donations (their
   * own receipts' donation lines, net of refunds) and their issued statements.
   * Needs ledger-self, which every signed-in person holds.
   */
  async myDonations(actor: DonationsActor): Promise<{ year: number; donationCount: number; total: number; deductible: number; statements: { id: string; issuedAt: string }[] }[]> {
    await this.authorize(actor, 'ledger-self');
    const personId = await this.options.personOf?.(actor);
    if (!personId) return [];
    const receipts = await this.options.ledger.ownDocuments(actor, 'receipt');
    const refunds = await this.options.ledger.ownDocuments(actor, 'refund');
    const statements = this.options.db.prepare("SELECT id, year, issued_at FROM accounting_donations_statements WHERE donor_id = ? AND status = 'issued' ORDER BY issued_at DESC")
      .all(personId) as { id: string; year: number; issued_at: string }[];
    const years = new Set([...receipts.map(r => Number(r.date.slice(0, 4))), ...statements.map(s => s.year)]);
    return [...years].sort((a, b) => b - a).map(year => {
      const donations = donationsFor(personId, year, receipts, refunds);
      return { year, donationCount: donations.length, total: donations.reduce((t, g) => t + g.amount, 0), deductible: donations.reduce((t, g) => t + g.deductible, 0),
        statements: statements.filter(s => s.year === year).map(s => ({ id: s.id, issuedAt: s.issued_at })) };
    }).filter(y => y.donationCount || y.statements.length);
  }

  /** One of the signed-in donor's own issued statements, exactly as stored; another donor's is not found. Needs ledger-self. */
  async myStatement(actor: DonationsActor, statementId: string): Promise<IssuedStatement> {
    await this.authorize(actor, 'ledger-self');
    const personId = await this.options.personOf?.(actor);
    const row = this.options.db.prepare('SELECT donor_id FROM accounting_donations_statements WHERE id = ?').get(statementId) as { donor_id: string } | undefined;
    if (!personId || !row || row.donor_id !== personId) throw new DonationError(404, 'statementId: unknown statement');
    return this.getStatementRow(statementId);
  }

  // ── Donors: core's contacts (ngdpbase #1930) ───────────────────────────

  /**
   * A donor from a donor-list value (`person|<@id>` or `organization|<@id>`),
   * read through core's door with the caller's context (identity-read). A
   * contact that no longer exists is refused, naming the field.
   */
  async donor(actor: DonationsActor, value: string, field = 'donor'): Promise<Donor> {
    const [type, ...rest] = String(value).split('|');
    const id = rest.join('|');
    if ((type !== 'person' && type !== 'organization') || !id) throw new DonationError(400, `${field}: not a donor from the list`);
    const contacts = this.options.contacts?.() ?? {};
    const door = type === 'person' ? contacts.persons : contacts.organizations;
    if (!door) throw new DonationError(409, `${field}: ngdpbase's contacts are not available on this site`);
    const contact = await door.get(actor.subject as never, id) as { name?: string; email?: string; givenName?: string; familyName?: string } | null;
    if (!contact) throw new DonationError(404, `${field}: this donor no longer exists`);
    return { type, id, name: donorName(contact) };
  }

  /**
   * Add a donor who has no account: a person or an organization, created
   * through core's door (identity-manage, audited by core). Returns it as a
   * donor-list value's parts.
   */
  async addDonor(actor: DonationsActor, input: NewDonor): Promise<Donor> {
    const contacts = this.options.contacts?.() ?? {};
    const email = text(input.email, 'email', { max: 200 });
    const address = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'].some(k => text((input as unknown as Record<string, unknown>)[k], k, { max: 200 }))
      ? { '@type': 'PostalAddress' as const, streetAddress: text(input.streetAddress, 'streetAddress', { max: 200 }) ?? null,
          addressLocality: text(input.addressLocality, 'addressLocality', { max: 100 }) ?? null, addressRegion: text(input.addressRegion, 'addressRegion', { max: 100 }) ?? null,
          postalCode: text(input.postalCode, 'postalCode', { max: 20 }) ?? null, addressCountry: text(input.addressCountry, 'addressCountry', { max: 60 }) ?? null }
      : undefined;
    if (input.type === 'organization') {
      if (!contacts.organizations) throw new DonationError(409, "ngdpbase's contacts are not available on this site");
      const name = text(input.name, 'name', { required: true, max: 200 }) as string;
      const org = await contacts.organizations.create(actor.subject as never, { name, ...(email ? { email } : {}), ...(address ? { address } : {}) } as never);
      return { type: 'organization', id: org['@id'], name };
    }
    if (input.type !== 'person') throw new DonationError(400, 'type must be person or organization');
    if (!contacts.persons) throw new DonationError(409, "ngdpbase's contacts are not available on this site");
    const givenName = text(input.givenName, 'givenName', { max: 100 });
    const familyName = text(input.familyName, 'familyName', { required: true, max: 100 }) as string;
    const name = [givenName, familyName].filter(Boolean).join(' ');
    const organization = text(input.organization, 'organization', { max: 300 });
    // An affiliation is a schema.org OrganizationRole on the identity record (ngdpbase #2039): roleName is
    // the title, free text, and grants nothing. Core checks the organization and decides who may set it.
    let affiliation: { '@type': 'OrganizationRole'; memberOf: { '@id': string }; roleName?: string }[] | undefined;
    if (organization) {
      const org = await this.donor(actor, organization, 'organization');
      if (org.type !== 'organization') throw new DonationError(400, 'organization: choose an organization');
      const roleName = text(input.role, 'role', { max: 100 });
      affiliation = [{ '@type': 'OrganizationRole', memberOf: { '@id': org.id }, ...(roleName ? { roleName } : {}) }];
    }
    const person = await contacts.persons.create(actor.subject as never, {
      name, givenName, familyName, ...(email ? { email } : {}), ...(address ? { address } : {}), ...(affiliation ? { affiliation } : {})
    } as never);
    return { type: 'person', id: person['@id'], name };
  }

  // ── Form choices ───────────────────────────────────────────────────────

  /**
   *   donation-categories  the chart's donation categories   ledger-record (through LedgerManager)
   *   open-pledges     open pledges, with what is left   ledger-read
   */
  async toFormOptions(options: Record<string, string> = {}, viewer?: unknown): Promise<{ value: string; label: string; amount?: number }[]> {
    if (options.list === 'donors' || options.list === 'organizations') {
      // Core's doors decide with the viewer's own context (identity-read); a refusal is no choices.
      const contacts = this.options.contacts?.() ?? {};
      try {
        const orgs = (await contacts.organizations?.list(viewer as never)) ?? [];
        const orgChoices = orgs.map(o => ({ value: `organization|${o['@id']}`, label: `${o.name ?? o['@id']} (organization)` }));
        if (options.list === 'organizations') return orgChoices.sort((a, b) => a.label.localeCompare(b.label));
        const people = (await contacts.persons?.list(viewer as never)) ?? [];
        return [...people.map(p => ({ value: `person|${p['@id']}`, label: [donorName(p), p.email].filter(Boolean).join(' · ') })), ...orgChoices]
          .sort((a, b) => a.label.localeCompare(b.label));
      } catch (err) {
        if ((err as Error).name === 'ContactRefusedError') return [];
        throw err;
      }
    }
    if (options.list === 'donation-categories') {
      const allowed = new Set(this.options.categories());
      return (await this.options.ledger.toFormOptions({ list: 'categories', kind: 'in' }, viewer)).filter(c => allowed.has(c.value));
    }
    if (options.list === 'statement-years') {
      const year = Number(this.stamp().slice(0, 4));
      return [year - 1, year, year - 2].map(y => ({ value: String(y), label: String(y) }));
    }
    if (options.list === 'statements') {
      try {
        const actor = viewerActor(viewer);
        return (await this.listStatements(actor)).slice(0, 200).map(st => ({ value: st.id, label: `${st.donor.name} · ${st.year} · issued ${st.issuedAt.slice(0, 10)}` }));
      } catch {
        return [];
      }
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

  /** Donors named by the year's donation lines and in-kind donations, by @id; the latest name each was recorded under. */
  private async donorsOfYear(actor: DonationsActor, year: number): Promise<Map<string, Donor>> {
    const donors = new Map<string, Donor>();
    for (const r of await this.options.ledger.listDocuments(actor, 'receipt')) {
      if (Number(r.date.slice(0, 4)) !== year) continue;
      for (const l of r.lines) {
        const d = l.details.donation?.donor as Donor | null | undefined;
        if (d?.id) donors.set(d.id, d);
      }
    }
    const inKind = this.options.db.prepare(`SELECT donor_person_id, donor_name FROM accounting_donations_inkind
      WHERE status = 'posted' AND donor_person_id IS NOT NULL AND substr(date, 1, 4) = ?`).all(String(year)) as { donor_person_id: string; donor_name: string }[];
    for (const i of inKind) if (!donors.has(i.donor_person_id)) donors.set(i.donor_person_id, { type: 'person', id: i.donor_person_id, name: i.donor_name });
    return donors;
  }

  private async contentFor(actor: DonationsActor, donor: Donor, year: number): Promise<StatementContent> {
    const donations = donationsFor(donor.id, year, await this.options.ledger.listDocuments(actor, 'receipt'), await this.options.ledger.listDocuments(actor, 'refund'));
    const inKind = (this.options.db.prepare(`SELECT date, description FROM accounting_donations_inkind
      WHERE status = 'posted' AND donor_person_id = ? AND substr(date, 1, 4) = ? ORDER BY date`).all(donor.id, String(year)) as { date: string; description: string }[]);
    return { donor, year, donations, inKind, total: donations.reduce((t, g) => t + g.amount, 0), deductible: donations.reduce((t, g) => t + g.deductible, 0) };
  }

  private wording(): StatementWording {
    return this.options.wording?.() ?? { organization: { name: 'the organization', taxId: '', address: '' }, intro: '', noGoods: '', goodsNote: '', taxIdNote: '' };
  }

  private insertStatement(actor: DonationsActor, content: StatementContent, id: string = this.newId()): string {
    const issuedAt = this.stamp();
    const html = renderStatement(content, this.wording(), this.options.formatMoney, issuedAt.slice(0, 10));
    this.options.db.prepare(`INSERT INTO accounting_donations_statements (id, donor_type, donor_id, donor_name, year, html, sha256, total, deductible,
        donation_count, status, issued_by, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
      id, content.donor.type, content.donor.id, content.donor.name, content.year, html, createHash('sha256').update(html).digest('hex'),
      content.total, content.deductible, content.donations.length, actor.actingUsername(), issuedAt);
    return id;
  }

  /** Email a stored statement to the donor's address on file; false when there is none, or it could not be sent. */
  private async sendStatement(actor: DonationsActor, id: string): Promise<boolean> {
    const row = this.statementRow(id);
    const contacts = this.options.contacts?.() ?? {};
    const door = row.donor_type === 'person' ? contacts.persons : contacts.organizations;
    const contact = door ? await door.get(actor.subject as never, row.donor_id).catch(() => null) as { email?: string } | null : null;
    const mailer = this.options.email?.();
    const ctx = actor.subject;
    if (!contact?.email || !mailer || !ctx) return false;
    let pdf: Buffer | null;
    try {
      pdf = await pdfOf(this.options.pdf?.(), ctx, row.html);
    } catch {
      return false; // a PDF provider that fails is reported by ExportManager; nothing is sent half-made
    }
    try {
      const org = this.wording().organization.name;
      const options = pdf ? { attachments: [{ filename: `${row.year} donation statement.pdf`, contentType: 'application/pdf', content: pdf }] } : {};
      await mailer.sendTo(ctx, contact.email, `${row.year} donation statement from ${org}`,
        `Your ${row.year} donation statement from ${org} is ${pdf ? 'attached, and below' : 'below'}.`, row.html, options);
    } catch {
      return false; // EmailManager reports the failure to administrators itself (#1916)
    }
    this.options.db.prepare('UPDATE accounting_donations_statements SET emailed_to = ?, emailed_at = ?, pdf_sha256 = ? WHERE id = ? AND emailed_at IS NULL')
      .run(contact.email, this.stamp(), pdf ? createHash('sha256').update(pdf).digest('hex') : null, id);
    return true;
  }

  /**
   * Told after every committed write, so pages showing donations re-render
   * (ngdpbase caching guide: the owner bumps its own topic; index.ts bumps
   * `DonationManager`). The one write helper.
   */
  private async written(): Promise<void> {
    await this.options.changed?.();
  }

  private async donorOrNull(actor: DonationsActor, donor: Donor): Promise<string | null> {
    try { return (await this.donor(actor, `${donor.type}|${donor.id}`)).name; } catch { return null; }
  }

  private currentStatement(donorId: string, year: number): StatementRow | undefined {
    return this.options.db.prepare("SELECT * FROM accounting_donations_statements WHERE donor_id = ? AND year = ? AND status = 'issued'").get(donorId, year) as StatementRow | undefined;
  }

  private statementRow(id: string): StatementRow {
    const row = this.options.db.prepare('SELECT * FROM accounting_donations_statements WHERE id = ?').get(id) as StatementRow | undefined;
    if (!row) throw new DonationError(404, 'statementId: unknown statement');
    return row;
  }

  private getStatementRow(id: string): IssuedStatement {
    const r = this.statementRow(id);
    return {
      id: r.id, donor: { type: r.donor_type, id: r.donor_id, name: r.donor_name }, year: r.year, html: r.html, sha256: r.sha256, total: r.total,
      deductible: r.deductible, donationCount: r.donation_count, status: r.status, supersededBy: r.superseded_by, reissueReason: r.reissue_reason,
      emailedTo: r.emailed_to, emailedAt: r.emailed_at, issuedBy: r.issued_by, issuedAt: r.issued_at
    };
  }

  private async authorize(actor: DonationsActor, action: string): Promise<void> {
    const decision = await this.options.decide(actor.subject, { action });
    if (!decision.permit) await actor.enforceDeny(action, decision);
  }

  private async audit(actor: DonationsActor, record: { action: string; severity: string; resource: string; resourceType: string; reason?: string; metadata: Record<string, unknown>; eventType?: string }): Promise<void> {
    const who = actor.subject
      ? this.options.host.actorOf(actor.subject)
      : { user: 'unknown', ipAddress: actor.ipAddress, metadata: { actorMissing: true } };
    const { metadata: whoMetadata, ...fields } = who as { user: string; actor?: string; ipAddress?: string; metadata: Record<string, unknown> };
    const { eventType = 'donation-record', ...rest } = record;
    await this.options.recordAudit({ ...rest, eventType: this.options.host.addonAuditEventName(eventType), ...fields,
      ipAddress: fields.ipAddress, metadata: { ...whoMetadata, ...record.metadata } });
  }

  private inKind(id: string): InKindDonation {
    const row = this.options.db.prepare('SELECT * FROM accounting_donations_inkind WHERE id = ?').get(id) as InKindRow | undefined;
    if (!row) throw new DonationError(404, 'unknown in-kind donation');
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

interface StatementRow {
  id: string; donor_type: 'person' | 'organization'; donor_id: string; donor_name: string; year: number; html: string; sha256: string;
  total: number; deductible: number; donation_count: number; status: 'issued' | 'superseded'; superseded_by: string | null;
  reissue_reason: string | null; emailed_to: string | null; emailed_at: string | null; issued_by: string; issued_at: string;
}

/** A statement year: a whole number, 2000 to 9999. */
function statementYear(value: unknown): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new DonationError(400, 'year must be a year, e.g. 2026');
  return year;
}

/** Whether the donations behind a statement have changed since it was issued (a donation voided, refunded or added). */
function changed(row: StatementRow, content: StatementContent): boolean {
  return row.total !== content.total || row.deductible !== content.deductible || row.donation_count !== content.donations.length;
}

/** A contact's name for a donation record: its name, else given and family name, else its email. */
function donorName(c: { name?: unknown; givenName?: unknown; familyName?: unknown; email?: unknown; '@id'?: unknown }): string {
  if (typeof c.name === 'string' && c.name.trim() !== '') return c.name.trim();
  const parts = [c.givenName, c.familyName].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (parts.length) return parts.join(' ');
  return typeof c.email === 'string' ? c.email : String(c['@id'] ?? 'unknown');
}

const toInKind = (r: InKindRow): InKindDonation => ({
  id: r.id, donorPersonId: r.donor_person_id, donorName: r.donor_name, date: r.date, description: r.description,
  status: r.status, voidReason: r.void_reason, createdBy: r.created_by, createdAt: r.created_at
});

const toPledge = (r: PledgeRow, given: number): Pledge => ({
  id: r.id, donorPersonId: r.donor_person_id, donorName: r.donor_name, amount: r.amount, fundId: r.fund_id,
  startDate: r.start_date, endDate: r.end_date, schedule: r.schedule, memo: r.memo, status: r.status, cancelReason: r.cancel_reason,
  given, remaining: Math.max(0, r.amount - given), createdBy: r.created_by, createdAt: r.created_at
});
