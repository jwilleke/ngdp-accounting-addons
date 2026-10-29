/**
 * ReceivablesManager — the receivables add-on's one door (D-035): invoices in this add-on's
 * own database, outside the ledger, which holds only money that moved. A
 * payment is an ordinary receipt (R-number) whose line has `receivable` details
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
import { billingMonth, chargeFor, type Charge, lateChargesDue, settle, splitByShare, type Assessment, type Billed, type LateChargeRule, type Payment, type ProposedLateCharge } from '../billing.js';
import { renderInvoice, type InvoiceWording, type PostalAddress } from './invoice.js';

export type ReceivablesHost = Pick<AddonHost, 'actorOf' | 'addonAuditEventName'>;

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
export interface ReceivablesActor {
  enforceDeny(permission: string, decision: Decision): Promise<never>;
  actingUsername(): string;
  readonly ipAddress: string | undefined;
  readonly subject: ActorContext | null;
}

export interface ReceivablesDb {
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T;
}

/** An owner as accommodation's billing() gives it (ngdpbase#2042): their identity @id and share of the unit. */
export interface BillingOwner { '@id': string; share: number }

/** Where a unit's invoices go: free-text address, and that entry's percent of each charge. */
export interface BillingEntry { address: string; share: number }

/** An ownership period: the same owners with the same shares (D-048); its id is a folio's key. */
export interface OwnershipPeriod { id: string; from: string; through?: string }

/** What billing() gives: the ownership period, where the invoices go, and who owes them (D-047, D-048). */
export interface Billing { period: OwnershipPeriod; billing: BillingEntry[]; owners: BillingOwner[] }

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
export class ReceivablesError extends Error {
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
  /** The folio it is on (D-048): its id and its number, e.g. P-1/F02. */
  folioId: string | null; folio: string;
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
  /**
   * The folio the invoice goes on (D-048): the unit's assigned folio for this ownership period, or a
   * new one when the period is new (`folioId` null until it is issued); its number, e.g. P-1/F02.
   */
  folioId: string | null; folio: string; periodId: string | null; periodFrom: string | null;
  /** Why the account cannot be billed this month (no billing address, no owner, …); nothing is issued for it. */
  problem: string | null;
  /**
   * This entry's charge: its share of the unit's, when it is due, and the unit's charge lines at their
   * full amounts with the entry's share (percent), so the invoice shows how its amount was reached.
   */
  charge: { dueDate: string; amount: number; lines?: Charge['lines']; share?: number } | null;
  lateCharges: ProposedLateCharge[];
  /** Owed before this month; negative is a credit. */
  previous: number;
  total: number;
  owed: number;
  /** The month's invoice, when already issued. */
  invoiced: string | null;
}

export interface AccountBalance { accountId: string; label: string; invoiced: number; paid: number; balance: number }

/** What the Executive Hub's receivables card shows (ngdpbase#2094, D-050). Money in minor units. */
export interface ReceivablesExecutiveSummary {
  /** What units owe, all their folios together; a unit in credit adds nothing. */
  outstanding: number;
  unitsOwing: number;
  /** Liens standing (filed with the county, not voided), and what they claim. */
  liens: { count: number; total: number };
  /** Write-offs standing, and what they gave up. */
  writeOffs: { count: number; total: number };
  /** The newest month with an issued invoice, as YYYY-MM; null before the first. */
  lastInvoicedMonth: string | null;
}

/** A folio and its money (D-048). */
export interface FolioView {
  id: string; accountId: string; label: string; folio: string; from: string | null; owners: BillingOwner[];
  /** Whether new invoices go on it; open while assigned or while it has a balance. */
  assigned: boolean; open: boolean;
  invoiced: number; paid: number; balance: number;
  items: { id: string; kind: 'opening' | 'write-off' | 'lien'; amount: number; date: string; reason: string; reference: string | null }[];
}

export interface ReceivablesOptions {
  host: ReceivablesHost;
  db: ReceivablesDb;
  ledger: LedgerLike;
  /**
   * The payments: every posted `receivable` receipt line (and `dues`, from before the rename), net of refunds, bounced
   * checks left out. The ledger hands this reader to the add-on that registered
   * the kind, and to no one else (LedgerManager.registerLineDetails).
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
  /** The site's word for the charge (configuration): Assessment, Rent, Dues. */
  label: () => { singular: string; plural: string };
  wording?: () => InvoiceWording;
  formatMoney: (minor: number) => string;
  /** Told after every committed write; index.ts bumps the `ReceivablesManager` cache topic (ngdpbase caching guide: the owner bumps). */
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
  billing_address: string | null; owner_ids: string | null; folio_id: string | null;
}
interface FolioRow { id: string; account_id: string; number: number; period_id: string | null; period_from: string | null; owner_ids: string; created_by: string; created_at: string }
interface FolioItemRow { id: string; folio_id: string; kind: 'opening' | 'write-off' | 'lien'; amount: number; date: string; reason: string; reference: string | null; status: 'recorded' | 'voided'; void_reason: string | null; created_by: string; created_at: string }
interface LineRow { invoice_id: string; position: number; kind: 'charge' | 'late-charge'; description: string; amount: number; category: string; rule_id: string | null; applies_to: string | null; charge_key: string | null }

/** What a folio's money looks like (D-048): its invoices and balance brought forward, what payments and write-offs settled, and the balance. */
interface AccountState { invoices: Billed[]; paid: Map<string, number>; credit: number; invoiced: number; payments: number }

