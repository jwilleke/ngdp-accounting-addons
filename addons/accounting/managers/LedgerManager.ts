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
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import { createHash } from 'node:crypto';

/**
 * The core values the ledger uses, from the `host` ngdpbase hands register()
 * (#1813): never imported from core's files.
 */
export type LedgerHost = Pick<AddonHost, 'ApiError' | 'actorOf' | 'addonAuditEventName'>;

/** The caller: ngdpbase's ApiContext satisfies this. */
export interface LedgerActor {
  /**
   * Turn the decision point's "no" into the refusal (ngdpbase ApiContext.enforceDeny,
   * v5.11.0): 401 or 403, and for a step-up the way to sign in again, audited. Always throws.
   */
  enforceDeny(permission: string, decision: Decision): Promise<never>;
  actingUsername(): string;
  readonly ipAddress: string | undefined;
  /**
   * The request's subject (ngdpbase ApiContext.subject). An audit record's
   * "who" is built from it by ngdpbase's actorOf: under a proxy grant that is
   * the person represented in `user` and the person who acted in `actor`
   * (#1762). Null when there is no subject; the record then says so.
   */
  readonly subject: ActorContext | null;
}

/** What LedgerManager hands to the audit door; index.ts wraps ngdpbase's recordAuditEvent. */
export interface LedgerAuditRecord {
  eventType: ReturnType<AddonHost['addonAuditEventName']>;
  user: string;
  /** Who actually acted, when it is not `user` (a proxy grant, #1762). */
  actor?: string;
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

/**
 * Where money sits (D-031): a bank account from the site's configuration, or
 * Cash on Hand, which is built in. A fund says what money is for; an account
 * says where it is. One account holds money for several funds.
 */
export interface Account {
  id: string;
  name: string;
  kind: 'bank' | 'cash';
  /** The bank account ACH, Zelle and bank transfers land in, and money out comes from. */
  isDefault: boolean;
  active: boolean;
  /** False for an account entries still name but the configuration no longer has. */
  configured: boolean;
}

export interface AccountBalance {
  accountId: string;
  name: string;
  kind: Account['kind'];
  active: boolean;
  configured: boolean;
  openingBalance: number;
  /** Null until the treasurer sets it. */
  openingDate: string | null;
  totalIn: number;
  totalOut: number;
  balance: number;
}

/** One account over a period, like FundPeriod. */
export interface AccountPeriod {
  accountId: string; name: string; configured: boolean;
  start: number; opened: number; moneyIn: number; moneyOut: number; end: number;
}

export interface Transaction {
  id: string;
  direction: Direction;
  amount: number;
  currency: string;
  date: string;
  fundId: string;
  accountId: string;
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
  /** Where the money comes from or goes to; blank picks it by method (D-031). */
  accountId?: string;
  category: string;
  partyPersonId?: string;
  partyName?: string;
  paymentMethod?: string;
  paymentMethodId?: string;
  memo?: string;
}

/**
 * Money received, recorded by hand (D-029). The payer, the method and the
 * reason are required; a check's number goes in `paymentMethodId`. The receipt
 * number is the ledger's, never the caller's.
 */
export interface NewReceipt {
  amount: number;
  date: string;
  fundId: string;
  /** Blank picks it by method: cash and checks to Cash on Hand, bank methods to the default bank account. */
  accountId?: string;
  category: string;
  partyName: string;
  partyPersonId?: string;
  paymentMethod: string;
  paymentMethodId?: string;
  memo: string;
  /** What the money is for, once dues, donations and events exist: e.g. { type: 'dues-invoice', id }. */
  reference?: { type: string; id: string };
}

/** A refund of a receipt: money returned to the payer. The amount defaults to what is left to refund. */
export interface ReceiptRefund {
  amount?: number;
  date: string;
  memo: string;
  paymentMethod?: string;
  paymentMethodId?: string;
  /** The account the money is paid back from; blank picks it by method. */
  accountId?: string;
}

/** The provider that recorded a receipt, and its own number for it (D-004). */
export interface ReceiptSource {
  provider: string;
  /** The provider's number; absent for the manual provider, whose number the ledger assigns. */
  confirmationNumber?: string;
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

/** A reporting period, both ends included, as YYYY-MM-DD. */
export interface Period { from: string; to: string }

/** One fund over a period. end = start + opened + moneyIn - moneyOut. */
export interface FundPeriod {
  fundId: string; name: string; active: boolean;
  /** Balance at the start of the period: the opening balance if the fund opened before it, plus earlier entries. */
  start: number;
  /** An opening balance dated inside the period. */
  opened: number;
  moneyIn: number; moneyOut: number; end: number;
}

/** Income and expense of one category over a period; transfers are left out, they net to zero. */
export interface CategoryPeriod { category: string; label: string; income: number; expense: number }

export interface PeriodSummary {
  period: Period;
  currency: string;
  funds: FundPeriod[];
  /** The same money by where it sits; its ends add up to the funds' ends. */
  accounts: AccountPeriod[];
  categories: CategoryPeriod[];
  totals: { start: number; opened: number; moneyIn: number; moneyOut: number; end: number; income: number; expense: number };
}

/** A CSV export, with what the audit record keeps about it. */
export interface LedgerExport {
  kind: 'transactions' | 'funds';
  period: Period;
  filename: string;
  body: string;
  rows: number;
  sha256: string;
}

export interface LedgerOptions {
  /** ngdpbase's host for this add-on: the refusal type, actorOf and the audit event names. */
  host: LedgerHost;
  db: LedgerDb;
  recordAudit: RecordAudit;
  /** ISO 4217 code for every amount; the site's `ngdpbase.default.currency` once ngdpbase has it, else USD. */
  currency: string;
  now?: () => Date;
  newId?: () => string;
  /**
   * ngdpbase's PolicyDecisionPoint.decide: the ledger is the enforcement point
   * and asks it for every action (D-025). Without it every action is refused.
   */
  decide?: (subject: ActorContext | null, request: { action: string }) => Promise<Decision>;
  /** Income and expense categories: UCOA account code to label (D-023), from site configuration. */
  categories?: () => Record<string, string>;
  /** Bank accounts: `ngdpbase.addons.accounting.accounts` from site configuration (D-031), read by accountsFrom. */
  accounts?: () => unknown;
  /** ngdpbase's money formatter (PluginManager.formatters.formatMoney, #1820), for form choice labels. */
  formatMoney: (minor: number, currency: string) => string;
  /** ngdpbase's one CSV writer (ExportManager.toCsv, #1819), for the export. */
  toCsv: (headers: readonly string[], rows: readonly (readonly unknown[])[]) => string;
  /**
   * Told after every committed write. index.ts bumps the `LedgerManager`
   * topic in ngdpbase's CacheManager, so cached pages that read the ledger
   * (balances, a form's fund choices) re-render on their next view
   * (ngdpbase docs/guides/caching-developer-guide.md: the owner bumps).
   */
  dataChanged?: () => Promise<void> | void;
}

/** A choice in a form dropdown (ngdpbase BaseManager.toFormOptions). */
export interface FormChoice { value: string; label: string }

/**
 * The methods a treasurer records by hand, as UN/CEFACT UNCL 4461 codes (D-018).
 * docs/receipt-methods.md is the source of truth: this list is its rows marked
 * "Implemented: yes", in its order, and a test fails if they differ.
 */
/** How many of the latest entries the void form offers. */
const ENTRY_CHOICES = 100;

/** "2026-10-10 · General · in $1,250.50 · Pat Member" — enough to pick the right entry. */
function entryLabel(t: Transaction, fundName: string, formatMoney: LedgerOptions['formatMoney']): string {
  const who = t.partyName || t.memo || t.category;
  const kind = t.transferId ? 'transfer ' : '';
  return [t.confirmationNumber, t.date, fundName, `${kind}${t.direction} ${formatMoney(t.amount, t.currency)}`, who].filter(Boolean).join(' · ');
}

export const MANUAL_PAYMENT_MEANS: readonly FormChoice[] = [
  { value: '10', label: 'Cash' },
  { value: '20', label: 'Check' },
  { value: '2', label: 'ACH' },
  { value: '68', label: 'Zelle' },
  { value: '30', label: 'Bank transfer' },
  { value: '48', label: 'Card' }
];

/** The provider that is always there: receipts the treasurer records by hand (D-004). */
export const MANUAL_PROVIDER = 'manual';

/** The built-in account for money in hand: cash, and checks not yet deposited (D-031). */
export const CASH_ON_HAND = 'cash-on-hand';
const CASH_ON_HAND_ACCOUNT: Account = Object.freeze({ id: CASH_ON_HAND, name: 'Cash on Hand', kind: 'cash', isDefault: false, active: true, configured: true });

/**
 * Methods whose money is handed over, so it lands in Cash on Hand until it is
 * deposited; every other method lands in the default bank account (D-031).
 * docs/receipt-methods.md, column "Starting account", is the source of truth;
 * a test fails if they differ.
 */
export const CASH_ON_HAND_METHODS: readonly string[] = ['10', '20', '48'];

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The accounts from `ngdpbase.addons.accounting.accounts`, a map keyed by
 * account id (so each configuration layer adds or changes one account), with
 * Cash on Hand first. Each entry is `{ "name": "Checking", "kind": "bank",
 * "default": true, "active": true }`; `false` or `null` removes a shipped one.
 * Exactly one active bank account is the default: the one marked, else the
 * first. Anything it cannot use is skipped, with a warning.
 */
export function accountsFrom(entries: unknown, warn: (message: string) => void = () => undefined): Account[] {
  const accounts: Account[] = [CASH_ON_HAND_ACCOUNT];
  const map = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries as Record<string, unknown> : {};
  for (const [id, value] of Object.entries(map)) {
    if (value === null || value === false) continue;
    if (id === CASH_ON_HAND) { warn(`[accounting] account '${id}' is built in; its configuration entry is ignored`); continue; }
    if (!ACCOUNT_ID.test(id) || typeof value !== 'object' || Array.isArray(value)) {
      warn(`[accounting] account '${id}' is not usable: the id must be lowercase letters, digits and dashes, and the entry an object; skipped`);
      continue;
    }
    const entry = value as { name?: unknown; kind?: unknown; default?: unknown; active?: unknown };
    if (entry.kind !== undefined && entry.kind !== 'bank') { warn(`[accounting] account '${id}': kind must be 'bank'; skipped`); continue; }
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id;
    accounts.push({ id, name, kind: 'bank', isDefault: entry.default === true, active: entry.active !== false, configured: true });
  }
  const banks = accounts.filter(a => a.kind === 'bank' && a.active);
  const marked = banks.filter(a => a.isDefault);
  if (marked.length > 1) warn(`[accounting] several accounts are marked default; '${marked[0].id}' is used`);
  if (banks.length === 0) warn('[accounting] no bank account is configured: everything lands in Cash on Hand');
  const chosen = marked[0] ?? banks[0];
  return accounts.map(a => ({ ...a, isDefault: a === chosen }));
}
const RECEIPT_REFUND = 'receipt-refund';
const MONEY_IN_IS_A_RECEIPT = 'money in is recorded as a receipt (Record a Receipt), not as an entry';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** UN/CEFACT payment means code (UNCL 4461): digits, or ZZZ for "mutually defined". */
const PAYMENT_MEANS = /^(\d{1,3}|ZZZ)$/;
const CURRENCY = /^[A-Z]{3}$/;

interface FundRow {
  id: string; name: string; description: string; restricted: number; active: number;
  opening_balance: number; opening_date: string; created_by: string; created_at: string;
}
interface TransactionRow {
  id: string; direction: Direction; amount: number; currency: string; date: string; fund_id: string; account_id: string;
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
  id: r.id, direction: r.direction, amount: r.amount, currency: r.currency, date: r.date, fundId: r.fund_id, accountId: r.account_id,
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

/** Whole minor units as a plain decimal for a spreadsheet: 125050 USD → "1250.50". */
function decimalAmount(minor: number, currency: string): string {
  let digits = 2;
  try { digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* two */ }
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (digits === 0) return `${sign}${abs}`;
  const unit = 10 ** digits;
  return `${sign}${Math.trunc(abs / unit)}.${String(abs % unit).padStart(digits, '0')}`;
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
  private readonly host: LedgerHost;
  private readonly db: LedgerDb;
  private readonly recordAudit: RecordAudit;
  private readonly currency: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly decide: (subject: ActorContext | null, request: { action: string }) => Promise<Decision>;
  private readonly categories: () => Record<string, string>;
  private readonly accountsConfig: () => unknown;
  private readonly formatMoney: LedgerOptions['formatMoney'];
  private readonly toCsv: LedgerOptions['toCsv'];
  private readonly dataChanged: () => Promise<void> | void;

  constructor(options: LedgerOptions) {
    if (!CURRENCY.test(options.currency)) throw new Error(`accounting: currency '${options.currency}' is not an ISO 4217 code`);
    this.host = options.host;
    this.db = options.db;
    this.recordAudit = options.recordAudit;
    this.currency = options.currency;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.decide = options.decide ?? (async () => ({ permit: false, applicable: false, reason: 'no_decision_point' }));
    this.categories = options.categories ?? (() => ({}));
    this.accountsConfig = options.accounts ?? (() => ({}));
    this.formatMoney = options.formatMoney;
    this.toCsv = options.toCsv;
    this.dataChanged = options.dataChanged ?? (() => undefined);
  }

  /**
   * Every write's one way in: one synchronous transaction, then say the
   * ledger changed. Saying so cannot undo a committed write: a failure there
   * only means a cached page may show the old figures until its next change.
   */
  private async commit(work: () => void): Promise<void> {
    this.db.transaction(work)();
    try {
      await this.dataChanged();
    } catch {
      // The write stands; see above.
    }
  }

  // ── Reports ────────────────────────────────────────────────────────────

  /**
   * A reporting period from what a page or a request names: `month` as
   * `current`, `previous` or `YYYY-MM`, or explicit `from` and `to`
   * (YYYY-MM-DD, both included). Defaults to the current month.
   */
  period(spec: { month?: string; from?: string; to?: string } = {}): Period {
    if (spec.from !== undefined || spec.to !== undefined) {
      const from = isoDate(spec.from, 'from');
      const to = isoDate(spec.to, 'to');
      if (from > to) throw new LedgerError(400, 'from must not be after to');
      return { from, to };
    }
    const today = this.today();
    let year = Number(today.slice(0, 4));
    let month = Number(today.slice(5, 7));
    const named = spec.month ?? 'current';
    if (named === 'previous') {
      month -= 1;
      if (month === 0) { month = 12; year -= 1; }
    } else if (named !== 'current') {
      const m = /^(\d{4})-(\d{2})$/.exec(named);
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new LedgerError(400, "month must be current, previous or YYYY-MM");
      year = Number(m[1]); month = Number(m[2]);
    }
    const mm = String(month).padStart(2, '0');
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
  }

  /**
   * The board's monthly summary, or any period's: per fund the balance at the
   * start, money in and out, and the balance at the end; per category income
   * and expense (transfers left out); and the totals. Posted entries only, so
   * a voided entry is gone and its replacement counts. No names: needs only
   * ledger-summary-read.
   */
  async periodSummary(actor: LedgerActor, period: Period): Promise<PeriodSummary> {
    await this.authorize(actor, 'ledger-summary-read');
    const { from, to } = period;
    const funds = (this.db.prepare(`
      SELECT f.id, f.name, f.active, f.opening_balance, f.opening_date,
        COALESCE(SUM(CASE WHEN t.date < ? AND t.direction = 'in'  THEN t.amount END), 0) AS before_in,
        COALESCE(SUM(CASE WHEN t.date < ? AND t.direction = 'out' THEN t.amount END), 0) AS before_out,
        COALESCE(SUM(CASE WHEN t.date >= ? AND t.date <= ? AND t.direction = 'in'  THEN t.amount END), 0) AS period_in,
        COALESCE(SUM(CASE WHEN t.date >= ? AND t.date <= ? AND t.direction = 'out' THEN t.amount END), 0) AS period_out
      FROM accounting_funds f
      LEFT JOIN accounting_transactions t ON t.fund_id = f.id AND t.status = 'posted'
      WHERE f.opening_date <= ?
      GROUP BY f.id ORDER BY f.name`).all(from, from, from, to, from, to, to) as {
        id: string; name: string; active: number; opening_balance: number; opening_date: string;
        before_in: number; before_out: number; period_in: number; period_out: number;
      }[]).map((r): FundPeriod => {
        const openedBefore = r.opening_date < from;
        const start = (openedBefore ? r.opening_balance : 0) + r.before_in - r.before_out;
        const opened = openedBefore ? 0 : r.opening_balance;
        return {
          fundId: r.id, name: r.name, active: r.active === 1, start, opened,
          moneyIn: r.period_in, moneyOut: r.period_out, end: start + opened + r.period_in - r.period_out
        };
      });

    const openings = this.openings();
    const moved = new Map((this.db.prepare(`
      SELECT account_id,
        COALESCE(SUM(CASE WHEN date < ? AND direction = 'in'  THEN amount END), 0) AS before_in,
        COALESCE(SUM(CASE WHEN date < ? AND direction = 'out' THEN amount END), 0) AS before_out,
        COALESCE(SUM(CASE WHEN date >= ? AND date <= ? AND direction = 'in'  THEN amount END), 0) AS period_in,
        COALESCE(SUM(CASE WHEN date >= ? AND date <= ? AND direction = 'out' THEN amount END), 0) AS period_out
      FROM accounting_transactions WHERE status = 'posted' AND date <= ?
      GROUP BY account_id`).all(from, from, from, to, from, to, to) as {
        account_id: string; before_in: number; before_out: number; period_in: number; period_out: number;
      }[]).map(r => [r.account_id, r]));
    const accounts = this.accountsInUse().map((a): AccountPeriod => {
      const o = openings.get(a.id);
      const m = moved.get(a.id) ?? { before_in: 0, before_out: 0, period_in: 0, period_out: 0 };
      const openingBalance = o && o.opening_date <= to ? o.opening_balance : 0;
      const openedBefore = o !== undefined && o.opening_date < from;
      const start = (openedBefore ? openingBalance : 0) + m.before_in - m.before_out;
      const opened = openedBefore ? 0 : openingBalance;
      return { accountId: a.id, name: a.name, configured: a.configured, start, opened, moneyIn: m.period_in, moneyOut: m.period_out, end: start + opened + m.period_in - m.period_out };
    });

    const labels = this.categories();
    const categories = (this.db.prepare(`
      SELECT category,
        COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END), 0) AS expense
      FROM accounting_transactions
      WHERE status = 'posted' AND transfer_id IS NULL AND date >= ? AND date <= ?
      GROUP BY category ORDER BY category`).all(from, to) as { category: string; income: number; expense: number }[])
      .map(r => ({ category: r.category, label: typeof labels[r.category] === 'string' ? labels[r.category] : '', income: r.income, expense: r.expense }));

    const sum = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((total, r) => total + pick(r), 0);
    return {
      period: { from, to },
      currency: this.currency,
      funds,
      accounts,
      categories,
      totals: {
        start: sum(funds, f => f.start), opened: sum(funds, f => f.opened),
        moneyIn: sum(funds, f => f.moneyIn), moneyOut: sum(funds, f => f.moneyOut), end: sum(funds, f => f.end),
        income: sum(categories, c => c.income), expense: sum(categories, c => c.expense)
      }
    };
  }

  /**
   * The CSV for the books of record: `transactions` (every ledger field, every
   * entry dated in the period, voided ones included with their status) or
   * `funds` (the period summary per fund). Needs ledger-export, which asks for
   * a fresh sign-in; the audit record — who, the period, the row count and the
   * file's SHA-256 — is written before the file is handed over, and if it
   * cannot be written there is no file.
   */
  async exportCsv(actor: LedgerActor, kind: 'transactions' | 'funds', period: Period): Promise<LedgerExport> {
    await this.authorize(actor, 'ledger-export');
    if (kind !== 'transactions' && kind !== 'funds') throw new LedgerError(400, "kind must be 'transactions' or 'funds'");
    actor.actingUsername(); // a person must be signed in to take the file

    let headers: string[];
    let rows: unknown[][];
    if (kind === 'transactions') {
      headers = ['id', 'date', 'direction', 'amount_minor', 'amount', 'currency', 'fund_id', 'fund', 'account_id', 'account', 'category', 'party_person_id', 'party_name',
        'payment_method', 'payment_method_id', 'provider', 'confirmation_number', 'source_type', 'source_id', 'status', 'voids_id',
        'voided_by_id', 'void_reason', 'transfer_id', 'memo', 'created_by', 'created_at'];
      const names = new Map((this.db.prepare('SELECT id, name FROM accounting_funds').all() as { id: string; name: string }[]).map(f => [f.id, f.name]));
      const accountNames = new Map(this.accountsInUse().map(a => [a.id, a.name]));
      rows = (this.db.prepare('SELECT * FROM accounting_transactions WHERE date >= ? AND date <= ? ORDER BY date, created_at')
        .all(period.from, period.to) as TransactionRow[]).map(toTransaction).map(t => [
        t.id, t.date, t.direction, t.amount, decimalAmount(t.amount, t.currency), t.currency, t.fundId, names.get(t.fundId) ?? '', t.accountId, accountNames.get(t.accountId) ?? '', t.category,
        t.partyPersonId, t.partyName, t.paymentMethod, t.paymentMethodId, t.provider, t.confirmationNumber, t.sourceType, t.sourceId,
        t.status, t.voidsId, t.voidedById, t.voidReason, t.transferId, t.memo, t.createdBy, t.createdAt
      ]);
    } else {
      const summary = await this.periodSummary(actor, period);
      headers = ['fund_id', 'fund', 'active', 'currency', 'start_minor', 'opened_minor', 'in_minor', 'out_minor', 'end_minor', 'start', 'opened', 'in', 'out', 'end'];
      rows = summary.funds.map(f => [f.fundId, f.name, f.active, this.currency, f.start, f.opened, f.moneyIn, f.moneyOut, f.end,
        ...[f.start, f.opened, f.moneyIn, f.moneyOut, f.end].map(v => decimalAmount(v, this.currency))]);
    }

    const body = this.toCsv(headers, rows);
    const sha256 = createHash('sha256').update(body).digest('hex');
    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-export'), action: 'ledger-export',
      severity: 'high', resource: `${kind}:${period.from}..${period.to}`, resourceType: 'accounting-export',
      metadata: { kind, from: period.from, to: period.to, rows: rows.length, sha256 }
    });
    return { kind, period, filename: `ledger-${kind}-${period.from}-to-${period.to}.csv`, body, rows: rows.length, sha256 };
  }

