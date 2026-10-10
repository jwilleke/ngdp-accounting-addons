/**
 * LedgerManager — the one door to the accounting ledger (docs/plans/ledger-design.md).
 *
 * Every write is one method, one permission and one audit event, in this order:
 *   1. ask for the permission on the caller's own context (never rebuilt);
 *   2. write the audit record and wait for it — the money permissions are
 *      declared `on-failure: refuse`, so a record that cannot be written stops
 *      the action here and no money moves without a record;
 *   3. change the rows, and append the history row, in one synchronous
 *      transaction.
 *
 * The database refuses what this class must never do even if it is wrong:
 * deleting an entry, changing an entry's money, or voiding it twice
 * (managers/migrations.ts).
 *
 * The event names below are string literals on purpose: ngdpbase's
 * `audit-coverage --addon` reads them to prove every declared event has an
 * emitter.
 */
import { randomUUID } from 'node:crypto';
import { addonAuditEventName } from '../../../dist/src/utils/auditEventNames.js';
import { ApiError } from '../../../dist/src/context/ApiContext.js';

/** The caller: ngdpbase's ApiContext satisfies this. */
export interface LedgerActor {
  requirePermission(permission: string): Promise<void>;
  actingUsername(): string;
  readonly ipAddress: string | undefined;
}

/** What LedgerManager hands to the audit door; index.ts wraps ngdpbase's recordAuditEvent. */
export interface LedgerAuditRecord {
  eventType: ReturnType<typeof addonAuditEventName>;
  user: string;
  ipAddress: string | undefined;
  action: string;
  severity: 'low' | 'medium' | 'high';
  resource?: string;
  resourceType?: string;
  reason?: string;
  metadata: Record<string, unknown>;
}
export type RecordAudit = (record: LedgerAuditRecord) => Promise<void>;

/** The slice of the SQLite handle the ledger uses (better-sqlite3). */
export interface LedgerStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface LedgerDb {
  prepare(sql: string): LedgerStatement;
  transaction<T>(fn: () => T): () => T;
}

/** A refusal the caller can fix: bad input, an unknown or closed fund, a voided entry. */
export class LedgerError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface Fund {
  id: string;
  name: string;
  description: string;
  restricted: boolean;
  active: boolean;
  openingBalance: number;
  openingDate: string;
  createdBy: string;
  createdAt: string;
}

export type Direction = 'in' | 'out';

export interface Transaction {
  id: string;
  direction: Direction;
  amount: number;
  currency: string;
  date: string;
  fundId: string;
  category: string;
  partyPersonId: string | null;
  partyName: string | null;
  paymentMethod: string | null;
  paymentMethodId: string | null;
  provider: string | null;
  confirmationNumber: string | null;
  sourceType: string;
  sourceId: string | null;
  status: 'posted' | 'voided';
  voidsId: string | null;
  voidedById: string | null;
  voidReason: string | null;
  transferId: string | null;
  memo: string;
  createdBy: string;
  createdAt: string;
}

export interface NewFund {
  name: string;
  description?: string;
  restricted?: boolean;
  openingBalance?: number;
  openingDate?: string;
}

export interface NewTransaction {
  direction: Direction;
  amount: number;
  date: string;
  fundId: string;
  category: string;
  partyPersonId?: string;
  partyName?: string;
  paymentMethod?: string;
  paymentMethodId?: string;
  memo?: string;
}

export interface FundBalance {
  fundId: string;
  name: string;
  active: boolean;
  restricted: boolean;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  balance: number;
}

export interface LedgerOptions {
  db: LedgerDb;
  recordAudit: RecordAudit;
  /** ISO 4217 code for every amount; the site's `ngdpbase.default.currency` once ngdpbase has it, else USD. */
  currency: string;
  now?: () => Date;
  newId?: () => string;
  /**
   * Does this viewer hold `permission`? For the choices a form offers
   * (toFormOptions), where there is a viewer but no request; index.ts asks
   * ngdpbase's PolicyDecisionPoint. Without it no choices are offered.
   */
  viewerMay?: (viewer: unknown, permission: string) => Promise<boolean>;
  /** Income and expense categories: UCOA account code to label (D-023), from site configuration. */
  categories?: () => Record<string, string>;
}

