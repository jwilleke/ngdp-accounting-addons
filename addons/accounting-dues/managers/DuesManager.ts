/**
 * DuesManager — the dues add-on's one door (D-035): invoices in this add-on's
 * own database, outside the ledger, which holds only money that moved. A
 * payment is an ordinary receipt (R-number) whose line has `dues` details
 * naming the account; this manager reads those through LedgerManager and never
 * touches the accounting database.
 *
 * Accounts come from a manager named in configuration (CondoUnitManager for a
 * condominium): this one keeps no copy of them, only the money side.
 *
 * Every write: ask the decision point for `invoice-issue`, write the audit
 * record and wait for it (on-failure: refuse), then change the rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import { billingMonth, chargeFor, lateChargesDue, settle, type Assessment, type Billed, type LateChargeRule, type Payment, type ProposedLateCharge } from '../billing.js';
import { renderInvoice, type InvoiceWording } from './invoice.js';

export type DuesHost = Pick<AddonHost, 'actorOf' | 'addonAuditEventName'>;

/** The caller: ngdpbase's ApiContext satisfies this, as it does LedgerManager's. */
export interface DuesActor {
  enforceDeny(permission: string, decision: Decision): Promise<never>;
  actingUsername(): string;
  readonly ipAddress: string | undefined;
  readonly subject: ActorContext | null;
}

export interface DuesDb {
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T;
}

/** An owner as billed (CondoUnitManager.owners): an ngdpbase user and the percent they pay. */
export interface AccountOwner { username: string; name: string; email: string | null; share: number }

/** The manager that holds the accounts billed (D-035); for a condominium, CondoUnitManager. */
export interface AccountSource {
  list(): ({ id: string } & Record<string, unknown>)[];
  get(id: string): ({ id: string } & Record<string, unknown>) | undefined;
  assessment(id: string): Assessment | null;
  owners(ctx: ActorContext, id: string): Promise<AccountOwner[]>;
  lateCharges?(): LateChargeRule[];
}

/** The slice of the accounting add-on's LedgerManager this one calls. */
export interface LedgerLike {
  currencyCode(): string;
  listDocuments(actor: DuesActor, kind: 'receipt' | 'refund', filter?: { includeVoided?: boolean }): Promise<{
    id: string; status: 'posted' | 'voided'; bounced?: boolean;
    lines: { id: string; amount: number; status: 'posted' | 'voided'; receiptLineId: string | null; details: Record<string, Record<string, unknown>> }[];
  }[]>;
  toFormOptions(options: Record<string, string>, viewer?: unknown): Promise<{ value: string; label: string }[]>;
}

/** A refusal the caller can fix. Named LedgerError so the forms show it on the field, as the ledger's are. */
export class DuesError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface InvoiceLine {
  description: string; amount: number; kind: 'charge' | 'late-charge'; category: string;
  ruleId: string | null; appliesTo: string | null;
}

export interface Invoice {
  id: string; number: string; accountId: string; accountLabel: string; month: string; date: string; dueDate: string;
  total: number; previous: number; owed: number; owners: { username: string; name: string; share: number }[];
  lines: InvoiceLine[]; html: string; sha256: string;
  status: 'issued' | 'voided'; voidReason: string | null; emailedTo: string | null; emailedAt: string | null;
  createdBy: string; createdAt: string;
  /** What payments have settled of it so far, and what is left. */
  paid: number; remaining: number;
}

/** One account's month, for the Prepare This Month's Invoices page. */
export interface MonthRow {
  accountId: string; label: string;
  charge: { dueDate: string; amount: number } | null;
  lateCharges: ProposedLateCharge[];
  /** Owed before this month; negative is a credit. */
  previous: number;
  total: number;
  owed: number;
  /** The month's invoice, when already issued. */
  invoiced: string | null;
}

export interface AccountBalance { accountId: string; label: string; invoiced: number; paid: number; balance: number }