  // ── Decisions ──────────────────────────────────────────────────────────

  /**
   * Every action's one check: ask the decision point, and hand a "no" to the
   * caller's enforceDeny, which throws ngdpbase's own refusal (D-025).
   */
  private async authorize(actor: LedgerActor, action: string): Promise<void> {
    const decision = await this.decide(actor.subject, { action });
    if (!decision.permit) await actor.enforceDeny(action, decision);
  }

  // ── Audit ──────────────────────────────────────────────────────────────

  /**
   * Every audit record's one way out. Its "who" comes from the caller's
   * context through ngdpbase's actorOf (audit-developer-guide, rule 6):
   * `user`, `actor` under a proxy grant, the address, and the delegation
   * metadata. Never copied from a username. With no subject the record says
   * so: user 'unknown', actorMissing.
   */
  private async audit(actor: LedgerActor, record: Omit<LedgerAuditRecord, 'user' | 'actor' | 'ipAddress'>): Promise<void> {
    const who = actor.subject
      ? this.host.actorOf(actor.subject)
      : { user: 'unknown', ipAddress: actor.ipAddress, metadata: { actorMissing: true } };
    const { metadata: whoMetadata, ...fields } = who as { user: string; actor?: string; ipAddress?: string; metadata: Record<string, unknown> };
    await this.recordAudit({ ...record, ...fields, ipAddress: fields.ipAddress, metadata: { ...whoMetadata, ...record.metadata } });
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
      subject: (viewer ?? null) as ActorContext | null,
      actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
      // A render has no request to answer, so a refusal is just a refusal: the plugin shows a note.
      enforceDeny: async (permission: string) => { throw new this.host.ApiError(403, `not permitted: ${permission}`); }
    };
  }