/** A choice in a form dropdown (ngdpbase BaseManager.toFormOptions). */
export interface FormChoice { value: string; label: string }

/**
 * The payment means a treasurer records by hand, as UN/CEFACT UNCL 4461 codes
 * (D-018). Card and online payments arrive through providers, not this list.
 */
export const MANUAL_PAYMENT_MEANS: readonly FormChoice[] = [
  { value: '10', label: 'Cash' },
  { value: '20', label: 'Check' },
  { value: '30', label: 'Bank transfer' },
  { value: '48', label: 'Card' }
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** UN/CEFACT payment means code (UNCL 4461): digits, or ZZZ for "mutually defined". */
const PAYMENT_MEANS = /^(\d{1,3}|ZZZ)$/;
const CURRENCY = /^[A-Z]{3}$/;

interface FundRow {
  id: string; name: string; description: string; restricted: number; active: number;
  opening_balance: number; opening_date: string; created_by: string; created_at: string;
}
interface TransactionRow {
  id: string; direction: Direction; amount: number; currency: string; date: string; fund_id: string;
  category: string; party_person_id: string | null; party_name: string | null; payment_method: string | null;
  payment_method_id: string | null; provider: string | null; confirmation_number: string | null;
  source_type: string; source_id: string | null; status: 'posted' | 'voided'; voids_id: string | null;
  voided_by_id: string | null; void_reason: string | null; transfer_id: string | null; memo: string;
  created_by: string; created_at: string;
}

const toFund = (r: FundRow): Fund => ({
  id: r.id, name: r.name, description: r.description, restricted: r.restricted === 1, active: r.active === 1,
  openingBalance: r.opening_balance, openingDate: r.opening_date, createdBy: r.created_by, createdAt: r.created_at
});

const toTransaction = (r: TransactionRow): Transaction => ({
  id: r.id, direction: r.direction, amount: r.amount, currency: r.currency, date: r.date, fundId: r.fund_id,
  category: r.category, partyPersonId: r.party_person_id, partyName: r.party_name, paymentMethod: r.payment_method,
  paymentMethodId: r.payment_method_id, provider: r.provider, confirmationNumber: r.confirmation_number,
  sourceType: r.source_type, sourceId: r.source_id, status: r.status, voidsId: r.voids_id,
  voidedById: r.voided_by_id, voidReason: r.void_reason, transferId: r.transfer_id, memo: r.memo,
  createdBy: r.created_by, createdAt: r.created_at
});

function text(value: unknown, field: string, { required = false, max = 500 } = {}): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LedgerError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new LedgerError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw new LedgerError(400, `${field} is required`);
  if (trimmed.length > max) throw new LedgerError(400, `${field} is longer than ${max} characters`);
  return trimmed === '' ? undefined : trimmed;
}

function minorUnits(value: unknown, field: string, { positive }: { positive: boolean }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (positive ? value <= 0 : false)) {
    throw new LedgerError(400, `${field} must be a whole number of cents${positive ? ', more than 0' : ''}`);
  }
  return value;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new LedgerError(400, `${field} must be a date as YYYY-MM-DD`);
  }
  return value;
}

export default class LedgerManager {
  private readonly db: LedgerDb;
  private readonly recordAudit: RecordAudit;
  private readonly currency: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly viewerMay: (viewer: unknown, permission: string) => Promise<boolean>;
  private readonly categories: () => Record<string, string>;

  constructor(options: LedgerOptions) {
    if (!CURRENCY.test(options.currency)) throw new Error(`accounting: currency '${options.currency}' is not an ISO 4217 code`);
    this.db = options.db;
    this.recordAudit = options.recordAudit;
    this.currency = options.currency;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.viewerMay = options.viewerMay ?? (async () => false);
    this.categories = options.categories ?? (() => ({}));
  }

  // ── Viewers ────────────────────────────────────────────────────────────

