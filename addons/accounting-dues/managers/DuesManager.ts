/**
 * DuesManager — the dues add-on's one door (D-035): invoices in this add-on's
 * own database, outside the ledger, which holds only money that moved. A
 * payment is an ordinary receipt (R-number) whose line has `dues` details
 * naming the account; this manager reads those through LedgerManager and never
 * touches the accounting database.
 *
 * Accounts and their billing parties come from managers named in configuration
 * (the accommodation add-on's AccommodationManager and ResidencyManager): this
 * one keeps no copy of them, only the money side. Each billing party gets its
 * own invoice and keeps its own balance (D-038), billed exactly as the billing
 * array says (D-040).
 *
 * Every write: ask the decision point for `invoice-issue`, write the audit
 * record and wait for it (on-failure: refuse), then change the rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import { billingMonth, chargeFor, lateChargesDue, partyKey, settle, splitByShare, type Assessment, type Billed, type LateChargeRule, type Payment, type ProposedLateCharge } from '../billing.js';
import { renderInvoice, type InvoiceWording, type PostalAddress } from './invoice.js';

export type DuesHost = Pick<AddonHost, 'actorOf' | 'addonAuditEventName'>;

/** A mail attachment, as ngdpbase's EmailManager takes it. */
export interface MailAttachment { filename: string; contentType: string; content: Buffer }

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

/** A person billed (ResidencyManager.billing): an ngdpbase user. */
export interface AccountOwner { username: string; name: string; email: string | null }

/** One invoice's worth of an account (ResidencyManager.billing): who, where, and the percent of the charge. */
export interface BillingParty { to: AccountOwner[]; name: string; address: PostalAddress; share: number }

/** The manager that holds the accounts billed (D-035); for a condominium, AccommodationManager. */
export interface AccountSource {
  list(): ({ id: string } & Record<string, unknown>)[];
  get(id: string): ({ id: string } & Record<string, unknown>) | undefined;
  assessment(id: string): Assessment | null;
  lateCharges?(): LateChargeRule[];
}

/** Who an invoice goes to: a party's people, names and address. */
type Billee = { to: AccountOwner[]; name: string; address: PostalAddress | null };

/** The manager that holds each account's billing parties on a date; for a condominium, ResidencyManager. */
export interface BillingSource {
  billing(ctx: ActorContext, id: string, options?: { on?: string }): Promise<BillingParty[]>;
}

/** The slice of the accounting add-on's LedgerManager this one calls. */
export interface LedgerLike {
  currencyCode(): string;
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
  /** The billing party: its key (usernames), its names, and where the invoice went. */
  party: string; partyName: string; address: PostalAddress | null;
  total: number; previous: number; owed: number; owners: { username: string; name: string }[];
  lines: InvoiceLine[]; html: string; sha256: string;
  status: 'issued' | 'voided'; voidReason: string | null; emailedTo: string | null; emailedAt: string | null;
  /** The SHA-256 of the PDF it was emailed as; null when it went as the page alone, or was not emailed. */
  pdfSha256: string | null;
  createdBy: string; createdAt: string;
  /** What payments have settled of it so far, and what is left. */
  paid: number; remaining: number;
}

/** One billing party's month, for the Prepare This Month's Invoices page. */
export interface MonthRow {
  accountId: string; label: string;
  /** The party billed: its key, names, people and address. */
  party: string; partyName: string; to: AccountOwner[]; address: PostalAddress | null;
  /** Why the account cannot be billed this month (its billing parties were refused); nothing is issued for it. */
  problem: string | null;
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
  /**
   * The payments: every posted `dues` receipt line, net of refunds, bounced
   * checks left out. The ledger hands this reader to the add-on that registered
   * the `dues` kind, and to no one else (LedgerManager.registerLineDetails).
   */
  payments: () => { amount: number; details: Record<string, unknown> }[];
  /** The account source; looked up when used, so it may arrive after this manager. */
  accounts: () => AccountSource | null | undefined;
  /** The billing source; looked up when used, as the account source is. */
  billing: () => BillingSource | null | undefined;
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
  /** ngdpbase's EmailManager, to send invoices, as the caller. */
  email?: () => { sendTo(ctx: ActorContext, to: string, subject: string, text: string, html?: string, options?: { attachments?: MailAttachment[] }): Promise<void> } | null | undefined;
  /** ngdpbase's ExportManager, to send each invoice as a PDF (#51). */
  pdf?: () => { htmlToPdf(ctx: ActorContext, html: string): Promise<Buffer> } | null | undefined;
  /**
   * Tell the people who issue invoices (the holders of invoice-issue, never a
   * role name) what a scheduled run issued while nothing went to owners.
   */
  notifyIssuers?: (title: string, message: string) => Promise<void>;
  /** Whether anything may be sent to owners (`send-to-owners`, off by default): a development or copied site never mails real owners. */
  sendToOwners?: () => boolean;
  now?: () => Date;
  newId?: () => string;
}

