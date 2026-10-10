/**
 * The treasurer's screens are forms of ngdpbase's forms add-on, on locked pages
 * this add-on ships (pages/). This file gives the forms add-on their
 * definitions and handlers. The handler posts through LedgerManager, which
 * asks its own permission and writes the audit record, so the page's rules
 * decide who may use the form and the ledger decides what they may change.
 *
 * When the forms add-on is not enabled, nothing here runs; the JSON API stays.
 */
import { ApiContext, ApiError } from '../../dist/src/context/ApiContext.js';
import type LedgerManager from './managers/LedgerManager.js';
import { LedgerError, type NewTransaction } from './managers/LedgerManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined }

interface FormsAddonLike {
  registerHandler(formId: string, handler: (submission: { data: Record<string, unknown> }, context: { engine: unknown; req: unknown }) => Promise<HandlerResult>): void;
}
interface FormsDataManagerLike {
  getDefinition(formId: string): unknown;
  saveDefinition(form: unknown): Promise<void>;
}
interface HandlerResult { ok: boolean; error?: string; fields?: Record<string, string>; [key: string]: unknown }

export const ENTRY_FORM_ID = 'ledger-entry';

/** Field names are LedgerManager's, so its error messages point at the right field. */
export const ENTRY_FORM = {
  id: ENTRY_FORM_ID,
  title: 'Record an entry',
  description: 'Money in or out of a fund. A posted entry is never edited: a mistake is voided and replaced.',
  handler: 'accounting',
  store: false,
  proxySubmission: false,
  notifyRole: 'admin',
  fields: [
    { name: 'money', type: 'section', label: 'Money', required: false },
    { name: 'direction', type: 'dropdown', label: 'In or out', required: true, options: ['in', 'out'] },
    { name: 'amount', type: 'amount', label: 'Amount', required: true },
    { name: 'date', type: 'date', label: 'Date', required: true },
    { name: 'fundId', type: 'dropdown', label: 'Fund', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' },
    { name: 'category', type: 'dropdown', label: 'Category', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=categories)' },
    { name: 'who', type: 'section', label: 'Who and how', required: false },
    { name: 'partyName', type: 'text', label: 'Paid by / paid to', required: false },
    { name: 'paymentMethod', type: 'dropdown', label: 'Payment method', required: false, optionsSource: 'fetch:LedgerManager.toFormOptions(list=payment-methods)' },
    { name: 'memo', type: 'textarea', label: 'Memo', required: false }
  ]
};

const ENTRY_FIELDS = new Set(['direction', 'amount', 'date', 'fundId', 'category', 'partyName', 'paymentMethod', 'memo']);

/** A LedgerError names its field first ("amount must be…", "fund 'X' is closed"); put the message there. */
export function fieldOf(message: string): string | undefined {
  const first = message.split(/[\s']/, 1)[0];
  if (first === 'fund') return 'fundId';
  return ENTRY_FIELDS.has(first) ? first : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function entryFromForm(data: Record<string, unknown>): NewTransaction {
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

export async function registerForms(engine: Engine, log: (message: string) => void): Promise<void> {
  const forms = engine.getManager<FormsAddonLike>('FormsAddon');
  const definitions = engine.getManager<FormsDataManagerLike>('FormsDataManager');
  if (!forms || !definitions) { log('[accounting] Forms add-on not enabled: treasurer screens are off; the API still works'); return; }

  // The forms add-on reads definitions from its data folder; ship ours there once.
  // A site that edits it in the form builder keeps its edits.
  if (!definitions.getDefinition(ENTRY_FORM_ID)) await definitions.saveDefinition(ENTRY_FORM);

  forms.registerHandler(ENTRY_FORM_ID, async (submission, { req }) => {
    const ledger = engine.getManager<LedgerManager>('LedgerManager');
    if (!ledger) return { ok: false, error: 'The ledger is not available on this site' };
    try {
      const ctx = ApiContext.from(req as never, engine as never);
      const entry = await ledger.postTransaction(ctx, entryFromForm(submission.data));
      return { ok: true, transactionId: entry.id };
    } catch (err) {
      if (err instanceof LedgerError) {
        const field = fieldOf(err.message);
        return { ok: false, error: err.message, ...(field ? { fields: { [field]: err.message } } : {}) };
      }
      if (err instanceof ApiError) return { ok: false, error: err.message };
      throw err;
    }
  });
}