  /** The site currency every amount is kept in (ISO 4217). */
  currencyCode(): string {
    return this.currency;
  }

  /**
   * The caller for a page render, where there is a viewer but no request
   * (a plugin). Each ledger method still asks its own permission of it, so a
   * plugin reads only what the viewer may read. It never satisfies a step-up:
   * use it for reading, never for posting.
   */
  viewerActor(viewer: unknown): LedgerActor {
    const username = (viewer as { username?: unknown } | null | undefined)?.username;
    return {
      ipAddress: undefined,
      actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
      requirePermission: async (permission: string) => {
        if (!(await this.viewerMay(viewer, permission))) throw new ApiError(403, `not permitted: ${permission}`);
      }
    };
  }

  // ── Form choices ───────────────────────────────────────────────────────

  /**
   * Choices for a form dropdown, from page content:
   * `"optionsSource": "fetch:LedgerManager.toFormOptions(list=funds)"`.
   * Lists: `funds` (open funds), `categories`, `payment-methods`. A viewer
   * who may not record an entry is offered nothing. No side effects: this
   * runs on every render.
   */
  async toFormOptions(options: Record<string, string> = {}, viewer?: unknown): Promise<FormChoice[]> {
    if (!(await this.viewerMay(viewer, 'ledger-record'))) return [];
    switch (options.list) {
      case 'funds':
        return (this.db.prepare('SELECT * FROM accounting_funds WHERE active = 1 ORDER BY name').all() as FundRow[])
          .map(r => ({ value: r.id, label: r.name }));
      case 'categories':
        return Object.entries(this.categories())
          .filter(([code, label]) => code !== '' && typeof label === 'string')
          .map(([code, label]) => ({ value: code, label: `${code} ${label}` }));
      case 'payment-methods':
        return [...MANUAL_PAYMENT_MEANS];
      default:
        return [];
    }
  }

  // ── Funds ──────────────────────────────────────────────────────────────