  // ── Form choices ───────────────────────────────────────────────────────

  /**
   * Choices for a form dropdown, from page content:
   * `"optionsSource": "fetch:LedgerManager.toFormOptions(list=funds)"`.
   * Each list asks the permission that would let the viewer see what it
   * shows, through the ledger's own reads where there is one:
   *   funds            open funds                   ledger-summary-read (listFunds)
   *   accounts         active accounts              ledger-summary-read (listAccounts)
   *   entries          latest posted entries        ledger-read (listTransactions)
   *   categories       site's UCOA categories       ledger-record
   *   payment-methods  manual UN/CEFACT codes       ledger-record
   * A refusal is no choices. No side effects: this runs on every render.
   */
  async toFormOptions(options: Record<string, string> = {}, viewer?: unknown): Promise<FormChoice[]> {
    const actor = this.viewerActor(viewer);
    try {
      switch (options.list) {
        case 'funds':
          return (await this.listFunds(actor)).filter(f => f.active).map(f => ({ value: f.id, label: f.name }));
        case 'accounts':
          return (await this.listAccounts(actor)).filter(a => a.configured && a.active).map(a => ({ value: a.id, label: a.name }));
        case 'entries': {
          const names = new Map((await this.listFunds(actor)).map(f => [f.id, f.name]));
          const latest = (await this.listTransactions(actor))
            .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
            .slice(0, ENTRY_CHOICES);
          return latest.map(t => ({ value: t.id, label: entryLabel(t, names.get(t.fundId) ?? t.fundId, this.formatMoney) }));
        }
        case 'receipts': {
          // Seeing the receipts is reading the ledger. The refund itself asks receipt-refund,
          // with its step-up, when the form is submitted; a page render cannot step up.
          await this.authorize(actor, 'ledger-read');
          const names = new Map((await this.listFunds(actor)).map(f => [f.id, f.name]));
          return this.receiptRows()
            .filter(t => this.refundable(t) > 0)
            .slice(0, ENTRY_CHOICES)
            .map(t => ({ value: t.id, label: entryLabel(t, names.get(t.fundId) ?? t.fundId, this.formatMoney) }));
        }
        case 'categories':
          await this.authorize(actor, 'ledger-record');
          return Object.entries(this.categories())
            .filter(([code, label]) => code !== '' && typeof label === 'string')
            .map(([code, label]) => ({ value: code, label: `${code} ${label}` }));
        case 'payment-methods':
          await this.authorize(actor, 'ledger-record');
          return [...MANUAL_PAYMENT_MEANS];
        default:
          return [];
      }
    } catch (err) {
      if (err instanceof this.host.ApiError) return [];
      throw err;
    }
  }

