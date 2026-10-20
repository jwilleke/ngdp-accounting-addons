/**
 * The treasurer's gift screen: a form of ngdpbase's forms add-on on a locked
 * page this add-on ships (pages/). Its handler is one call to the accounting
 * add-on's ReceiptManager, the one door for money in: a gift is a receipt line
 * with gift details (D-036). When the forms add-on is not enabled, nothing here runs.
 */
import type { AddonHost, ApiContext } from '@jwilleke/ngdpbase-types';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined }
interface HandlerResult { ok: boolean; error?: string; fields?: Record<string, string>; [key: string]: unknown }
type Data = Record<string, unknown>;
interface FormsAddonLike {
  registerHandler(formId: string, handler: (submission: { data: Data }, context: { engine: unknown; req: unknown }) => Promise<HandlerResult>): void;
}
interface FormsDataManagerLike { getDefinition(formId: string): unknown; saveDefinition(form: unknown): Promise<void> }

/** The slice of the accounting add-on's ReceiptManager this add-on calls. */
export interface ReceiptManagerLike {
  recordReceipt(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string; number: string | null }>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export const GIFT_FORM = {
  id: 'gift-record', title: 'Record a gift', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A gift received: cash, a check, a bank transfer. It is recorded as a receipt (R-0001, …) with a gift line. If the donor received goods or services (a dinner, a ticket), enter their value: the receipt slip then shows what is deductible.',
  fields: [
    { name: 'money', type: 'section', label: 'The gift' },
    { name: 'amount', type: 'amount', label: 'Amount', required: true },
    { name: 'date', type: 'date', label: 'Date received', required: true },
    { name: 'fundId', type: 'dropdown', label: 'Fund', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' },
    { name: 'category', type: 'dropdown', label: 'Category', required: true, optionsSource: 'fetch:DonationManager.toFormOptions(list=gift-categories)' },
    { name: 'who', type: 'section', label: 'From whom, and how' },
    { name: 'partyName', type: 'text', label: 'Received from', required: true },
    { name: 'anonymous', type: 'checkbox', label: 'Anonymous: keep the donor hidden from the board and public totals', required: false },
    { name: 'paymentMethod', type: 'dropdown', label: 'Method', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=payment-methods)' },
    { name: 'paymentMethodId', type: 'text', label: 'Check number or confirmation code', required: false },
    { name: 'pledgeId', type: 'dropdown', label: 'Pays toward a pledge (optional)', required: false, optionsSource: 'fetch:DonationManager.toFormOptions(list=open-pledges)' },
    { name: 'goods', type: 'section', label: 'Goods or services received (if any)' },
    { name: 'goodsValue', type: 'amount', label: 'Their value (blank: none)', required: false },
    { name: 'goodsDescription', type: 'text', label: 'What they were (e.g. dinner for two)', required: false },
    { name: 'memo', type: 'textarea', label: 'Reason or purpose', required: true }
  ]
};

/** The receipt a submitted gift form makes: one line, in the chosen fund and category, with its gift details. */
export function giftFromForm(data: Data): Record<string, unknown> {
  return {
    date: data.date, partyName: data.partyName, paymentMethod: data.paymentMethod, paymentMethodId: str(data.paymentMethodId), memo: data.memo,
    lines: [{
      amount: data.amount, fundId: data.fundId, category: data.category,
      details: { gift: {
        goodsValue: typeof data.goodsValue === 'number' ? data.goodsValue : undefined,
        goodsDescription: str(data.goodsDescription),
        anonymous: data.anonymous !== undefined && data.anonymous !== '' && data.anonymous !== false,
        pledgeId: str(data.pledgeId)
      } }
    }]
  };
}

/** The form field a refusal is about, from the ledger's message ("lines[0].details.gift.goodsValue …"). */
export function giftField(message: string): string | undefined {
  const m = /(goodsValue|goodsDescription|pledgeId|category|fundId|amount|partyName|paymentMethod|memo|date)\b/.exec(message);
  return m?.[1];
}

/** In-kind gifts and pledges: one call each to DonationManager (D-036). */
export interface DonationManagerLike {
  recordInKind(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string }>;
  createPledge(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string }>;
}

export const INKIND_FORM = {
  id: 'inkind-record', title: 'Record an in-kind gift', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A gift of goods or services rather than money. Describe it; do not value it: under IRS rules the organization does not put a value on a non-cash gift. It does not touch fund balances.',
  fields: [
    { name: 'donorName', type: 'text', label: 'Donor', required: true },
    { name: 'date', type: 'date', label: 'Date received', required: true },
    { name: 'description', type: 'textarea', label: 'What was given (e.g. Dell laptop, used)', required: true }
  ]
};

export const PLEDGE_FORM = {
  id: 'pledge-create', title: 'Record a pledge', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A promise to give that is not money yet. It stays outside the ledger; gifts that pay toward it name it on Record a Gift.',
  fields: [
    { name: 'donorName', type: 'text', label: 'Donor', required: true },
    { name: 'amount', type: 'amount', label: 'Amount pledged', required: true },
    { name: 'fundId', type: 'dropdown', label: 'Fund', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' },
    { name: 'startDate', type: 'date', label: 'From', required: true },
    { name: 'endDate', type: 'date', label: 'To (optional)', required: false },
    { name: 'schedule', type: 'dropdown', label: 'How it is paid', required: true, options: ['once', 'monthly', 'quarterly', 'yearly'] },
    { name: 'memo', type: 'textarea', label: 'Note (e.g. building campaign)', required: false }
  ]
};

export async function registerGiftForms(engine: Engine, host: AddonHost): Promise<void> {
  const forms = engine.getManager<FormsAddonLike>('FormsAddon');
  const definitions = engine.getManager<FormsDataManagerLike>('FormsDataManager');
  if (!forms || !definitions) { host.logger.info('[accounting-donations] Forms add-on not enabled: the gift screen is off'); return; }
  if (!definitions.getDefinition(GIFT_FORM.id)) await definitions.saveDefinition(GIFT_FORM);
  for (const [definition, run] of [
    [INKIND_FORM, (d: DonationManagerLike, ctx: ApiContext, data: Data) => d.recordInKind(ctx, { donorName: data.donorName, date: data.date, description: data.description })],
    [PLEDGE_FORM, (d: DonationManagerLike, ctx: ApiContext, data: Data) => d.createPledge(ctx, {
      donorName: data.donorName, amount: data.amount, fundId: data.fundId, startDate: data.startDate, endDate: str(data.endDate), schedule: data.schedule, memo: str(data.memo)
    })]
  ] as const) {
    if (!definitions.getDefinition(definition.id)) await definitions.saveDefinition(definition);
    forms.registerHandler(definition.id, async (submission, { req }) => {
      const donations = engine.getManager<DonationManagerLike>('DonationManager');
      if (!donations) return { ok: false, error: 'Donations are not running on this site' };
      try {
        return { ok: true, id: (await run(donations, host.ApiContext.from(req as never, engine as never), submission.data)).id };
      } catch (err) {
        if ((err as { name?: string }).name !== 'LedgerError') throw err;
        const message = (err as Error).message;
        const field = /^(\w+)/.exec(message)?.[1];
        return { ok: false, error: message, ...(field && definition.fields.some(f => f.name === field) ? { fields: { [field]: message } } : {}) };
      }
    });
  }
  forms.registerHandler(GIFT_FORM.id, async (submission, { req }) => {
    const receipts = engine.getManager<ReceiptManagerLike>('ReceiptManager');
    if (!receipts) return { ok: false, error: 'The accounting add-on is not running on this site' };
    try {
      const ctx = host.ApiContext.from(req as never, engine as never);
      const receipt = await receipts.recordReceipt(ctx, giftFromForm(submission.data));
      return { ok: true, receiptId: receipt.id, receiptNumber: receipt.number, slip: `/api/accounting/receipts/${receipt.id}/slip` };
    } catch (err) {
      // The ledger's own refusals (LedgerError) are shown on the field; a permission refusal is the forms add-on's to answer.
      if ((err as { name?: string }).name !== 'LedgerError') throw err;
      const message = (err as Error).message;
      const field = giftField(message);
      return { ok: false, error: message, ...(field ? { fields: { [field]: message } } : {}) };
    }
  });
}
