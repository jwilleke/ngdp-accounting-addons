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
import { billingMonth, chargeFor, lateChargesDue, settle, splitByShare, type Assessment, type Billed, type LateChargeRule, type Payment, type ProposedLateCharge } from '../billing.js';
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

/** An owner as accommodation's billing() gives it (ngdpbase#2042): their identity @id and share of the unit. */
export interface BillingOwner { '@id': string; share: number }

/** Where a unit's invoices go: free-text address, and that entry's percent of each charge. */
export interface BillingEntry { address: string; share: number }

/** What billing() gives: where the invoices go, and who owes them (D-047). */
export interface Billing { billing: BillingEntry[]; owners: BillingOwner[] }

/** A unit the viewer holds today, as accommodation's ownUnits() gives it. */
export interface OwnUnit { id: string; as: string[] }

/** The manager that holds the accounts billed (D-035); for a condominium, AccommodationManager. */
export interface AccountSource {
  list(): ({ id: string } & Record<string, unknown>)[];
  get(id: string): ({ id: string } & Record<string, unknown>) | undefined;
  assessment(id: string): Assessment | null;
  lateCharges?(): LateChargeRule[];
}

/**
 * The manager that holds each account's billing and owners; for a condominium,
 * ResidencyManager. billing() is read as the caller (accommodation-billing-read);
 * ownUnits() gives the viewer's own units today (accommodation-self).
 */
export interface BillingSource {
  billing(ctx: ActorContext, id: string, options?: { on?: string }): Promise<Billing>;
  ownUnits?(ctx: ActorContext): Promise<OwnUnit[]>;
}

/** core's IdentityManager, read as the caller: an owner's name and email to send to, and the viewer's own @id. */
export interface IdentitySource {
  getById(ctx: ActorContext, id: string): Promise<{ '@id'?: string; name?: string; email?: string } | null>;
  getByUserIdentifier(ctx: ActorContext, username: string): Promise<{ '@id': string } | null>;
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
  /**
   * Which billing entry it went to (entry-1, …), and where. New invoices keep the address as typed
   * (`billingAddress`) and the owners' @ids and shares at that date (D-047); invoices issued before
   * keep their party of usernames, names and structured address as they were.
   */
  party: string; partyName: string; address: PostalAddress | null; billingAddress: string | null; ownerIds: BillingOwner[];
  total: number; previous: number; owed: number; owners: { username: string; name: string }[];
  lines: InvoiceLine[]; html: string; sha256: string;
  status: 'issued' | 'voided'; voidReason: string | null; emailedTo: string | null; emailedAt: string | null;
  /** The SHA-256 of the PDF it was emailed as; null when it went as the page alone, or was not emailed. */
  pdfSha256: string | null;
  createdBy: string; createdAt: string;
  /** What payments have settled of it so far, and what is left. */
  paid: number; remaining: number;
}

/** One billing entry's month, for the Prepare This Month's Invoices page. */
export interface MonthRow {
  accountId: string; label: string;
  /** The billing entry (entry-1, …), its address as typed, its first line to show, and the unit's owners at the due date. */
  party: string; partyName: string; address: string | null; owners: BillingOwner[];
  /** Why the account cannot be billed this month (no billing address, no owner, …); nothing is issued for it. */
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
  /** core's IdentityManager: owners by @id, to email them, and the viewer's own @id. */
  identities?: () => IdentitySource | null | undefined;
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
  billing_address: string | null; owner_ids: string | null;
}
interface LineRow { invoice_id: string; position: number; kind: 'charge' | 'late-charge'; description: string; amount: number; category: string; rule_id: string | null; applies_to: string | null; charge_key: string | null }