export interface DuesOptions {
  host: DuesHost;
  db: DuesDb;
  ledger: LedgerLike;
  /** The account source; looked up when used, so it may arrive after this manager. */
  accounts: () => AccountSource | null | undefined;
  recordAudit: (record: Record<string, unknown>) => Promise<void>;
  decide: (subject: ActorContext | null, request: { action: string }) => Promise<Decision>;
  /** Chart codes a payment may use; the first is the one invoices charge (configuration). */
  categories: () => string[];
  /** The module's word for the charge (configuration): Dues, Assessment. */
  label: () => { singular: string; plural: string };
  wording?: () => InvoiceWording;
  formatMoney: (minor: number) => string;
  /** Told after every committed write; index.ts bumps the `DuesManager` cache topic (ngdpbase caching guide: the owner bumps). */
  changed?: () => Promise<void>;
  /** The account source's manager name, for pages to depend on its cache topic. */
  accountsManager?: string;
  /** ngdpbase's EmailManager, to send invoices. */
  email?: () => { sendTo(to: string, subject: string, text: string, html?: string): Promise<void> } | null | undefined;
  now?: () => Date;
  newId?: () => string;
}

interface InvoiceRow {
  id: string; number: string; account_id: string; account_label: string; month: string; date: string; due_date: string;
  total: number; previous: number; owed: number; owners: string; html: string; sha256: string; status: 'issued' | 'voided';
  void_reason: string | null; emailed_to: string | null; emailed_at: string | null; created_by: string; created_at: string;
}
interface LineRow { invoice_id: string; position: number; kind: 'charge' | 'late-charge'; description: string; amount: number; category: string; rule_id: string | null; applies_to: string | null; charge_key: string | null }

/** What an account's money looks like: its issued invoices, what payments settled, and the balance. */
interface AccountState { invoices: Billed[]; paid: Map<string, number>; credit: number; invoiced: number; payments: number }

export default class DuesManager {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: DuesOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  // ── The month ──────────────────────────────────────────────────────────

