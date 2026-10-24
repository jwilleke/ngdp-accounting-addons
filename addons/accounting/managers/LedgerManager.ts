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
  /** The bank's routing number (ABA, nine digits), if configured. Public: it names the bank. */
  routingNumber: string | null;
  /** The last four digits of the account number, if configured. The full number is a secret (accountNumbers). */
  accountNumberLast4: string | null;
}

/** A bank account's numbers, in full: only for fund-manage holders, through accountNumbers (D-031). */
export interface AccountNumbers { accountId: string; name: string; routingNumber: string | null; accountNumber: string }

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

/**
 * Receipts taken from Cash on Hand to a bank account together: one line on the
 * bank statement (D-031). Its money moves in paired ledger entries per fund,
 * out of Cash on Hand and into the bank account, so no fund balance changes.
 */
export interface Deposit {
  id: string;
  /** D-0001 onwards: one sequence per site, never reused. */
  number: string;
  date: string;
  accountId: string;
  /** The bank's deposit slip number, if any. */
  slipReference: string | null;
  total: number;
  memo: string;
  status: 'posted' | 'voided';
  voidReason: string | null;
  receipts: { receiptId: string; amount: number }[];
  /** The date the bank shows the deposit, once the treasurer marks it cleared (D-032); null until then. */
  clearedDate: string | null;
  createdBy: string;
  createdAt: string;
}

export interface NewDeposit {
  accountId: string;
  date: string;
  receiptIds: string[];
  /** The deposit slip's total; the deposit is refused unless the receipts add up to it. */
  total: number;
  slipReference?: string;
  memo?: string;
}

/**
 * A deposited check the bank returned (D-032). The receipt never changes; a
 * returned-check entry and the bank's fee take the money back out. The payer
 * owes the check, the fee and any penalty; repayments are receipts that
 * reference the bounce.
 */
export interface Bounce {
  id: string;
  receiptId: string;
  receiptNumber: string | null;
  depositId: string;
  depositNumber: string;
  date: string;
  partyName: string | null;
  accountId: string;
  checkAmount: number;
  fee: number;
  penalty: number;
  /** check + fee + penalty */
  owed: number;
  /** What posted repayment receipts add up to. */
  repaid: number;
  stillOwed: number;
  memo: string;
  createdBy: string;
  createdAt: string;
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
  /** The receipt or refund this entry is a line of (D-033). */
  documentId: string | null;
  /** A refund line: the receipt line it gives back. */
  lineOf: string | null;
  memo: string;
  createdBy: string;
  createdAt: string;
}

/** One line of a receipt or refund: a ledger entry with its own amount, fund and category (D-033). */
export interface DocumentLine {
  id: string;
  amount: number;
  fundId: string;
  category: string;
  memo: string;
  status: 'posted' | 'voided';
  /** A refund line: the receipt line it gives back. */
  receiptLineId: string | null;
  /** What modules added to the line, by kind: e.g. `{ gift: { goodsValue, anonymous, … } }` (D-036). */
  details: Record<string, Record<string, unknown>>;
}

/**
 * A kind of detail a module adds to receipt lines (accounting-donations adds
 * `gift`). `validate` gets what the caller sent and the line, and returns what
 * is stored; it throws an Error naming the field when the data is wrong, which
 * the ledger refuses as the caller's mistake (400).
 */
export interface LineDetailsKind {
  validate(data: unknown, line: { amount: number; category: string; fundId: string }): Record<string, unknown>;
}

/**
 * What a module reads of its own line details, handed to it when it registers
 * the kind and to no one else: every posted receipt line carrying the kind,
 * bounced checks left out, net of refunds. accounting-dues works out which of
 * its invoices are paid from it.
 */
export interface LineDetailsReader {
  lines(): { lineId: string; receiptId: string; date: string; amount: number; details: Record<string, unknown> }[];
}

/** Notes a module adds to a receipt slip, e.g. a gift's quid pro quo disclosure: plain text, one per paragraph. */
export type SlipNotes = (receipt: Receipt) => string[];

/** A receipt as its printable slip shows it: the receipt and the notes modules add. */
export interface ReceiptSlip { receipt: Receipt; notes: string[]; currency: string }

interface DocumentBase {
  id: string;
  /** R-0001 or RF-0001 onwards for the manual provider; a provider's own number for its receipts. */
  number: string | null;
  date: string;
  partyName: string | null;
  partyPersonId: string | null;
  paymentMethod: string | null;
  paymentMethodId: string | null;
  /** One payment, one account: every line is in it. */
  accountId: string;
  total: number;
  memo: string;
  status: 'posted' | 'voided';
  voidReason: string | null;
  lines: DocumentLine[];
  createdBy: string;
  createdAt: string;
}

/** Money received: one record, one number, shown once at its total, with one or more lines (D-033). */
export interface Receipt extends DocumentBase {
  kind: 'receipt';
  provider: string | null;
  /** The bank returned it (D-032): it stays posted, but its money came back out. */
  bounced: boolean;
  /** What it pays for, once dues, donations and events exist. */
  reference: { type: string; id: string } | null;
}

/** Money given back from a receipt: numbered RF-0001 onwards, each line tied to a receipt line (D-033). */
export interface Refund extends DocumentBase {
  kind: 'refund';
  receiptId: string;
}

/** A line of a new receipt. Its note defaults to the receipt's reason; `details` are what modules add, by kind. */
export interface NewLine { amount: number; fundId: string; category: string; memo?: string; details?: Record<string, unknown> }

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
  /** One or more lines. Without them, amount, fundId and category make the one line. */
  lines?: NewLine[];
  amount?: number;
  date: string;
  fundId?: string;
  /** Blank picks it by method: cash and checks to Cash on Hand, bank methods to the default bank account. */
  accountId?: string;
  category?: string;
  partyName: string;
  partyPersonId?: string;
  paymentMethod: string;
  paymentMethodId?: string;
  memo: string;
  /** What the money is for, once dues, donations and events exist: e.g. { type: 'dues-invoice', id }. */
  reference?: { type: string; id: string };
}

/**
 * A refund of a receipt: money returned to the payer. `lines` name the receipt
 * lines and how much of each; a one-line receipt may give just `amount`, which
 * defaults to what is left.
 */
export interface ReceiptRefund {
  lines?: { receiptLineId: string; amount: number }[];
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

/** How this site's periods are locked, chosen by the treasurer (#19). */
export type LockPeriod = 'month' | 'quarter' | 'half-year' | 'year';
const LOCK_PERIODS: readonly LockPeriod[] = ['month', 'quarter', 'half-year', 'year'];
const MONTHS_IN: Record<LockPeriod, number> = { month: 1, quarter: 3, 'half-year': 6, year: 12 };
export interface LockSettings { period: LockPeriod; fiscalStartMonth: number }
/** Until the treasurer chooses: monthly, with the fiscal year starting in January. */
const DEFAULT_LOCK_SETTINGS: LockSettings = { period: 'month', fiscalStartMonth: 1 };

/**
 * The period ends after `after` and up to `until` (YYYY-MM-DD), for periods of
 * `period` in a fiscal year starting in `fiscalStartMonth` (1–12): e.g.
 * quarters from July end on Sep 30, Dec 31, Mar 31 and Jun 30.
 */
export function periodEnds(settings: LockSettings, after: string, until: string): string[] {
  const size = MONTHS_IN[settings.period];
  const ends: string[] = [];
  let year = Number(after.slice(0, 4));
  let month = Number(after.slice(5, 7));
  for (let i = 0; i < 1200; i++) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    if (end > until) break;
    const intoYear = (month - settings.fiscalStartMonth + 12) % 12 + 1;
    if (intoYear % size === 0 && end > after) ends.push(end);
    month += 1;
    if (month === 13) { month = 1; year += 1; }
  }
  return ends;
}

/** QuickBooks' fixed account types, which every category carries (D-034). */
export type CategoryType = 'income' | 'other-income' | 'cost-of-goods' | 'expense' | 'other-expense';
const CATEGORY_TYPES: readonly CategoryType[] = ['income', 'other-income', 'cost-of-goods', 'expense', 'other-expense'];
/** Types money in is recorded under; every other type is money out. */
const MONEY_IN_TYPES: readonly CategoryType[] = ['income', 'other-income'];

/**
 * An income or expense category (D-023, D-034): an account code, a name, and
 * QuickBooks' type and detail type, so an accountant knows it and an export
 * maps one to one.
 */
export interface Category { code: string; name: string; type: CategoryType; detailType: string | null }

const CATEGORY_CODE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;

/** The usual numbering (D-034): 4000s income, 5000s cost of goods, 6000s–7000s expenses, 8000s other income, 9000s other expense. */
function typeByNumber(code: string): CategoryType | null {
  return ({ 4: 'income', 5: 'cost-of-goods', 6: 'expense', 7: 'expense', 8: 'other-income', 9: 'other-expense' } as Record<string, CategoryType>)[code.length === 4 ? code[0] : ''] ?? null;
}

/**
 * The categories from `ngdpbase.addons.accounting.categories`, a map keyed by
 * code, sorted by code. Each entry is `{ "name", "type", "detailType" }`; the
 * older `"<code>": "<name>"` still works, its type read from the number. False
 * or null removes a shipped one. Anything it cannot use is skipped, with a warning.
 */
export function categoriesFrom(entries: unknown, warn: (message: string) => void = () => undefined): Category[] {
  const map = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries as Record<string, unknown> : {};
  const categories: Category[] = [];
  for (const [code, value] of Object.entries(map)) {
    if (value === null || value === false) continue;
    if (!CATEGORY_CODE.test(code)) { warn(`[accounting] category '${code}': the code must be letters, digits, dots or dashes; skipped`); continue; }
    const entry = typeof value === 'string' ? { name: value } : value as { name?: unknown; type?: unknown; detailType?: unknown };
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.trim() === '') {
      warn(`[accounting] category '${code}' has no name; skipped`);
      continue;
    }
    const type = entry.type === undefined ? typeByNumber(code) : (CATEGORY_TYPES as readonly unknown[]).includes(entry.type) ? entry.type as CategoryType : null;
    if (!type) { warn(`[accounting] category '${code}': type must be one of ${CATEGORY_TYPES.join(', ')}; skipped`); continue; }
    categories.push({ code, name: entry.name.trim(), type, detailType: typeof entry.detailType === 'string' && entry.detailType !== '' ? entry.detailType : null });
  }
  return categories.sort((a, b) => a.code.localeCompare(b.code));
}

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
export interface CategoryPeriod { category: string; label: string; type: CategoryType | null; income: number; expense: number }

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
  /** Income and expense categories: `ngdpbase.addons.accounting.categories` from site configuration, read by categoriesFrom (D-023, D-034). */
  categories?: () => unknown;
  /**
   * The bounced-check settings (D-032): the bank-charges and other-income category codes and the
   * default penalty, from `ngdpbase.addons.accounting.bank-charges-category`, `.other-income-category`
   * and `.bounced-check-penalty`.
   */
  bouncedChecks?: () => { bankChargesCategory?: unknown; otherIncomeCategory?: unknown; penalty?: unknown };
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
  /**
   * The ngdpbase person a username is, as its `@id` (PersonManager.getByUserIdentifier), for the
   * caller's own receipts (D-037). Without it a person has no receipts of their own.
   */
  personOf?: (username: string) => Promise<string | null>;
}