/** What a unit's money looks like (D-047): its issued invoices, what payments settled, and the balance. */
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
   * What each of a unit's billing entries would be invoiced for a month, without
   * issuing (D-047): its share of the unit's charge and of the unit's balance
   * brought forward, the late charges due on the unit's earlier invoices (as of
   * the 1st of the month, on the first entry), and the amount owed. Entries and
   * owners are the unit's on the charge's due date. A unit that cannot be billed
   * (no billing address, no owner, …) is shown with the reason, and not billed.
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
      const existing = this.monthRows(unit.id, m);
      if (existing.length) {
        // Already invoiced: the invoices' own figures, as issued.
        for (const r of existing) rows.push({ accountId: unit.id, label, party: r.party, partyName: r.party_name, address: r.billing_address,
          owners: ownersOf(r), problem: null, charge: charge ? { dueDate: charge.dueDate, amount: r.total } : null, lateCharges: [],
          previous: r.previous, total: r.total, owed: r.owed, invoiced: r.number });
        continue;
      }
      const state = states.get(unit.id) ?? emptyState();
      const lateCharges = lateChargesDue(state.invoices, state.paid, rules, `${m}-01`, made);
      if (!charge && !lateCharges.length) continue;
      let billing: Billing;
      try {
        // Read as the caller (treasurer or job), so the read is attributed and decided (accommodation-billing-read).
        billing = await this.billingSource().billing(actor.subject as ActorContext, unit.id, { on: charge?.dueDate ?? `${m}-01` });
      } catch (err) {
        if (err instanceof DuesError) throw err;
        rows.push({ accountId: unit.id, label, party: '', partyName: '', address: null, owners: [], problem: (err as Error).message,
          charge, lateCharges: [], previous: 0, total: 0, owed: 0, invoiced: null });
        continue;
      }
      const charges = splitByShare(charge?.amount ?? 0, billing.billing);
      const brought = splitByShare(state.invoiced - state.payments, billing.billing);
      billing.billing.forEach((entry, i) => {
        const late = i === 0 ? lateCharges : [];
        const amount = charges[i] ?? 0;
        const previous = brought[i] ?? 0;
        const total = amount + late.reduce((t, l) => t + l.amount, 0);
        rows.push({ accountId: unit.id, label, party: `entry-${i + 1}`, partyName: firstLine(entry.address), address: entry.address, owners: billing.owners,
          problem: null, charge: charge && amount > 0 ? { dueDate: charge.dueDate, amount } : null, lateCharges: late,
          previous, total, owed: Math.max(0, previous + total), invoiced: null });
      });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.party.localeCompare(b.party, undefined, { numeric: true }));
  }

  /**
   * Issue a month's invoices: one per billing entry of each unit with something
   * charged and no invoice for the month yet, or one unit's. Each is stored
   * exactly as issued. Late charges are added only when the treasurer says so
   * (`lateCharges`), having seen them on the Prepare page. With `email`, an
   * invoice with something owed is sent to each of the unit's owners with an
   * email on file; one fully paid by credit is kept, and not sent. A unit that
   * cannot be billed is skipped and named in `skipped`, never billed to a
   * guessed address (D-047).
   */
  async issueMonth(actor: DuesActor, input: { month: string; account?: string; lateCharges?: boolean; email?: boolean }): Promise<{ issued: number; emailed: number; notEmailed: string[]; held: boolean; skipped: string[] }> {
    await this.authorize(actor, 'invoice-issue');
    const month = this.month(input.month);
    const prepared = (await this.prepareMonth(actor, month)).filter(r => !input.account || r.accountId === input.account);
    const skipped = prepared.filter(r => r.problem).map(r => `${r.label}: ${r.problem}`);
    const rows = prepared.filter(r => !r.invoiced && !r.problem);
    if (input.account && !rows.length) throw new DuesError(409, `account: nothing to invoice for ${month}, or it is already invoiced${skipped.length ? ` (${skipped.join('; ')})` : ''}`);
    const pending: { row: MonthRow; late: ProposedLateCharge[] }[] = [];
    for (const row of rows) {
      const late = input.lateCharges ? row.lateCharges : [];
      if (!row.charge && !late.length) continue;
      pending.push({ row, late });
    }
    await this.audit(actor, { action: 'invoice-issue', severity: 'high', resource: `invoices:${month}`, resourceType: 'dues-invoice',
      metadata: { month, count: pending.length, accounts: pending.map(p => p.row.accountId), entries: pending.map(p => p.row.party), skipped,
        lateCharges: input.lateCharges === true, email: input.email === true } });
    let emailed = 0;
    // Nothing goes to owners while send-to-owners is off (D-035): the invoices are kept, not sent.
    const held = input.email === true && !(this.options.sendToOwners?.() ?? false);
    const notEmailed: string[] = [];
    // Each owner is looked up once per run, as the caller, and nothing of them is copied onto an invoice.
    const people = new Map<string, Promise<{ name?: string; email?: string } | null>>();
    const person = (id: string) => {
      if (!people.has(id)) people.set(id, this.identitySource()?.getById(actor.subject as ActorContext, id).catch(() => null) ?? Promise.resolve(null));
      return people.get(id) as Promise<{ name?: string; email?: string } | null>;
    };
    for (const p of pending) {
      const id = this.insertInvoice(actor, month, p.row, p.late);
      if (input.email && !held && this.row(id).owed > 0) {
        const to = (await Promise.all(p.row.owners.map(o => person(o['@id'])))).map(o => o?.email).filter((e): e is string => typeof e === 'string' && e !== '');
        if (await this.sendInvoice(actor, id, to)) emailed++; else notEmailed.push(`${p.row.label} · ${p.row.partyName}`);
      }
    }
    if (pending.length) await this.options.changed?.();
    return { issued: pending.length, emailed, notEmailed, held, skipped };
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
    const summary = `${month}: ${result.issued} issued, ${sent}${result.skipped.length ? `; not invoiced: ${result.skipped.join('; ')}` : ''}`;
    // While nothing goes to owners, the people who issue invoices are told instead (D-035); and a unit
    // left unbilled is always told, never left silently (D-047).
    if ((result.held && result.issued) || result.skipped.length) await this.options.notifyIssuers?.(`Invoices issued for ${month}`, summary);
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

  /** An invoice, exactly as issued, with what has been paid of it. Needs ledger-read, or account-read (the board, D-047). */
  async getInvoice(actor: DuesActor, invoiceId: string): Promise<Invoice> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const row = this.row(invoiceId);
    return this.toInvoice(row, this.states().get(row.account_id) ?? emptyState());
  }

  /** Invoices, newest first; one account's, or one month's; voided ones only when asked. Needs ledger-read, or account-read. */
  async listInvoices(actor: DuesActor, filter: { accountId?: string; month?: string; includeVoided?: boolean } = {}): Promise<Invoice[]> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeVoided) where.push("status = 'issued'");
    if (filter.accountId) { where.push('account_id = ?'); params.push(filter.accountId); }
    if (filter.month) { where.push('month = ?'); params.push(this.month(filter.month)); }
    const rows = this.options.db.prepare(`SELECT * FROM accounting_dues_invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY month DESC, number DESC`).all(...params) as InvoiceRow[];
    const states = this.states();
    return rows.map(r => this.toInvoice(r, states.get(r.account_id) ?? emptyState()));
  }

  /** Each unit: what was invoiced, what was paid, and the balance (negative is a credit). Needs ledger-read, or account-read. */
  async balances(actor: DuesActor): Promise<AccountBalance[]> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const states = this.states();
    return this.source().list().map(unit => {
      const s = states.get(unit.id) ?? emptyState();
      return { accountId: unit.id, label: accountLabel(unit), invoiced: s.invoiced, paid: s.payments, balance: s.invoiced - s.payments };
    }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  // ── An owner's own view (D-037, D-047) ──────────────────────────────────

  /**
   * The signed-in person's own bills (D-047). For each unit they own today,
   * decided now through accommodation (ownUnits, by the viewer's own context),
   * the unit's whole account: every invoice of every billing entry, what is paid
   * and left, and the unit's balance. For a unit they no longer own, only the
   * invoices issued while they did (those naming their identity @id, or their
   * username on invoices from before), and no balance. Needs ledger-self, which
   * every signed-in person holds.
   */
  async myDues(actor: DuesActor): Promise<{ accountId: string; label: string; current: boolean; balance: number | null;
    invoices: { id: string; number: string; month: string; dueDate: string; billedTo: string; total: number; paid: number; remaining: number }[] }[]> {
    await this.authorize(actor, 'ledger-self');
    const { current, rows } = await this.ownRows(actor);
    if (!rows.length) return [];
    const states = this.states();
    const units = new Map<string, InvoiceRow[]>();
    for (const r of rows) units.set(r.account_id, [...(units.get(r.account_id) ?? []), r]);
    return [...units.entries()].map(([unitId, invoices]) => {
      const state = states.get(unitId) ?? emptyState();
      const owns = current.has(unitId);
      return {
        accountId: unitId, label: (invoices[0] as InvoiceRow).account_label, current: owns,
        balance: owns ? state.invoiced - state.payments : null,
        invoices: invoices.map(r => {
          const paid = state.paid.get(r.id) ?? 0;
          return { id: r.id, number: r.number, month: r.month, dueDate: r.due_date, billedTo: r.party_name, total: r.total, paid, remaining: r.total - paid };
        })
      };
    }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  /** One of the signed-in person's own invoices (as myDues decides), exactly as issued; any other is not found. Needs ledger-self. */
  async myInvoice(actor: DuesActor, invoiceId: string): Promise<Invoice> {
    await this.authorize(actor, 'ledger-self');
    const row = (await this.ownRows(actor)).rows.find(r => r.id === invoiceId);
    if (!row) throw new DuesError(404, 'invoiceId: unknown invoice');
    return this.toInvoice(row, this.states().get(row.account_id) ?? emptyState());
  }

  /**
   * The invoices a person may see as their own, newest first, and the units they own today: every
   * invoice of a unit they own now (accommodation, as the viewer), and any other naming them, by
   * identity @id, or by username on invoices issued before identities (D-045, D-047).
   */
  private async ownRows(actor: DuesActor): Promise<{ current: Set<string>; rows: InvoiceRow[] }> {
    const ctx = actor.subject as ActorContext;
    const username = actor.actingUsername();
    const units = await this.billingSource().ownUnits?.(ctx).catch(() => []) ?? [];
    const current = new Set(units.filter(u => u.as.includes('owner')).map(u => u.id));
    const me = (await this.identitySource()?.getByUserIdentifier(ctx, username).catch(() => null))?.['@id'];
    const rows = (this.options.db.prepare("SELECT * FROM accounting_dues_invoices WHERE status = 'issued' ORDER BY month DESC, number DESC").all() as InvoiceRow[])
      .filter(r => current.has(r.account_id) || (me && ownersOf(r).some(o => o['@id'] === me)) || (!r.owner_ids && r.party.split(',').includes(username)));
    return { current, rows };
  }

  /** An invoice's account and status, for the `dues` line kind's validator. */
  invoiceOf(invoiceId: string): { accountId: string; status: string } | null {
    const row = this.options.db.prepare('SELECT account_id, status FROM accounting_dues_invoices WHERE id = ?').get(invoiceId) as
      { account_id: string; status: string } | undefined;
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

  private identitySource(): IdentitySource | null | undefined {
    return this.options.identities?.();
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
   * Every unit's issued invoices and payments, read once, by unit (D-047):
   * payments are posted dues lines, less refunds, bounced checks left out, and
   * settle the unit's invoices oldest first, or the one they name first.
   * Invoices issued to billing parties before (D-038) count in their unit too.
   */
  private states(): Map<string, AccountState> {
    const invoices = new Map<string, Billed[]>();
    for (const r of this.options.db.prepare("SELECT id, number, account_id, due_date, total FROM accounting_dues_invoices WHERE status = 'issued'").all() as
      { id: string; number: string; account_id: string; due_date: string; total: number }[]) {
      invoices.set(r.account_id, [...(invoices.get(r.account_id) ?? []), { id: r.id, number: r.number, dueDate: r.due_date, total: r.total }]);
    }
    const payments = new Map<string, Payment[]>();
    for (const { amount, details } of this.options.payments()) {
      const dues = details as { account?: string; invoiceId?: string | null };
      if (!dues.account) continue;
      payments.set(dues.account, [...(payments.get(dues.account) ?? []), { amount, invoiceId: dues.invoiceId ?? null }]);
    }
    const states = new Map<string, AccountState>();
    for (const unit of new Set([...payments.keys(), ...invoices.keys()])) {
      const inv = invoices.get(unit) ?? [];
      const pay = payments.get(unit) ?? [];
      const { paid, credit } = settle(inv, pay);
      states.set(unit, { invoices: inv, paid, credit, invoiced: inv.reduce((t, i) => t + i.total, 0), payments: pay.reduce((t, p) => t + p.amount, 0) });
    }
    return states;
  }

  /** Late charges already on issued invoices, by key, so none is made twice. */
  private madeKeys(): Set<string> {
    return new Set((this.options.db.prepare(`SELECT l.charge_key FROM accounting_dues_invoice_lines l JOIN accounting_dues_invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND l.charge_key IS NOT NULL`).all() as { charge_key: string }[]).map(r => r.charge_key));
  }

  /** A unit's issued invoices for a month. */
  private monthRows(accountId: string, month: string): InvoiceRow[] {
    return this.options.db.prepare("SELECT * FROM accounting_dues_invoices WHERE account_id = ? AND month = ? AND status = 'issued' ORDER BY number")
      .all(accountId, month) as InvoiceRow[];
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

    this.options.db.transaction(() => {
      const seq = this.options.db.prepare("SELECT next FROM accounting_dues_sequence WHERE name = 'invoice'").get() as { next: number };
      this.options.db.prepare("UPDATE accounting_dues_sequence SET next = next + 1 WHERE name = 'invoice'").run();
      const number = `I-${String(seq.next).padStart(4, '0')}`;
      const html = renderInvoice({ number, accountLabel: row.label, month, date, dueDate, lines, previous: row.previous, total, owed,
        billTo: row.address ?? '', label: label.singular },
        this.wording(), this.options.formatMoney);
      // Where it went as typed, and the owners by @id and share at that date: no names (D-047).
      this.options.db.prepare(`INSERT INTO accounting_dues_invoices (id, number, account_id, account_label, month, date, due_date, total, previous, owed, owners,
          party, party_name, address, billing_address, owner_ids, html, sha256, status, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, ?, ?, ?, ?, 'issued', ?, ?)`).run(
        id, number, row.accountId, row.label, month, date, dueDate, total, row.previous, owed,
        row.party, row.partyName, row.address, JSON.stringify(row.owners),
        html, createHash('sha256').update(html).digest('hex'), actor.actingUsername(), this.stamp());
      lines.forEach((l, position) => this.options.db.prepare(`INSERT INTO accounting_dues_invoice_lines (id, invoice_id, position, kind, description, amount, category,
          rule_id, applies_to, charge_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.newId(), id, position, l.kind, l.description, l.amount, l.category, l.ruleId, l.appliesTo, l.key));
    })();
    return id;
  }

  /**
   * Email a stored invoice to the unit's owners (their emails, looked up as the
   * caller), with the invoice attached as a PDF when the site makes PDFs (else
   * the page alone); false when none could be sent.
   */
  private async sendInvoice(actor: DuesActor, id: string, to: string[]): Promise<boolean> {
    const row = this.row(id);
    const mailer = this.options.email?.();
    const ctx = actor.subject;
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
      billingAddress: r.billing_address, ownerIds: ownersOf(r),
      total: r.total, previous: r.previous, owed: r.owed, owners: JSON.parse(r.owners) as Invoice['owners'], lines, html: r.html, sha256: r.sha256,
      status: r.status, voidReason: r.void_reason, emailedTo: r.emailed_to, emailedAt: r.emailed_at, pdfSha256: r.pdf_sha256, createdBy: r.created_by, createdAt: r.created_at,
      paid, remaining: r.status === 'issued' ? r.total - paid : 0
    };
  }

  private async authorize(actor: DuesActor, action: string): Promise<void> {
    const decision = await this.options.decide(actor.subject, { action });
    if (!decision.permit) await actor.enforceDeny(action, decision);
  }

  /** Allowed when any of the actions is; refused naming the last. */
  private async authorizeAny(actor: DuesActor, actions: string[]): Promise<void> {
    let last: Decision | null = null;
    for (const action of actions) {
      last = await this.options.decide(actor.subject, { action });
      if (last.permit) return;
    }
    await actor.enforceDeny(actions[actions.length - 1] as string, last as Decision);
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

/** The owners an invoice names, by @id and share (D-047); none on an invoice issued before identities. */
const ownersOf = (r: { owner_ids: string | null }): BillingOwner[] => (r.owner_ids ? JSON.parse(r.owner_ids) as BillingOwner[] : []);

/** The first line of an address as typed, to name a billing entry on screens. */
const firstLine = (address: string): string => address.split(/\r?\n/)[0]?.trim() ?? '';

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
