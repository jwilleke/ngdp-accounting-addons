/**
 * The treasurer's receivables screens: forms of ngdpbase's forms add-on on locked
 * pages this add-on ships (pages/). A payment is one call to the accounting
 * add-on's ReceiptManager, the one door for money in: a receipt line with
 * `dues` details naming the account (D-035). Issuing and voiding invoices are
 * one call each to ReceivablesManager. When the forms add-on is not enabled, nothing
 * here runs.
 */
import type { AddonHost, ApiContext } from '@jwilleke/ngdpbase-types';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined }
interface HandlerResult { ok: boolean; error?: string; fields?: Record<string, string>; [key: string]: unknown }
type Data = Record<string, unknown>;
interface FormsAddonLike {
  registerHandler(formId: string, handler: (submission: { data: Data }, context: { engine: unknown; req: unknown }) => Promise<HandlerResult>): void;
}
/** ngdpbase's forms add-on (v5.22.0, #1880, #1918): a shipped form is registered on every start. */
interface FormsDataManagerLike { registerShippedForm(addon: string, definition: unknown, ctx: unknown): Promise<unknown> }

/** The slice of the accounting add-on's ReceiptManager this add-on calls. */
export interface ReceiptManagerLike {
  recordReceipt(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string; number: string | null }>;
}