/**
 * A choice in a form dropdown or checklist (ngdpbase BaseManager.toFormOptions).
 * `amount`, in minor units, lets a checklist show a running total of what is ticked (ngdpbase #1904).
 */
export interface FormChoice { value: string; label: string; amount?: number }

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

/** "Checking …1234": an account's name, with the last four digits of its number when one is configured. */
export const accountLabel = (a: Pick<Account, 'name' | 'accountNumberLast4'>): string =>
  a.accountNumberLast4 ? `${a.name} …${a.accountNumberLast4}` : a.name;

/** "R-0012 · 2026-10-19 · $75.00 · Pat Payer": a receipt or refund, shown once at its total. */
function documentLabel(d: Receipt | Refund, fundNames: Map<string, string>, formatMoney: LedgerOptions['formatMoney'], currency: string): string {
  const funds = [...new Set(d.lines.map(l => fundNames.get(l.fundId) ?? l.fundId))];
  return [d.number, d.date, funds.length === 1 ? funds[0] : `${funds.length} funds`, formatMoney(d.total, currency), d.partyName || d.memo].filter(Boolean).join(' · ');
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
const CASH_ON_HAND_ACCOUNT: Account = Object.freeze({ id: CASH_ON_HAND, name: 'Cash on Hand', kind: 'cash', isDefault: false, active: true, configured: true, routingNumber: null, accountNumberLast4: null });

/**
 * Methods whose money is handed over, so it lands in Cash on Hand until it is
 * deposited; every other method lands in the default bank account (D-031).
 * docs/receipt-methods.md, column "Starting account", is the source of truth;
 * a test fails if they differ.
 */
export const CASH_ON_HAND_METHODS: readonly string[] = ['10', '20', '48'];

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ROUTING_NUMBER = /^\d{9}$/;
const ACCOUNT_NUMBER = /^\d{4,17}$/;

/**
 * A bank account's full numbers from its configuration entry. `account-number`
 * is a `$VAR` reference that ngdpbase resolves (v5.21.0, #1889) and hides as a
 * secret; a value that is not a number is ignored, with a warning that never
 * repeats it.
 */
function bankNumbers(id: string, entry: Record<string, unknown>, warn: (message: string) => void): { routingNumber: string | null; accountNumber: string | null } {
  const routing = entry['routing-number'];
  const number = entry['account-number'];
  let routingNumber: string | null = null;
  let accountNumber: string | null = null;
  if (routing !== undefined && routing !== '') {
    if (typeof routing === 'string' && ROUTING_NUMBER.test(routing)) routingNumber = routing;
    else warn(`[accounting] account '${id}': routing-number must be nine digits; ignored`);
  }
  if (number !== undefined && number !== '') {
    if (typeof number === 'string' && ACCOUNT_NUMBER.test(number)) accountNumber = number;
    else warn(`[accounting] account '${id}': account-number must be 4 to 17 digits; ignored`);
  }
  return { routingNumber, accountNumber };
}

/** Each configured bank account's full numbers, by id. Never logged, audited or exported. */
function accountNumbersFrom(entries: unknown): Map<string, { routingNumber: string | null; accountNumber: string | null }> {
  const map = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries as Record<string, unknown> : {};
  const numbers = new Map<string, { routingNumber: string | null; accountNumber: string | null }>();
  for (const [id, value] of Object.entries(map)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) numbers.set(id, bankNumbers(id, value as Record<string, unknown>, () => undefined));
  }
  return numbers;
}

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
    const { routingNumber, accountNumber } = bankNumbers(id, entry as Record<string, unknown>, warn);
    accounts.push({ id, name, kind: 'bank', isDefault: entry.default === true, active: entry.active !== false, configured: true,
      routingNumber, accountNumberLast4: accountNumber ? accountNumber.slice(-4) : null });
  }
  const banks = accounts.filter(a => a.kind === 'bank' && a.active);
  const marked = banks.filter(a => a.isDefault);
  if (marked.length > 1) warn(`[accounting] several accounts are marked default; '${marked[0].id}' is used`);
  if (banks.length === 0) warn('[accounting] no bank account is configured: everything lands in Cash on Hand');
  const chosen = marked[0] ?? banks[0];
  return accounts.map(a => ({ ...a, isDefault: a === chosen }));
}
const RECEIPT_REFUND = 'receipt-refund';
const DEPOSIT = 'deposit';
const RETURNED_CHECK = 'returned-check';
const BOUNCE_FEE = 'bounce-fee';
const BOUNCED_CHECK = 'bounced-check';
const CHECK = '20';
const MONEY_IN_IS_A_RECEIPT = 'money in is recorded as a receipt (Record a Receipt), not as an entry';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** UN/CEFACT payment means code (UNCL 4461): digits, or ZZZ for "mutually defined". */
const PAYMENT_MEANS = /^(\d{1,3}|ZZZ)$/;
const CURRENCY = /^[A-Z]{3}$/;

interface DepositRow {
  id: string; number: string; date: string; account_id: string; slip_reference: string | null; total: number;
  memo: string; status: 'posted' | 'voided'; void_reason: string | null; created_by: string; created_at: string;
}

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
  created_by: string; created_at: string; document_id: string | null; line_of: string | null;
}

interface DocumentRow {
  id: string; kind: 'receipt' | 'refund'; number: string | null; provider: string | null; date: string;
  party_person_id: string | null; party_name: string | null; payment_method: string | null; payment_method_id: string | null;
  account_id: string; total: number; memo: string; source_type: string | null; source_id: string | null;
  status: 'posted' | 'voided'; void_reason: string | null; created_by: string; created_at: string;
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
  voidedById: r.voided_by_id, voidReason: r.void_reason, transferId: r.transfer_id, documentId: r.document_id ?? null,
  lineOf: r.line_of ?? null, memo: r.memo, createdBy: r.created_by, createdAt: r.created_at
});

const toLine = (t: Transaction, details: Record<string, Record<string, unknown>> = {}): DocumentLine => ({
  id: t.id, amount: t.amount, fundId: t.fundId, category: t.category, memo: t.memo, status: t.status, receiptLineId: t.lineOf, details
});

const DETAIL_KIND = /^[a-z][a-z0-9-]{0,31}$/;