  // ── Funds ──────────────────────────────────────────────────────────────

  async createFund(actor: LedgerActor, input: NewFund): Promise<Fund> {
    await this.authorize(actor, 'fund-manage');
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

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'fund-create',
      severity: 'medium', resource: fund.id, resourceType: 'accounting-fund',
      metadata: { name, openingBalance, openingDate, restricted: fund.restricted }
    });
    await this.commit(() => {
      this.db.prepare(`INSERT INTO accounting_funds (id, name, description, restricted, active, opening_balance, opening_date, created_by, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(fund.id, name, description, fund.restricted ? 1 : 0, openingBalance, openingDate, user, fund.createdAt);
      this.history(user, 'fund-create', 'fund', fund.id, null, fund);
    });
    return fund;
  }

  /** Change a fund's name, description or restricted flag. Its opening balance never changes. */
  async updateFund(actor: LedgerActor, fundId: string, changes: { name?: string; description?: string; restricted?: boolean }): Promise<Fund> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    const before = this.fund(fundId);
    const name = changes.name === undefined ? before.name : text(changes.name, 'name', { required: true, max: 120 }) as string;
    const description = changes.description === undefined ? before.description : (text(changes.description, 'description') ?? '');
    const restricted = changes.restricted === undefined ? before.restricted : changes.restricted === true;
    if (name !== before.name && this.db.prepare('SELECT id FROM accounting_funds WHERE name = ?').get(name)) {
      throw new LedgerError(409, `a fund named '${name}' already exists`);
    }
    const after: Fund = { ...before, name, description, restricted };

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'fund-update',
      severity: 'medium', resource: fundId, resourceType: 'accounting-fund',
      metadata: { fields: Object.keys(changes) }
    });
    await this.commit(() => {
      this.db.prepare('UPDATE accounting_funds SET name = ?, description = ?, restricted = ? WHERE id = ?')
        .run(name, description, restricted ? 1 : 0, fundId);
      this.history(user, 'fund-update', 'fund', fundId, before, after);
    });
    return after;
  }

  /** Close a fund: no new entries; its history and balance stay. */
  async closeFund(actor: LedgerActor, fundId: string, reason?: string): Promise<Fund> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    const before = this.fund(fundId);
    if (!before.active) throw new LedgerError(409, `fund '${before.name}' is already closed`);
    const why = text(reason, 'reason');

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'fund-close',
      severity: 'medium', resource: fundId, resourceType: 'accounting-fund', reason: why, metadata: { name: before.name }
    });
    await this.commit(() => {
      this.db.prepare('UPDATE accounting_funds SET active = 0 WHERE id = ?').run(fundId);
      this.history(user, 'fund-close', 'fund', fundId, before, { ...before, active: false }, why);
    });
    return { ...before, active: false };
  }

  async listFunds(actor: LedgerActor): Promise<Fund[]> {
    await this.authorize(actor, 'ledger-summary-read');
    return (this.db.prepare('SELECT * FROM accounting_funds ORDER BY name').all() as FundRow[]).map(toFund);
  }

  // ── Accounts (D-031) ───────────────────────────────────────────────────

  /** Cash on Hand, the configured bank accounts, and any that entries name but the configuration has dropped. */
  async listAccounts(actor: LedgerActor): Promise<Account[]> {
    await this.authorize(actor, 'ledger-summary-read');
    return this.accountsInUse();
  }

  /**
   * Set what an account held on the day the books started. Once: like a fund's,
   * an account's opening balance and date never change.
   */
  async setAccountOpening(actor: LedgerActor, accountId: string, input: { openingBalance: number; openingDate?: string }): Promise<AccountBalance> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    const account = this.account(text(accountId, 'accountId', { required: true, max: 32 }) as string);
    if (!account.configured) throw new LedgerError(409, `account '${account.id}' is no longer configured`);
    const openingBalance = minorUnits(input.openingBalance, 'openingBalance', { positive: false });
    const openingDate = input.openingDate === undefined || input.openingDate === '' ? this.today() : isoDate(input.openingDate, 'openingDate');
    if (this.db.prepare('SELECT account_id FROM accounting_account_openings WHERE account_id = ?').get(account.id)) {
      throw new LedgerError(409, `account '${account.name}' already has its opening balance`);
    }
    const opening = { accountId: account.id, openingBalance, openingDate, createdBy: user, createdAt: this.stamp() };

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'account-opening',
      severity: 'medium', resource: account.id, resourceType: 'accounting-account',
      metadata: { name: account.name, openingBalance, openingDate }
    });
    await this.commit(() => {
      this.db.prepare(`INSERT INTO accounting_account_openings (account_id, opening_balance, opening_date, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(account.id, openingBalance, openingDate, user, opening.createdAt);
      this.history(user, 'account-opening', 'account', account.id, null, opening);
    });
    return (await this.accountBalances(actor)).find(b => b.accountId === account.id) as AccountBalance;
  }

  /** Each account's opening balance plus posted money in, minus posted money out. Added up, they equal the funds. */
  async accountBalances(actor: LedgerActor): Promise<AccountBalance[]> {
    await this.authorize(actor, 'ledger-summary-read');
    const openings = this.openings();
    const totals = new Map((this.db.prepare(`
      SELECT account_id,
        COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END), 0) AS total_out
      FROM accounting_transactions WHERE status = 'posted' GROUP BY account_id`).all() as { account_id: string; total_in: number; total_out: number }[])
      .map(r => [r.account_id, r]));
    return this.accountsInUse().map(a => {
      const opening = openings.get(a.id);
      const t = totals.get(a.id);
      const openingBalance = opening?.opening_balance ?? 0;
      const totalIn = t?.total_in ?? 0;
      const totalOut = t?.total_out ?? 0;
      return {
        accountId: a.id, name: a.name, kind: a.kind, active: a.active, configured: a.configured,
        openingBalance, openingDate: opening?.opening_date ?? null, totalIn, totalOut, balance: openingBalance + totalIn - totalOut
      };
    });
  }

  /** Account ids that entries name but the configuration no longer has: index.ts warns at startup. */
  droppedAccounts(): string[] {
    return this.accountsInUse().filter(a => !a.configured).map(a => a.id);
  }

  // ── Entries ────────────────────────────────────────────────────────────

  /** Money out. Money in is a receipt (`postReceipt`, D-029). */
  async postTransaction(actor: LedgerActor, input: NewTransaction): Promise<Transaction> {
    await this.authorize(actor, 'ledger-record');
    const user = actor.actingUsername();
    if (input.direction === 'in') throw new LedgerError(400, MONEY_IN_IS_A_RECEIPT);
    const entry = this.newEntry(user, input, { sourceType: 'manual' });

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-record'), action: 'ledger-post',
      severity: 'medium', resource: entry.id, resourceType: 'accounting-transaction',
      metadata: { direction: entry.direction, amount: entry.amount, currency: entry.currency, fundId: entry.fundId, date: entry.date, category: entry.category }
    });
    await this.commit(() => {
      this.insert(entry);
      this.history(user, 'ledger-post', 'transaction', entry.id, null, entry);
    });
    return entry;
  }

  /**
   * Void a posted entry, with a reason, and optionally post its replacement in
   * the same step. A transfer is voided as a pair and has no replacement — post
   * a new transfer instead.
   */
  async voidTransaction(actor: LedgerActor, transactionId: string, reason: string, replacement?: NewTransaction): Promise<{ voided: Transaction[]; replacement: Transaction | null }> {
    await this.authorize(actor, 'ledger-adjust');
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
    if (replacement?.direction === 'in') {
      throw new LedgerError(400, 'a receipt is corrected by voiding it and recording a new receipt, not by a replacement');
    }
    if (original.confirmationNumber && this.refunded(original) > 0) {
      throw new LedgerError(409, 'this receipt has refunds; void the refunds first');
    }
    const next = replacement ? this.newEntry(user, replacement, { sourceType: 'adjustment', voidsId: original.id }) : null;

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-adjust'), action: 'ledger-void',
      severity: 'high', resource: original.id, resourceType: 'accounting-transaction', reason: why,
      metadata: { voided: targets.map(t => t.id), replacement: next ? { id: next.id, amount: next.amount, direction: next.direction, fundId: next.fundId } : null }
    });
    await this.commit(() => {
      if (next) this.insert(next);
      for (const t of targets) {
        this.db.prepare("UPDATE accounting_transactions SET status = 'voided', void_reason = ?, voided_by_id = ? WHERE id = ?")
          .run(why, t.id === original.id && next ? next.id : null, t.id);
        this.history(user, 'ledger-void', 'transaction', t.id, t, { ...t, status: 'voided', voidReason: why, voidedById: t.id === original.id && next ? next.id : null }, why);
      }
      if (next) this.history(user, 'ledger-post', 'transaction', next.id, null, next, why);
    });
    return {
      voided: targets.map(t => this.transaction(t.id)),
      replacement: next
    };
  }

  /** Move money between two funds: an `out` and an `in` sharing one transfer id; the total is unchanged. */
  async transferBetweenFunds(actor: LedgerActor, input: { fromFundId: string; toFundId: string; amount: number; date: string; memo?: string }): Promise<Transaction[]> {
    await this.authorize(actor, 'ledger-adjust');
    const user = actor.actingUsername();
    if (input.fromFundId === input.toFundId) throw new LedgerError(400, 'a transfer needs two different funds');
    const transferId = this.newId();
    // Funds do not care where money sits: both halves are in the same account, so no account changes.
    const common = { amount: input.amount, date: input.date, category: 'transfer', memo: input.memo, accountId: this.startingAccount().id };
    const out = this.newEntry(user, { ...common, direction: 'out', fundId: input.fromFundId }, { sourceType: 'transfer', transferId });
    const into = this.newEntry(user, { ...common, direction: 'in', fundId: input.toFundId }, { sourceType: 'transfer', transferId });

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-adjust'), action: 'ledger-transfer',
      severity: 'high', resource: transferId, resourceType: 'accounting-transfer',
      metadata: { fromFundId: out.fundId, toFundId: into.fundId, amount: out.amount, currency: out.currency, date: out.date }
    });
    await this.commit(() => {
      this.insert(out);
      this.insert(into);
      this.history(user, 'ledger-transfer', 'transfer', transferId, null, { out, into });
    });
    return [out, into];
  }

  // ── Receipts (D-028, D-029) ──────────────────────────────────────────────

  /**
   * Money received. The manual provider's receipt is numbered by the ledger,
   * R-0001 onwards, in the same database transaction that posts it: one
   * sequence per site, never reused (a voided receipt keeps its number). A
   * provider's own number (Stripe, later) is stored as given; provider plus
   * number is unique, so the same receipt never posts twice.
   */
  async postReceipt(actor: LedgerActor, input: NewReceipt, source: ReceiptSource): Promise<Transaction> {
    await this.authorize(actor, 'ledger-record');
    const user = actor.actingUsername();
    const provider = text(source.provider, 'provider', { required: true, max: 32 }) as string;
    const given = text(source.confirmationNumber, 'confirmationNumber', { max: 128 });
    if (provider !== MANUAL_PROVIDER && !given) throw new LedgerError(400, 'confirmationNumber is required for a provider receipt');
    text(input.partyName, 'partyName', { required: true, max: 200 });
    text(input.paymentMethod, 'paymentMethod', { required: true, max: 16 });
    const referenceType = text(input.reference?.type, 'reference.type', { max: 32 });
    const referenceId = text(input.reference?.id, 'reference.id', { max: 64 });
    if (Boolean(referenceType) !== Boolean(referenceId)) throw new LedgerError(400, 'reference needs both a type and an id');
    const draft = this.newEntry(user, { ...input, direction: 'in' },
      { sourceType: referenceType ?? 'receipt', sourceId: referenceId, provider, confirmationNumber: given });

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-record'), action: 'receipt-record',
      severity: 'medium', resource: draft.id, resourceType: 'accounting-transaction',
      metadata: { amount: draft.amount, currency: draft.currency, fundId: draft.fundId, date: draft.date, category: draft.category,
        provider, confirmationNumber: given ?? 'assigned on posting', paymentMethod: draft.paymentMethod }
    });
    let receipt = draft;
    await this.commit(() => {
      receipt = given ? draft : { ...draft, confirmationNumber: this.nextReceiptNumber() };
      this.insert(receipt);
      this.history(user, 'receipt-record', 'transaction', receipt.id, null, receipt);
    });
    return receipt;
  }

  /**
   * Return money to the payer of a receipt: an out entry in the receipt's fund
   * and category, linked to it. The receipt stays posted. Partial refunds add up
   * to at most the receipt's amount.
   */
  async refundReceipt(actor: LedgerActor, receiptId: string, input: ReceiptRefund): Promise<Transaction> {
    await this.authorize(actor, 'receipt-refund');
    const user = actor.actingUsername();
    const receipt = this.transaction(text(receiptId, 'receiptId', { required: true }) as string);
    if (receipt.direction !== 'in' || !receipt.confirmationNumber) throw new LedgerError(400, 'only a receipt can be refunded');
    if (receipt.status !== 'posted') throw new LedgerError(409, 'this receipt is voided');
    const left = this.refundable(receipt);
    if (left <= 0) throw new LedgerError(409, 'this receipt is already fully refunded');
    const amount = input.amount === undefined ? left : minorUnits(input.amount, 'amount', { positive: true });
    if (amount > left) throw new LedgerError(400, `amount is more than is left to refund (${this.formatMoney(left, receipt.currency)})`);
    const refund = this.newEntry(user, {
      direction: 'out', amount, date: input.date, fundId: receipt.fundId, category: receipt.category,
      partyName: receipt.partyName ?? undefined, partyPersonId: receipt.partyPersonId ?? undefined,
      paymentMethod: input.paymentMethod ?? receipt.paymentMethod ?? undefined, paymentMethodId: input.paymentMethodId, memo: input.memo,
      accountId: input.accountId
    }, { sourceType: RECEIPT_REFUND, sourceId: receipt.id });

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('receipt-refund'), action: 'receipt-refund',
      severity: 'high', resource: receipt.id, resourceType: 'accounting-transaction', reason: refund.memo,
      metadata: { refundId: refund.id, receipt: receipt.confirmationNumber, amount, currency: refund.currency, leftBefore: left }
    });
    await this.commit(() => {
      this.insert(refund);
      this.history(user, 'receipt-refund', 'transaction', refund.id, null, refund, refund.memo);
    });
    return refund;
  }

  async listTransactions(actor: LedgerActor, filter: { fundId?: string; from?: string; to?: string; includeVoided?: boolean } = {}): Promise<Transaction[]> {
    await this.authorize(actor, 'ledger-read');
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
    await this.authorize(actor, 'ledger-read');
    return this.transaction(transactionId);
  }

  /** Each fund's opening balance plus posted money in, minus posted money out. Voided entries do not count. */
  async fundBalances(actor: LedgerActor): Promise<FundBalance[]> {
    await this.authorize(actor, 'ledger-summary-read');
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

  private newEntry(user: string, input: NewTransaction, link: { sourceType: string; sourceId?: string; voidsId?: string; transferId?: string; provider?: string; confirmationNumber?: string }): Transaction {
    if (input.direction !== 'in' && input.direction !== 'out') throw new LedgerError(400, "direction must be 'in' or 'out'");
    const fund = this.fund(text(input.fundId, 'fundId', { required: true }) as string);
    if (!fund.active) throw new LedgerError(409, `fund '${fund.name}' is closed`);
    const paymentMethod = text(input.paymentMethod, 'paymentMethod', { max: 16 });
    if (paymentMethod !== undefined && !PAYMENT_MEANS.test(paymentMethod)) {
      throw new LedgerError(400, 'paymentMethod must be a UN/CEFACT payment means code, e.g. 10 (cash) or 20 (cheque)');
    }
    const accountId = text(input.accountId, 'accountId', { max: 32 });
    const account = accountId === undefined ? this.startingAccount(paymentMethod) : this.account(accountId);
    if (!account.configured) throw new LedgerError(409, `account '${account.id}' is no longer configured`);
    if (!account.active) throw new LedgerError(409, `account '${account.name}' is closed`);
    return {
      id: this.newId(),
      direction: input.direction,
      amount: minorUnits(input.amount, 'amount', { positive: true }),
      currency: this.currency,
      date: isoDate(input.date, 'date'),
      fundId: fund.id,
      accountId: account.id,
      category: text(input.category, 'category', { required: true, max: 32 }) as string,
      partyPersonId: text(input.partyPersonId, 'partyPersonId', { max: 64 }) ?? null,
      partyName: text(input.partyName, 'partyName', { max: 200 }) ?? null,
      paymentMethod: paymentMethod ?? null,
      paymentMethodId: text(input.paymentMethodId, 'paymentMethodId', { max: 64 }) ?? null,
      provider: link.provider ?? null,
      confirmationNumber: link.confirmationNumber ?? null,
      sourceType: link.sourceType,
      sourceId: link.sourceId ?? null,
      status: 'posted',
      voidsId: link.voidsId ?? null,
      voidedById: null,
      voidReason: null,
      transferId: link.transferId ?? null,
      // Every money movement says why (D-029).
      memo: text(input.memo, 'memo', { required: true, max: 2000 }) as string,
      createdBy: user,
      createdAt: this.stamp()
    };
  }

  private insert(t: Transaction): void {
    this.db.prepare(`INSERT INTO accounting_transactions (id, direction, amount, currency, date, fund_id, account_id, category,
        party_person_id, party_name, payment_method, payment_method_id, provider, confirmation_number,
        source_type, source_id, status, voids_id, voided_by_id, void_reason, transfer_id, memo, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id, t.direction, t.amount, t.currency, t.date, t.fundId, t.accountId, t.category, t.partyPersonId, t.partyName,
      t.paymentMethod, t.paymentMethodId, t.provider, t.confirmationNumber, t.sourceType, t.sourceId, t.status,
      t.voidsId, t.voidedById, t.voidReason, t.transferId, t.memo, t.createdBy, t.createdAt);
  }

  private history(actor: string, action: string, entity: string, entityId: string, before: unknown, after: unknown, reason?: string): void {
    this.db.prepare('INSERT INTO accounting_history (at, actor, action, entity, entity_id, before, after, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.stamp(), actor, action, entity, entityId, before === null ? null : JSON.stringify(before), JSON.stringify(after), reason ?? null);
  }

  /** The configured accounts, plus any that entries or openings still name but the configuration has dropped. */
  private accountsInUse(): Account[] {
    const configured = accountsFrom(this.accountsConfig());
    const known = new Set(configured.map(a => a.id));
    const named = (this.db.prepare(`SELECT account_id FROM accounting_transactions
      UNION SELECT account_id FROM accounting_account_openings ORDER BY account_id`).all() as { account_id: string }[]).map(r => r.account_id);
    const dropped = named.filter(id => !known.has(id))
      .map((id): Account => ({ id, name: id, kind: 'bank', isDefault: false, active: false, configured: false }));
    return [...configured, ...dropped];
  }

  private account(accountId: string): Account {
    const account = this.accountsInUse().find(a => a.id === accountId);
    if (!account) throw new LedgerError(404, 'unknown account');
    return account;
  }

  /** Where money lands when no account is named: by method, else the default bank account (D-031). */
  private startingAccount(paymentMethod?: string | null): Account {
    const accounts = accountsFrom(this.accountsConfig());
    if (paymentMethod && CASH_ON_HAND_METHODS.includes(paymentMethod)) return CASH_ON_HAND_ACCOUNT;
    return accounts.find(a => a.isDefault) ?? CASH_ON_HAND_ACCOUNT;
  }

  private openings(): Map<string, { opening_balance: number; opening_date: string }> {
    return new Map((this.db.prepare('SELECT account_id, opening_balance, opening_date FROM accounting_account_openings').all() as
      { account_id: string; opening_balance: number; opening_date: string }[]).map(r => [r.account_id, r]));
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

  /** The next manual receipt number: one past the highest ever used, voided ones included. */
  private nextReceiptNumber(): string {
    const row = this.db.prepare(`SELECT MAX(CAST(SUBSTR(confirmation_number, 3) AS INTEGER)) AS last
      FROM accounting_transactions WHERE provider = ? AND confirmation_number LIKE 'R-%'`).get(MANUAL_PROVIDER) as { last: number | null };
    return `R-${String((row.last ?? 0) + 1).padStart(4, '0')}`;
  }

  /** What has been refunded of a receipt so far (posted refunds only). */
  private refunded(receipt: Transaction): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM accounting_transactions
      WHERE source_type = ? AND source_id = ? AND status = 'posted'`).get(RECEIPT_REFUND, receipt.id) as { total: number };
    return row.total;
  }

  private refundable(receipt: Transaction): number {
    return receipt.status === 'posted' ? receipt.amount - this.refunded(receipt) : 0;
  }

  /** Posted receipts, newest first. */
  private receiptRows(): Transaction[] {
    return (this.db.prepare(`SELECT * FROM accounting_transactions
      WHERE direction = 'in' AND confirmation_number IS NOT NULL AND status = 'posted'
      ORDER BY date DESC, created_at DESC`).all() as TransactionRow[]).map(toTransaction);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private today(): string {
    return this.stamp().slice(0, 10);
  }
}