  async createFund(actor: LedgerActor, input: NewFund): Promise<Fund> {
    await actor.requirePermission('fund-manage');
    const user = actor.actingUsername();
    const name = text(input.name, 'name', { required: true, max: 120 }) as string;
    const description = text(input.description, 'description') ?? '';
    const openingBalance = input.openingBalance === undefined ? 0 : minorUnits(input.openingBalance, 'openingBalance', { positive: false });
    const openingDate = input.openingDate === undefined ? this.today() : isoDate(input.openingDate, 'openingDate');
    if (this.db.prepare('SELECT id FROM accounting_funds WHERE name = ?').get(name)) {
      throw new LedgerError(409, `a fund named '${name}' already exists`);
    }
    const fund: Fund = {
      id: this.newId(), name, description, restricted: input.restricted === true, active: true,
      openingBalance, openingDate, createdBy: user, createdAt: this.stamp()
    };

    await this.recordAudit({
      eventType: addonAuditEventName('fund-manage'), user, ipAddress: actor.ipAddress, action: 'fund-create',
      severity: 'medium', resource: fund.id, resourceType: 'accounting-fund',
      metadata: { name, openingBalance, openingDate, restricted: fund.restricted }
    });
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO accounting_funds (id, name, description, restricted, active, opening_balance, opening_date, created_by, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(fund.id, name, description, fund.restricted ? 1 : 0, openingBalance, openingDate, user, fund.createdAt);
      this.history(user, 'fund-create', 'fund', fund.id, null, fund);
    })();
    return fund;
  }

  /** Change a fund's name, description or restricted flag. Its opening balance never changes. */
  async updateFund(actor: LedgerActor, fundId: string, changes: { name?: string; description?: string; restricted?: boolean }): Promise<Fund> {
    await actor.requirePermission('fund-manage');
    const user = actor.actingUsername();
    const before = this.fund(fundId);
    const name = changes.name === undefined ? before.name : text(changes.name, 'name', { required: true, max: 120 }) as string;
    const description = changes.description === undefined ? before.description : (text(changes.description, 'description') ?? '');
    const restricted = changes.restricted === undefined ? before.restricted : changes.restricted === true;
    if (name !== before.name && this.db.prepare('SELECT id FROM accounting_funds WHERE name = ?').get(name)) {
      throw new LedgerError(409, `a fund named '${name}' already exists`);
    }
    const after: Fund = { ...before, name, description, restricted };

    await this.recordAudit({
      eventType: addonAuditEventName('fund-manage'), user, ipAddress: actor.ipAddress, action: 'fund-update',
      severity: 'medium', resource: fundId, resourceType: 'accounting-fund',
      metadata: { fields: Object.keys(changes) }
    });
    this.db.transaction(() => {
      this.db.prepare('UPDATE accounting_funds SET name = ?, description = ?, restricted = ? WHERE id = ?')
        .run(name, description, restricted ? 1 : 0, fundId);
      this.history(user, 'fund-update', 'fund', fundId, before, after);
    })();
    return after;
  }

  /** Close a fund: no new entries; its history and balance stay. */
  async closeFund(actor: LedgerActor, fundId: string, reason?: string): Promise<Fund> {
    await actor.requirePermission('fund-manage');
    const user = actor.actingUsername();
    const before = this.fund(fundId);
    if (!before.active) throw new LedgerError(409, `fund '${before.name}' is already closed`);
    const why = text(reason, 'reason');

    await this.recordAudit({
      eventType: addonAuditEventName('fund-manage'), user, ipAddress: actor.ipAddress, action: 'fund-close',
      severity: 'medium', resource: fundId, resourceType: 'accounting-fund', reason: why, metadata: { name: before.name }
    });
    this.db.transaction(() => {
      this.db.prepare('UPDATE accounting_funds SET active = 0 WHERE id = ?').run(fundId);
      this.history(user, 'fund-close', 'fund', fundId, before, { ...before, active: false }, why);
    })();
    return { ...before, active: false };
  }

  async listFunds(actor: LedgerActor): Promise<Fund[]> {
    await actor.requirePermission('ledger-summary-read');
    return (this.db.prepare('SELECT * FROM accounting_funds ORDER BY name').all() as FundRow[]).map(toFund);
  }

  // ── Entries ────────────────────────────────────────────────────────────

  async postTransaction(actor: LedgerActor, input: NewTransaction): Promise<Transaction> {
    await actor.requirePermission('ledger-record');
    const user = actor.actingUsername();
    const entry = this.newEntry(user, input, { sourceType: 'manual' });

    await this.recordAudit({
      eventType: addonAuditEventName('ledger-record'), user, ipAddress: actor.ipAddress, action: 'ledger-post',
      severity: 'medium', resource: entry.id, resourceType: 'accounting-transaction',
      metadata: { direction: entry.direction, amount: entry.amount, currency: entry.currency, fundId: entry.fundId, date: entry.date, category: entry.category }
    });
    this.db.transaction(() => {
      this.insert(entry);
      this.history(user, 'ledger-post', 'transaction', entry.id, null, entry);
    })();
    return entry;
  }

  /**
   * Void a posted entry, with a reason, and optionally post its replacement in
   * the same step. A transfer is voided as a pair and has no replacement — post
   * a new transfer instead.
   */
  async voidTransaction(actor: LedgerActor, transactionId: string, reason: string, replacement?: NewTransaction): Promise<{ voided: Transaction[]; replacement: Transaction | null }> {
    await actor.requirePermission('ledger-adjust');
    const user = actor.actingUsername();
    const why = text(reason, 'reason', { required: true }) as string;
    const original = this.transaction(transactionId);
    if (original.status === 'voided') throw new LedgerError(409, 'this entry is already voided');
    const targets = original.transferId
      ? (this.db.prepare('SELECT * FROM accounting_transactions WHERE transfer_id = ?').all(original.transferId) as TransactionRow[]).map(toTransaction)
      : [original];
    if (original.transferId && replacement) {
      throw new LedgerError(400, 'a transfer is voided as a pair without a replacement; post a new transfer instead');
    }
    const next = replacement ? this.newEntry(user, replacement, { sourceType: 'adjustment', voidsId: original.id }) : null;

    await this.recordAudit({
      eventType: addonAuditEventName('ledger-adjust'), user, ipAddress: actor.ipAddress, action: 'ledger-void',
      severity: 'high', resource: original.id, resourceType: 'accounting-transaction', reason: why,
      metadata: { voided: targets.map(t => t.id), replacement: next ? { id: next.id, amount: next.amount, direction: next.direction, fundId: next.fundId } : null }
    });
    this.db.transaction(() => {
      if (next) this.insert(next);
      for (const t of targets) {
        this.db.prepare("UPDATE accounting_transactions SET status = 'voided', void_reason = ?, voided_by_id = ? WHERE id = ?")
          .run(why, t.id === original.id && next ? next.id : null, t.id);
        this.history(user, 'ledger-void', 'transaction', t.id, t, { ...t, status: 'voided', voidReason: why, voidedById: t.id === original.id && next ? next.id : null }, why);
      }
      if (next) this.history(user, 'ledger-post', 'transaction', next.id, null, next, why);
    })();
    return {
      voided: targets.map(t => this.transaction(t.id)),
      replacement: next
    };
  }

  /** Move money between two funds: an `out` and an `in` sharing one transfer id; the total is unchanged. */
  async transferBetweenFunds(actor: LedgerActor, input: { fromFundId: string; toFundId: string; amount: number; date: string; memo?: string }): Promise<Transaction[]> {
    await actor.requirePermission('ledger-adjust');
    const user = actor.actingUsername();
    if (input.fromFundId === input.toFundId) throw new LedgerError(400, 'a transfer needs two different funds');
    const transferId = this.newId();
    const common = { amount: input.amount, date: input.date, category: 'transfer', memo: input.memo };
    const out = this.newEntry(user, { ...common, direction: 'out', fundId: input.fromFundId }, { sourceType: 'transfer', transferId });
    const into = this.newEntry(user, { ...common, direction: 'in', fundId: input.toFundId }, { sourceType: 'transfer', transferId });

    await this.recordAudit({
      eventType: addonAuditEventName('ledger-adjust'), user, ipAddress: actor.ipAddress, action: 'ledger-transfer',
      severity: 'high', resource: transferId, resourceType: 'accounting-transfer',
      metadata: { fromFundId: out.fundId, toFundId: into.fundId, amount: out.amount, currency: out.currency, date: out.date }
    });
    this.db.transaction(() => {
      this.insert(out);
      this.insert(into);
      this.history(user, 'ledger-transfer', 'transfer', transferId, null, { out, into });
    })();
    return [out, into];
  }

  async listTransactions(actor: LedgerActor, filter: { fundId?: string; from?: string; to?: string; includeVoided?: boolean } = {}): Promise<Transaction[]> {
    await actor.requirePermission('ledger-read');
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.fundId) { where.push('fund_id = ?'); params.push(filter.fundId); }
    if (filter.from) { where.push('date >= ?'); params.push(isoDate(filter.from, 'from')); }
    if (filter.to) { where.push('date <= ?'); params.push(isoDate(filter.to, 'to')); }
    if (!filter.includeVoided) where.push("status = 'posted'");
    const sql = `SELECT * FROM accounting_transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY date, created_at`;
    return (this.db.prepare(sql).all(...params) as TransactionRow[]).map(toTransaction);
  }

  async getTransaction(actor: LedgerActor, transactionId: string): Promise<Transaction> {
    await actor.requirePermission('ledger-read');
    return this.transaction(transactionId);
  }

  /** Each fund's opening balance plus posted money in, minus posted money out. Voided entries do not count. */
  async fundBalances(actor: LedgerActor): Promise<FundBalance[]> {
    await actor.requirePermission('ledger-summary-read');
    const rows = this.db.prepare(`
      SELECT f.id, f.name, f.active, f.restricted, f.opening_balance,
        COALESCE(SUM(CASE WHEN t.direction = 'in'  THEN t.amount END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN t.direction = 'out' THEN t.amount END), 0) AS total_out
      FROM accounting_funds f
      LEFT JOIN accounting_transactions t ON t.fund_id = f.id AND t.status = 'posted'
      GROUP BY f.id ORDER BY f.name`).all() as { id: string; name: string; active: number; restricted: number; opening_balance: number; total_in: number; total_out: number }[];
    return rows.map(r => ({
      fundId: r.id, name: r.name, active: r.active === 1, restricted: r.restricted === 1, openingBalance: r.opening_balance,
      totalIn: r.total_in, totalOut: r.total_out, balance: r.opening_balance + r.total_in - r.total_out
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private newEntry(user: string, input: NewTransaction, link: { sourceType: string; voidsId?: string; transferId?: string }): Transaction {
    if (input.direction !== 'in' && input.direction !== 'out') throw new LedgerError(400, "direction must be 'in' or 'out'");
    const fund = this.fund(text(input.fundId, 'fundId', { required: true }) as string);
    if (!fund.active) throw new LedgerError(409, `fund '${fund.name}' is closed`);
    const paymentMethod = text(input.paymentMethod, 'paymentMethod', { max: 16 });
    if (paymentMethod !== undefined && !PAYMENT_MEANS.test(paymentMethod)) {
      throw new LedgerError(400, 'paymentMethod must be a UN/CEFACT payment means code, e.g. 10 (cash) or 20 (cheque)');
    }
    return {
      id: this.newId(),
      direction: input.direction,
      amount: minorUnits(input.amount, 'amount', { positive: true }),
      currency: this.currency,
      date: isoDate(input.date, 'date'),
      fundId: fund.id,
      category: text(input.category, 'category', { required: true, max: 32 }) as string,
      partyPersonId: text(input.partyPersonId, 'partyPersonId', { max: 64 }) ?? null,
      partyName: text(input.partyName, 'partyName', { max: 200 }) ?? null,
      paymentMethod: paymentMethod ?? null,
      paymentMethodId: text(input.paymentMethodId, 'paymentMethodId', { max: 64 }) ?? null,
      provider: null,
      confirmationNumber: null,
      sourceType: link.sourceType,
      sourceId: null,
      status: 'posted',
      voidsId: link.voidsId ?? null,
      voidedById: null,
      voidReason: null,
      transferId: link.transferId ?? null,
      memo: text(input.memo, 'memo', { max: 2000 }) ?? '',
      createdBy: user,
      createdAt: this.stamp()
    };
  }

  private insert(t: Transaction): void {
    this.db.prepare(`INSERT INTO accounting_transactions (id, direction, amount, currency, date, fund_id, category,
        party_person_id, party_name, payment_method, payment_method_id, provider, confirmation_number,
        source_type, source_id, status, voids_id, voided_by_id, void_reason, transfer_id, memo, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id, t.direction, t.amount, t.currency, t.date, t.fundId, t.category, t.partyPersonId, t.partyName,
      t.paymentMethod, t.paymentMethodId, t.provider, t.confirmationNumber, t.sourceType, t.sourceId, t.status,
      t.voidsId, t.voidedById, t.voidReason, t.transferId, t.memo, t.createdBy, t.createdAt);
  }

  private history(actor: string, action: string, entity: string, entityId: string, before: unknown, after: unknown, reason?: string): void {
    this.db.prepare('INSERT INTO accounting_history (at, actor, action, entity, entity_id, before, after, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.stamp(), actor, action, entity, entityId, before === null ? null : JSON.stringify(before), JSON.stringify(after), reason ?? null);
  }

  private fund(fundId: string): Fund {
    const row = this.db.prepare('SELECT * FROM accounting_funds WHERE id = ?').get(fundId) as FundRow | undefined;
    if (!row) throw new LedgerError(404, 'unknown fund');
    return toFund(row);
  }

  private transaction(transactionId: string): Transaction {
    const row = this.db.prepare('SELECT * FROM accounting_transactions WHERE id = ?').get(transactionId) as TransactionRow | undefined;
    if (!row) throw new LedgerError(404, 'unknown entry');
    return toTransaction(row);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private today(): string {
    return this.stamp().slice(0, 10);
  }
}
