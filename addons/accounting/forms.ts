/**
 * The treasurer's input screens are forms of ngdpbase's forms add-on, on locked
 * pages this add-on ships (pages/), D-024. This file gives the forms add-on
 * their definitions and handlers.
 *
 * Each handler is one call to the LedgerManager method the JSON API also calls:
 * one code path per action. The ledger asks its own permission and writes the
 * audit record. A refusal it throws (ngdpbase's ApiError, with `reauth` when
 * only a fresh sign-in is missing) is answered by the forms add-on; a
 * LedgerError is shown on the field it names.
 *
 * When the forms add-on is not enabled, nothing here runs; the JSON API stays.
 */
import type { ApiContext } from '../../dist/src/context/ApiContext.js';
import type { AddonHost } from '../../dist/src/utils/addonHost.js';
import type LedgerManager from './managers/LedgerManager.js';
import { LedgerError, type NewTransaction } from './managers/LedgerManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined }

interface HandlerResult { ok: boolean; error?: string; fields?: Record<string, string>; [key: string]: unknown }
type Data = Record<string, unknown>;

interface FormsAddonLike {
  registerHandler(formId: string, handler: (submission: { data: Data }, context: { engine: unknown; req: unknown }) => Promise<HandlerResult>): void;
}
interface FormsDataManagerLike {
  getDefinition(formId: string): unknown;
  saveDefinition(form: unknown): Promise<void>;
}