  /**
   * What each account would be invoiced for a month, without issuing: its
   * charge, the late charges due on earlier invoices (as of the 1st of the
   * month), the balance brought forward and the amount owed. Needs ledger-read.
   */
  async prepareMonth(actor: DuesActor, month: string): Promise<MonthRow[]> {
    await this.authorize(actor, 'ledger-read');
    const m = this.month(month);
    const source = this.source();
    const states = await this.states(actor);
    const rules = source.lateCharges?.() ?? [];
    const made = this.madeKeys();
    const rows: MonthRow[] = [];
    for (const unit of source.list()) {
      const state = states.get(unit.id) ?? emptyState();
      const charge = chargeFor(source.assessment(unit.id), m);
      const lateCharges = lateChargesDue(state.invoices, state.paid, rules, `${m}-01`, made);
      const existing = this.monthInvoice(unit.id, m);
      if (existing) {
        // Already invoiced: the invoice's own figures, as issued.
        rows.push({ accountId: unit.id, label: accountLabel(unit), charge, lateCharges: [], previous: existing.previous, total: existing.total, owed: existing.owed, invoiced: existing.number });
        continue;
      }
      if (!charge && !lateCharges.length) continue;
      const previous = state.invoiced - state.payments;
      const total = (charge?.amount ?? 0) + lateCharges.reduce((t, l) => t + l.amount, 0);
      rows.push({ accountId: unit.id, label: accountLabel(unit), charge, lateCharges, previous, total, owed: Math.max(0, previous + total), invoiced: null });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  /**
   * Issue a month's invoices: one per account with something charged that has
   * none for the month yet, or one account. Each is stored exactly as issued.
   * Late charges are added only when the treasurer says so (`lateCharges`),
   * having seen them on the Prepare page. With `email`, an invoice with
   * something owed is sent to each owner with an email on file; one fully paid
   * by credit is kept, and not sent.
   */
  async issueMonth(actor: DuesActor, input: { month: string; account?: string; lateCharges?: boolean; email?: boolean }): Promise<{ issued: number; emailed: number; notEmailed: string[] }> {
    await this.authorize(actor, 'invoice-issue');
    const month = this.month(input.month);
    let rows = (await this.prepareMonth(actor, month)).filter(r => !r.invoiced);
    if (input.account) {
      const row = rows.find(r => r.accountId === input.account);
      if (!row) throw new DuesError(409, `account: nothing to invoice for ${month}, or it is already invoiced`);
      rows = [row];
    }
    const source = this.source();
    const pending: { row: MonthRow; late: ProposedLateCharge[]; owners: AccountOwner[] }[] = [];
    for (const row of rows) {
      const late = input.lateCharges ? row.lateCharges : [];
      if (!row.charge && !late.length) continue;
      // Owners are read as the treasurer (or a job), so the read is attributed (ngdpbase-addons#11).
      pending.push({ row, late, owners: await source.owners(actor.subject as ActorContext, row.accountId) });
    }
    await this.audit(actor, { action: 'invoice-issue', severity: 'high', resource: `invoices:${month}`, resourceType: 'dues-invoice',
      metadata: { month, count: pending.length, accounts: pending.map(p => p.row.accountId), lateCharges: input.lateCharges === true, email: input.email === true } });
    let emailed = 0;
    const notEmailed: string[] = [];
    for (const p of pending) {
      const id = this.insertInvoice(actor, month, p.row, p.late, p.owners);
      if (input.email && this.row(id).owed > 0) {
        if (await this.sendInvoice(id, p.owners)) emailed++; else notEmailed.push(p.row.label);
      }
    }
    if (pending.length) await this.options.changed?.();
    return { issued: pending.length, emailed, notEmailed };
  }

  /** Void an invoice, with a reason; the month can then be invoiced again. */
  async voidInvoice(actor: DuesActor, invoiceId: string, reason: string): Promise<Invoice> {
    await this.authorize(actor, 'invoice-issue');
    const why = text(reason, 'reason');
    const row = this.row(text(invoiceId, 'invoiceId'));
    if (row.status === 'voided') throw new DuesError(409, 'invoiceId: this invoice is already voided');
    await this.audit(actor, { action: 'invoice-void', severity: 'high', resource: row.id, resourceType: 'dues-invoice', reason: why,
      metadata: { number: row.number, account: row.account_id, month: row.month, total: row.total } });
    this.options.db.transaction(() => {
      this.options.db.prepare("UPDATE accounting_dues_invoices SET status = 'voided', void_reason = ? WHERE id = ? AND status = 'issued'").run(why, row.id);
    })();
    await this.options.changed?.();
    return this.getInvoice(actor, row.id);
  }

  // ── Reading ────────────────────────────────────────────────────────────

  /** An invoice, exactly as issued, with what has been paid of it. Needs ledger-read. */
  async getInvoice(actor: DuesActor, invoiceId: string): Promise<Invoice> {
    await this.authorize(actor, 'ledger-read');
    const row = this.row(invoiceId);
    return this.toInvoice(row, (await this.states(actor)).get(row.account_id) ?? emptyState());
  }

  /** Invoices, newest first; one account's, or one month's; voided ones only when asked. Needs ledger-read. */
  async listInvoices(actor: DuesActor, filter: { accountId?: string; month?: string; includeVoided?: boolean } = {}): Promise<Invoice[]> {
    await this.authorize(actor, 'ledger-read');
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeVoided) where.push("status = 'issued'");
    if (filter.accountId) { where.push('account_id = ?'); params.push(filter.accountId); }
    if (filter.month) { where.push('month = ?'); params.push(this.month(filter.month)); }
    const rows = this.options.db.prepare(`SELECT * FROM accounting_dues_invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY month DESC, number DESC`).all(...params) as InvoiceRow[];
    const states = await this.states(actor);
    return rows.map(r => this.toInvoice(r, states.get(r.account_id) ?? emptyState()));
  }

  /** Each account: what was invoiced, what was paid, and the balance (negative is a credit). Needs ledger-read. */
  async balances(actor: DuesActor): Promise<AccountBalance[]> {
    await this.authorize(actor, 'ledger-read');
    const states = await this.states(actor);
    return this.source().list().map(unit => {
      const s = states.get(unit.id) ?? emptyState();
      return { accountId: unit.id, label: accountLabel(unit), invoiced: s.invoiced, paid: s.payments, balance: s.invoiced - s.payments };
    }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  /** An invoice's account and status, for the `dues` line kind's validator. */
  invoiceOf(invoiceId: string): { accountId: string; status: string } | null {
    const row = this.options.db.prepare('SELECT account_id, status FROM accounting_dues_invoices WHERE id = ?').get(invoiceId) as { account_id: string; status: string } | undefined;
    return row ? { accountId: row.account_id, status: row.status } : null;
  }

  /** The manager holding the accounts, so a page showing them depends on its cache topic too. */
  accountsManagerName(): string | undefined {
    return this.options.accountsManager;
  }

  /** Whether an account exists in the account source, for the validator. */
  accountExists(id: string): boolean {
    return Boolean(this.options.accounts()?.get(id));
  }

  // ── Form choices ───────────────────────────────────────────────────────

  /**
   *   accounts         every account, by label           (none: no account source)
   *   dues-categories  the chart's dues categories       ledger-record (through LedgerManager)
   *   months           last month, this month, next month
   *   open-invoices    issued invoices with money owed   ledger-read
   *   invoices         issued invoices, for voiding      ledger-read
   */
  async toFormOptions(options: Record<string, string> = {}, viewer?: unknown): Promise<{ value: string; label: string; amount?: number }[]> {
    if (options.list === 'accounts') {
      const source = this.options.accounts();
      return (source?.list() ?? []).map(u => ({ value: u.id, label: accountLabel(u) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    }
    if (options.list === 'dues-categories') {
      const allowed = new Set(this.options.categories());
      return (await this.options.ledger.toFormOptions({ list: 'categories', kind: 'in' }, viewer)).filter(c => allowed.has(c.value));
    }
    if (options.list === 'months') {
      const d = this.now();
      const at = (offset: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
      return [at(0), at(1), at(-1)].map(m => ({ value: m, label: m }));
    }
    if (options.list === 'open-invoices' || options.list === 'invoices') {
      try {
        const invoices = await this.listInvoices(viewerActor(viewer));
        return invoices.filter(i => options.list === 'invoices' || i.remaining > 0).slice(0, 500).map(i => ({
          value: i.id, amount: i.remaining,
          label: `${i.number} · ${i.accountLabel} · ${i.month} · ${this.options.formatMoney(i.remaining)} left`
        }));
      } catch {
        return [];
      }
    }
    return [];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private source(): AccountSource {
    const source = this.options.accounts();
    if (!source) throw new DuesError(409, 'the accounts to bill are not available on this site (ngdpbase.addons.accounting-dues.accounts-manager)');
    return source;
  }

  private month(value: unknown): string {
    try { return billingMonth(value); } catch (err) { throw new DuesError(400, (err as Error).message); }
  }

  /** Every account's issued invoices and payments, read once: payments are posted dues lines, less refunds, bounced checks left out. */
  private async states(actor: DuesActor): Promise<Map<string, AccountState>> {
    const refunded = new Map<string, number>();
    for (const r of await this.options.ledger.listDocuments(actor, 'refund')) if (r.status === 'posted') for (const l of r.lines) {
      if (l.status === 'posted' && l.receiptLineId) refunded.set(l.receiptLineId, (refunded.get(l.receiptLineId) ?? 0) + l.amount);
    }
    const payments = new Map<string, Payment[]>();
    for (const r of await this.options.ledger.listDocuments(actor, 'receipt')) {
      if (r.status !== 'posted' || r.bounced) continue;
      for (const l of r.lines) {
        const dues = l.details.dues as { account?: string; invoiceId?: string | null } | undefined;
        if (l.status !== 'posted' || !dues?.account) continue;
        const amount = l.amount - (refunded.get(l.id) ?? 0);
        if (amount > 0) payments.set(dues.account, [...(payments.get(dues.account) ?? []), { amount, invoiceId: dues.invoiceId ?? null }]);
      }
    }
    const invoices = new Map<string, Billed[]>();
    for (const r of this.options.db.prepare("SELECT id, number, account_id, due_date, total FROM accounting_dues_invoices WHERE status = 'issued'").all() as
      { id: string; number: string; account_id: string; due_date: string; total: number }[]) {
      invoices.set(r.account_id, [...(invoices.get(r.account_id) ?? []), { id: r.id, number: r.number, dueDate: r.due_date, total: r.total }]);
    }
    const states = new Map<string, AccountState>();
    for (const account of new Set([...payments.keys(), ...invoices.keys()])) {
      const inv = invoices.get(account) ?? [];
      const pay = payments.get(account) ?? [];
      const { paid, credit } = settle(inv, pay);
      states.set(account, { invoices: inv, paid, credit, invoiced: inv.reduce((t, i) => t + i.total, 0), payments: pay.reduce((t, p) => t + p.amount, 0) });
    }
    return states;
  }

  /** Late charges already on issued invoices, by key, so none is made twice. */
  private madeKeys(): Set<string> {
    return new Set((this.options.db.prepare(`SELECT l.charge_key FROM accounting_dues_invoice_lines l JOIN accounting_dues_invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND l.charge_key IS NOT NULL`).all() as { charge_key: string }[]).map(r => r.charge_key));
  }

  private monthInvoice(accountId: string, month: string): { number: string; previous: number; total: number; owed: number } | undefined {
    return this.options.db.prepare("SELECT number, previous, total, owed FROM accounting_dues_invoices WHERE account_id = ? AND month = ? AND status = 'issued'")
      .get(accountId, month) as { number: string; previous: number; total: number; owed: number } | undefined;
  }

  private insertInvoice(actor: DuesActor, month: string, row: MonthRow, late: ProposedLateCharge[], owners: AccountOwner[]): string {
    const label = this.options.label();
    const category = this.options.categories()[0];
    if (!category) throw new DuesError(409, 'no dues category is set (ngdpbase.addons.accounting-dues.categories)');
    const lines: (InvoiceLine & { key: string | null })[] = [
      ...(row.charge ? [{ description: `${label.singular} for ${month}`, amount: row.charge.amount, kind: 'charge' as const, category, ruleId: null, appliesTo: null, key: null }] : []),
      ...late.map(l => ({ description: `Late charge on ${l.appliesToNumber}, ${l.daysLate} days past due`, amount: l.amount, kind: 'late-charge' as const,
        category, ruleId: l.ruleId, appliesTo: l.appliesTo, key: l.key }))
    ];
    const total = lines.reduce((t, l) => t + l.amount, 0);
    const owed = Math.max(0, row.previous + total);
    const id = this.newId();
    const date = this.stamp().slice(0, 10);
    const dueDate = row.charge?.dueDate ?? `${month}-01`;
    const owned = owners.map(o => ({ username: o.username, name: o.name, share: o.share }));
    this.options.db.transaction(() => {
      const seq = this.options.db.prepare("SELECT next FROM accounting_dues_sequence WHERE name = 'invoice'").get() as { next: number };
      this.options.db.prepare("UPDATE accounting_dues_sequence SET next = next + 1 WHERE name = 'invoice'").run();
      const number = `I-${String(seq.next).padStart(4, '0')}`;
      const html = renderInvoice({ number, accountLabel: row.label, month, date, dueDate, lines, previous: row.previous, total, owed, owners: owned, label: label.singular },
        this.wording(), this.options.formatMoney);
      this.options.db.prepare(`INSERT INTO accounting_dues_invoices (id, number, account_id, account_label, month, date, due_date, total, previous, owed, owners,
          html, sha256, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
        id, number, row.accountId, row.label, month, date, dueDate, total, row.previous, owed, JSON.stringify(owned),
        html, createHash('sha256').update(html).digest('hex'), actor.actingUsername(), this.stamp());
      lines.forEach((l, position) => this.options.db.prepare(`INSERT INTO accounting_dues_invoice_lines (id, invoice_id, position, kind, description, amount, category,
          rule_id, applies_to, charge_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.newId(), id, position, l.kind, l.description, l.amount, l.category, l.ruleId, l.appliesTo, l.key));
    })();
    return id;
  }

  /** Email a stored invoice to each owner with an email; false when none could be sent. */
  private async sendInvoice(id: string, owners: AccountOwner[]): Promise<boolean> {
    const row = this.row(id);
    const mailer = this.options.email?.();
    const to = owners.map(o => o.email).filter((e): e is string => typeof e === 'string' && e !== '');
    if (!mailer || !to.length) return false;
    const org = this.wording().organization.name || 'the association';
    const sent: string[] = [];
    for (const address of to) {
      try {
        await mailer.sendTo(address, `Invoice ${row.number} from ${org}`, `Invoice ${row.number} from ${org}: ${this.options.formatMoney(row.owed)} owed, due ${row.due_date}. It is below.`, row.html);
        sent.push(address);
      } catch {
        // EmailManager reports the failure to administrators itself (#1916)
      }
    }
    if (!sent.length) return false;
    this.options.db.prepare('UPDATE accounting_dues_invoices SET emailed_to = ?, emailed_at = ? WHERE id = ? AND emailed_at IS NULL').run(sent.join(', '), this.stamp(), id);
    return true;
  }

  private wording(): InvoiceWording {
    return this.options.wording?.() ?? { organization: { name: '', address: '', payTo: '' } };
  }

  private row(id: string): InvoiceRow {
    const row = this.options.db.prepare('SELECT * FROM accounting_dues_invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
    if (!row) throw new DuesError(404, 'invoiceId: unknown invoice');
    return row;
  }

  private toInvoice(r: InvoiceRow, state: AccountState): Invoice {
    const lines = (this.options.db.prepare('SELECT * FROM accounting_dues_invoice_lines WHERE invoice_id = ? ORDER BY position').all(r.id) as LineRow[])
      .map(l => ({ description: l.description, amount: l.amount, kind: l.kind, category: l.category, ruleId: l.rule_id, appliesTo: l.applies_to }));
    const paid = r.status === 'issued' ? state.paid.get(r.id) ?? 0 : 0;
    return {
      id: r.id, number: r.number, accountId: r.account_id, accountLabel: r.account_label, month: r.month, date: r.date, dueDate: r.due_date,
      total: r.total, previous: r.previous, owed: r.owed, owners: JSON.parse(r.owners) as Invoice['owners'], lines, html: r.html, sha256: r.sha256,
      status: r.status, voidReason: r.void_reason, emailedTo: r.emailed_to, emailedAt: r.emailed_at, createdBy: r.created_by, createdAt: r.created_at,
      paid, remaining: r.status === 'issued' ? r.total - paid : 0
    };
  }

  private async authorize(actor: DuesActor, action: string): Promise<void> {
    const decision = await this.options.decide(actor.subject, { action });
    if (!decision.permit) await actor.enforceDeny(action, decision);
  }

  private async audit(actor: DuesActor, record: { action: string; severity: string; resource: string; resourceType: string; reason?: string; metadata: Record<string, unknown> }): Promise<void> {
    const who = actor.subject
      ? this.options.host.actorOf(actor.subject)
      : { user: 'unknown', ipAddress: actor.ipAddress, metadata: { actorMissing: true } };
    const { metadata: whoMetadata, ...fields } = who as { user: string; actor?: string; ipAddress?: string; metadata: Record<string, unknown> };
    await this.options.recordAudit({ ...record, eventType: this.options.host.addonAuditEventName('invoice-issue'), ...fields,
      ipAddress: fields.ipAddress, metadata: { ...whoMetadata, ...record.metadata } });
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

const emptyState = (): AccountState => ({ invoices: [], paid: new Map(), credit: 0, invoiced: 0, payments: 0 });

/** How an account is named on screens and invoices: its unit number, else its address, else its id. */
export function accountLabel(unit: { id: string } & Record<string, unknown>): string {
  for (const key of ['unitNumber', 'name', 'address']) {
    const v = unit[key];
    if (typeof v === 'string' && v.trim() !== '') return key === 'address' ? `${v.trim()} (${unit.id})` : v.trim();
  }
  return unit.id;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new DuesError(400, `${field} is required`);
  if (value.length > 2000) throw new DuesError(400, `${field} is longer than 2000 characters`);
  return value.trim();
}

/** A page render's viewer as a caller, for reading only, as LedgerManager.viewerActor does. */
function viewerActor(viewer: unknown): DuesActor {
  const username = (viewer as { username?: unknown } | null | undefined)?.username;
  return {
    ipAddress: undefined, subject: (viewer ?? null) as ActorContext | null,
    actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
    enforceDeny: async (permission: string) => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
}
