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
/** ngdpbase's forms add-on (v5.22.0, #1880, #1918): a shipped form is registered on every start. */
interface FormsDataManagerLike { registerShippedForm(addon: string, definition: unknown, ctx: unknown): Promise<unknown> }

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
    { name: 'donor', type: 'dropdown', label: 'Donor (a person or organization; add new ones on Add a Donor)', required: false, optionsSource: 'fetch:DonationManager.toFormOptions(list=donors)' },
    { name: 'partyName', type: 'text', label: 'Received from (if not on the list, e.g. anonymous cash)', required: false },
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

/** A donor resolved from the donor list (DonationManager.donor). */
export interface DonorLike { type: 'person' | 'organization'; id: string; name: string }

/** The receipt a submitted gift form makes: one line, in the chosen fund and category, with its gift details and donor. */
export function giftFromForm(data: Data, donor?: DonorLike): Record<string, unknown> {
  return {
    date: data.date, partyName: donor?.name ?? data.partyName, paymentMethod: data.paymentMethod, paymentMethodId: str(data.paymentMethodId), memo: data.memo,
    ...(donor?.type === 'person' ? { partyPersonId: donor.id } : {}),
    lines: [{
      amount: data.amount, fundId: data.fundId, category: data.category,
      details: { gift: {
        goodsValue: typeof data.goodsValue === 'number' ? data.goodsValue : undefined,
        goodsDescription: str(data.goodsDescription),
        anonymous: data.anonymous !== undefined && data.anonymous !== '' && data.anonymous !== false,
        pledgeId: str(data.pledgeId),
        donor: donor ?? null
      } }
    }]
  };
}

/** The form field a refusal is about, from the ledger's message ("lines[0].details.gift.goodsValue …"). */
export function giftField(message: string): string | undefined {
  const m = /(goodsValue|goodsDescription|pledgeId|donor|category|fundId|amount|partyName|paymentMethod|memo|date)\b/.exec(message);
  return m?.[1];
}

/** In-kind gifts and pledges: one call each to DonationManager (D-036). */
export interface DonationManagerLike {
  recordInKind(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string }>;
  createPledge(actor: ApiContext, input: Record<string, unknown>): Promise<{ id: string }>;
  donor(actor: ApiContext, value: string, field?: string): Promise<DonorLike>;
  issueStatements(actor: ApiContext, input: Record<string, unknown>): Promise<{ issued: number; emailed: number; notEmailed: string[] }>;
  reissueStatement(actor: ApiContext, id: string, reason: string, options?: { email?: boolean }): Promise<{ id: string }>;
  addDonor(actor: ApiContext, input: Record<string, unknown>): Promise<DonorLike>;
}

/** A donor field for the in-kind and pledge forms: pick a contact, or type a name. */
const donorFields = [
  { name: 'donor', type: 'dropdown', label: 'Donor (a person or organization)', required: false, optionsSource: 'fetch:DonationManager.toFormOptions(list=donors)' },
  { name: 'donorName', type: 'text', label: 'Or the donor\'s name, if not on the list', required: false }
];

/** The donor's name and contact id for an in-kind gift or pledge: the picked contact, else the typed name. */
async function donorOf(donations: DonationManagerLike, ctx: ApiContext, data: Data): Promise<{ donorName: unknown; donorPersonId?: string }> {
  const picked = str(data.donor) ? await donations.donor(ctx, data.donor as string) : undefined;
  return picked ? { donorName: picked.name, donorPersonId: picked.id } : { donorName: data.donorName };
}

const checked = (v: unknown): boolean => v !== undefined && v !== '' && v !== false;

export const STATEMENT_ISSUE_FORM = {
  id: 'statement-issue', title: 'Issue giving statements', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'Year-end giving statements: one per donor with gifts in the year who has none yet, or one donor. Each is kept exactly as issued. Tick email to send each to the donor\'s address on file.',
  fields: [
    { name: 'year', type: 'dropdown', label: 'Year', required: true, optionsSource: 'fetch:DonationManager.toFormOptions(list=statement-years)' },
    { name: 'donor', type: 'dropdown', label: 'Only this donor (blank: every donor still without one)', required: false, optionsSource: 'fetch:DonationManager.toFormOptions(list=donors)' },
    { name: 'email', type: 'checkbox', label: 'Email each statement to the donor', required: false }
  ]
};

export const STATEMENT_REISSUE_FORM = {
  id: 'statement-reissue', title: 'Reissue a giving statement', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A statement whose gifts have changed since it was issued (a gift voided, refunded or added): issue a new one, with the reason. The old one is kept, marked superseded.',
  fields: [
    { name: 'statementId', type: 'dropdown', label: 'Statement', required: true, optionsSource: 'fetch:DonationManager.toFormOptions(list=statements)' },
    { name: 'reason', type: 'textarea', label: 'Reason', required: true },
    { name: 'email', type: 'checkbox', label: 'Email the new statement to the donor', required: false }
  ]
};