/** A receipt or refund holds at most this many lines. */
const MAX_LINES = 50;

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
  private readonly categoriesConfig: () => unknown;
  private readonly accountsConfig: () => unknown;
  private readonly bouncedChecksConfig: NonNullable<LedgerOptions['bouncedChecks']>;
  private readonly lineKinds = new Map<string, LineDetailsKind>();
  private readonly slipNoteSources: SlipNotes[] = [];
  private readonly formatMoney: LedgerOptions['formatMoney'];
  private readonly toCsv: LedgerOptions['toCsv'];
  private readonly dataChanged: () => Promise<void> | void;
  private readonly personOf: (username: string) => Promise<string | null>;

  constructor(options: LedgerOptions) {
    if (!CURRENCY.test(options.currency)) throw new Error(`accounting: currency '${options.currency}' is not an ISO 4217 code`);
    this.host = options.host;
    this.db = options.db;
    this.recordAudit = options.recordAudit;
    this.currency = options.currency;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.decide = options.decide ?? (async () => ({ permit: false, applicable: false, reason: 'no_decision_point' }));
    this.categoriesConfig = options.categories ?? (() => ({}));
    this.accountsConfig = options.accounts ?? (() => ({}));
    this.bouncedChecksConfig = options.bouncedChecks ?? (() => ({}));
    this.formatMoney = options.formatMoney;
    this.toCsv = options.toCsv;
    this.dataChanged = options.dataChanged ?? (() => undefined);
    this.personOf = options.personOf ?? (async () => null);
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

    const known = new Map(this.categories().map(c => [c.code, c]));
    const categories = (this.db.prepare(`
      SELECT category,
        COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN direction = 'out' THEN amount END), 0) AS expense
      FROM accounting_transactions
      WHERE status = 'posted' AND transfer_id IS NULL AND source_type <> '${DEPOSIT}' AND date >= ? AND date <= ?
      GROUP BY category ORDER BY category`).all(from, to) as { category: string; income: number; expense: number }[])
      .map(r => ({ category: r.category, label: known.get(r.category)?.name ?? '', type: known.get(r.category)?.type ?? null, income: r.income, expense: r.expense }));

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
        'payment_method', 'payment_method_id', 'provider', 'confirmation_number', 'document_number', 'source_type', 'source_id', 'status', 'voids_id',
        'voided_by_id', 'void_reason', 'transfer_id', 'memo', 'created_by', 'created_at'];
      const names = new Map((this.db.prepare('SELECT id, name FROM accounting_funds').all() as { id: string; name: string }[]).map(f => [f.id, f.name]));
      const accountNames = new Map(this.accountsInUse().map(a => [a.id, a.name]));
      // Each line carries its receipt's or refund's number (D-033).
      const documentNumbers = new Map((this.db.prepare('SELECT id, number FROM accounting_documents').all() as { id: string; number: string | null }[]).map(d => [d.id, d.number ?? '']));
      rows = (this.db.prepare('SELECT * FROM accounting_transactions WHERE date >= ? AND date <= ? ORDER BY date, created_at')
        .all(period.from, period.to) as TransactionRow[]).map(toTransaction).map(t => [
        t.id, t.date, t.direction, t.amount, decimalAmount(t.amount, t.currency), t.currency, t.fundId, names.get(t.fundId) ?? '', t.accountId, accountNames.get(t.accountId) ?? '', t.category,
        t.partyPersonId, t.partyName, t.paymentMethod, t.paymentMethodId, t.provider, t.confirmationNumber,
        t.documentId ? documentNumbers.get(t.documentId) ?? '' : '', t.sourceType, t.sourceId,
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
   *   bank-accounts    active bank accounts         ledger-summary-read (listAccounts)
   *   deposit-receipts receipts in Cash on Hand     ledger-read (receiptsToDeposit)
   *   refundable-lines receipt lines left to refund ledger-read
   *   deposits         standing deposits            ledger-read (listDeposits)
   *   uncleared-deposits, cleared-deposits          ledger-read (listDeposits)
   *   bounceable-receipts deposited checks          ledger-read
   *   unsettled-bounces  bounces still owed         ledger-read (listBounces)
   *   entries          latest posted entries        ledger-read (listTransactions)
   *   categories       site's categories            ledger-record (kind=in: income; kind=out: the rest)
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
          return (await this.listAccounts(actor)).filter(a => a.configured && a.active).map(a => ({ value: a.id, label: accountLabel(a) }));
        case 'bank-accounts':
          return (await this.listAccounts(actor)).filter(a => a.kind === 'bank' && a.configured && a.active).map(a => ({ value: a.id, label: accountLabel(a) }));
        case 'deposit-receipts': {
          const names = new Map((await this.listFunds(actor)).map(f => [f.id, f.name]));
          return (await this.receiptsToDeposit(actor)).map(r => ({ value: r.id, label: documentLabel(r, names, this.formatMoney, this.currency), amount: r.total }));
        }
        case 'bounceable-receipts': {
          // Checks in a standing deposit that have not bounced: what the bank can return.
          await this.authorize(actor, 'ledger-read');
          const names = new Map((await this.listFunds(actor)).map(f => [f.id, f.name]));
          return (this.documents('receipt') as Receipt[])
            .filter(r => r.paymentMethod === CHECK && this.depositRowOf(r.id) && !this.bounceOf(r.id))
            .slice(0, ENTRY_CHOICES).map(r => ({ value: r.id, label: documentLabel(r, names, this.formatMoney, this.currency), amount: r.total }));
        }
        case 'unsettled-bounces':
          return (await this.listBounces(actor, { settled: false })).slice(0, ENTRY_CHOICES).map(b => ({
            value: b.id, amount: b.stillOwed,
            label: [b.receiptNumber, b.partyName, `${this.formatMoney(b.stillOwed, this.currency)} still owed`].filter(Boolean).join(' · ')
          }));
        case 'lockable-periods':
          // Period ends the treasurer can lock now (#19).
          await this.authorize(actor, 'fund-manage');
          return this.lockablePeriods().reverse().map(end => ({ value: end, label: `through ${end} (${this.lockSettings().period})` }));
        case 'uncleared-deposits':
        case 'cleared-deposits': {
          const accounts = new Map(this.accountsInUse().map(a => [a.id, a.name]));
          const wantCleared = options.list === 'cleared-deposits';
          return (await this.listDeposits(actor)).filter(d => Boolean(d.clearedDate) === wantCleared).slice(0, ENTRY_CHOICES).map(d => ({
            value: d.id, label: [d.number, d.date, accounts.get(d.accountId) ?? d.accountId, this.formatMoney(d.total, this.currency), d.clearedDate ? `cleared ${d.clearedDate}` : ''].filter(Boolean).join(' · ')
          }));
        }
        case 'deposits': {
          const accounts = new Map(this.accountsInUse().map(a => [a.id, a.name]));
          return (await this.listDeposits(actor)).slice(0, ENTRY_CHOICES).map(d => ({
            value: d.id, label: [d.number, d.date, accounts.get(d.accountId) ?? d.accountId, this.formatMoney(d.total, this.currency)].join(' · ')
          }));
        }
        case 'entries': {
          const names = new Map((await this.listFunds(actor)).map(f => [f.id, f.name]));
          // A receipt or refund is voided whole, so it is offered once; a deposit's entries are undone
          // with the deposit, never one by one.
          await this.authorize(actor, 'ledger-read');
          const choices = [
            ...[...this.documents('receipt'), ...this.documents('refund')].map(d => ({ date: d.date, at: d.createdAt, value: d.id, label: documentLabel(d, names, this.formatMoney, this.currency) })),
            ...(await this.listTransactions(actor)).filter(t => t.sourceType !== DEPOSIT && !t.documentId)
              .map(t => ({ date: t.date, at: t.createdAt, value: t.id, label: entryLabel(t, names.get(t.fundId) ?? t.fundId, this.formatMoney) }))
          ];
          return choices.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at)).slice(0, ENTRY_CHOICES)
            .map(({ value, label }) => ({ value, label }));
        }
        case 'receipts': {
          // Seeing the receipts is reading the ledger. The refund itself asks receipt-refund,
          // with its step-up, when the form is submitted; a page render cannot step up.
          await this.authorize(actor, 'ledger-read');
          const names = new Map((await this.listFunds(actor)).map(f => [f.id, f.name]));
          return (this.documents('receipt') as Receipt[])
            .filter(r => this.refundable(r) > 0)
            .slice(0, ENTRY_CHOICES)
            .map(r => ({ value: r.id, label: documentLabel(r, names, this.formatMoney, this.currency) }));
        }
        case 'refundable-lines': {
          // For a refund's lines (the forms lines field, ngdpbase #1913): each receipt line with money left on it.
          await this.authorize(actor, 'ledger-read');
          const labels = new Map(this.categories().map(c => [c.code, c.name]));
          return (this.documents('receipt') as Receipt[]).flatMap(r => r.lines.map(line => ({ r, line, left: this.lineLeft(line) })))
            .filter(x => x.left > 0).slice(0, ENTRY_CHOICES)
            .map(({ r, line, left }) => ({
              value: line.id, amount: left,
              label: [r.number, labels.get(line.category) ?? line.category, `${this.formatMoney(left, this.currency)} left`].filter(Boolean).join(' · ')
            }));
        }
        case 'categories': {
          // kind=in offers income types (receipts), kind=out the rest (money out); no kind, all.
          await this.authorize(actor, 'ledger-record');
          const fits = (c: Category) => options.kind === 'in' ? MONEY_IN_TYPES.includes(c.type)
            : options.kind === 'out' ? !MONEY_IN_TYPES.includes(c.type) : true;
          return this.categories().filter(fits).map(c => ({ value: c.code, label: `${c.code} ${c.name}` }));
        }
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

  // ── What modules add (D-036) ───────────────────────────────────────────

  /**
   * Let a module add details of its own to receipt lines (accounting-donations:
   * `gift`). Called from the module's register(); a kind is registered once.
   * Returns the module's reader of its own lines (LineDetailsReader).
   */
  registerLineDetails(kind: string, definition: LineDetailsKind): LineDetailsReader {
    if (!DETAIL_KIND.test(kind)) throw new Error(`accounting: line details kind '${kind}' must be lowercase letters, digits and dashes`);
    if (this.lineKinds.has(kind)) throw new Error(`accounting: line details kind '${kind}' is already registered`);
    this.lineKinds.set(kind, definition);
    return { lines: () => this.linesOfKind(kind) };
  }

  /** Let a module add notes to receipt slips (accounting-donations: the quid pro quo disclosure). */
  registerSlipNotes(notes: SlipNotes): void {
    this.slipNoteSources.push(notes);
  }

  /** A receipt as its printable slip shows it, with the notes modules add. Needs ledger-read. */
  async receiptSlip(actor: LedgerActor, receiptId: string): Promise<ReceiptSlip> {
    await this.authorize(actor, 'ledger-read');
    const receipt = this.document(text(receiptId, 'receiptId', { required: true }) as string);
    if (receipt.kind !== 'receipt') throw new LedgerError(400, 'only a receipt has a receipt slip');
    return { receipt, notes: this.slipNoteSources.flatMap(source => source(receipt)), currency: this.currency };
  }

  // ── Period locks (#19) ─────────────────────────────────────────────────

  /** How periods are locked, and the date everything is locked through (null: nothing is). */
  async lockStatus(actor: LedgerActor): Promise<LockSettings & { lockedThrough: string | null }> {
    await this.authorize(actor, 'ledger-summary-read');
    return { ...this.lockSettings(), lockedThrough: this.lockedThrough() };
  }

  /** The treasurer chooses how this site's periods are locked: month, quarter, half-year or year, and the fiscal year's first month. */
  async setLockSettings(actor: LedgerActor, input: { period: string; fiscalStartMonth: number }): Promise<LockSettings> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    if (!(LOCK_PERIODS as readonly string[]).includes(input.period)) throw new LedgerError(400, `period must be one of ${LOCK_PERIODS.join(', ')}`);
    const month = Number(input.fiscalStartMonth);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(400, 'fiscalStartMonth must be a month, 1 to 12');
    const settings: LockSettings = { period: input.period as LockPeriod, fiscalStartMonth: month };
    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'lock-settings',
      severity: 'medium', resource: 'period-lock', resourceType: 'accounting-settings', metadata: { ...settings }
    });
    await this.commit(() => {
      this.db.prepare('INSERT INTO accounting_lock_settings (period, fiscal_start_month, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(settings.period, settings.fiscalStartMonth, user, this.stamp());
      this.history(user, 'lock-settings', 'settings', 'period-lock', this.lockSettings(), settings);
    });
    return settings;
  }

  /**
   * Lock everything dated on or before a period end: nothing in it can be
   * posted, voided or corrected until it is unlocked (#19). Only a period end
   * of the site's chosen period, after the current lock and not in the future.
   */
  async lockPeriod(actor: LedgerActor, throughDate: string): Promise<{ lockedThrough: string }> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    const through = isoDate(throughDate, 'throughDate');
    const check = (): void => {
      const now = this.lockedThrough();
      if (!this.lockablePeriods().includes(through)) {
        throw new LedgerError(400, now && through <= now
          ? `throughDate: everything through ${now} is already locked`
          : `throughDate: ${through} is not the end of a ${this.lockSettings().period} that has ended`);
      }
    };
    check();
    const id = this.newId();
    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'period-lock',
      severity: 'medium', resource: id, resourceType: 'accounting-period-lock', metadata: { throughDate: through, period: this.lockSettings().period }
    });
    await this.commit(() => {
      check(); // again inside the transaction
      this.db.prepare('INSERT INTO accounting_period_locks (id, through_date, period, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, through, this.lockSettings().period, user, this.stamp());
      this.history(user, 'period-lock', 'period-lock', id, null, { throughDate: through });
    });
    return { lockedThrough: through };
  }

  /** Take the latest lock off, with a reason: the period before it is locked again, the rest opens. */
  async unlockPeriod(actor: LedgerActor, reason: string): Promise<{ lockedThrough: string | null }> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    const why = text(reason, 'reason', { required: true }) as string;
    const latest = this.latestLock();
    if (!latest) throw new LedgerError(409, 'nothing is locked');
    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'period-unlock',
      severity: 'high', resource: latest.id, resourceType: 'accounting-period-lock', reason: why, metadata: { throughDate: latest.through_date }
    });
    await this.commit(() => {
      if (this.latestLock()?.id !== latest.id) throw new LedgerError(409, 'the locks changed meanwhile; try again');
      this.db.prepare('UPDATE accounting_period_locks SET removed = 1, removed_reason = ? WHERE id = ?').run(why, latest.id);
      this.history(user, 'period-unlock', 'period-lock', latest.id, { throughDate: latest.through_date }, { removed: true }, why);
    });
    return { lockedThrough: this.lockedThrough() };
  }

  // ── Funds ──────────────────────────────────────────────────────────────

  async createFund(actor: LedgerActor, input: NewFund): Promise<Fund> {
    await this.authorize(actor, 'fund-manage');
    const user = actor.actingUsername();
    const name = text(input.name, 'name', { required: true, max: 120 }) as string;
    const description = text(input.description, 'description') ?? '';
    const openingBalance = input.openingBalance === undefined ? 0 : minorUnits(input.openingBalance, 'openingBalance', { positive: false });
    const openingDate = input.openingDate === undefined ? this.today() : isoDate(input.openingDate, 'openingDate');
    this.assertOpen(openingDate, 'openingDate');
    const nameTaken = (): void => {
      if (this.db.prepare('SELECT id FROM accounting_funds WHERE name = ?').get(name)) {
        throw new LedgerError(409, `a fund named '${name}' already exists`);
      }
    };
    nameTaken();
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
      nameTaken(); // again inside the transaction, as for an account's opening balance
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
    this.assertOpen(openingDate, 'openingDate');
    const alreadySet = (): void => {
      if (this.db.prepare('SELECT account_id FROM accounting_account_openings WHERE account_id = ?').get(account.id)) {
        throw new LedgerError(409, `account '${account.name}' already has its opening balance`);
      }
    };
    alreadySet();
    const opening = { accountId: account.id, openingBalance, openingDate, createdBy: user, createdAt: this.stamp() };

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'account-opening',
      severity: 'medium', resource: account.id, resourceType: 'accounting-account',
      metadata: { name: account.name, openingBalance, openingDate }
    });
    await this.commit(() => {
      // Again inside the transaction: a second submission can pass the first check while the audit is written.
      alreadySet();
      this.db.prepare(`INSERT INTO accounting_account_openings (account_id, opening_balance, opening_date, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(account.id, openingBalance, openingDate, user, opening.createdAt);
      this.history(user, 'account-opening', 'account', account.id, null, opening);
    });
    return (await this.accountBalances(actor)).find(b => b.accountId === account.id) as AccountBalance;
  }

  /**
   * A bank account's full numbers, for holders of fund-manage (treasurer;
   * admin). Every read is audited, never with the number in the record; if
   * the record cannot be written, the number is not shown.
   */
  async accountNumbers(actor: LedgerActor, accountId: string): Promise<AccountNumbers> {
    await this.authorize(actor, 'fund-manage');
    const account = this.account(text(accountId, 'accountId', { required: true, max: 32 }) as string);
    const numbers = account.kind === 'bank' && account.configured ? accountNumbersFrom(this.accountsConfig()).get(account.id) : undefined;
    if (!numbers?.accountNumber) throw new LedgerError(404, `account '${account.name}' has no account number configured`);
    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('fund-manage'), action: 'account-number-view',
      severity: 'medium', resource: account.id, resourceType: 'accounting-account', metadata: { name: account.name }
    });
    return { accountId: account.id, name: account.name, routingNumber: numbers.routingNumber, accountNumber: numbers.accountNumber };
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
    const doc = this.findDocument(text(transactionId, 'transactionId', { required: true }) as string);
    if (doc) return this.voidDocument(actor, user, doc, why, replacement);
    const original = this.transaction(transactionId);
    if (original.status === 'voided') throw new LedgerError(409, 'this entry is already voided');
    this.assertOpen(original.date, 'transactionId');
    if (original.documentId) {
      const of = this.document(original.documentId);
      throw new LedgerError(409, `this entry is a line of ${of.number ?? `this ${of.kind}`}; void the ${of.kind} instead`);
    }
    const targets = original.transferId
      ? (this.db.prepare('SELECT * FROM accounting_transactions WHERE transfer_id = ?').all(original.transferId) as TransactionRow[]).map(toTransaction)
      : [original];
    if (original.transferId && replacement) {
      throw new LedgerError(400, 'a transfer is voided as a pair without a replacement; post a new transfer instead');
    }
    if (replacement?.direction === 'in') {
      throw new LedgerError(400, 'a receipt is corrected by voiding it and recording a new receipt, not by a replacement');
    }
    if (original.sourceType === DEPOSIT) throw new LedgerError(409, 'this entry is part of a deposit; undo the deposit instead');
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

  /**
   * Void a whole receipt or refund, with a reason: the record and every line.
   * A receipt is corrected by recording it again, never by a replacement; it
   * waits for its refunds to be voided and its deposit to be undone.
   */
  private async voidDocument(actor: LedgerActor, user: string, doc: Receipt | Refund, why: string, replacement?: NewTransaction): Promise<{ voided: Transaction[]; replacement: Transaction | null }> {
    if (doc.status === 'voided') throw new LedgerError(409, 'this entry is already voided');
    this.assertOpen(doc.date, 'transactionId');
    if (replacement) {
      throw new LedgerError(400, doc.kind === 'receipt'
        ? 'a receipt is corrected by voiding it and recording a new receipt, not by a replacement'
        : 'a refund is voided without a replacement; record a new refund instead');
    }
    if (doc.kind === 'receipt') {
      if (this.bounceOf(doc.id)) throw new LedgerError(409, 'this receipt bounced: it stays as received, and the returned check is its own entry');
      const inDeposit = this.depositOf(doc.id);
      if (inDeposit) throw new LedgerError(409, `this receipt is in deposit ${inDeposit}; undo the deposit first`);
      if (this.refunded(doc) > 0) throw new LedgerError(409, 'this receipt has refunds; void the refunds first');
    }
    const lines = doc.lines.filter(l => l.status === 'posted');

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-adjust'), action: 'ledger-void',
      severity: 'high', resource: doc.id, resourceType: `accounting-${doc.kind}`, reason: why,
      metadata: { number: doc.number, total: doc.total, voided: lines.map(l => l.id), replacement: null }
    });
    await this.commit(() => {
      if (this.document(doc.id).status === 'voided') throw new LedgerError(409, 'this entry is already voided');
      this.db.prepare("UPDATE accounting_documents SET status = 'voided', void_reason = ? WHERE id = ?").run(why, doc.id);
      for (const line of lines) {
        this.db.prepare("UPDATE accounting_transactions SET status = 'voided', void_reason = ? WHERE id = ?").run(why, line.id);
      }
      this.history(user, 'ledger-void', doc.kind, doc.id, doc, { ...doc, status: 'voided', voidReason: why }, why);
    });
    return { voided: lines.map(l => this.transaction(l.id)), replacement: null };
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
  async postReceipt(actor: LedgerActor, input: NewReceipt, source: ReceiptSource): Promise<Receipt> {
    await this.authorize(actor, 'ledger-record');
    const user = actor.actingUsername();
    const provider = text(source.provider, 'provider', { required: true, max: 32 }) as string;
    const given = text(source.confirmationNumber, 'confirmationNumber', { max: 128 });
    if (provider !== MANUAL_PROVIDER && !given) throw new LedgerError(400, 'confirmationNumber is required for a provider receipt');
    const partyName = text(input.partyName, 'partyName', { required: true, max: 200 }) as string;
    text(input.paymentMethod, 'paymentMethod', { required: true, max: 16 });
    const referenceType = text(input.reference?.type, 'reference.type', { max: 32 });
    const referenceId = text(input.reference?.id, 'reference.id', { max: 64 });
    if (Boolean(referenceType) !== Boolean(referenceId)) throw new LedgerError(400, 'reference needs both a type and an id');
    const memo = text(input.memo, 'memo', { required: true, max: 2000 }) as string;
    const id = this.newId();
    // Every line is in the one account the payment landed in: the first line's, picked by method unless named.
    let accountId = input.accountId;
    const details = new Map<string, Record<string, Record<string, unknown>>>();
    const lines = this.lineSpecs(input).map((line, i, all) => this.asLine(all.length > 1 || Array.isArray(input.lines), i, () => {
      const entry = this.newEntry(user, {
        direction: 'in', amount: line.amount, date: input.date, fundId: line.fundId, category: line.category, accountId,
        partyName, partyPersonId: input.partyPersonId, paymentMethod: input.paymentMethod, paymentMethodId: input.paymentMethodId,
        memo: text(line.memo, 'memo', { max: 2000 }) ?? memo
      }, { sourceType: referenceType ?? 'receipt', sourceId: referenceId, documentId: id });
      accountId = entry.accountId;
      details.set(entry.id, this.lineDetails(line.details, entry));
      return entry;
    }));
    const head = lines[0];
    const receipt: Receipt = {
      kind: 'receipt', id, number: given ?? null, provider, bounced: false, date: head.date, partyName, partyPersonId: head.partyPersonId,
      paymentMethod: head.paymentMethod, paymentMethodId: head.paymentMethodId, accountId: head.accountId,
      total: lines.reduce((t, l) => t + l.amount, 0), memo, status: 'posted', voidReason: null,
      reference: referenceType && referenceId ? { type: referenceType, id: referenceId } : null,
      lines: lines.map(l => toLine(l, details.get(l.id))), createdBy: user, createdAt: this.stamp()
    };

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-record'), action: 'receipt-record',
      severity: 'medium', resource: id, resourceType: 'accounting-receipt',
      metadata: { amount: receipt.total, currency: this.currency, date: receipt.date, lines: lines.map(l => ({ fundId: l.fundId, category: l.category, amount: l.amount })),
        provider, confirmationNumber: given ?? 'assigned on posting', paymentMethod: receipt.paymentMethod, accountId: receipt.accountId }
    });
    await this.commit(() => {
      const number = given ?? this.nextReceiptNumber();
      this.insertDocument({ ...receipt, number });
      for (const line of lines) {
        this.insert(line);
        for (const [kind, data] of Object.entries(details.get(line.id) ?? {})) {
          this.db.prepare('INSERT INTO accounting_line_details (line_id, kind, data) VALUES (?, ?, ?)').run(line.id, kind, JSON.stringify(data));
        }
      }
      this.history(user, 'receipt-record', 'receipt', id, null, { ...receipt, number });
    });
    return this.document(id) as Receipt;
  }

  /**
   * Return money to the payer of a receipt: a refund, numbered RF-0001 onwards,
   * whose lines each give back part of a receipt line, as money out in that
   * line's fund and category. The receipt stays posted. A line never gives back
   * more than is left on it.
   */
  async refundReceipt(actor: LedgerActor, receiptId: string, input: ReceiptRefund): Promise<Refund> {
    await this.authorize(actor, 'receipt-refund');
    const user = actor.actingUsername();
    const receipt = this.findDocument(text(receiptId, 'receiptId', { required: true }) as string);
    if (!receipt || receipt.kind !== 'receipt') throw new LedgerError(400, 'only a receipt can be refunded');
    if (receipt.status !== 'posted') throw new LedgerError(409, 'this receipt is voided');
    if (this.bounceOf(receipt.id)) throw new LedgerError(409, 'this receipt bounced: the bank took the money back, so there is nothing to refund');
    if (this.refundable(receipt) <= 0) throw new LedgerError(409, 'this receipt is already fully refunded');
    const memo = text(input.memo, 'memo', { required: true, max: 2000 }) as string;
    const asked = this.refundSpecs(receipt, input);
    const id = this.newId();
    let accountId = input.accountId;
    const lines = asked.map(({ line, amount }, i) => this.asLine(asked.length > 1 || Array.isArray(input.lines), i, () => {
      const entry = this.newEntry(user, {
        direction: 'out', amount, date: input.date, fundId: line.fundId, category: line.category, accountId,
        partyName: receipt.partyName ?? undefined, partyPersonId: receipt.partyPersonId ?? undefined,
        paymentMethod: input.paymentMethod ?? receipt.paymentMethod ?? undefined, paymentMethodId: input.paymentMethodId, memo
      }, { sourceType: RECEIPT_REFUND, sourceId: receipt.id, documentId: id, lineOf: line.id });
      accountId = entry.accountId;
      return entry;
    }));
    const head = lines[0];
    const refund: Refund = {
      kind: 'refund', id, number: null, receiptId: receipt.id, date: head.date, partyName: receipt.partyName, partyPersonId: receipt.partyPersonId,
      paymentMethod: head.paymentMethod, paymentMethodId: head.paymentMethodId, accountId: head.accountId,
      total: lines.reduce((t, l) => t + l.amount, 0), memo, status: 'posted', voidReason: null,
      lines: lines.map(l => toLine(l)), createdBy: user, createdAt: this.stamp()
    };

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('receipt-refund'), action: 'receipt-refund',
      severity: 'high', resource: receipt.id, resourceType: 'accounting-receipt', reason: memo,
      metadata: { refundId: id, receipt: receipt.number, amount: refund.total, currency: this.currency, leftBefore: this.refundable(receipt),
        lines: asked.map(a => ({ receiptLineId: a.line.id, amount: a.amount })) }
    });
    await this.commit(() => {
      // Again inside the transaction: another refund of the same lines may have been saved meanwhile.
      this.refundSpecs(this.document(receipt.id) as Receipt, { ...input, lines: asked.map(a => ({ receiptLineId: a.line.id, amount: a.amount })) });
      const number = this.nextNumber('RF', 'number', "accounting_documents WHERE kind = 'refund' AND provider = ?", MANUAL_PROVIDER);
      this.insertDocument({ ...refund, number }, MANUAL_PROVIDER);
      for (const line of lines) this.insert(line);
      this.history(user, 'receipt-refund', 'refund', id, null, { ...refund, number }, memo);
    });
    return this.document(id) as Refund;
  }

  // ── Deposits (D-031) ───────────────────────────────────────────────────

  /**
   * Take receipts from Cash on Hand to a bank account: one deposit, numbered
   * D-0001 onwards, and for each fund an out entry from Cash on Hand and an in
   * entry to the bank account. Fund balances do not change. Whole receipts only;
   * the slip total must equal theirs.
   */
  async makeDeposit(actor: LedgerActor, input: NewDeposit): Promise<Deposit> {
    await this.authorize(actor, 'ledger-record');
    const user = actor.actingUsername();
    const account = this.account(text(input.accountId, 'accountId', { required: true, max: 32 }) as string);
    if (account.kind !== 'bank' || !account.configured || !account.active) throw new LedgerError(400, 'accountId: a deposit goes into an open bank account');
    const date = isoDate(input.date, 'date');
    const ids = [...new Set((Array.isArray(input.receiptIds) ? input.receiptIds : []).filter((id): id is string => typeof id === 'string' && id !== ''))];
    if (ids.length === 0) throw new LedgerError(400, 'receiptIds: choose at least one receipt');
    const total = minorUnits(input.total, 'total', { positive: true });
    const slipReference = text(input.slipReference, 'slipReference', { max: 64 }) ?? null;
    const memo = text(input.memo, 'memo', { max: 2000 }) ?? '';
    const receipts = this.depositable(ids, date);
    const sum = receipts.reduce((t, r) => t + r.total, 0);
    if (sum !== total) {
      throw new LedgerError(400, `total: the slip says ${this.formatMoney(total, this.currency)} but the receipts add up to ${this.formatMoney(sum, this.currency)}`);
    }
    const id = this.newId();
    const byFund = new Map<string, number>();
    for (const line of receipts.flatMap(r => r.lines.filter(l => l.status === 'posted'))) byFund.set(line.fundId, (byFund.get(line.fundId) ?? 0) + line.amount);
    const legs = [...byFund].flatMap(([fundId, amount]) => [
      this.newEntry(user, { direction: 'out', amount, date, fundId, accountId: CASH_ON_HAND, category: DEPOSIT, memo: 'deposit' }, { sourceType: DEPOSIT, sourceId: id }),
      this.newEntry(user, { direction: 'in', amount, date, fundId, accountId: account.id, category: DEPOSIT, memo: 'deposit' }, { sourceType: DEPOSIT, sourceId: id })
    ]);

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-record'), action: 'deposit-make',
      severity: 'medium', resource: id, resourceType: 'accounting-deposit',
      metadata: { accountId: account.id, date, total, currency: this.currency, receipts: receipts.map(r => r.number), slipReference }
    });
    let number = '';
    await this.commit(() => {
      this.depositable(ids, date); // again inside the transaction: another deposit may have taken one
      number = this.nextNumber('D', 'number', 'accounting_deposits WHERE 1 = 1');
      const createdAt = this.stamp();
      this.db.prepare(`INSERT INTO accounting_deposits (id, number, date, account_id, slip_reference, total, memo, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`).run(id, number, date, account.id, slipReference, total, memo, user, createdAt);
      for (const r of receipts) {
        this.db.prepare('INSERT INTO accounting_deposit_receipts (deposit_id, receipt_id, amount) VALUES (?, ?, ?)').run(id, r.id, r.total);
      }
      for (const leg of legs) this.insert({ ...leg, memo: memo ? `Deposit ${number}: ${memo}` : `Deposit ${number}` });
      this.history(user, 'deposit-make', 'deposit', id, null, { number, date, accountId: account.id, total, receipts: receipts.map(r => r.id), legs: legs.map(l => l.id) });
    });
    return this.deposit(id);
  }

  /** Undo a deposit, with a reason: its entries are voided and its receipts are back in Cash on Hand. */
  async undoDeposit(actor: LedgerActor, depositId: string, reason: string): Promise<Deposit> {
    await this.authorize(actor, 'ledger-adjust');
    const user = actor.actingUsername();
    const why = text(reason, 'reason', { required: true }) as string;
    const before = this.deposit(text(depositId, 'depositId', { required: true }) as string);
    if (before.status === 'voided') throw new LedgerError(409, `deposit ${before.number} is already undone`);
    this.assertOpen(before.date, 'depositId');
    if (before.clearedDate) throw new LedgerError(409, `deposit ${before.number} is cleared: the bank has it; take the cleared mark off first`);
    const bounced = before.receipts.map(r => this.bounceOf(r.receiptId)).find(Boolean);
    if (bounced) throw new LedgerError(409, `deposit ${before.number} has a bounced check (${bounced.receiptNumber ?? 'a receipt'}); it cannot be undone`);
    const legs = this.depositLegs(before.id);

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-adjust'), action: 'deposit-undo',
      severity: 'high', resource: before.id, resourceType: 'accounting-deposit', reason: why,
      metadata: { number: before.number, total: before.total, voided: legs.map(l => l.id) }
    });
    await this.commit(() => {
      if (this.deposit(before.id).status === 'voided') throw new LedgerError(409, `deposit ${before.number} is already undone`);
      this.db.prepare("UPDATE accounting_deposits SET status = 'voided', void_reason = ? WHERE id = ?").run(why, before.id);
      this.db.prepare('UPDATE accounting_deposit_receipts SET undone = 1 WHERE deposit_id = ?').run(before.id);
      for (const leg of legs) {
        this.db.prepare("UPDATE accounting_transactions SET status = 'voided', void_reason = ? WHERE id = ?").run(why, leg.id);
      }
      this.history(user, 'deposit-undo', 'deposit', before.id, before, { ...before, status: 'voided', voidReason: why }, why);
    });
    return this.deposit(before.id);
  }

  /**
   * Mark a deposit cleared: the bank statement shows it, on `date` (D-032).
   * No money moves; its receipts count as cleared. One standing mark per deposit.
   */
  async clearDeposit(actor: LedgerActor, depositId: string, date: string): Promise<Deposit> {
    await this.authorize(actor, 'ledger-record');
    const user = actor.actingUsername();
    const deposit = this.deposit(text(depositId, 'depositId', { required: true }) as string);
    const cleared = isoDate(date, 'date');
    const check = (): void => {
      const now = this.deposit(deposit.id);
      if (now.status === 'voided') throw new LedgerError(409, `deposit ${now.number} is undone`);
      if (now.clearedDate) throw new LedgerError(409, `deposit ${now.number} is already cleared, on ${now.clearedDate}`);
    };
    check();
    if (cleared < deposit.date) throw new LedgerError(400, `date: the bank cannot clear deposit ${deposit.number} before it was made (${deposit.date})`);
    const id = this.newId();

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-record'), action: 'deposit-clear',
      severity: 'low', resource: deposit.id, resourceType: 'accounting-deposit', metadata: { number: deposit.number, clearedDate: cleared }
    });
    await this.commit(() => {
      check(); // again inside the transaction
      this.db.prepare('INSERT INTO accounting_deposit_clearings (id, deposit_id, cleared_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, deposit.id, cleared, user, this.stamp());
      this.history(user, 'deposit-clear', 'deposit', deposit.id, null, { number: deposit.number, clearedDate: cleared });
    });
    return this.deposit(deposit.id);
  }

  /** Take a wrong cleared mark off a deposit, with a reason. The mark stays in the history. */
  async unclearDeposit(actor: LedgerActor, depositId: string, reason: string): Promise<Deposit> {
    await this.authorize(actor, 'ledger-record');
    const user = actor.actingUsername();
    const why = text(reason, 'reason', { required: true }) as string;
    const deposit = this.deposit(text(depositId, 'depositId', { required: true }) as string);
    const mark = this.clearing(deposit.id);
    if (!mark) throw new LedgerError(409, `deposit ${deposit.number} is not cleared`);

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-record'), action: 'deposit-unclear',
      severity: 'medium', resource: deposit.id, resourceType: 'accounting-deposit', reason: why, metadata: { number: deposit.number, clearedDate: mark.cleared_date }
    });
    await this.commit(() => {
      if (!this.clearing(deposit.id)) throw new LedgerError(409, `deposit ${deposit.number} is not cleared`);
      this.db.prepare('UPDATE accounting_deposit_clearings SET removed = 1, removed_reason = ? WHERE id = ?').run(why, mark.id);
      this.history(user, 'deposit-unclear', 'deposit', deposit.id, { clearedDate: mark.cleared_date }, { clearedDate: null }, why);
    });
    return this.deposit(deposit.id);
  }

  // ── Bounced checks (D-032) ─────────────────────────────────────────────

  /**
   * The bank returned a deposited check. Posts a returned-check entry for each
   * of the receipt's lines (the full amount, out of the bank account it was
   * deposited into, in the line's fund and category) and the bank's fee as a
   * bank-charges expense, and records what the payer owes: check + fee +
   * penalty. The receipt never changes.
   */
  async recordBounce(actor: LedgerActor, receiptId: string, input: { date: string; fee?: number; penalty?: number; memo?: string }): Promise<Bounce> {
    await this.authorize(actor, 'ledger-adjust');
    const user = actor.actingUsername();
    const settings = this.bounceSettings();
    const receipt = this.findDocument(text(receiptId, 'receiptId', { required: true }) as string);
    if (!receipt || receipt.kind !== 'receipt') throw new LedgerError(400, 'receiptId: only a receipt can bounce');
    const name = receipt.number ?? 'this receipt';
    if (receipt.status !== 'posted') throw new LedgerError(409, `receiptId: ${name} is voided`);
    if (receipt.paymentMethod !== CHECK) throw new LedgerError(400, `receiptId: ${name} was not paid by check`);
    const deposit = this.depositRowOf(receipt.id);
    if (!deposit) throw new LedgerError(409, `receiptId: ${name} is not in a deposit: a check never taken to the bank is voided as a mistake, not bounced`);
    if (this.bounceOf(receipt.id)) throw new LedgerError(409, `receiptId: ${name} has already bounced`);
    const date = isoDate(input.date, 'date');
    if (date < deposit.date) throw new LedgerError(400, `date: ${name} cannot come back before its deposit ${deposit.number} (${deposit.date})`);
    const fee = input.fee === undefined || input.fee === null ? 0 : minorUnits(input.fee, 'fee', { positive: false });
    const penalty = input.penalty === undefined || input.penalty === null ? settings.penalty : minorUnits(input.penalty, 'penalty', { positive: false });
    if (fee < 0 || penalty < 0) throw new LedgerError(400, 'fee and penalty cannot be less than 0');
    const memo = text(input.memo, 'memo', { max: 2000 }) ?? '';
    const id = this.newId();
    const why = `Returned check ${name}${memo ? `: ${memo}` : ''}`;
    const lines = receipt.lines.filter(l => l.status === 'posted');
    const entries = [
      ...lines.map(l => this.newEntry(user, {
        direction: 'out', amount: l.amount, date, fundId: l.fundId, category: l.category, accountId: deposit.accountId,
        partyName: receipt.partyName ?? undefined, paymentMethod: CHECK, paymentMethodId: receipt.paymentMethodId ?? undefined, memo: why
      }, { sourceType: RETURNED_CHECK, sourceId: id })),
      ...(fee > 0 ? [this.newEntry(user, {
        direction: 'out', amount: fee, date, fundId: lines[0].fundId, category: settings.bankCharges.code, accountId: deposit.accountId,
        memo: `Bank fee for returned check ${name}`
      }, { sourceType: BOUNCE_FEE, sourceId: id })] : [])
    ];
    const checkAmount = lines.reduce((t, l) => t + l.amount, 0);

    await this.audit(actor, {
      eventType: this.host.addonAuditEventName('ledger-adjust'), action: 'check-bounce',
      severity: 'high', resource: receipt.id, resourceType: 'accounting-receipt', reason: memo || undefined,
      metadata: { bounceId: id, receipt: receipt.number, deposit: deposit.number, checkAmount, fee, penalty, currency: this.currency }
    });
    await this.commit(() => {
      if (this.bounceOf(receipt.id)) throw new LedgerError(409, `receiptId: ${name} has already bounced`);
      this.db.prepare(`INSERT INTO accounting_bounces (id, receipt_id, deposit_id, date, account_id, check_amount, fee, penalty, memo, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, receipt.id, deposit.id, date, deposit.accountId, checkAmount, fee, penalty, memo, user, this.stamp());
      for (const e of entries) this.insert(e);
      this.history(user, 'check-bounce', 'bounce', id, null, { receipt: receipt.number, deposit: deposit.number, checkAmount, fee, penalty, entries: entries.map(e => e.id) }, memo || undefined);
    });
    return this.bounce(id);
  }

  /**
   * A payment toward a bounced check: one receipt whose lines fill in order
   * (D-032): the check amount in the receipt's own lines and categories, then
   * the fee against bank charges, then the penalty as other income. Never more
   * than is still owed.
   */
  async repayBounce(actor: LedgerActor, bounceId: string, input: { amount: number; date: string; paymentMethod: string; paymentMethodId?: string; accountId?: string; memo?: string }): Promise<Receipt> {
    await this.authorize(actor, 'ledger-record');
    const settings = this.bounceSettings();
    const bounce = this.bounce(text(bounceId, 'bounceId', { required: true }) as string);
    const amount = minorUnits(input.amount, 'amount', { positive: true });
    if (bounce.stillOwed <= 0) throw new LedgerError(409, `bounceId: ${bounce.receiptNumber ?? 'this check'} is already repaid`);
    if (amount > bounce.stillOwed) throw new LedgerError(400, `amount is more than is still owed (${this.formatMoney(bounce.stillOwed, this.currency)})`);
    const receipt = this.document(bounce.receiptId) as Receipt;
    const firstFund = receipt.lines[0].fundId;
    const parts = [
      ...receipt.lines.filter(l => l.status === 'posted').map(l => ({ fundId: l.fundId, category: l.category, amount: l.amount })),
      { fundId: firstFund, category: settings.bankCharges.code, amount: bounce.fee },
      { fundId: firstFund, category: settings.otherIncome.code, amount: bounce.penalty }
    ];
    // Skip what earlier repayments covered, in the same order, then fill with this one.
    let covered = bounce.repaid;
    let left = amount;
    const lines: NewLine[] = [];
    for (const part of parts) {
      const already = Math.min(part.amount, covered);
      covered -= already;
      const take = Math.min(part.amount - already, left);
      if (take > 0) lines.push({ fundId: part.fundId, category: part.category, amount: take });
      left -= take;
    }
    return this.postReceipt(actor, {
      lines, date: input.date, partyName: bounce.partyName ?? 'unknown', paymentMethod: input.paymentMethod, paymentMethodId: input.paymentMethodId,
      accountId: input.accountId, memo: text(input.memo, 'memo', { max: 2000 }) ?? `Repayment of bounced check ${bounce.receiptNumber ?? ''}`.trim(),
      reference: { type: BOUNCED_CHECK, id: bounce.id }
    }, { provider: MANUAL_PROVIDER });
  }

  /** Bounced checks, newest first, with what is owed, repaid and still owed. `settled` filters. */
  async listBounces(actor: LedgerActor, filter: { settled?: boolean } = {}): Promise<Bounce[]> {
    await this.authorize(actor, 'ledger-read');
    return (this.db.prepare('SELECT id FROM accounting_bounces ORDER BY date DESC, created_at DESC').all() as { id: string }[])
      .map(r => this.bounce(r.id))
      .filter(b => filter.settled === undefined || (b.stillOwed <= 0) === filter.settled);
  }

  /** Deposits, newest first; undone ones only when asked. */
  async listDeposits(actor: LedgerActor, filter: { includeVoided?: boolean } = {}): Promise<Deposit[]> {
    await this.authorize(actor, 'ledger-read');
    const rows = this.db.prepare(`SELECT id FROM accounting_deposits ${filter.includeVoided ? '' : "WHERE status = 'posted'"}
      ORDER BY date DESC, created_at DESC`).all() as { id: string }[];
    return rows.map(r => this.deposit(r.id));
  }

  async getDeposit(actor: LedgerActor, depositId: string): Promise<Deposit> {
    await this.authorize(actor, 'ledger-read');
    return this.deposit(depositId);
  }

  /** The receipts a deposit can take: posted, in Cash on Hand, in no deposit that stands. Oldest first. */
  async receiptsToDeposit(actor: LedgerActor): Promise<Receipt[]> {
    await this.authorize(actor, 'ledger-read');
    return (this.db.prepare(`SELECT id FROM accounting_documents d
      WHERE d.kind = 'receipt' AND d.status = 'posted' AND d.account_id = ?
        AND NOT EXISTS (SELECT 1 FROM accounting_deposit_receipts r WHERE r.receipt_id = d.id AND r.undone = 0)
      ORDER BY d.date, d.created_at`).all(CASH_ON_HAND) as { id: string }[]).map(r => this.document(r.id) as Receipt);
  }

  /** Receipts or refunds, newest first; voided ones only when asked (D-033). */
  async listDocuments(actor: LedgerActor, kind: 'receipt' | 'refund', filter: { includeVoided?: boolean } = {}): Promise<(Receipt | Refund)[]> {
    await this.authorize(actor, 'ledger-read');
    return this.documents(kind, filter);
  }

  /**
   * The caller's own receipts, or refunds of them: those whose payer is the
   * caller's own ngdpbase person (D-037). Needs ledger-self, which every
   * signed-in person holds; the modules show their own lines from it (gifts,
   * dues payments).
   */
  async ownDocuments(actor: LedgerActor, kind: 'receipt' | 'refund', filter: { includeVoided?: boolean } = {}): Promise<(Receipt | Refund)[]> {
    await this.authorize(actor, 'ledger-self');
    const personId = await this.personOf(actor.actingUsername());
    if (!personId) return [];
    const own = this.documents('receipt', filter).filter(d => d.partyPersonId === personId);
    if (kind === 'receipt') return own;
    const ids = new Set(own.map(r => r.id));
    return this.documents('refund', filter).filter(d => ids.has((d as Refund).receiptId));
  }

  /** One receipt or refund, with its lines. */
  async getDocument(actor: LedgerActor, id: string): Promise<Receipt | Refund> {
    await this.authorize(actor, 'ledger-read');
    return this.document(id);
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

  private newEntry(user: string, input: NewTransaction, link: { sourceType: string; sourceId?: string; voidsId?: string; transferId?: string; provider?: string; confirmationNumber?: string; documentId?: string; lineOf?: string }): Transaction {
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
      date: this.openDate(isoDate(input.date, 'date')),
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
      documentId: link.documentId ?? null,
      lineOf: link.lineOf ?? null,
      // Every money movement says why (D-029).
      memo: text(input.memo, 'memo', { required: true, max: 2000 }) as string,
      createdBy: user,
      createdAt: this.stamp()
    };
  }

  private insert(t: Transaction): void {
    this.db.prepare(`INSERT INTO accounting_transactions (id, direction, amount, currency, date, fund_id, account_id, category,
        party_person_id, party_name, payment_method, payment_method_id, provider, confirmation_number,
        source_type, source_id, status, voids_id, voided_by_id, void_reason, transfer_id, document_id, line_of, memo, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id, t.direction, t.amount, t.currency, t.date, t.fundId, t.accountId, t.category, t.partyPersonId, t.partyName,
      t.paymentMethod, t.paymentMethodId, t.provider, t.confirmationNumber, t.sourceType, t.sourceId, t.status,
      t.voidsId, t.voidedById, t.voidReason, t.transferId, t.documentId, t.lineOf, t.memo, t.createdBy, t.createdAt);
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
      .map((id): Account => ({ id, name: id, kind: 'bank', isDefault: false, active: false, configured: false, routingNumber: null, accountNumberLast4: null }));
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

  private deposit(depositId: string): Deposit {
    const row = this.db.prepare('SELECT * FROM accounting_deposits WHERE id = ?').get(depositId) as DepositRow | undefined;
    if (!row) throw new LedgerError(404, 'unknown deposit');
    const receipts = (this.db.prepare('SELECT receipt_id, amount FROM accounting_deposit_receipts WHERE deposit_id = ? ORDER BY rowid')
      .all(depositId) as { receipt_id: string; amount: number }[]).map(r => ({ receiptId: r.receipt_id, amount: r.amount }));
    return {
      id: row.id, number: row.number, date: row.date, accountId: row.account_id, slipReference: row.slip_reference, total: row.total,
      memo: row.memo, status: row.status, voidReason: row.void_reason, receipts, clearedDate: this.clearing(depositId)?.cleared_date ?? null,
      createdBy: row.created_by, createdAt: row.created_at
    };
  }

  /** A deposit's standing cleared mark, if any. */
  private clearing(depositId: string): { id: string; cleared_date: string } | undefined {
    return this.db.prepare('SELECT id, cleared_date FROM accounting_deposit_clearings WHERE deposit_id = ? AND removed = 0')
      .get(depositId) as { id: string; cleared_date: string } | undefined;
  }

  /** The posted entries a deposit made. */
  private depositLegs(depositId: string): Transaction[] {
    return (this.db.prepare("SELECT * FROM accounting_transactions WHERE source_type = ? AND source_id = ? AND status = 'posted'")
      .all(DEPOSIT, depositId) as TransactionRow[]).map(toTransaction);
  }

  /** The number of the standing deposit a receipt is in, if any. */
  /** The standing deposit a receipt is in. */
  private depositRowOf(receiptId: string): { id: string; number: string; date: string; accountId: string } | undefined {
    const row = this.db.prepare(`SELECT d.id, d.number, d.date, d.account_id FROM accounting_deposit_receipts r JOIN accounting_deposits d ON d.id = r.deposit_id
      WHERE r.receipt_id = ? AND r.undone = 0 AND d.status = 'posted'`).get(receiptId) as { id: string; number: string; date: string; account_id: string } | undefined;
    return row ? { id: row.id, number: row.number, date: row.date, accountId: row.account_id } : undefined;
  }

  private bounce(id: string): Bounce {
    const row = this.db.prepare(`SELECT b.*, d.number AS deposit_number, r.number AS receipt_number, r.party_name
      FROM accounting_bounces b JOIN accounting_deposits d ON d.id = b.deposit_id JOIN accounting_documents r ON r.id = b.receipt_id
      WHERE b.id = ?`).get(id) as {
        id: string; receipt_id: string; deposit_id: string; date: string; account_id: string; check_amount: number; fee: number; penalty: number;
        memo: string; created_by: string; created_at: string; deposit_number: string; receipt_number: string | null; party_name: string | null;
      } | undefined;
    if (!row) throw new LedgerError(404, 'unknown bounced check');
    const repaid = (this.db.prepare(`SELECT COALESCE(SUM(total), 0) AS total FROM accounting_documents
      WHERE kind = 'receipt' AND status = 'posted' AND source_type = ? AND source_id = ?`).get(BOUNCED_CHECK, id) as { total: number }).total;
    const owed = row.check_amount + row.fee + row.penalty;
    return {
      id: row.id, receiptId: row.receipt_id, receiptNumber: row.receipt_number, depositId: row.deposit_id, depositNumber: row.deposit_number,
      date: row.date, partyName: row.party_name, accountId: row.account_id, checkAmount: row.check_amount, fee: row.fee, penalty: row.penalty,
      owed, repaid, stillOwed: owed - repaid, memo: row.memo, createdBy: row.created_by, createdAt: row.created_at
    };
  }

  /** The bounce of a receipt, if it bounced. */
  private bounceOf(receiptId: string): Bounce | undefined {
    const row = this.db.prepare('SELECT id FROM accounting_bounces WHERE receipt_id = ?').get(receiptId) as { id: string } | undefined;
    return row ? this.bounce(row.id) : undefined;
  }

  /**
   * The categories a bounce uses, from configuration (D-032): bank charges must
   * be an expense in the chart, other income an other-income. Until both are,
   * bounces are refused, saying which is wrong.
   */
  private bounceSettings(): { bankCharges: Category; otherIncome: Category; penalty: number } {
    const raw = this.bouncedChecksConfig();
    const chart = new Map(this.categories().map(c => [c.code, c]));
    const pick = (code: unknown, key: string, type: CategoryType): Category => {
      const found = typeof code === 'string' ? chart.get(code) : undefined;
      if (!found || found.type !== type) throw new LedgerError(409, `bounced checks are off: ngdpbase.addons.accounting.${key} must name a category of type ${type} in the chart`);
      return found;
    };
    const penalty = typeof raw.penalty === 'number' && Number.isSafeInteger(raw.penalty) && raw.penalty >= 0 ? raw.penalty : 0;
    return { bankCharges: pick(raw.bankChargesCategory, 'bank-charges-category', 'expense'), otherIncome: pick(raw.otherIncomeCategory, 'other-income-category', 'other-income'), penalty };
  }

  private depositOf(receiptId: string): string | null {
    const row = this.db.prepare(`SELECT d.number FROM accounting_deposit_receipts r JOIN accounting_deposits d ON d.id = r.deposit_id
      WHERE r.receipt_id = ? AND r.undone = 0`).get(receiptId) as { number: string } | undefined;
    return row?.number ?? null;
  }

  /** The receipts, checked one by one: each must be able to go into a deposit dated `date`. */
  private depositable(ids: string[], date: string): Receipt[] {
    return ids.map(id => {
      const t = this.findDocument(id);
      if (!t || t.kind !== 'receipt') {
        if (!t) this.transaction(id); // an unknown id is a 404
        throw new LedgerError(400, `receiptIds: ${t?.number ?? 'this entry'} is not a receipt`);
      }
      const name = t.number ?? 'this receipt';
      if (t.status !== 'posted') throw new LedgerError(409, `receiptIds: ${name} is voided`);
      if (t.accountId !== CASH_ON_HAND) throw new LedgerError(409, `receiptIds: ${name} is not in Cash on Hand`);
      const already = this.depositOf(t.id);
      if (already) throw new LedgerError(409, `receiptIds: ${name} is already in deposit ${already}`);
      if (t.date > date) throw new LedgerError(400, `receiptIds: ${name} is dated after the deposit`);
      return t;
    });
  }

  /** The site's categories, parsed on each read: configuration is the source (D-034). */
  categories(): Category[] {
    return categoriesFrom(this.categoriesConfig());
  }

  private lockSettings(): LockSettings {
    const row = this.db.prepare('SELECT period, fiscal_start_month FROM accounting_lock_settings ORDER BY seq DESC LIMIT 1')
      .get() as { period: LockPeriod; fiscal_start_month: number } | undefined;
    return row ? { period: row.period, fiscalStartMonth: row.fiscal_start_month } : DEFAULT_LOCK_SETTINGS;
  }

  private latestLock(): { id: string; through_date: string } | undefined {
    return this.db.prepare('SELECT id, through_date FROM accounting_period_locks WHERE removed = 0 ORDER BY through_date DESC, created_at DESC LIMIT 1')
      .get() as { id: string; through_date: string } | undefined;
  }

  /** The date everything is locked through, or null. */
  private lockedThrough(): string | null {
    return this.latestLock()?.through_date ?? null;
  }

  /** The period ends that can be locked now: after the current lock (or the last two years), up to today. */
  private lockablePeriods(): string[] {
    const today = this.today();
    const twoYearsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
    return periodEnds(this.lockSettings(), this.lockedThrough() ?? twoYearsAgo, today);
  }

  private openDate(date: string): string {
    this.assertOpen(date);
    return date;
  }

  /** Refuse anything dated in a locked period (#19). */
  private assertOpen(date: string, field = 'date'): void {
    const through = this.lockedThrough();
    if (through && date <= through) {
      throw new LedgerError(409, `${field}: ${date} is in a locked period (locked through ${through}); the treasurer unlocks it first`);
    }
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
    return this.nextNumber('R', 'number', "accounting_documents WHERE kind = 'receipt' AND provider = ?", MANUAL_PROVIDER);
  }

  /**
   * One sequence's next number: the prefix, a dash, and one past the highest
   * number ever used, at least four digits and with no upper limit (R-0001,
   * R-10000, D-30000000). Only the digits count, never the prefix (D-031).
   */
  private nextNumber(prefix: 'R' | 'D' | 'RF', column: string, fromWhere: string, ...params: unknown[]): string {
    const row = this.db.prepare(`SELECT MAX(CAST(SUBSTR(${column}, ${prefix.length + 2}) AS INTEGER)) AS last
      FROM ${fromWhere} AND ${column} LIKE '${prefix}-%'`).get(...params) as { last: number | null };
    return `${prefix}-${String((row.last ?? 0) + 1).padStart(4, '0')}`;
  }

  /** What has been refunded of a receipt so far (posted refunds only). */
  private refunded(receipt: Receipt): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM accounting_transactions
      WHERE source_type = ? AND source_id = ? AND status = 'posted'`).get(RECEIPT_REFUND, receipt.id) as { total: number };
    return row.total;
  }

  private refundable(receipt: Receipt): number {
    return receipt.status === 'posted' ? receipt.total - this.refunded(receipt) : 0;
  }

  /** What is left to refund on one receipt line. */
  private lineLeft(line: DocumentLine): number {
    if (line.status !== 'posted') return 0;
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM accounting_transactions
      WHERE line_of = ? AND status = 'posted'`).get(line.id) as { total: number };
    return line.amount - row.total;
  }

  /** A line's module details, each checked by the module that registered its kind. */
  private lineDetails(given: unknown, line: Transaction): Record<string, Record<string, unknown>> {
    if (given === undefined || given === null) return {};
    if (typeof given !== 'object' || Array.isArray(given)) throw new LedgerError(400, 'details must be an object of kinds');
    const out: Record<string, Record<string, unknown>> = {};
    for (const [kind, data] of Object.entries(given as Record<string, unknown>)) {
      const definition = this.lineKinds.get(kind);
      if (!definition) throw new LedgerError(400, `details: no module on this site records '${kind}' details`);
      try {
        out[kind] = definition.validate(data, { amount: line.amount, category: line.category, fundId: line.fundId });
      } catch (err) {
        // A module throws a plain Error naming the field; it is the caller's mistake, refused as one.
        if (err instanceof LedgerError) throw err;
        throw new LedgerError(400, err instanceof Error ? err.message : `details.${kind} are not valid`);
      }
    }
    return out;
  }

  /** A new receipt's lines: `lines`, or the one line its amount, fund and category make. */
  private lineSpecs(input: NewReceipt): NewLine[] {
    if (input.lines === undefined) return [{ amount: input.amount as number, fundId: input.fundId as string, category: input.category as string }];
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new LedgerError(400, 'lines: a receipt needs at least one line');
    if (input.lines.length > MAX_LINES) throw new LedgerError(400, `lines: a receipt has at most ${MAX_LINES} lines`);
    return input.lines.map((line, i) => {
      if (!line || typeof line !== 'object') throw new LedgerError(400, `lines[${i}]: a line needs an amount, a fund and a category`);
      return line;
    });
  }

  /**
   * Build one line, and when the caller gave lines, say which one a refusal is
   * about: "lines[1].category is required", the key the forms lines field
   * shows a message under (ngdpbase #1913).
   */
  private asLine<T>(named: boolean, index: number, build: () => T): T {
    try {
      return build();
    } catch (err) {
      if (!named || !(err instanceof LedgerError)) throw err;
      const onField = /^(amount|fundId|category|memo|accountId)\b/.test(err.message);
      throw new LedgerError(err.status, onField ? `lines[${index}].${err.message}` : `lines[${index}]: ${err.message}`);
    }
  }

  /** The receipt lines a refund gives back, and how much of each: checked against what is left on each line. */
  private refundSpecs(receipt: Receipt, input: ReceiptRefund): { line: DocumentLine; amount: number }[] {
    const posted = receipt.lines.filter(l => l.status === 'posted');
    const named = Array.isArray(input.lines);
    let asked: { receiptLineId: string; amount?: number }[];
    if (named) {
      if ((input.lines as unknown[]).length === 0) throw new LedgerError(400, 'lines: name at least one line to refund');
      asked = input.lines as { receiptLineId: string; amount?: number }[];
    } else {
      if (posted.length !== 1) throw new LedgerError(400, `lines: ${receipt.number ?? 'this receipt'} has several lines; name the lines to refund`);
      asked = [{ receiptLineId: posted[0].id, amount: input.amount }];
    }
    const taken = new Map<string, number>();
    return asked.map((a, i) => {
      const at = named ? `lines[${i}].` : '';
      const line = posted.find(l => l.id === a?.receiptLineId);
      if (!line) throw new LedgerError(400, `${at}receiptLineId: not a line of ${receipt.number ?? 'this receipt'}`);
      const left = this.lineLeft(line) - (taken.get(line.id) ?? 0);
      if (left <= 0) throw new LedgerError(409, named ? `${at}receiptLineId: this line is already fully refunded` : 'this receipt is already fully refunded');
      const amount = a.amount === undefined ? left : minorUnits(a.amount, `${at}amount`, { positive: true });
      if (amount > left) throw new LedgerError(400, `${at}amount is more than is left to refund (${this.formatMoney(left, this.currency)})`);
      taken.set(line.id, (taken.get(line.id) ?? 0) + amount);
      return { line, amount };
    });
  }

  private insertDocument(d: Receipt | Refund, provider: string | null = d.kind === 'receipt' ? d.provider : MANUAL_PROVIDER): void {
    this.db.prepare(`INSERT INTO accounting_documents (id, kind, number, provider, date, party_person_id, party_name, payment_method,
        payment_method_id, account_id, total, memo, source_type, source_id, status, void_reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?)`).run(
      d.id, d.kind, d.number, provider, d.date, d.partyPersonId, d.partyName, d.paymentMethod, d.paymentMethodId, d.accountId, d.total, d.memo,
      d.kind === 'receipt' ? d.reference?.type ?? null : 'receipt', d.kind === 'receipt' ? d.reference?.id ?? null : d.receiptId,
      d.createdBy, d.createdAt);
  }

  private findDocument(id: string): Receipt | Refund | undefined {
    const row = this.db.prepare('SELECT * FROM accounting_documents WHERE id = ?').get(id) as DocumentRow | undefined;
    if (!row) return undefined;
    const detailRows = this.db.prepare(`SELECT d.line_id, d.kind, d.data FROM accounting_line_details d
      JOIN accounting_transactions t ON t.id = d.line_id WHERE t.document_id = ?`).all(id) as { line_id: string; kind: string; data: string }[];
    const byLine = new Map<string, Record<string, Record<string, unknown>>>();
    for (const r of detailRows) byLine.set(r.line_id, { ...byLine.get(r.line_id), [r.kind]: JSON.parse(r.data) as Record<string, unknown> });
    const lines = (this.db.prepare('SELECT * FROM accounting_transactions WHERE document_id = ? ORDER BY rowid').all(id) as TransactionRow[])
      .map(toTransaction).map(t => toLine(t, byLine.get(t.id)));
    const base = {
      id: row.id, number: row.number, date: row.date, partyName: row.party_name, partyPersonId: row.party_person_id,
      paymentMethod: row.payment_method, paymentMethodId: row.payment_method_id, accountId: row.account_id, total: row.total,
      memo: row.memo, status: row.status, voidReason: row.void_reason, lines, createdBy: row.created_by, createdAt: row.created_at
    };
    return row.kind === 'receipt'
      ? { ...base, kind: 'receipt', provider: row.provider, reference: row.source_type && row.source_id ? { type: row.source_type, id: row.source_id } : null,
          bounced: Boolean(this.db.prepare('SELECT 1 FROM accounting_bounces WHERE receipt_id = ?').get(row.id)) }
      : { ...base, kind: 'refund', receiptId: row.source_id as string };
  }

  private document(id: string): Receipt | Refund {
    const found = this.findDocument(id);
    if (!found) throw new LedgerError(404, 'unknown receipt or refund');
    return found;
  }

  /** Receipts or refunds, newest first. */
  /** Posted receipt lines carrying a kind of details, bounced checks left out, net of refunds. */
  private linesOfKind(kind: string): ReturnType<LineDetailsReader['lines']> {
    const refunded = new Map<string, number>();
    for (const r of this.documents('refund')) for (const l of r.lines) {
      if (l.status === 'posted' && l.receiptLineId) refunded.set(l.receiptLineId, (refunded.get(l.receiptLineId) ?? 0) + l.amount);
    }
    const out: ReturnType<LineDetailsReader['lines']> = [];
    for (const r of this.documents('receipt') as Receipt[]) {
      if (r.bounced) continue;
      for (const l of r.lines) {
        const details = l.details[kind];
        if (l.status !== 'posted' || !details) continue;
        const amount = l.amount - (refunded.get(l.id) ?? 0);
        if (amount > 0) out.push({ lineId: l.id, receiptId: r.id, date: r.date, amount, details });
      }
    }
    return out;
  }

  private documents(kind: 'receipt' | 'refund', { includeVoided = false } = {}): (Receipt | Refund)[] {
    return (this.db.prepare(`SELECT id FROM accounting_documents WHERE kind = ? ${includeVoided ? '' : "AND status = 'posted'"}
      ORDER BY date DESC, created_at DESC`).all(kind) as { id: string }[]).map(r => this.document(r.id));
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private today(): string {
    return this.stamp().slice(0, 10);
  }
}
