/**
 * The treasurer's dues screens: forms of ngdpbase's forms add-on on locked
 * pages this add-on ships (pages/). A payment is one call to the accounting
 * add-on's ReceiptManager, the one door for money in: a receipt line with
 * `dues` details naming the account (D-035). Issuing and voiding invoices are
 * one call each to DuesManager. When the forms add-on is not enabled, nothing
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
interface FormsDataManagerLike { registerShippedForm(addon: string, definition: unknown, options?: { required?: boolean }): Promise<unknown> }

/** The slice of the accounting add-on's ReceiptManager this add-on calls. */
export interface ReceiptManagerLike {
  recordReceipt(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string; number: string | null }>;
}

/** The slice of DuesManager the forms call. */
export interface DuesManagerLike {
  issueMonth(actor: ApiContext, input: Record<string, unknown>): Promise<{ issued: number; emailed: number; notEmailed: string[]; held: boolean }>;
  voidInvoice(actor: ApiContext, id: string, reason: string): Promise<{ id: string; number: string }>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const checked = (v: unknown): boolean => v !== undefined && v !== '' && v !== false;

export const PAYMENT_FORM = {
  id: 'dues-payment', title: 'Record a payment on an account', handler: 'accounting-dues', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'Money an account paid: cash, a check, a bank transfer. It is recorded as a receipt (R-0001, …). It settles the account\'s invoices oldest first, or the one you name first; money paid ahead is kept as the account\'s credit.',
  fields: [
    { name: 'account', type: 'dropdown', label: 'Account', required: true, optionsSource: 'fetch:DuesManager.toFormOptions(list=accounts)' },
    { name: 'amount', type: 'amount', label: 'Amount', required: true },
    { name: 'date', type: 'date', label: 'Date received', required: true },
    { name: 'partyName', type: 'text', label: 'Received from (blank: the account)', required: false },
    { name: 'paymentMethod', type: 'dropdown', label: 'Method', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=payment-methods)' },
    { name: 'paymentMethodId', type: 'text', label: 'Check number or confirmation code', required: false },
    { name: 'fundId', type: 'dropdown', label: 'Fund', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' },
    { name: 'category', type: 'dropdown', label: 'Category', required: true, optionsSource: 'fetch:DuesManager.toFormOptions(list=dues-categories)' },
    { name: 'invoiceId', type: 'dropdown', label: 'Pays this invoice first (optional)', required: false, optionsSource: 'fetch:DuesManager.toFormOptions(list=open-invoices)' },
    { name: 'memo', type: 'textarea', label: 'Note', required: false }
  ]
};

export const ISSUE_FORM = {
  id: 'invoice-issue', title: 'Issue this month\'s invoices', handler: 'accounting-dues', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'One invoice per account with something charged for the month and no invoice yet, or one account. Check the Prepare page first. Each is kept exactly as issued.',
  fields: [
    { name: 'month', type: 'dropdown', label: 'Month', required: true, optionsSource: 'fetch:DuesManager.toFormOptions(list=months)' },
    { name: 'account', type: 'dropdown', label: 'Only this account (blank: every account)', required: false, optionsSource: 'fetch:DuesManager.toFormOptions(list=accounts)' },
    { name: 'lateCharges', type: 'checkbox', label: 'Add the late charges shown on the Prepare page', required: false },
    { name: 'email', type: 'checkbox', label: 'Email each invoice with money owed to the owners', required: false }
  ]
};

export const VOID_FORM = {
  id: 'invoice-void', title: 'Void an invoice', handler: 'accounting-dues', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'An invoice issued by mistake. It is kept, marked voided with the reason; issue the month again for the account if needed.',
  fields: [
    { name: 'invoiceId', type: 'dropdown', label: 'Invoice', required: true, optionsSource: 'fetch:DuesManager.toFormOptions(list=invoices)' },
    { name: 'reason', type: 'textarea', label: 'Reason', required: true }
  ]
};

/** The receipt a submitted payment form makes: one line, with the dues details naming the account. */
export function paymentFromForm(data: Data, accountLabel: string): Record<string, unknown> {
  return {
    date: data.date, partyName: str(data.partyName) ?? accountLabel, paymentMethod: data.paymentMethod, paymentMethodId: str(data.paymentMethodId),
    memo: str(data.memo) ?? `Payment on ${accountLabel}`,
    lines: [{ amount: data.amount, fundId: data.fundId, category: data.category, details: { dues: { account: data.account, invoiceId: str(data.invoiceId) } } }]
  };
}

/** The form field a refusal is about, from the ledger's message ("lines[0].details.dues.account …"). */
export function paymentField(message: string): string | undefined {
  const m = /(account|invoiceId|category|fundId|amount|partyName|paymentMethod|memo|date)\b/.exec(message);
  return m?.[1];
}

const refusal = (err: unknown, fieldOf: (message: string) => string | undefined): HandlerResult => {
  if ((err as { name?: string }).name !== 'LedgerError') throw err;
  const message = (err as Error).message;
  const field = fieldOf(message);
  return { ok: false, error: message, ...(field ? { fields: { [field]: message } } : {}) };
};

export async function registerDuesForms(engine: Engine, host: AddonHost, accountLabel: (id: string) => string): Promise<void> {
  const forms = engine.getManager<FormsAddonLike>('FormsAddon');
  const definitions = engine.getManager<FormsDataManagerLike>('FormsDataManager');
  if (!forms || !definitions) { host.logger.info('[accounting-dues] Forms add-on not enabled: the dues screens are off'); return; }
  for (const definition of [PAYMENT_FORM, ISSUE_FORM, VOID_FORM]) await definitions.registerShippedForm('accounting-dues', definition);

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
    const dues = engine.getManager<DuesManagerLike>('DuesManager');
    if (!dues) return { ok: false, error: 'Dues are not running on this site' };
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
    const dues = engine.getManager<DuesManagerLike>('DuesManager');
    if (!dues) return { ok: false, error: 'Dues are not running on this site' };
    try {
      const ctx = host.ApiContext.from(req as never, engine as never);
      const invoice = await dues.voidInvoice(ctx, String(submission.data.invoiceId ?? ''), String(submission.data.reason ?? ''));
      return { ok: true, id: invoice.number };
    } catch (err) {
      return refusal(err, fieldIn(VOID_FORM));
    }
  });
}