export const DONOR_FORM = {
  id: 'donor-add', title: 'Add a donor', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A donor who has no login on this site: a person or an organization. They are kept with the site\'s contacts, and a later sign-up with the same email joins them. A year-end statement needs a postal address.',
  fields: [
    { name: 'type', type: 'dropdown', label: 'A person or an organization', required: true, options: ['person', 'organization'] },
    { name: 'givenName', type: 'text', label: 'Given name (a person)', required: false },
    { name: 'familyName', type: 'text', label: 'Family name (a person)', required: false },
    { name: 'name', type: 'text', label: 'Name (an organization)', required: false },
    { name: 'email', type: 'text', label: 'Email', required: false },
    { name: 'address', type: 'section', label: 'Postal address' },
    { name: 'streetAddress', type: 'text', label: 'Street', required: false },
    { name: 'addressLocality', type: 'text', label: 'City', required: false },
    { name: 'addressRegion', type: 'text', label: 'State', required: false },
    { name: 'postalCode', type: 'text', label: 'ZIP code', required: false },
    { name: 'addressCountry', type: 'text', label: 'Country', required: false },
    { name: 'affiliation', type: 'section', label: 'Gives on behalf of an organization (a person, optional)' },
    { name: 'organization', type: 'dropdown', label: 'Organization', required: false, optionsSource: 'fetch:DonationManager.toFormOptions(list=organizations)' },
    { name: 'role', type: 'text', label: 'Role there (e.g. Treasurer)', required: false }
  ]
};

export const INKIND_FORM = {
  id: 'inkind-record', title: 'Record an in-kind gift', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A gift of goods or services rather than money. Describe it; do not value it: under IRS rules the organization does not put a value on a non-cash gift. It does not touch fund balances.',
  fields: [
    ...donorFields,
    { name: 'date', type: 'date', label: 'Date received', required: true },
    { name: 'description', type: 'textarea', label: 'What was given (e.g. Dell laptop, used)', required: true }
  ]
};

export const PLEDGE_FORM = {
  id: 'pledge-create', title: 'Record a pledge', handler: 'accounting-donations', store: false, proxySubmission: false, notifyRole: 'admin',
  description: 'A promise to give that is not money yet. It stays outside the ledger; gifts that pay toward it name it on Record a Gift.',
  fields: [
    ...donorFields,
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
  await definitions.registerShippedForm('accounting-donations', GIFT_FORM, host.systemContext(`accounting-donations: shipped form ${GIFT_FORM.id}`));
  for (const [definition, run] of [
    [INKIND_FORM, async (d: DonationManagerLike, ctx: ApiContext, data: Data) => d.recordInKind(ctx, { ...await donorOf(d, ctx, data), date: data.date, description: data.description })],
    [PLEDGE_FORM, async (d: DonationManagerLike, ctx: ApiContext, data: Data) => d.createPledge(ctx, {
      ...await donorOf(d, ctx, data), amount: data.amount, fundId: data.fundId, startDate: data.startDate, endDate: str(data.endDate), schedule: data.schedule, memo: str(data.memo)
    })],
    [DONOR_FORM, async (d: DonationManagerLike, ctx: ApiContext, data: Data) => d.addDonor(ctx, data)],
    [STATEMENT_ISSUE_FORM, async (d: DonationManagerLike, ctx: ApiContext, data: Data) => {
      const result = await d.issueStatements(ctx, { year: Number(data.year), donor: str(data.donor), email: checked(data.email) });
      return { id: `${result.issued} issued, ${result.emailed} emailed${result.notEmailed.length ? `; not emailed: ${result.notEmailed.join(', ')}` : ''}` };
    }],
    [STATEMENT_REISSUE_FORM, async (d: DonationManagerLike, ctx: ApiContext, data: Data) =>
      d.reissueStatement(ctx, data.statementId as string, data.reason as string, { email: checked(data.email) })]
  ] as const) {
    await definitions.registerShippedForm('accounting-donations', definition, host.systemContext(`accounting-donations: shipped form ${definition.id}`));
    forms.registerHandler(definition.id, async (submission, { req }) => {
      const donations = engine.getManager<DonationManagerLike>('DonationManager');
      if (!donations) return { ok: false, error: 'Donations are not running on this site' };
      try {
        const ctx = host.ApiContext.from(req as never, engine as never);
        try {
          return { ok: true, id: (await run(donations, ctx, submission.data)).id };
        } catch (err) {
          // Core's contact door said no: its own refusal (401, 403 or step-up), never built here.
          if ((err as { name?: string }).name === 'ContactRefusedError') {
            const refused = err as unknown as { permission: string; decision: never };
            await ctx.enforceDeny(refused.permission, refused.decision);
          }
          throw err;
        }
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
    const donations = engine.getManager<DonationManagerLike>('DonationManager');
    if (!receipts || !donations) return { ok: false, error: 'The accounting add-on is not running on this site' };
    try {
      const ctx = host.ApiContext.from(req as never, engine as never);
      let donor: DonorLike | undefined;
      try {
        donor = str(submission.data.donor) ? await donations.donor(ctx, submission.data.donor as string) : undefined;
      } catch (err) {
        if ((err as { name?: string }).name === 'ContactRefusedError') {
          const refused = err as unknown as { permission: string; decision: never };
          await ctx.enforceDeny(refused.permission, refused.decision);
        }
        throw err;
      }
      const receipt = await receipts.recordReceipt(ctx, giftFromForm(submission.data, donor));
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