export default class ReceivablesManager {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: ReceivablesOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  // ── The month ──────────────────────────────────────────────────────────

  /**
   * What each folio of each unit would be invoiced for a month, without issuing
   * (D-047, D-048). The current ownership period's folio: one row per billing
   * entry, its share of the unit's charge and of that folio's balance brought
   * forward, and the late charges due on that folio (on the first entry); a new
   * period means a new folio, which starts at $0. Every earlier folio that still
   * owes: no charge, only the late charges due on its unpaid invoices, to its last
   * billing address, until it is paid or written off. Late charges are as of the
   * 1st of the month. A unit whose billing is refused is shown with the reason,
   * and its current folio is not billed. Needs ledger-read.
   */
  async prepareMonth(actor: ReceivablesActor, month: string): Promise<MonthRow[]> {
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
      const existing = new Map<string, InvoiceRow[]>();
      for (const r of this.monthRows(unit.id, m)) existing.set(this.folioKeyOf(r), [...(existing.get(this.folioKeyOf(r)) ?? []), r]);
      const issuedRows = (list: InvoiceRow[]) => list.map(r => {
        const folio = this.folioOfInvoice(r);
        return { accountId: unit.id, label, party: r.party, partyName: r.party_name, address: r.billing_address, owners: ownersOf(r),
          folioId: folio?.id ?? null, folio: folio ? folioNumber(folio) : '', periodId: folio?.period_id ?? null, periodFrom: folio?.period_from ?? null,
          problem: null, charge: charge ? { dueDate: charge.dueDate, amount: r.total } : null, lateCharges: [],
          previous: r.previous, total: r.total, owed: r.owed, invoiced: r.number } satisfies MonthRow;
      });
      const lateOn = (key: string) => {
        const st = states.get(key) ?? emptyState();
        return { state: st, late: lateChargesDue(st.invoices, st.paid, rules, `${m}-01`, made) };
      };
      const folios = this.options.db.prepare('SELECT * FROM accounting_receivables_folios WHERE account_id = ? ORDER BY number').all(unit.id) as FolioRow[];
      const assigned = folios[folios.length - 1] ?? null;
      // The current ownership period's folio.
      let currentKey: string | null = null;
      const assignedLate = lateOn(assigned?.id ?? legacyKey(unit.id)).late;
      if (charge || assignedLate.length) {
        let billing: Billing | null = null;
        try {
          // Read as the caller (treasurer or job), so the read is attributed and decided (accommodation-billing-read).
          billing = await this.billingSource().billing(actor.subject as ActorContext, unit.id, { on: charge?.dueDate ?? `${m}-01` });
        } catch (err) {
          if (err instanceof ReceivablesError) throw err;
          rows.push({ accountId: unit.id, label, party: '', partyName: '', address: null, owners: [], folioId: null, folio: '', periodId: null, periodFrom: null,
            problem: (err as Error).message, charge, lateCharges: [], previous: 0, total: 0, owed: 0, invoiced: null });
          currentKey = assigned?.id ?? legacyKey(unit.id); // its own late charges wait for its billing to be fixed
        }
        if (billing) {
          // The folio for this period: the one keyed to it, the unit's first folio for its first period (the
          // money from before folios counts there), or a new one, created when the invoices are issued.
          const folio = this.folioOfPeriod(billing.period.id) ?? (assigned && !assigned.period_id ? assigned : null) ?? (!assigned ? null : undefined);
          currentKey = folio?.id ?? (folio === null ? legacyKey(unit.id) : `new:${billing.period.id}`);
          const done = existing.get(currentKey);
          if (done) rows.push(...issuedRows(done));
          else {
            const { state, late } = folio !== undefined ? lateOn(currentKey) : { state: emptyState(), late: [] as ProposedLateCharge[] };
            if (charge || late.length) {
              const charges = splitByShare(charge?.amount ?? 0, billing.billing);
              const brought = splitByShare(state.invoiced - state.payments, billing.billing);
              const number = folio ? folioNumber(folio) : `${unit.id}/F${String(this.nextFolioNumber(unit.id)).padStart(2, '0')}`;
              billing.billing.forEach((entry, idx) => {
                const lines = idx === 0 ? late : [];
                const amount = charges[idx] ?? 0;
                const previous = brought[idx] ?? 0;
                const total = amount + lines.reduce((t, l) => t + l.amount, 0);
                rows.push({ accountId: unit.id, label, party: `entry-${idx + 1}`, partyName: firstLine(entry.address), address: entry.address, owners: billing.owners,
                  folioId: folio?.id ?? null, folio: number, periodId: billing.period.id, periodFrom: billing.period.from,
                  problem: null, charge: charge && amount > 0 ? { dueDate: charge.dueDate, amount, lines: charge.lines, share: entry.share } : null, lateCharges: lines,
                  previous, total, owed: Math.max(0, previous + total), invoiced: null });
              });
            }
          }
        }
      }
      // Every earlier folio that still owes keeps its late charges, and only those, until it is paid or written
      // off (D-048); they go to its last billing address and its owners.
      for (const f of folios) {
        if (f.id === currentKey) continue;
        const done = existing.get(f.id);
        if (done) { rows.push(...issuedRows(done)); continue; }
        const { state, late } = lateOn(f.id);
        if (!late.length || state.invoiced - state.payments <= 0) continue;
        const last = this.options.db.prepare("SELECT * FROM accounting_receivables_invoices WHERE folio_id = ? AND status = 'issued' ORDER BY due_date DESC, number DESC LIMIT 1").get(f.id) as InvoiceRow | undefined
          ?? (this.options.db.prepare("SELECT * FROM accounting_receivables_invoices WHERE account_id = ? AND folio_id IS NULL AND status = 'issued' ORDER BY due_date DESC, number DESC LIMIT 1").get(unit.id) as InvoiceRow | undefined);
        const previous = state.invoiced - state.payments;
        const total = late.reduce((t, l) => t + l.amount, 0);
        rows.push({ accountId: unit.id, label, party: 'entry-1', partyName: last?.party_name ?? '', address: last?.billing_address ?? null, owners: JSON.parse(f.owner_ids) as BillingOwner[],
          folioId: f.id, folio: folioNumber(f), periodId: f.period_id, periodFrom: f.period_from,
          problem: null, charge: null, lateCharges: late, previous, total, owed: Math.max(0, previous + total), invoiced: null });
      }
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.folio.localeCompare(b.folio) || a.party.localeCompare(b.party, undefined, { numeric: true }));
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
  async issueMonth(actor: ReceivablesActor, input: { month: string; account?: string; lateCharges?: boolean; email?: boolean }): Promise<{ issued: number; emailed: number; notEmailed: string[]; held: boolean; skipped: string[] }> {
    await this.authorize(actor, 'invoice-issue');
    const month = this.month(input.month);
    const prepared = (await this.prepareMonth(actor, month)).filter(r => !input.account || r.accountId === input.account);
    const skipped = prepared.filter(r => r.problem).map(r => `${r.label}: ${r.problem}`);
    const rows = prepared.filter(r => !r.invoiced && !r.problem);
    if (input.account && !rows.length) throw new ReceivablesError(409, `account: nothing to invoice for ${month}, or it is already invoiced${skipped.length ? ` (${skipped.join('; ')})` : ''}`);
    const pending: { row: MonthRow; late: ProposedLateCharge[] }[] = [];
    for (const row of rows) {
      const late = input.lateCharges ? row.lateCharges : [];
      if (!row.charge && !late.length) continue;
      pending.push({ row, late });
    }
    await this.audit(actor, { action: 'invoice-issue', severity: 'high', resource: `invoices:${month}`, resourceType: 'receivables-invoice',
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
      // A new ownership period gets its folio now, once for all of the unit's entries (D-048).
      if (!p.row.folioId) p.row.folioId = this.folioFor(actor, p.row).id;
      for (const other of pending) if (other.row.accountId === p.row.accountId && !other.row.folioId) other.row.folioId = p.row.folioId;
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
  async scheduledRun(actor: ReceivablesActor, month: string): Promise<{ success: boolean; summary: string }> {
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
  async voidInvoice(actor: ReceivablesActor, invoiceId: string, reason: string): Promise<Invoice> {
    await this.authorize(actor, 'invoice-issue');
    const why = text(reason, 'reason');
    const row = this.row(text(invoiceId, 'invoiceId'));
    if (row.status === 'voided') throw new ReceivablesError(409, 'invoiceId: this invoice is already voided');
    await this.audit(actor, { action: 'invoice-void', severity: 'high', resource: row.id, resourceType: 'receivables-invoice', reason: why,
      metadata: { number: row.number, account: row.account_id, month: row.month, total: row.total } });
    this.options.db.transaction(() => {
      this.options.db.prepare("UPDATE accounting_receivables_invoices SET status = 'voided', void_reason = ? WHERE id = ? AND status = 'issued'").run(why, row.id);
    })();
    await this.options.changed?.();
    return this.getInvoice(actor, row.id);
  }

  // ── Reading ────────────────────────────────────────────────────────────

  /** An invoice, exactly as issued, with what has been paid of it. Needs ledger-read, or account-read (the board, D-047). */
  async getInvoice(actor: ReceivablesActor, invoiceId: string): Promise<Invoice> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const row = this.row(invoiceId);
    return this.toInvoice(row, this.stateOf(this.states(), row));
  }

  /** Invoices, newest first; one account's, or one month's; voided ones only when asked. Needs ledger-read, or account-read. */
  async listInvoices(actor: ReceivablesActor, filter: { accountId?: string; month?: string; includeVoided?: boolean } = {}): Promise<Invoice[]> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeVoided) where.push("status = 'issued'");
    if (filter.accountId) { where.push('account_id = ?'); params.push(filter.accountId); }
    if (filter.month) { where.push('month = ?'); params.push(this.month(filter.month)); }
    const rows = this.options.db.prepare(`SELECT * FROM accounting_receivables_invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY month DESC, number DESC`).all(...params) as InvoiceRow[];
    const states = this.states();
    return rows.map(r => this.toInvoice(r, this.stateOf(states, r)));
  }

  /** Each unit: what was invoiced, what was paid, and the balance (negative is a credit), all its folios together. Needs ledger-read, or account-read. */
  async balances(actor: ReceivablesActor): Promise<AccountBalance[]> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const totals = new Map<string, { invoiced: number; payments: number }>();
    for (const [key, s] of this.states()) {
      const account = this.accountOfFolioKey(key);
      const t = totals.get(account) ?? { invoiced: 0, payments: 0 };
      totals.set(account, { invoiced: t.invoiced + s.invoiced, payments: t.payments + s.payments });
    }
    return this.source().list().map(unit => {
      const s = totals.get(unit.id) ?? { invoiced: 0, payments: 0 };
      return { accountId: unit.id, label: accountLabel(unit), invoiced: s.invoiced, paid: s.payments, balance: s.invoiced - s.payments };
    }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  /**
   * The receivables card on core's Executive Hub (ngdpbase#2094, D-050): what units owe
   * and how many owe, the liens and write-offs standing, and the last month invoiced.
   * One pass over the money, as `balances` makes, and aggregate queries for the rest;
   * no unit is read from the accounts manager. Needs ledger-read, or account-read.
   */
  async executiveSummary(actor: ReceivablesActor): Promise<ReceivablesExecutiveSummary> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const byAccount = new Map<string, number>();
    for (const [key, s] of this.states()) {
      const account = this.accountOfFolioKey(key);
      byAccount.set(account, (byAccount.get(account) ?? 0) + s.invoiced - s.payments);
    }
    const owing = [...byAccount.values()].filter(b => b > 0);
    const items = (kind: 'lien' | 'write-off') => {
      const row = this.options.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t FROM accounting_receivables_folio_items
        WHERE kind = ? AND status = 'recorded'`).get(kind) as { n: number; t: number };
      return { count: row.n, total: row.t };
    };
    const last = this.options.db.prepare("SELECT MAX(month) AS m FROM accounting_receivables_invoices WHERE status = 'issued'").get() as { m: string | null };
    return { outstanding: owing.reduce((t, b) => t + b, 0), unitsOwing: owing.length, liens: items('lien'), writeOffs: items('write-off'), lastInvoicedMonth: last.m };
  }

  /**
   * Every folio, or one unit's (D-048): its number, owners, whether new invoices go on it, whether it
   * is open (assigned, or still owed or owing), and its money, with the balance brought forward and
   * write-offs recorded on it. Needs ledger-read, or account-read (the board).
   */
  async folios(actor: ReceivablesActor, filter: { accountId?: string } = {}): Promise<FolioView[]> {
    await this.authorizeAny(actor, ['account-read', 'ledger-read']);
    const states = this.states();
    const labels = new Map((this.options.accounts()?.list() ?? []).map(u => [u.id, accountLabel(u)]));
    const rows = (filter.accountId
      ? this.options.db.prepare('SELECT * FROM accounting_receivables_folios WHERE account_id = ? ORDER BY account_id, number').all(filter.accountId)
      : this.options.db.prepare('SELECT * FROM accounting_receivables_folios ORDER BY account_id, number').all()) as FolioRow[];
    return rows.map(f => this.folioView(f, states.get(f.id) ?? emptyState(), labels.get(f.account_id) ?? f.account_id))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.folio.localeCompare(b.folio));
  }

  /** A balance brought forward on a folio (D-048): owed when positive, a credit when negative; one standing per folio. Needs invoice-issue. */
  async setOpeningBalance(actor: ReceivablesActor, input: { folio: string; amount: number; date: string; reason: string }): Promise<FolioView> {
    return this.recordFolioItem(actor, 'opening', input);
  }

  /** A write-off on a folio (D-048): an amount the association gives up; no money moved. Needs invoice-issue. */
  async writeOff(actor: ReceivablesActor, input: { folio: string; amount: number; date: string; reason: string }): Promise<FolioView> {
    return this.recordFolioItem(actor, 'write-off', input);
  }

  /**
   * A lien filed with the county on a folio whose debt is judged uncollectable (D-048): the date filed,
   * the amount, and the county's reference (recording number or instrument). It does not change the
   * balance; money recovered later is an ordinary payment on the folio. Needs invoice-issue.
   */
  async fileLien(actor: ReceivablesActor, input: { folio: string; amount: number; date: string; reference: string; reason?: string }): Promise<FolioView> {
    return this.recordFolioItem(actor, 'lien', { ...input, reason: input.reason && input.reason.trim() ? input.reason : 'Lien filed with the county' });
  }

  /** Void a balance brought forward, a write-off or a lien, once, with a reason. Needs invoice-issue. */
  async voidFolioItem(actor: ReceivablesActor, itemId: string, reason: string): Promise<FolioView> {
    await this.authorize(actor, 'invoice-issue');
    const why = text(reason, 'reason');
    const item = this.options.db.prepare('SELECT * FROM accounting_receivables_folio_items WHERE id = ?').get(text(itemId, 'item')) as FolioItemRow | undefined;
    if (!item) throw new ReceivablesError(404, 'item: unknown folio item');
    if (item.status === 'voided') throw new ReceivablesError(409, 'item: already voided');
    const folio = this.folioRow(item.folio_id);
    await this.audit(actor, { action: 'folio-item-void', severity: 'high', resource: item.id, resourceType: 'receivables-folio', reason: why,
      metadata: { folio: folioNumber(folio), kind: item.kind, amount: item.amount } });
    this.options.db.prepare("UPDATE accounting_receivables_folio_items SET status = 'voided', void_reason = ? WHERE id = ? AND status = 'recorded'").run(why, item.id);
    await this.options.changed?.();
    return this.folioView(folio, this.states().get(folio.id) ?? emptyState(), this.labelOf(folio.account_id));
  }

  // ── An owner's own view (D-037, D-047, D-048) ───────────────────────────

  /**
   * The signed-in person's own bills, folio by folio (D-048). For each unit they
   * own today (accommodation's ownUnits, as the viewer), its assigned folio: every
   * invoice of every billing entry, what is paid and left, and the balance. For
   * each folio they were an owner on before (its owners name their identity @id,
   * or, on invoices from before identities, their username), that folio with its
   * balance: they still owe it. Needs ledger-self, which every signed-in person holds.
   */
  async myAccounts(actor: ReceivablesActor): Promise<{ accountId: string; label: string; folio: string; current: boolean; balance: number;
    invoices: { id: string; number: string; month: string; dueDate: string; billedTo: string; total: number; paid: number; remaining: number }[] }[]> {
    await this.authorize(actor, 'ledger-self');
    const { assigned, rows, folios } = await this.ownRows(actor);
    const states = this.states();
    return [...folios.values()].map(f => {
      const state = states.get(f.key) ?? emptyState();
      const invoices = rows.filter(r => this.folioKeyOf(r) === f.key);
      return {
        accountId: f.accountId, label: this.labelOf(f.accountId), folio: f.number, current: assigned.has(f.key),
        balance: state.invoiced - state.payments,
        invoices: invoices.map(r => {
          const paid = state.paid.get(r.id) ?? 0;
          return { id: r.id, number: r.number, month: r.month, dueDate: r.due_date, billedTo: r.party_name, total: r.total, paid, remaining: r.total - paid };
        })
      };
    }).filter(f => f.invoices.length || f.balance !== 0).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.folio.localeCompare(b.folio));
  }

  /** One of the signed-in person's own invoices (as myAccounts decides), exactly as issued; any other is not found. Needs ledger-self. */
  async myInvoice(actor: ReceivablesActor, invoiceId: string): Promise<Invoice> {
    await this.authorize(actor, 'ledger-self');
    const row = (await this.ownRows(actor)).rows.find(r => r.id === invoiceId);
    if (!row) throw new ReceivablesError(404, 'invoiceId: unknown invoice');
    return this.toInvoice(row, this.stateOf(this.states(), row));
  }

  /**
   * The folios a person may see as their own, and their invoices: the assigned folio of each unit they
   * own today, and every folio whose owners name their identity @id (or whose invoices from before
   * identities name their username).
   */
  private async ownRows(actor: ReceivablesActor): Promise<{ assigned: Set<string>; rows: InvoiceRow[]; folios: Map<string, { key: string; accountId: string; number: string }> }> {
    const ctx = actor.subject as ActorContext;
    const username = actor.actingUsername();
    const units = await this.billingSource().ownUnits?.(ctx).catch(() => []) ?? [];
    const me = (await this.identitySource()?.getByUserIdentifier(ctx, username).catch(() => null))?.['@id'];
    const folios = new Map<string, { key: string; accountId: string; number: string }>();
    const assigned = new Set<string>();
    const add = (key: string, accountId: string, number: string) => { if (!folios.has(key)) folios.set(key, { key, accountId, number }); };
    for (const u of units.filter(x => x.as.includes('owner'))) {
      // The unit's current folio, if it is this owner's: a new owner's folio starts with their first invoice,
      // and until then they see none of the earlier owners' (D-048).
      const f = this.assignedFolio(u.id);
      if (f && me && !(JSON.parse(f.owner_ids) as BillingOwner[]).some(o => o['@id'] === me)) continue;
      const key = f?.id ?? legacyKey(u.id);
      assigned.add(key);
      add(key, u.id, f ? folioNumber(f) : `${u.id}/F01`);
    }
    const all = this.options.db.prepare("SELECT * FROM accounting_receivables_invoices WHERE status = 'issued' ORDER BY month DESC, number DESC").all() as InvoiceRow[];
    for (const r of all) {
      if ((me && ownersOf(r).some(o => o['@id'] === me)) || (!r.owner_ids && r.party.split(',').includes(username))) {
        const f = this.folioOfInvoice(r);
        add(this.folioKeyOf(r), r.account_id, f ? folioNumber(f) : `${r.account_id}/F01`);
      }
    }
    return { assigned, folios, rows: all.filter(r => folios.has(this.folioKeyOf(r))) };
  }

  /** An invoice's account, folio and status, for the `receivable` line kind's validator. */
  invoiceOf(invoiceId: string): { accountId: string; folio: string | null; status: string } | null {
    const row = this.options.db.prepare('SELECT * FROM accounting_receivables_invoices WHERE id = ?').get(invoiceId) as InvoiceRow | undefined;
    return row ? { accountId: row.account_id, folio: this.folioOfInvoice(row)?.id ?? null, status: row.status } : null;
  }

  /** The folio a payment on a unit goes on when it names none (D-048): the unit's assigned folio, if it has one yet. For the validator. */
  assignedFolioId(accountId: string): string | null {
    return this.assignedFolio(accountId)?.id ?? null;
  }

  /** Whether a folio is one of the unit's, for the validator. */
  folioOfAccount(accountId: string, folioId: string): boolean {
    return Boolean(this.options.db.prepare('SELECT 1 FROM accounting_receivables_folios WHERE id = ? AND account_id = ?').get(folioId, accountId));
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
   *   folios           each folio, with its balance         account-read or ledger-read
   *   folio-items      balances brought forward, write-offs and liens, for voiding
   *   receivable-categories  the chart's categories for payments ledger-record (through LedgerManager)
   *   months           last month, this month, next month
   *   open-invoices    issued invoices with money owed   ledger-read
   *   invoices         issued invoices, for voiding      ledger-read
   */
  async toFormOptions(options: Record<string, string> = {}, viewer?: unknown): Promise<{ value: string; label: string; amount?: number }[]> {
    if (options.list === 'accounts') {
      const source = this.options.accounts();
      return (source?.list() ?? []).map(u => ({ value: u.id, label: accountLabel(u) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    }
    if (options.list === 'receivable-categories') {
      const allowed = new Set(this.options.categories());
      return (await this.options.ledger.toFormOptions({ list: 'categories', kind: 'in' }, viewer)).filter(c => allowed.has(c.value));
    }
    if (options.list === 'months') {
      const d = this.now();
      const at = (offset: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
      return [at(0), at(1), at(-1)].map(m => ({ value: m, label: m }));
    }
    if (options.list === 'folios' || options.list === 'folio-items') {
      try {
        const folios = await this.folios(viewerActor(viewer));
        if (options.list === 'folio-items') {
          return folios.flatMap(f => f.items.map(i => ({ value: i.id, label: `${f.folio} · ${i.kind === 'opening' ? 'balance brought forward' : i.kind} · ${this.options.formatMoney(i.amount)} · ${i.date}` })));
        }
        return folios.map(f => ({ value: f.id, amount: f.balance,
          label: `${f.label} · ${f.folio}${f.assigned ? ' (current)' : f.open ? ' (earlier owners, open)' : ' (closed)'} · ${this.options.formatMoney(f.balance)}` }));
      } catch {
        return [];
      }
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
    if (!source) throw new ReceivablesError(409, 'the accounts to bill are not available on this site (ngdpbase.addons.accounting-receivables.accounts-manager)');
    return source;
  }

  private identitySource(): IdentitySource | null | undefined {
    return this.options.identities?.();
  }

  private billingSource(): BillingSource {
    const source = this.options.billing();
    if (!source) throw new ReceivablesError(409, 'the billing parties are not available on this site (ngdpbase.addons.accounting-receivables.billing-manager)');
    return source;
  }

  private month(value: unknown): string {
    try { return billingMonth(value); } catch (err) { throw new ReceivablesError(400, (err as Error).message); }
  }

  /**
   * Every folio's invoices, balance brought forward, payments and write-offs, read
   * once, by folio (D-048): payments are posted receivable lines, less refunds,
   * bounced checks left out, and settle their folio's invoices oldest first, or
   * the one they name first. A payment names its folio when recorded (the one
   * chosen, its invoice's, or the unit's assigned one); invoices and payments from
   * before folios count on the unit's first folio.
   */
  private states(): Map<string, AccountState> {
    const invoices = new Map<string, Billed[]>();
    const folioOfInvoice = new Map<string, string>();
    const add = <T>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);
    for (const r of this.options.db.prepare("SELECT * FROM accounting_receivables_invoices WHERE status = 'issued'").all() as InvoiceRow[]) {
      const key = this.folioKeyOf(r);
      add(invoices, key, { id: r.id, number: r.number, dueDate: r.due_date, total: r.total });
      folioOfInvoice.set(r.id, key);
    }
    const payments = new Map<string, Payment[]>();
    for (const item of this.options.db.prepare("SELECT * FROM accounting_receivables_folio_items WHERE status = 'recorded'").all() as FolioItemRow[]) {
      // A balance brought forward is owed like an invoice (a credit when negative); a write-off settles like a payment.
      if (item.kind === 'lien') continue; // a lien records a claim filed with the county; the balance stays as it is
      if (item.kind === 'opening' && item.amount > 0) add(invoices, item.folio_id, { id: `opening:${item.id}`, number: 'Balance brought forward', dueDate: item.date, total: item.amount });
      else add(payments, item.folio_id, { amount: item.kind === 'opening' ? -item.amount : item.amount, invoiceId: null });
    }
    for (const { amount, details } of this.options.payments()) {
      const d = details as { account?: string; folio?: string | null; invoiceId?: string | null };
      if (!d.account) continue;
      const key = d.folio ?? (d.invoiceId ? folioOfInvoice.get(d.invoiceId) : undefined) ?? this.firstFolioKey(d.account);
      add(payments, key, { amount, invoiceId: d.invoiceId ?? null });
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

  // ── Folios (D-048) ─────────────────────────────────────────────────────

  private folioRow(id: string): FolioRow {
    const row = this.options.db.prepare('SELECT * FROM accounting_receivables_folios WHERE id = ?').get(id) as FolioRow | undefined;
    if (!row) throw new ReceivablesError(404, 'folio: unknown folio');
    return row;
  }

  /** The unit's assigned folio: the newest; new invoices go on it. */
  private assignedFolio(accountId: string): FolioRow | null {
    return (this.options.db.prepare('SELECT * FROM accounting_receivables_folios WHERE account_id = ? ORDER BY number DESC LIMIT 1').get(accountId) as FolioRow | undefined) ?? null;
  }

  private folioOfPeriod(periodId: string): FolioRow | null {
    return (this.options.db.prepare('SELECT * FROM accounting_receivables_folios WHERE period_id = ?').get(periodId) as FolioRow | undefined) ?? null;
  }

  /** The key money from before folios counts under: the unit's first folio, once it has one. */
  private firstFolioKey(accountId: string): string {
    const first = this.options.db.prepare('SELECT id FROM accounting_receivables_folios WHERE account_id = ? ORDER BY number LIMIT 1').get(accountId) as { id: string } | undefined;
    return first?.id ?? legacyKey(accountId);
  }

  private folioKeyOf(r: InvoiceRow): string {
    return r.folio_id ?? this.firstFolioKey(r.account_id);
  }

  private folioOfInvoice(r: InvoiceRow): FolioRow | null {
    const key = this.folioKeyOf(r);
    return key.startsWith('legacy:') ? null : this.folioRow(key);
  }

  private stateOf(states: Map<string, AccountState>, r: InvoiceRow): AccountState {
    return states.get(this.folioKeyOf(r)) ?? emptyState();
  }

  private accountOfFolioKey(key: string): string {
    return key.startsWith('legacy:') ? key.slice('legacy:'.length) : this.folioRow(key).account_id;
  }

  private nextFolioNumber(accountId: string): number {
    const row = this.options.db.prepare('SELECT MAX(number) AS n FROM accounting_receivables_folios WHERE account_id = ?').get(accountId) as { n: number | null };
    return (row.n ?? 0) + 1;
  }

  private labelOf(accountId: string): string {
    const unit = this.options.accounts()?.get(accountId);
    return unit ? accountLabel(unit) : accountId;
  }

  /**
   * The folio for a month row's ownership period, created when the period is new: the unit's first
   * folio takes the first period (and the money from before folios); every later period a new one,
   * numbered on. Written with the invoices it is issued for.
   */
  private folioFor(actor: ReceivablesActor, row: MonthRow): FolioRow {
    if (row.periodId) {
      const keyed = this.folioOfPeriod(row.periodId);
      if (keyed) return keyed;
    }
    const id = this.newId();
    this.options.db.prepare(`INSERT INTO accounting_receivables_folios (id, account_id, number, period_id, period_from, owner_ids, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.accountId, this.nextFolioNumber(row.accountId), row.periodId, row.periodFrom, JSON.stringify(row.owners),
      actor.actingUsername(), this.stamp());
    return this.folioRow(id);
  }

  private folioView(f: FolioRow, state: AccountState, label: string): FolioView {
    const balance = state.invoiced - state.payments;
    const assigned = this.assignedFolio(f.account_id)?.id === f.id;
    const items = (this.options.db.prepare("SELECT * FROM accounting_receivables_folio_items WHERE folio_id = ? AND status = 'recorded' ORDER BY date, created_at").all(f.id) as FolioItemRow[])
      .map(i => ({ id: i.id, kind: i.kind, amount: i.amount, date: i.date, reason: i.reason, reference: i.reference }));
    return { id: f.id, accountId: f.account_id, label, folio: folioNumber(f), from: f.period_from, owners: JSON.parse(f.owner_ids) as BillingOwner[],
      assigned, open: assigned || balance !== 0, invoiced: state.invoiced, paid: state.payments, balance, items };
  }

  private async recordFolioItem(actor: ReceivablesActor, kind: 'opening' | 'write-off' | 'lien', input: { folio: string; amount: number; date: string; reason: string; reference?: string }): Promise<FolioView> {
    await this.authorize(actor, 'invoice-issue');
    const folio = this.folioRow(text(input.folio, 'folio'));
    const amount = input.amount;
    if (!Number.isInteger(amount) || amount === 0 || (kind !== 'opening' && amount < 0)) throw new ReceivablesError(400, `amount: ${kind === 'opening' ? 'a balance brought forward is not zero' : 'a positive amount'}, in cents`);
    const reference = kind === 'lien' ? text(input.reference, 'reference') : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) throw new ReceivablesError(400, 'date must be YYYY-MM-DD');
    const why = text(input.reason, 'reason');
    if (kind === 'opening' && this.options.db.prepare("SELECT 1 FROM accounting_receivables_folio_items WHERE folio_id = ? AND kind = 'opening' AND status = 'recorded'").get(folio.id)) {
      throw new ReceivablesError(409, 'folio: it already has a balance brought forward; void that one first');
    }
    const id = this.newId();
    await this.audit(actor, { action: `folio-${kind}`, severity: 'high', resource: id, resourceType: 'receivables-folio', reason: why,
      metadata: { folio: folioNumber(folio), amount, date: input.date, ...(reference ? { reference } : {}) } });
    this.options.db.prepare(`INSERT INTO accounting_receivables_folio_items (id, folio_id, kind, amount, date, reason, reference, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)`).run(id, folio.id, kind, amount, input.date, why, reference, actor.actingUsername(), this.stamp());
    await this.options.changed?.();
    return this.folioView(folio, this.states().get(folio.id) ?? emptyState(), this.labelOf(folio.account_id));
  }

  /** Late charges already on issued invoices, by key, so none is made twice. */
  private madeKeys(): Set<string> {
    return new Set((this.options.db.prepare(`SELECT l.charge_key FROM accounting_receivables_invoice_lines l JOIN accounting_receivables_invoices i ON i.id = l.invoice_id
      WHERE i.status = 'issued' AND l.charge_key IS NOT NULL`).all() as { charge_key: string }[]).map(r => r.charge_key));
  }

  /** A unit's issued invoices for a month. */
  private monthRows(accountId: string, month: string): InvoiceRow[] {
    return this.options.db.prepare("SELECT * FROM accounting_receivables_invoices WHERE account_id = ? AND month = ? AND status = 'issued' ORDER BY number")
      .all(accountId, month) as InvoiceRow[];
  }

  private insertInvoice(actor: ReceivablesActor, month: string, row: MonthRow, late: ProposedLateCharge[]): string {
    const label = this.options.label();
    const category = this.options.categories()[0];
    if (!category) throw new ReceivablesError(409, 'no category is set for invoices (ngdpbase.addons.accounting-receivables.categories)');
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
      const seq = this.options.db.prepare("SELECT next FROM accounting_receivables_sequence WHERE name = 'invoice'").get() as { next: number };
      this.options.db.prepare("UPDATE accounting_receivables_sequence SET next = next + 1 WHERE name = 'invoice'").run();
      const number = `I-${String(seq.next).padStart(4, '0')}`;
      const html = renderInvoice({ number, accountLabel: row.label, month, date, dueDate, lines, chargeLines: row.charge?.lines ?? [], share: row.charge?.share ?? 100,
        previous: row.previous, total, owed,
        billTo: row.address ?? '', label: label.singular },
        this.wording(), this.options.formatMoney);
      // Where it went as typed, and the owners by @id and share at that date: no names (D-047).
      this.options.db.prepare(`INSERT INTO accounting_receivables_invoices (id, number, account_id, account_label, month, date, due_date, total, previous, owed, owners,
          party, party_name, address, billing_address, owner_ids, folio_id, html, sha256, status, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, ?, ?, ?, ?, ?, 'issued', ?, ?)`).run(
        id, number, row.accountId, row.label, month, date, dueDate, total, row.previous, owed,
        row.party, row.partyName, row.address, JSON.stringify(row.owners), row.folioId,
        html, createHash('sha256').update(html).digest('hex'), actor.actingUsername(), this.stamp());
      lines.forEach((l, position) => this.options.db.prepare(`INSERT INTO accounting_receivables_invoice_lines (id, invoice_id, position, kind, description, amount, category,
          rule_id, applies_to, charge_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.newId(), id, position, l.kind, l.description, l.amount, l.category, l.ruleId, l.appliesTo, l.key));
    })();
    return id;
  }

  /**
   * Email a stored invoice to the unit's owners (their emails, looked up as the
   * caller), with the invoice attached as a PDF when the site makes PDFs (else
   * the page alone); false when none could be sent.
   */
  private async sendInvoice(actor: ReceivablesActor, id: string, to: string[]): Promise<boolean> {
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
    this.options.db.prepare('UPDATE accounting_receivables_invoices SET emailed_to = ?, emailed_at = ?, pdf_sha256 = ? WHERE id = ? AND emailed_at IS NULL')
      .run(sent.join(', '), this.stamp(), pdf ? createHash('sha256').update(pdf).digest('hex') : null, id);
    return true;
  }

  private wording(): InvoiceWording {
    return this.options.wording?.() ?? { organization: { name: '', address: '', payTo: '' } };
  }

  private row(id: string): InvoiceRow {
    const row = this.options.db.prepare('SELECT * FROM accounting_receivables_invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
    if (!row) throw new ReceivablesError(404, 'invoiceId: unknown invoice');
    return row;
  }

  private toInvoice(r: InvoiceRow, state: AccountState): Invoice {
    const lines = (this.options.db.prepare('SELECT * FROM accounting_receivables_invoice_lines WHERE invoice_id = ? ORDER BY position').all(r.id) as LineRow[])
      .map(l => ({ description: l.description, amount: l.amount, kind: l.kind, category: l.category, ruleId: l.rule_id, appliesTo: l.applies_to }));
    const paid = r.status === 'issued' ? state.paid.get(r.id) ?? 0 : 0;
    return {
      id: r.id, number: r.number, accountId: r.account_id, accountLabel: r.account_label, month: r.month, date: r.date, dueDate: r.due_date,
      party: r.party, partyName: r.party_name, address: r.address ? JSON.parse(r.address) as PostalAddress : null,
      billingAddress: r.billing_address, ownerIds: ownersOf(r),
      folioId: this.folioOfInvoice(r)?.id ?? null, folio: (() => { const f = this.folioOfInvoice(r); return f ? folioNumber(f) : ''; })(),
      total: r.total, previous: r.previous, owed: r.owed, owners: JSON.parse(r.owners) as Invoice['owners'], lines, html: r.html, sha256: r.sha256,
      status: r.status, voidReason: r.void_reason, emailedTo: r.emailed_to, emailedAt: r.emailed_at, pdfSha256: r.pdf_sha256, createdBy: r.created_by, createdAt: r.created_at,
      paid, remaining: r.status === 'issued' ? r.total - paid : 0
    };
  }

  private async authorize(actor: ReceivablesActor, action: string): Promise<void> {
    const decision = await this.options.decide(actor.subject, { action });
    if (!decision.permit) await actor.enforceDeny(action, decision);
  }

  /** Allowed when any of the actions is; refused naming the last. */
  private async authorizeAny(actor: ReceivablesActor, actions: string[]): Promise<void> {
    let last: Decision | null = null;
    for (const action of actions) {
      last = await this.options.decide(actor.subject, { action });
      if (last.permit) return;
    }
    await actor.enforceDeny(actions[actions.length - 1] as string, last as Decision);
  }

  private async audit(actor: ReceivablesActor, record: { action: string; severity: string; resource: string; resourceType: string; reason?: string; metadata: Record<string, unknown> }): Promise<void> {
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

/** A folio's number as people read it: the unit and F01, F02, … (D-048). */
const folioNumber = (f: { account_id: string; number: number }): string => `${f.account_id}/F${String(f.number).padStart(2, '0')}`;

/** Where a unit's money counts before it has any folio. */
const legacyKey = (accountId: string): string => `legacy:${accountId}`;

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
  if (typeof value !== 'string' || value.trim() === '') throw new ReceivablesError(400, `${field} is required`);
  if (value.length > 2000) throw new ReceivablesError(400, `${field} is longer than 2000 characters`);
  return value.trim();
}

/** A page render's viewer as a caller, for reading only, as LedgerManager.viewerActor does. */
function viewerActor(viewer: unknown): ReceivablesActor {
  const username = (viewer as { username?: unknown } | null | undefined)?.username;
  return {
    ipAddress: undefined, subject: (viewer ?? null) as ActorContext | null,
    actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
    enforceDeny: async (permission: string) => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
}