interface InvoiceRow {
  id: string; number: string; account_id: string; account_label: string; month: string; date: string; due_date: string;
  total: number; previous: number; owed: number; owners: string; html: string; sha256: string; status: 'issued' | 'voided';
  void_reason: string | null; emailed_to: string | null; emailed_at: string | null; created_by: string; created_at: string;
  party: string; party_name: string; address: string | null; pdf_sha256: string | null;
}
interface LineRow { invoice_id: string; position: number; kind: 'charge' | 'late-charge'; description: string; amount: number; category: string; rule_id: string | null; applies_to: string | null; charge_key: string | null }

/** What a party's money on an account looks like: its issued invoices, what payments settled, and the balance. */
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
   * What each billing party would be invoiced for a month, without issuing:
   * its share of the account's charge, the late charges due on its earlier
   * invoices (as of the 1st of the month), its balance brought forward and the
   * amount owed. Parties are the account's on the charge's due date. An account
   * whose parties are refused is shown with the reason, and not billed.
   * Needs ledger-read.
   */
  async prepareMonth(actor: DuesActor, month: string): Promise<MonthRow[]> {
    await this.authorize(actor, 'ledger-read');
    const m = this.month(month);
    const source = this.source();
    const states = this.states();
    const rules = source.lateCharges?.() ?? [];
    const made = this.madeKeys();
    const rows: MonthRow[] = [];
    for (const unit of source.list()) {
      const label = accountLabel(unit);
      const charge = chargeFor(source.assessment(unit.id), m);
      const billed = new Map<string, { party: Billee; amount: number }>();
      if (charge) {
        let parties: BillingParty[];
        try {
          // Read as the caller (treasurer or job), so the read is attributed (ngdpbase-addons#11).
          parties = await this.billingSource().billing(actor.subject as ActorContext, unit.id, { on: charge.dueDate });
        } catch (err) {
          if (err instanceof DuesError) throw err;
          rows.push({ accountId: unit.id, label, party: '', partyName: '', to: [], address: null, problem: (err as Error).message,
            charge, lateCharges: [], previous: 0, total: 0, owed: 0, invoiced: null });
          continue;
        }
        const parts = splitByShare(charge.amount, parties);
        parties.forEach((p, i) => billed.set(partyKey(p.to.map(o => o.username)), { party: p, amount: parts[i] ?? 0 }));
      }
      // A party billed before, and not this month, may still owe late charges on its earlier invoices.
      for (const key of this.partiesOf(unit.id)) if (!billed.has(key)) billed.set(key, { party: this.lastBilled(unit.id, key), amount: 0 });
      const existing = this.monthInvoices(unit.id, m);
      for (const [key, { party, amount }] of billed) {
        const base = { accountId: unit.id, label, party: key, partyName: party.name, to: party.to, address: party.address, problem: null };
        const partyCharge = charge && amount > 0 ? { dueDate: charge.dueDate, amount } : null;
        const invoice = existing.get(key);
        if (invoice) {
          // Already invoiced: the invoice's own figures, as issued.
          rows.push({ ...base, charge: partyCharge, lateCharges: [], previous: invoice.previous, total: invoice.total, owed: invoice.owed, invoiced: invoice.number });
          continue;
        }
        const state = states.get(stateKey(unit.id, key)) ?? emptyState();
        const lateCharges = lateChargesDue(state.invoices, state.paid, rules, `${m}-01`, made);
        if (!partyCharge && !lateCharges.length) continue;
        const previous = state.invoiced - state.payments;
        const total = (partyCharge?.amount ?? 0) + lateCharges.reduce((t, l) => t + l.amount, 0);
        rows.push({ ...base, charge: partyCharge, lateCharges, previous, total, owed: Math.max(0, previous + total), invoiced: null });
      }
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.partyName.localeCompare(b.partyName));
  }

  /**
   * Issue a month's invoices: one per billing party with something charged
   * that has none for the month yet, or one account's. Each is stored exactly
   * as issued. Late charges are added only when the treasurer says so
   * (`lateCharges`), having seen them on the Prepare page. With `email`, an
   * invoice with something owed is sent to each person on its party with an
   * email on file; one fully paid by credit is kept, and not sent.
   */
  async issueMonth(actor: DuesActor, input: { month: string; account?: string; lateCharges?: boolean; email?: boolean }): Promise<{ issued: number; emailed: number; notEmailed: string[]; held: boolean }> {
    await this.authorize(actor, 'invoice-issue');
    const month = this.month(input.month);
    let rows = (await this.prepareMonth(actor, month)).filter(r => !r.invoiced && !r.problem);
    if (input.account) {
      rows = rows.filter(r => r.accountId === input.account);
      if (!rows.length) throw new DuesError(409, `account: nothing to invoice for ${month}, or it is already invoiced`);
    }
    const pending: { row: MonthRow; late: ProposedLateCharge[] }[] = [];
    for (const row of rows) {
      const late = input.lateCharges ? row.lateCharges : [];
      if (!row.charge && !late.length) continue;
      pending.push({ row, late });
    }
    await this.audit(actor, { action: 'invoice-issue', severity: 'high', resource: `invoices:${month}`, resourceType: 'dues-invoice',
      metadata: { month, count: pending.length, accounts: pending.map(p => p.row.accountId), parties: pending.map(p => p.row.party),
        lateCharges: input.lateCharges === true, email: input.email === true } });
    let emailed = 0;
    // Nothing goes to owners while send-to-owners is off (D-035): the invoices are kept, not sent.
    const held = input.email === true && !(this.options.sendToOwners?.() ?? false);
    const notEmailed: string[] = [];
    for (const p of pending) {
      const id = this.insertInvoice(actor, month, p.row, p.late);
      if (input.email && !held && this.row(id).owed > 0) {
        if (await this.sendInvoice(actor, id, p.row.to)) emailed++; else notEmailed.push(`${p.row.label} · ${p.row.partyName}`);
      }
    }
    if (pending.length) await this.options.changed?.();
    return { issued: pending.length, emailed, notEmailed, held };
  }

  /**
   * The scheduled run (D-035, #11): the month's invoices, with the late charges
   * due, emailed. Turning the schedule on is the site's standing confirmation of
   * both. Safe to run again for the same month: a party already invoiced for it
   * is skipped. While send-to-owners is off nothing goes to owners, as for the
   * Issue form. Needs invoice-issue, which the job's own policy grants it.
   */
  async scheduledRun(actor: DuesActor, month: string): Promise<{ success: boolean; summary: string }> {
    const result = await this.issueMonth(actor, { month, lateCharges: true, email: true });
    const sent = result.held ? 'nothing sent to owners: sending to owners is off on this site'
      : `${result.emailed} emailed${result.notEmailed.length ? `; not emailed: ${result.notEmailed.join(', ')}` : ''}`;
    const summary = `${month}: ${result.issued} issued, ${sent}`;
    // While nothing goes to owners, the people who issue invoices are told instead (D-035).
    if (result.held && result.issued) await this.options.notifyIssuers?.(`Invoices issued for ${month}`, summary);
    return { success: true, summary };
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
    return this.toInvoice(row, this.states().get(stateKey(row.account_id, row.party)) ?? emptyState());
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
    const states = this.states();
    return rows.map(r => this.toInvoice(r, states.get(stateKey(r.account_id, r.party)) ?? emptyState()));
  }

  /** Each account: what was invoiced, what was paid, and the balance (negative is a credit), summed over its parties. Needs ledger-read. */
  async balances(actor: DuesActor): Promise<AccountBalance[]> {
    await this.authorize(actor, 'ledger-read');
    const totals = new Map<string, { invoiced: number; payments: number }>();
    for (const [key, s] of this.states()) {
      const account = accountOfKey(key);
      const t = totals.get(account) ?? { invoiced: 0, payments: 0 };
      totals.set(account, { invoiced: t.invoiced + s.invoiced, payments: t.payments + s.payments });
    }
    return this.source().list().map(unit => {
      const s = totals.get(unit.id) ?? { invoiced: 0, payments: 0 };
      return { accountId: unit.id, label: accountLabel(unit), invoiced: s.invoiced, paid: s.payments, balance: s.invoiced - s.payments };
    }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  // ── An owner's own view (D-037, D-038) ──────────────────────────────────

  /**
   * The signed-in person's own bills: for each billing party they are on, its
   * invoices with what is paid and left, and the party's balance (negative is
   * a credit). Everyone on a party sees the same. Needs ledger-self, which
   * every signed-in person holds.
   */
  async myDues(actor: DuesActor): Promise<{ accountId: string; label: string; party: string; partyName: string; balance: number;
    invoices: { id: string; number: string; month: string; dueDate: string; total: number; paid: number; remaining: number }[] }[]> {
    await this.authorize(actor, 'ledger-self');
    const rows = this.ownRows(actor.actingUsername());
    if (!rows.length) return [];
    const states = this.states();
    const parties = new Map<string, InvoiceRow[]>();
    for (const r of rows) parties.set(stateKey(r.account_id, r.party), [...(parties.get(stateKey(r.account_id, r.party)) ?? []), r]);
    return [...parties.entries()].map(([key, invoices]) => {
      const state = states.get(key) ?? emptyState();
      const first = invoices[0] as InvoiceRow;
      return {
        accountId: first.account_id, label: first.account_label, party: first.party, partyName: first.party_name,
        balance: state.invoiced - state.payments,
        invoices: invoices.map(r => {
          const paid = state.paid.get(r.id) ?? 0;
          return { id: r.id, number: r.number, month: r.month, dueDate: r.due_date, total: r.total, paid, remaining: r.total - paid };
        })
      };
    }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  /** One of the signed-in person's own invoices, exactly as issued; another party's is not found. Needs ledger-self. */
  async myInvoice(actor: DuesActor, invoiceId: string): Promise<Invoice> {
    await this.authorize(actor, 'ledger-self');
    const row = this.ownRows(actor.actingUsername()).find(r => r.id === invoiceId);
    if (!row) throw new DuesError(404, 'invoiceId: unknown invoice');
    return this.toInvoice(row, this.states().get(stateKey(row.account_id, row.party)) ?? emptyState());
  }

  /** Issued invoices of every party a person is on (a party is its people's usernames), newest first. */
  private ownRows(username: string): InvoiceRow[] {
    return (this.options.db.prepare("SELECT * FROM accounting_dues_invoices WHERE status = 'issued' ORDER BY month DESC, number DESC").all() as InvoiceRow[])
      .filter(r => r.party.split(',').includes(username));
  }

  /** An invoice's account, party and status, for the `dues` line kind's validator. */
  invoiceOf(invoiceId: string): { accountId: string; party: string; status: string } | null {
    const row = this.options.db.prepare('SELECT account_id, party, status FROM accounting_dues_invoices WHERE id = ?').get(invoiceId) as
      { account_id: string; party: string; status: string } | undefined;
    return row ? { accountId: row.account_id, party: row.party, status: row.status } : null;
  }

  /** The parties an account's issued invoices were billed to, first billed first. */
  partiesOf(accountId: string): string[] {
    return (this.options.db.prepare(`SELECT party FROM accounting_dues_invoices WHERE account_id = ? AND status = 'issued'
      GROUP BY party ORDER BY MIN(due_date), MIN(number)`).all(accountId) as { party: string }[]).map(r => r.party);
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
   *   parties          each party billed, by account     ledger-read
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
    if (options.list === 'parties') {
      try {
        await this.authorize(viewerActor(viewer), 'ledger-read');
      } catch {
        return [];
      }
      const rows = this.options.db.prepare(`SELECT account_label, party, party_name FROM accounting_dues_invoices WHERE status = 'issued'
        GROUP BY account_id, party`).all() as { account_label: string; party: string; party_name: string }[];
      return rows.map(r => ({ value: r.party, label: `${r.account_label} · ${r.party_name}` }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    }
    if (options.list === 'open-invoices' || options.list === 'invoices') {
      try {
        const invoices = await this.listInvoices(viewerActor(viewer));
        return invoices.filter(i => options.list === 'invoices' || i.remaining > 0).slice(0, 500).map(i => ({
          value: i.id, amount: i.remaining,
          label: `${i.number} · ${i.accountLabel} · ${i.partyName} · ${i.month} · ${this.options.formatMoney(i.remaining)} left`
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

  private billingSource(): BillingSource {
    const source = this.options.billing();
    if (!source) throw new DuesError(409, 'the billing parties are not available on this site (ngdpbase.addons.accounting-dues.billing-manager)');
    return source;
  }

  private month(value: unknown): string {
    try { return billingMonth(value); } catch (err) { throw new DuesError(400, (err as Error).message); }
  }

  /**
   * Every party's issued invoices and payments, read once, by account and party:
   * payments are posted dues lines, less refunds, bounced checks left out. A
   * payment settles its own party's invoices (D-038); one recorded before
   * parties, naming none, settles the party its invoice names, else the
   * account's first party.
   */
  private states(): Map<string, AccountState> {
    const invoices = new Map<string, Billed[]>();
    const partyOfInvoice = new Map<string, string>();
    for (const r of this.options.db.prepare("SELECT id, number, account_id, party, due_date, total FROM accounting_dues_invoices WHERE status = 'issued'").all() as
      { id: string; number: string; account_id: string; party: string; due_date: string; total: number }[]) {
      const key = stateKey(r.account_id, r.party);
      invoices.set(key, [...(invoices.get(key) ?? []), { id: r.id, number: r.number, dueDate: r.due_date, total: r.total }]);
      partyOfInvoice.set(r.id, r.party);
    }
    const payments = new Map<string, Payment[]>();
    for (const { amount, details } of this.options.payments()) {
      const dues = details as { account?: string; party?: string | null; invoiceId?: string | null };
      if (!dues.account) continue;
      const party = dues.party ?? (dues.invoiceId ? partyOfInvoice.get(dues.invoiceId) : undefined) ?? this.partiesOf(dues.account)[0] ?? '';
      const key = stateKey(dues.account, party);
      payments.set(key, [...(payments.get(key) ?? []), { amount, invoiceId: dues.invoiceId ?? null }]);
    }
    const states = new Map<string, AccountState>();
    for (const key of new Set([...payments.keys(), ...invoices.keys()])) {
      const inv = invoices.get(key) ?? [];
      const pay = payments.get(key) ?? [];
      const { paid, credit } = settle(inv, pay);
      states.set(key, { invoices: inv, paid, credit, invoiced: inv.reduce((t, i) => t + i.total, 0), payments: pay.reduce((t, p) => t + p.amount, 0) });
    }
    return states;
  }

  /** Late charges already on issued invoices, by key, so none is made twice. */
  private madeKeys(): Set<string> {
    return new Set((this.options.db.prepare(`SELECT l.charge_key FROM accounting_dues_invoice_lines l JOIN accounting_dues_invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND l.charge_key IS NOT NULL`).all() as { charge_key: string }[]).map(r => r.charge_key));
  }

  /** An account's issued invoices for a month, by party. */
  private monthInvoices(accountId: string, month: string): Map<string, { number: string; previous: number; total: number; owed: number }> {
    const rows = this.options.db.prepare("SELECT party, number, previous, total, owed FROM accounting_dues_invoices WHERE account_id = ? AND month = ? AND status = 'issued'")
      .all(accountId, month) as { party: string; number: string; previous: number; total: number; owed: number }[];
    return new Map(rows.map(r => [r.party, r]));
  }

  /** A party as it was last billed on an account, for late charges on its earlier invoices once it is billed no more. */
  private lastBilled(accountId: string, party: string): Billee {
    const r = this.options.db.prepare(`SELECT owners, party_name, address FROM accounting_dues_invoices WHERE account_id = ? AND party = ? AND status = 'issued'
      ORDER BY due_date DESC, number DESC LIMIT 1`).get(accountId, party) as { owners: string; party_name: string; address: string | null };
    const owners = JSON.parse(r.owners) as { username: string; name: string }[];
    return { to: owners.map(o => ({ ...o, email: null })), name: r.party_name, address: r.address ? JSON.parse(r.address) as PostalAddress : null };
  }

  private insertInvoice(actor: DuesActor, month: string, row: MonthRow, late: ProposedLateCharge[]): string {
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
    const owned = row.to.map(o => ({ username: o.username, name: o.name }));
    this.options.db.transaction(() => {
      const seq = this.options.db.prepare("SELECT next FROM accounting_dues_sequence WHERE name = 'invoice'").get() as { next: number };
      this.options.db.prepare("UPDATE accounting_dues_sequence SET next = next + 1 WHERE name = 'invoice'").run();
      const number = `I-${String(seq.next).padStart(4, '0')}`;
      const html = renderInvoice({ number, accountLabel: row.label, month, date, dueDate, lines, previous: row.previous, total, owed,
        billTo: { name: row.partyName, address: row.address }, label: label.singular },
        this.wording(), this.options.formatMoney);
      this.options.db.prepare(`INSERT INTO accounting_dues_invoices (id, number, account_id, account_label, month, date, due_date, total, previous, owed, owners,
          party, party_name, address, html, sha256, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
        id, number, row.accountId, row.label, month, date, dueDate, total, row.previous, owed, JSON.stringify(owned),
        row.party, row.partyName, row.address ? JSON.stringify(row.address) : null,
        html, createHash('sha256').update(html).digest('hex'), actor.actingUsername(), this.stamp());
      lines.forEach((l, position) => this.options.db.prepare(`INSERT INTO accounting_dues_invoice_lines (id, invoice_id, position, kind, description, amount, category,
          rule_id, applies_to, charge_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.newId(), id, position, l.kind, l.description, l.amount, l.category, l.ruleId, l.appliesTo, l.key));
    })();
    return id;
  }

  /**
   * Email a stored invoice to each person on its party with an email, as the
   * caller, with the invoice attached as a PDF when the site makes PDFs (else
   * the page alone); false when none could be sent.
   */
  private async sendInvoice(actor: DuesActor, id: string, owners: AccountOwner[]): Promise<boolean> {
    const row = this.row(id);
    const mailer = this.options.email?.();
    const ctx = actor.subject;
    const to = owners.map(o => o.email).filter((e): e is string => typeof e === 'string' && e !== '');
    if (!mailer || !ctx || !to.length) return false;
    let pdf: Buffer | null;
    try {
      pdf = await pdfOf(this.options.pdf?.(), ctx, row.html);
    } catch {
      return false; // a PDF provider that fails is reported by ExportManager; nothing is sent half-made
    }
    const org = this.wording().organization.name || 'the association';
    const where = pdf ? 'It is attached, and below.' : 'It is below.';
    const options = pdf ? { attachments: [{ filename: `Invoice ${row.number}.pdf`, contentType: 'application/pdf', content: pdf }] } : {};
    const sent: string[] = [];
    for (const address of to) {
      try {
        await mailer.sendTo(ctx, address, `Invoice ${row.number} from ${org}`, `Invoice ${row.number} from ${org}: ${this.options.formatMoney(row.owed)} owed, due ${row.due_date}. ${where}`, row.html, options);
        sent.push(address);
      } catch {
        // EmailManager reports the failure to administrators itself (#1916)
      }
    }
    if (!sent.length) return false;
    this.options.db.prepare('UPDATE accounting_dues_invoices SET emailed_to = ?, emailed_at = ?, pdf_sha256 = ? WHERE id = ? AND emailed_at IS NULL')
      .run(sent.join(', '), this.stamp(), pdf ? createHash('sha256').update(pdf).digest('hex') : null, id);
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
      party: r.party, partyName: r.party_name, address: r.address ? JSON.parse(r.address) as PostalAddress : null,
      total: r.total, previous: r.previous, owed: r.owed, owners: JSON.parse(r.owners) as Invoice['owners'], lines, html: r.html, sha256: r.sha256,
      status: r.status, voidReason: r.void_reason, emailedTo: r.emailed_to, emailedAt: r.emailed_at, pdfSha256: r.pdf_sha256, createdBy: r.created_by, createdAt: r.created_at,
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

/** A party's money is kept by account and party: a key for both. */
const stateKey = (accountId: string, party: string): string => `${accountId}\n${party}`;
const accountOfKey = (key: string): string => key.slice(0, key.indexOf('\n'));

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