/** The slice of ReceivablesManager the forms call. */
export interface ReceivablesManagerLike {
  issueMonth(actor: ApiContext, input: Record<string, unknown>): Promise<{ issued: number; emailed: number; notEmailed: string[]; held: boolean }>;
  voidInvoice(actor: ApiContext, id: string, reason: string): Promise<{ id: string; number: string }>;
  setOpeningBalance(actor: ApiContext, input: { folio: string; amount: number; date: string; reason: string }): Promise<{ folio: string }>;
  writeOff(actor: ApiContext, input: { folio: string; amount: number; date: string; reason: string }): Promise<{ folio: string }>;
  fileLien(actor: ApiContext, input: { folio: string; amount: number; date: string; reference: string; reason?: string }): Promise<{ folio: string }>;
  voidFolioItem(actor: ApiContext, itemId: string, reason: string): Promise<{ folio: string }>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const checked = (v: unknown): boolean => v !== undefined && v !== '' && v !== false;

export const PAYMENT_FORM = {
  id: 'receivable-payment', title: 'Record a payment on an account', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'Money an account paid: cash, a check, a bank transfer. It is recorded as a receipt (R-0001, …). It settles the unit\'s invoices oldest first, or the one you name first; money paid ahead is kept as the unit\'s credit.',
  fields: [
    { name: 'account', type: 'dropdown', label: 'Account', required: true, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=accounts)' },
    { name: 'amount', type: 'amount', label: 'Amount', required: true },
    { name: 'date', type: 'date', label: 'Date received', required: true },
    { name: 'partyName', type: 'text', label: 'Received from (blank: the account)', required: false },
    { name: 'paymentMethod', type: 'dropdown', label: 'Method', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=payment-methods)' },
    { name: 'paymentMethodId', type: 'text', label: 'Check number or confirmation code', required: false },
    { name: 'fundId', type: 'dropdown', label: 'Fund', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' },
    { name: 'category', type: 'dropdown', label: 'Category', required: true, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=receivable-categories)' },
    { name: 'folio', type: 'dropdown', label: 'On an earlier owners\' folio (blank: the unit\'s current folio)', required: false, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=folios)' },
    { name: 'invoiceId', type: 'dropdown', label: 'Pays this invoice first (optional)', required: false, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=open-invoices)' },
    { name: 'memo', type: 'textarea', label: 'Note', required: false }
  ]
};

export const ISSUE_FORM = {
  id: 'invoice-issue', title: 'Issue this month\'s invoices', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'One invoice per billing address with something charged for the month and no invoice yet, or one account. Check the Prepare page first. Each is kept exactly as issued.',
  fields: [
    { name: 'month', type: 'dropdown', label: 'Month', required: true, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=months)' },
    { name: 'account', type: 'dropdown', label: 'Only this account (blank: every account)', required: false, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=accounts)' },
    { name: 'lateCharges', type: 'checkbox', label: 'Add the late charges shown on the Prepare page', required: false },
    { name: 'email', type: 'checkbox', label: 'Email each invoice with money owed to the owners', required: false }
  ]
};

export const VOID_FORM = {
  id: 'invoice-void', title: 'Void an invoice', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'An invoice issued by mistake. It is kept, marked voided with the reason; issue the month again for the account if needed.',
  fields: [
    { name: 'invoiceId', type: 'dropdown', label: 'Invoice', required: true, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=invoices)' },
    { name: 'reason', type: 'textarea', label: 'Reason', required: true }
  ]
};

/** The receipt a submitted payment form makes: one line, with the receivable details naming the account. */
export function paymentFromForm(data: Data, accountLabel: string): Record<string, unknown> {
  return {
    date: data.date, partyName: str(data.partyName) ?? accountLabel, paymentMethod: data.paymentMethod, paymentMethodId: str(data.paymentMethodId),
    memo: str(data.memo) ?? `Payment on ${accountLabel}`,
    lines: [{ amount: data.amount, fundId: data.fundId, category: data.category, details: { receivable: { account: data.account, folio: str(data.folio), invoiceId: str(data.invoiceId) } } }]
  };
}

/** The form field a refusal is about, from the ledger's message ("lines[0].details.receivable.account …"). */
export function paymentField(message: string): string | undefined {
  const m = /(account|folio|invoiceId|category|fundId|amount|partyName|paymentMethod|memo|date)\b/.exec(message);
  return m?.[1];
}

const refusal = (err: unknown, fieldOf: (message: string) => string | undefined): HandlerResult => {
  if ((err as { name?: string }).name !== 'LedgerError') throw err;
  const message = (err as Error).message;
  const field = fieldOf(message);
  return { ok: false, error: message, ...(field ? { fields: { [field]: message } } : {}) };
};

const folioField = { name: 'folio', type: 'dropdown', label: 'Folio', required: true, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=folios)' };

export const FOLIO_OPENING_FORM = {
  id: 'folio-opening', title: 'Enter a balance brought forward', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'What a folio owed, or had as credit, before these books: once per folio. It is kept as entered; a mistake is voided and entered again.',
  fields: [folioField,
    { name: 'amount', type: 'amount', label: 'Amount', required: true },
    { name: 'credit', type: 'checkbox', label: 'It is a credit (paid ahead), not money owed', required: false },
    { name: 'date', type: 'date', label: 'As of', required: true },
    { name: 'reason', type: 'textarea', label: 'Where the figure comes from', required: true }]
};

export const FOLIO_WRITE_OFF_FORM = {
  id: 'folio-write-off', title: 'Write off a folio\'s debt', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'An amount the association gives up on a folio. No money moves; the folio\'s balance drops by it.',
  fields: [folioField,
    { name: 'amount', type: 'amount', label: 'Amount written off', required: true },
    { name: 'date', type: 'date', label: 'Date', required: true },
    { name: 'reason', type: 'textarea', label: 'Reason', required: true }]
};

export const FOLIO_LIEN_FORM = {
  id: 'folio-lien', title: 'Record a lien', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A lien filed with the county on a folio whose debt is judged uncollectable. It does not change the balance; money recovered later is an ordinary payment on the folio.',
  fields: [folioField,
    { name: 'amount', type: 'amount', label: 'Amount of the lien', required: true },
    { name: 'date', type: 'date', label: 'Date filed', required: true },
    { name: 'reference', type: 'text', label: 'County recording number or instrument', required: true },
    { name: 'reason', type: 'textarea', label: 'Note (optional)', required: false }]
};

export const FOLIO_ITEM_VOID_FORM = {
  id: 'folio-item-void', title: 'Void a folio entry', handler: 'accounting-receivables', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A balance brought forward, write-off or lien entered by mistake. It is kept, marked voided with the reason.',
  fields: [
    { name: 'item', type: 'dropdown', label: 'Entry', required: true, optionsSource: 'fetch:ReceivablesManager.toFormOptions(list=folio-items)' },
    { name: 'reason', type: 'textarea', label: 'Reason', required: true }]
};

/** A form's amount field, in cents, as the forms add-on hands it over (as the payment form passes it on). */
const cents = (v: unknown): number => Number(v);

export async function registerReceivableForms(engine: Engine, host: AddonHost, accountLabel: (id: string) => string): Promise<void> {
  const forms = engine.getManager<FormsAddonLike>('FormsAddon');
  const definitions = engine.getManager<FormsDataManagerLike>('FormsDataManager');
  if (!forms || !definitions) { host.logger.info('[accounting-receivables] Forms add-on not enabled: the invoice screens are off'); return; }
  // Registered on every start, as the system (ngdpbase #1973): replaced when this add-on's version is newer.
  for (const definition of [PAYMENT_FORM, ISSUE_FORM, VOID_FORM, FOLIO_OPENING_FORM, FOLIO_WRITE_OFF_FORM, FOLIO_LIEN_FORM, FOLIO_ITEM_VOID_FORM]) await definitions.registerShippedForm('accounting-receivables', definition, host.systemContext(`accounting-receivables: shipped form ${definition.id}`));

  forms.registerHandler(PAYMENT_FORM.id, async (submission, { req }) => {
    const receipts = engine.getManager<ReceiptManagerLike>('ReceiptManager');
    if (!receipts) return { ok: false, error: 'The accounting add-on is not running on this site' };
    try {
      const ctx = host.ApiContext.from(req as never, engine as never);
      const receipt = await receipts.recordReceipt(ctx, paymentFromForm(submission.data, accountLabel(String(submission.data.account ?? ''))));
      return { ok: true, receiptId: receipt.id, receiptNumber: receipt.number, slip: `/api/accounting/receipts/${receipt.id}/slip` };
    } catch (err) {
      return refusal(err, paymentField);
    }
  });

  const fieldIn = (definition: { fields: { name: string }[] }) => (message: string) => {
    const field = /^(\w+)/.exec(message)?.[1];
    return field && definition.fields.some(f => f.name === field) ? field : undefined;
  };
  forms.registerHandler(ISSUE_FORM.id, async (submission, { req }) => {
    const dues = engine.getManager<ReceivablesManagerLike>('ReceivablesManager');
    if (!dues) return { ok: false, error: 'Invoices are not running on this site' };
    try {
      const ctx = host.ApiContext.from(req as never, engine as never);
      const d = submission.data;
      const result = await dues.issueMonth(ctx, { month: d.month, account: str(d.account), lateCharges: checked(d.lateCharges), email: checked(d.email) });
      const sent = result.held ? 'nothing sent: sending to owners is off on this site'
        : `${result.emailed} emailed${result.notEmailed.length ? `; not emailed: ${result.notEmailed.join(', ')}` : ''}`;
      return { ok: true, id: `${result.issued} issued, ${sent}` };
    } catch (err) {
      return refusal(err, fieldIn(ISSUE_FORM));
    }
  });
  forms.registerHandler(VOID_FORM.id, async (submission, { req }) => {
    const dues = engine.getManager<ReceivablesManagerLike>('ReceivablesManager');
    if (!dues) return { ok: false, error: 'Invoices are not running on this site' };
    try {
      const ctx = host.ApiContext.from(req as never, engine as never);
      const invoice = await dues.voidInvoice(ctx, String(submission.data.invoiceId ?? ''), String(submission.data.reason ?? ''));
      return { ok: true, id: invoice.number };
    } catch (err) {
      return refusal(err, fieldIn(VOID_FORM));
    }
  });

  const folioHandler = (definition: { id: string; fields: { name: string }[] }, run: (r: ReceivablesManagerLike, ctx: ApiContext, d: Record<string, unknown>) => Promise<{ folio: string }>) =>
    forms.registerHandler(definition.id, async (submission, { req }) => {
      const receivables = engine.getManager<ReceivablesManagerLike>('ReceivablesManager');
      if (!receivables) return { ok: false, error: 'Invoices are not running on this site' };
      try {
        const ctx = host.ApiContext.from(req as never, engine as never);
        return { ok: true, id: (await run(receivables, ctx, submission.data)).folio };
      } catch (err) {
        return refusal(err, fieldIn(definition));
      }
    });
  folioHandler(FOLIO_OPENING_FORM, (r, ctx, d) => r.setOpeningBalance(ctx, { folio: String(d.folio ?? ''), amount: cents(d.amount) * (checked(d.credit) ? -1 : 1), date: String(d.date ?? ''), reason: String(d.reason ?? '') }));
  folioHandler(FOLIO_WRITE_OFF_FORM, (r, ctx, d) => r.writeOff(ctx, { folio: String(d.folio ?? ''), amount: cents(d.amount), date: String(d.date ?? ''), reason: String(d.reason ?? '') }));
  folioHandler(FOLIO_LIEN_FORM, (r, ctx, d) => r.fileLien(ctx, { folio: String(d.folio ?? ''), amount: cents(d.amount), date: String(d.date ?? ''), reference: String(d.reference ?? ''), reason: str(d.reason) }));
  folioHandler(FOLIO_ITEM_VOID_FORM, (r, ctx, d) => r.voidFolioItem(ctx, String(d.item ?? ''), String(d.reason ?? '')));
}