/** A field of a forms add-on definition. */
interface FieldDef { name: string; type: string; label: string; required?: boolean; options?: string[]; optionsSource?: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

// ── Field sets shared by more than one form ─────────────────────────────────

const fundsChoice = (name: string, label: string, required = true): FieldDef =>
  ({ name, type: 'dropdown', label, required, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' });

const entryFields = (required: boolean): FieldDef[] => [
  { name: 'direction', type: 'dropdown', label: 'In or out', required, options: ['in', 'out'] },
  { name: 'amount', type: 'amount', label: 'Amount', required },
  { name: 'date', type: 'date', label: 'Date', required },
  fundsChoice('fundId', 'Fund', required),
  { name: 'category', type: 'dropdown', label: 'Category', required, optionsSource: 'fetch:LedgerManager.toFormOptions(list=categories)' },
  { name: 'partyName', type: 'text', label: 'Paid by / paid to', required: false },
  { name: 'paymentMethod', type: 'dropdown', label: 'Payment method', required: false, optionsSource: 'fetch:LedgerManager.toFormOptions(list=payment-methods)' },
  { name: 'memo', type: 'textarea', label: 'Memo', required: false }
];

export function entryFromForm(data: Data): NewTransaction {
  return {
    direction: data.direction as NewTransaction['direction'],
    amount: data.amount as number,
    date: data.date as string,
    fundId: data.fundId as string,
    category: data.category as string,
    partyName: str(data.partyName),
    paymentMethod: str(data.paymentMethod),
    memo: str(data.memo)
  };
}

// ── The forms ──────────────────────────────────────────────────────────────

interface LedgerForm {
  definition: { id: string; store: boolean; fields: FieldDef[]; [key: string]: unknown };
  /** One LedgerManager call. */
  run(ledger: LedgerManager, ctx: ApiContext, data: Data): Promise<Record<string, unknown>>;
  /** A LedgerError whose message does not start with a field name, mapped to the field it is about. */
  messageFields?: [RegExp, string][];
}

const form = (id: string, title: string, description: string, fields: FieldDef[]) =>
  ({ id, title, description, handler: 'accounting', store: false, proxySubmission: false, notifyRole: 'admin', fields });

export const LEDGER_FORMS: LedgerForm[] = [
  {
    definition: form('ledger-entry', 'Record an entry',
      'Money in or out of a fund. A posted entry is never edited: a mistake is voided and replaced.',
      [{ name: 'money', type: 'section', label: 'Money' }, ...entryFields(true).slice(0, 5),
        { name: 'who', type: 'section', label: 'Who and how' }, ...entryFields(true).slice(5)]),
    run: async (ledger, ctx, data) => ({ transactionId: (await ledger.postTransaction(ctx, entryFromForm(data))).id }),
    messageFields: [[/^fund '/, 'fundId']]
  },
  {
    definition: form('ledger-transfer', 'Move money between funds',
      'Takes the amount out of one fund and puts it into another. The total stays the same.',
      [fundsChoice('fromFundId', 'From fund'), fundsChoice('toFundId', 'To fund'),
        { name: 'amount', type: 'amount', label: 'Amount', required: true },
        { name: 'date', type: 'date', label: 'Date', required: true },
        { name: 'memo', type: 'textarea', label: 'Why', required: false }]),
    run: async (ledger, ctx, data) => ({
      transferId: (await ledger.transferBetweenFunds(ctx, {
        fromFundId: data.fromFundId as string, toFundId: data.toFundId as string,
        amount: data.amount as number, date: data.date as string, memo: str(data.memo)
      }))[0]?.transferId
    }),
    messageFields: [[/^a transfer needs two different funds/, 'toFundId']]
  },
  {
    definition: form('ledger-void', 'Void an entry',
      'Voids a posted entry, with the reason. To correct it, fill in the replacement too: both are posted together. A transfer is voided as a pair, without a replacement.',
      [{ name: 'transactionId', type: 'dropdown', label: 'Entry', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=entries)' },
        { name: 'reason', type: 'textarea', label: 'Reason', required: true },
        { name: 'replacement', type: 'section', label: 'Replacement (optional)' }, ...entryFields(false)]),
    run: async (ledger, ctx, data) => {
      const replacement = data.amount === '' || data.amount === undefined ? undefined : entryFromForm(data);
      const result = await ledger.voidTransaction(ctx, data.transactionId as string, data.reason as string, replacement);
      return { replacementId: result.replacement?.id ?? null };
    },
    messageFields: [[/^this entry is already voided/, 'transactionId'], [/^a transfer is voided as a pair/, 'amount'], [/^fund '/, 'fundId']]
  },
  {
    definition: form('fund-create', 'Create a fund', 'A new fund starts at its opening balance, on its opening date.',
      [{ name: 'name', type: 'text', label: 'Name', required: true },
        { name: 'description', type: 'textarea', label: 'Description', required: false },
        { name: 'restricted', type: 'checkbox', label: 'Restricted: money given for a stated purpose', required: false },
        { name: 'openingBalance', type: 'amount', label: 'Opening balance', required: false },
        { name: 'openingDate', type: 'date', label: 'Opening date (default today)', required: false }]),
    run: async (ledger, ctx, data) => ({
      fundId: (await ledger.createFund(ctx, {
        name: data.name as string, description: str(data.description), restricted: data.restricted !== undefined && data.restricted !== '',
        openingBalance: typeof data.openingBalance === 'number' ? data.openingBalance : undefined, openingDate: str(data.openingDate)
      })).id
    }),
    messageFields: [[/^a fund named/, 'name']]
  },
  {
    definition: form('fund-rename', 'Rename a fund', 'Changes the name or description. The fund keeps its entries.',
      [fundsChoice('fundId', 'Fund'),
        { name: 'name', type: 'text', label: 'New name', required: true },
        { name: 'description', type: 'textarea', label: 'New description (blank keeps it)', required: false }]),
    run: async (ledger, ctx, data) => ({
      fundId: (await ledger.updateFund(ctx, data.fundId as string, { name: data.name as string, description: str(data.description) })).id
    }),
    messageFields: [[/^a fund named/, 'name']]
  },
  {
    definition: form('fund-close', 'Close a fund', 'A closed fund takes no new entries. Its history stays.',
      [fundsChoice('fundId', 'Fund'), { name: 'reason', type: 'textarea', label: 'Reason', required: false }]),
    run: async (ledger, ctx, data) => ({ fundId: (await ledger.closeFund(ctx, data.fundId as string, str(data.reason))).id }),
    messageFields: [[/^fund '/, 'fundId']]
  }
];

/** The field a LedgerError is about: the form's own mapping, else the message's first word when it is a field. */
export function fieldOf(ledgerForm: LedgerForm, message: string): string | undefined {
  for (const [pattern, field] of ledgerForm.messageFields ?? []) if (pattern.test(message)) return field;
  const first = message.split(/[\s']/, 1)[0];
  return ledgerForm.definition.fields.some(f => f.name === first) ? first : undefined;
}

export async function registerForms(engine: Engine, host: AddonHost): Promise<void> {
  const log = (message: string): void => host.logger.info(message);
  const forms = engine.getManager<FormsAddonLike>('FormsAddon');
  const definitions = engine.getManager<FormsDataManagerLike>('FormsDataManager');
  if (!forms || !definitions) { log('[accounting] Forms add-on not enabled: treasurer screens are off; the API still works'); return; }

  for (const ledgerForm of LEDGER_FORMS) {
    const { id } = ledgerForm.definition;
    // The forms add-on reads definitions from its data folder; ship ours there once.
    // A site that edits one in the form builder keeps its edits.
    if (!definitions.getDefinition(id)) await definitions.saveDefinition(ledgerForm.definition);

    forms.registerHandler(id, async (submission, { req }) => {
      const ledger = engine.getManager<LedgerManager>('LedgerManager');
      if (!ledger) return { ok: false, error: 'The ledger is not available on this site' };
      try {
        const ctx = host.ApiContext.from(req as never, engine as never);
        return { ok: true, ...(await ledgerForm.run(ledger, ctx, submission.data)) };
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err; // a permission refusal is the forms add-on's to answer
        const field = fieldOf(ledgerForm, err.message);
        return { ok: false, error: err.message, ...(field ? { fields: { [field]: err.message } } : {}) };
      }
    });
  }
}
