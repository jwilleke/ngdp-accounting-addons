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
import type { AddonHost, ApiContext } from '@jwilleke/ngdpbase-types';
import type LedgerManager from './managers/LedgerManager.js';
import { LedgerError, type NewTransaction } from './managers/LedgerManager.js';
import type ReceiptManager from './managers/ReceiptManager.js';

interface Engine { getManager<T = unknown>(name: string): T | null | undefined }

interface HandlerResult { ok: boolean; error?: string; fields?: Record<string, string>; [key: string]: unknown }
type Data = Record<string, unknown>;

interface FormsAddonLike {
  registerHandler(formId: string, handler: (submission: { data: Data }, context: { engine: unknown; req: unknown }) => Promise<HandlerResult>): void;
}
/** ngdpbase's forms add-on (v5.22.0, #1880, #1918): a shipped form is registered on every start. */
interface FormsDataManagerLike {
  registerShippedForm(addon: string, definition: unknown, ctx: unknown): Promise<unknown>;
}


/** A row of a lines field, as the forms add-on submits it: amounts already in minor units (ngdpbase #1913). */
type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => Boolean(r) && typeof r === 'object') : []);

/**
 * A field of a forms add-on definition. A `checklist` (ngdpbase v5.21.0, #1904) submits the ticked
 * values as an array; with `totalField` it shows whether the ticked amounts match that field. That
 * line is only shown: the ledger checks the sum itself.
 */
interface FieldDef {
  name: string; type: string; label: string; required?: boolean; options?: string[]; optionsSource?: string; totalField?: string;
  /** lines (ngdpbase #1913): the sub-fields of each row, how many rows, and which sub-field is summed. */
  fields?: FieldDef[]; minRows?: number; maxRows?: number; amountField?: string;
}

/** The receipt a submitted Record a Receipt form makes: one line per row (D-033). */
export function receiptFromForm(data: Data): Record<string, unknown> {
  return {
    date: data.date, accountId: str(data.accountId), partyName: data.partyName, paymentMethod: data.paymentMethod,
    paymentMethodId: str(data.paymentMethodId), memo: data.memo,
    lines: rows(data.lines).map(r => ({ amount: r.amount, fundId: r.fundId, category: r.category, memo: str(r.memo) }))
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

// ── Field sets shared by more than one form ─────────────────────────────────

const fundsChoice = (name: string, label: string, required = true): FieldDef =>
  ({ name, type: 'dropdown', label, required, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' });

/** Where the money sits (D-031). Blank lets the method pick: cash and checks to Cash on Hand, bank methods to the default bank account. */
const accountChoice = (label = 'Account (blank: picked by method)'): FieldDef =>
  ({ name: 'accountId', type: 'dropdown', label, required: false, optionsSource: 'fetch:LedgerManager.toFormOptions(list=accounts)' });

const methodChoice = (required: boolean): FieldDef =>
  ({ name: 'paymentMethod', type: 'dropdown', label: 'Method', required, optionsSource: 'fetch:LedgerManager.toFormOptions(list=payment-methods)' });

/** Money out (D-029: money in is a receipt). Every money movement says why. */
const entryFields = (required: boolean): FieldDef[] => [
  { name: 'amount', type: 'amount', label: 'Amount', required },
  { name: 'date', type: 'date', label: 'Date', required },
  fundsChoice('fundId', 'Fund', required),
  accountChoice(),
  { name: 'category', type: 'dropdown', label: 'Category', required, optionsSource: 'fetch:LedgerManager.toFormOptions(list=categories,kind=out)' },
  { name: 'partyName', type: 'text', label: 'Paid to', required: false },
  methodChoice(false),
  { name: 'memo', type: 'textarea', label: 'Reason', required }
];

/**
 * An entry from a form. The current form has no direction field and means money
 * out. An older saved form still sends "in" or "out": "in" is passed on as it is,
 * so the ledger refuses it and says to record a receipt, never turned into money
 * out.
 */
export function entryFromForm(data: Data): NewTransaction {
  return {
    direction: data.direction === 'in' ? 'in' : 'out',
    amount: data.amount as number,
    date: data.date as string,
    fundId: data.fundId as string,
    accountId: str(data.accountId),
    category: data.category as string,
    partyName: str(data.partyName),
    paymentMethod: str(data.paymentMethod),
    memo: str(data.memo)
  };
}

// ── The forms ──────────────────────────────────────────────────────────────

interface Managers { ledger: LedgerManager; receipts: ReceiptManager }

interface LedgerForm {
  definition: { id: string; store: boolean; fields: FieldDef[]; [key: string]: unknown };
  /** One LedgerManager or ReceiptManager call. */
  run(managers: Managers, ctx: ApiContext, data: Data): Promise<Record<string, unknown>>;
  /** A LedgerError whose message does not start with a field name, mapped to the field it is about. */
  messageFields?: [RegExp, string][];
}

const form = (id: string, title: string, description: string, fields: FieldDef[]) =>
  ({ id, title, description, handler: 'accounting', store: false, proxySubmission: false, notifyRole: 'admin', fields });

export const LEDGER_FORMS: LedgerForm[] = [
  {
    definition: form('ledger-entry', 'Record money out',
      'Money paid out of a fund, and why. Money received is a receipt: use Record a Receipt. A posted entry is never edited: a mistake is voided and replaced.',
      [{ name: 'money', type: 'section', label: 'Money' }, ...entryFields(true).slice(0, 5),
        { name: 'who', type: 'section', label: 'Who, how and why' }, ...entryFields(true).slice(5)]),
    run: async ({ ledger }, ctx, data) => ({ transactionId: (await ledger.postTransaction(ctx, entryFromForm(data))).id }),
    messageFields: [[/^fund '/, 'fundId'], [/^account '/, 'accountId'], [/^money in is recorded as a receipt/, 'direction']]
  },
  {
    definition: form('ledger-transfer', 'Move money between funds',
      'Takes the amount out of one fund and puts it into another. The total stays the same.',
      [fundsChoice('fromFundId', 'From fund'), fundsChoice('toFundId', 'To fund'),
        { name: 'amount', type: 'amount', label: 'Amount', required: true },
        { name: 'date', type: 'date', label: 'Date', required: true },
        { name: 'memo', type: 'textarea', label: 'Reason', required: true }]),
    run: async ({ ledger }, ctx, data) => ({
      transferId: (await ledger.transferBetweenFunds(ctx, {
        fromFundId: data.fromFundId as string, toFundId: data.toFundId as string,
        amount: data.amount as number, date: data.date as string, memo: str(data.memo)
      }))[0]?.transferId
    }),
    messageFields: [[/^a transfer needs two different funds/, 'toFundId']]
  },
  {
    definition: form('ledger-void', 'Void an entry',
      'Voids a posted entry, with the reason. To correct money out, fill in the replacement too: both are posted together. A receipt is corrected by voiding it and recording a new receipt; a transfer is voided as a pair, without a replacement.',
      [{ name: 'transactionId', type: 'dropdown', label: 'Entry', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=entries)' },
        { name: 'reason', type: 'textarea', label: 'Reason', required: true },
        { name: 'replacement', type: 'section', label: 'Replacement (optional)' }, ...entryFields(false)]),
    run: async ({ ledger }, ctx, data) => {
      const replacement = data.amount === '' || data.amount === undefined ? undefined : entryFromForm(data);
      const result = await ledger.voidTransaction(ctx, data.transactionId as string, data.reason as string, replacement);
      return { replacementId: result.replacement?.id ?? null };
    },
    messageFields: [[/^this entry is already voided/, 'transactionId'], [/^this receipt has refunds/, 'transactionId'],
      [/^a transfer is voided as a pair/, 'amount'], [/^a receipt is corrected/, 'amount'], [/^fund '/, 'fundId'], [/^account '/, 'accountId']]
  },
  {
    definition: form('receipt-record', 'Record a receipt',
      'Money received: cash, a check, a bank transfer. Each receipt gets a number (R-0001, …) to write on the paper slip. A mistake is voided and recorded again; money returned to the payer is a refund.',
      [{ name: 'money', type: 'section', label: 'Money' },
        { name: 'date', type: 'date', label: 'Date received', required: true },
        accountChoice(),
        { name: 'lines', type: 'lines', label: 'What it is for (one line per fund and category: dues and a donation on one check are two lines)', required: true,
          minRows: 1, maxRows: 50, amountField: 'amount',
          fields: [
            { name: 'amount', type: 'amount', label: 'Amount', required: true },
            { name: 'fundId', type: 'dropdown', label: 'Fund', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=funds)' },
            { name: 'category', type: 'dropdown', label: 'Category', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=categories,kind=in)' },
            { name: 'memo', type: 'text', label: 'Note (optional)', required: false }
          ] },
        { name: 'who', type: 'section', label: 'Who, how and why' },
        { name: 'partyName', type: 'text', label: 'Received from', required: true },
        methodChoice(true),
        { name: 'paymentMethodId', type: 'text', label: 'Check number or confirmation code', required: false },
        { name: 'memo', type: 'textarea', label: 'Reason', required: true }]),
    run: async ({ receipts }, ctx, data) => {
      const receipt = await receipts.recordReceipt(ctx, receiptFromForm(data) as never);
      return { receiptId: receipt.id, receiptNumber: receipt.number };
    },
    messageFields: [[/^account '/, 'accountId']]
  },
  {
    definition: form('receipt-refund', 'Refund a receipt',
      'Money returned to the payer: all of a receipt, or part. The receipt stays recorded; the refund is linked to it.',
      [{ name: 'receiptId', type: 'dropdown', label: 'Receipt', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=receipts)' },
        { name: 'amount', type: 'amount', label: 'Amount, for a one-line receipt (blank refunds what is left)', required: false },
        { name: 'lines', type: 'lines', label: 'For a receipt with several lines: which lines, and how much of each', required: false,
          minRows: 0, maxRows: 50, amountField: 'amount',
          fields: [
            { name: 'receiptLineId', type: 'dropdown', label: 'Receipt line', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=refundable-lines)' },
            { name: 'amount', type: 'amount', label: 'Amount', required: true }
          ] },
        { name: 'date', type: 'date', label: 'Date refunded', required: true },
        methodChoice(false),
        accountChoice('Paid back from (blank: picked by method)'),
        { name: 'paymentMethodId', type: 'text', label: 'Check number or confirmation code', required: false },
        { name: 'memo', type: 'textarea', label: 'Reason', required: true }]),
    run: async ({ receipts }, ctx, data) => ({
      refundId: (await receipts.refundReceipt(ctx, data.receiptId as string, {
        ...(rows(data.lines).length ? { lines: rows(data.lines).map(r => ({ receiptLineId: r.receiptLineId as string, amount: r.amount as number })) }
          : { amount: typeof data.amount === 'number' ? data.amount : undefined }),
        date: data.date as string,
        paymentMethod: str(data.paymentMethod), paymentMethodId: str(data.paymentMethodId), memo: data.memo as string,
        accountId: str(data.accountId)
      })).id
    }),
    messageFields: [[/^(only a receipt|this receipt|lines: )/, 'receiptId'], [/^account '/, 'accountId']]
  },
  {
    definition: form('deposit-make', 'Make a deposit',
      'Receipts taken from Cash on Hand to the bank together: one line on the bank statement. Tick the receipts going in, then enter the total from the deposit slip; the deposit is refused unless they match. Fund balances do not change.',
      [{ name: 'accountId', type: 'dropdown', label: 'Bank account', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=bank-accounts)' },
        { name: 'date', type: 'date', label: 'Deposit date', required: true },
        { name: 'receiptIds', type: 'checklist', label: 'Receipts in Cash on Hand', required: true,
          optionsSource: 'fetch:LedgerManager.toFormOptions(list=deposit-receipts)', totalField: 'total' },
        { name: 'total', type: 'amount', label: 'Deposit slip total', required: true },
        { name: 'slipReference', type: 'text', label: 'Deposit slip number (optional)', required: false },
        { name: 'memo', type: 'textarea', label: 'Note (optional)', required: false }]),
    run: async ({ ledger }, ctx, data) => {
      const deposit = await ledger.makeDeposit(ctx, {
        accountId: data.accountId as string, date: data.date as string,
        receiptIds: Array.isArray(data.receiptIds) ? data.receiptIds as string[] : [],
        total: data.total as number, slipReference: str(data.slipReference), memo: str(data.memo)
      });
      return { depositId: deposit.id, depositNumber: deposit.number };
    },
    messageFields: [[/^accountId:/, 'accountId'], [/^receiptIds:/, 'receiptIds'], [/^total:/, 'total']]
  },
  {
    definition: form('deposit-clear', 'Mark a deposit cleared',
      "The bank statement shows the deposit: mark it cleared with the date the bank shows. No money moves; its receipts count as cleared.",
      [{ name: 'depositId', type: 'dropdown', label: 'Deposit', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=uncleared-deposits)' },
        { name: 'date', type: 'date', label: 'Date on the bank statement', required: true }]),
    run: async ({ ledger }, ctx, data) => ({ depositId: (await ledger.clearDeposit(ctx, data.depositId as string, data.date as string)).id }),
    messageFields: [[/^deposit /, 'depositId'], [/^date:/, 'date']]
  },
  {
    definition: form('deposit-unclear', 'Take off a cleared mark',
      'A deposit marked cleared by mistake: take the mark off, with the reason. The mark stays in the history.',
      [{ name: 'depositId', type: 'dropdown', label: 'Deposit', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=cleared-deposits)' },
        { name: 'reason', type: 'textarea', label: 'Reason', required: true }]),
    run: async ({ ledger }, ctx, data) => ({ depositId: (await ledger.unclearDeposit(ctx, data.depositId as string, data.reason as string)).id }),
    messageFields: [[/^deposit /, 'depositId']]
  },
  {
    definition: form('deposit-undo', 'Undo a deposit',
      "Undoes a deposit, with the reason: its entries are voided and its receipts are back in Cash on Hand, ready for a new deposit. The deposit's number is not reused.",
      [{ name: 'depositId', type: 'dropdown', label: 'Deposit', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=deposits)' },
        { name: 'reason', type: 'textarea', label: 'Reason', required: true }]),
    run: async ({ ledger }, ctx, data) => ({ depositId: (await ledger.undoDeposit(ctx, data.depositId as string, data.reason as string)).id }),
    messageFields: [[/^deposit /, 'depositId']]
  },
  {
    definition: form('check-bounce', 'Record a bounced check',
      "The bank returned a deposited check. Its amount comes back out of the bank account, the bank's fee is recorded as bank charges, and the payer owes the check, the fee and any penalty. The receipt stays as it was.",
      [{ name: 'receiptId', type: 'dropdown', label: 'Check (receipt)', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=bounceable-receipts)' },
        { name: 'date', type: 'date', label: 'Date the bank returned it', required: true },
        { name: 'fee', type: 'amount', label: "Bank's fee (blank: none)", required: false },
        { name: 'penalty', type: 'amount', label: "Penalty to charge the payer (blank: the site's default)", required: false },
        { name: 'memo', type: 'textarea', label: 'Note (optional)', required: false }]),
    run: async ({ ledger }, ctx, data) => ({
      bounceId: (await ledger.recordBounce(ctx, data.receiptId as string, {
        date: data.date as string, memo: str(data.memo),
        fee: typeof data.fee === 'number' ? data.fee : undefined, penalty: typeof data.penalty === 'number' ? data.penalty : undefined
      })).id
    }),
    messageFields: [[/^receiptId:/, 'receiptId'], [/^date:/, 'date'], [/^bounced checks are off/, 'receiptId']]
  },
  {
    definition: form('bounce-repay', 'Repay a bounced check',
      'Money from the payer toward a bounced check. It is recorded as one receipt whose lines fill in order: the check, then the fee, then the penalty. Anything short stays owed.',
      [{ name: 'bounceId', type: 'dropdown', label: 'Bounced check', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=unsettled-bounces)' },
        { name: 'amount', type: 'amount', label: 'Amount received', required: true },
        { name: 'date', type: 'date', label: 'Date received', required: true },
        methodChoice(true),
        { name: 'paymentMethodId', type: 'text', label: 'Check number or confirmation code', required: false },
        { name: 'memo', type: 'textarea', label: 'Note (optional)', required: false }]),
    run: async ({ ledger }, ctx, data) => {
      const receipt = await ledger.repayBounce(ctx, data.bounceId as string, {
        amount: data.amount as number, date: data.date as string, paymentMethod: data.paymentMethod as string,
        paymentMethodId: str(data.paymentMethodId), memo: str(data.memo)
      });
      return { receiptId: receipt.id, receiptNumber: receipt.number };
    },
    messageFields: [[/^bounceId:/, 'bounceId'], [/^amount is more/, 'amount'], [/^bounced checks are off/, 'bounceId']]
  },
  {
    definition: form('lock-settings', 'Choose how periods are locked',
      'Lock periods by month, quarter, half-year or year, as you report to the board, and say which month the fiscal year starts. Locking then offers the ends of those periods.',
      [{ name: 'period', type: 'dropdown', label: 'Lock by', required: true, options: ['month', 'quarter', 'half-year', 'year'] },
        { name: 'fiscalStartMonth', type: 'dropdown', label: 'The fiscal year starts in', required: true, options: MONTHS }]),
    run: async ({ ledger }, ctx, data) => ({
      settings: await ledger.setLockSettings(ctx, { period: data.period as string, fiscalStartMonth: MONTHS.indexOf(data.fiscalStartMonth as string) + 1 })
    }),
    messageFields: [[/^period /, 'period'], [/^fiscalStartMonth/, 'fiscalStartMonth']]
  },
  {
    definition: form('period-lock', 'Lock a period',
      'After reporting a period to the board, lock it: nothing dated in it can then be added, voided or corrected. A mistake found later is fixed with an entry dated today, with its reason.',
      [{ name: 'throughDate', type: 'dropdown', label: 'Lock everything through', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=lockable-periods)' }]),
    run: async ({ ledger }, ctx, data) => ledger.lockPeriod(ctx, data.throughDate as string)
  },
  {
    definition: form('period-unlock', 'Unlock a period',
      'Takes the latest lock off, with the reason. The period before it stays locked. Rarely needed: a mistake in a locked period is usually fixed with an entry dated today.',
      [{ name: 'reason', type: 'textarea', label: 'Reason', required: true }]),
    run: async ({ ledger }, ctx, data) => ledger.unlockPeriod(ctx, data.reason as string),
    messageFields: [[/^nothing is locked/, 'reason']]
  },
  {
    definition: form('fund-create', 'Create a fund', 'A new fund starts at its opening balance, on its opening date.',
      [{ name: 'name', type: 'text', label: 'Name', required: true },
        { name: 'description', type: 'textarea', label: 'Description', required: false },
        { name: 'restricted', type: 'checkbox', label: 'Restricted: money given for a stated purpose', required: false },
        { name: 'openingBalance', type: 'amount', label: 'Opening balance', required: false },
        { name: 'openingDate', type: 'date', label: 'Opening date (default today)', required: false }]),
    run: async ({ ledger }, ctx, data) => ({
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
    run: async ({ ledger }, ctx, data) => ({
      fundId: (await ledger.updateFund(ctx, data.fundId as string, { name: data.name as string, description: str(data.description) })).id
    }),
    messageFields: [[/^a fund named/, 'name']]
  },
  {
    definition: form('fund-close', 'Close a fund', 'A closed fund takes no new entries. Its history stays.',
      [fundsChoice('fundId', 'Fund'), { name: 'reason', type: 'textarea', label: 'Reason', required: false }]),
    run: async ({ ledger }, ctx, data) => ({ fundId: (await ledger.closeFund(ctx, data.fundId as string, str(data.reason))).id }),
    messageFields: [[/^fund '/, 'fundId']]
  },
  {
    definition: form('account-opening', "Set an account's opening balance",
      'What the account held on the day the books started: the bank statement for a bank account, the count for Cash on Hand. Set once; it never changes. All accounts added up should equal all funds.',
      [{ name: 'accountId', type: 'dropdown', label: 'Account', required: true, optionsSource: 'fetch:LedgerManager.toFormOptions(list=accounts)' },
        { name: 'openingBalance', type: 'amount', label: 'Opening balance', required: true },
        { name: 'openingDate', type: 'date', label: 'Opening date (default today)', required: false }]),
    run: async ({ ledger }, ctx, data) => ({
      accountId: (await ledger.setAccountOpening(ctx, data.accountId as string, {
        openingBalance: data.openingBalance as number, openingDate: str(data.openingDate)
      })).accountId
    }),
    messageFields: [[/^account '/, 'accountId']]
  }
];

/**
 * The permission each form's manager call asks (ngdpbase#2094). The pages carry no
 * audience: a form is drawn only for a viewer the decision point permits this and
 * `form-submit` (LedgerPlugin's `view='form'`), and anyone else reads a short note.
 * The manager still asks it on submit.
 */
export const FORM_PERMISSIONS: Readonly<Record<string, string>> = {
  'ledger-entry': 'ledger-record', 'ledger-transfer': 'ledger-adjust', 'ledger-void': 'ledger-adjust',
  'receipt-record': 'ledger-record', 'receipt-refund': 'receipt-refund',
  'deposit-make': 'ledger-record', 'deposit-clear': 'ledger-record', 'deposit-unclear': 'ledger-record', 'deposit-undo': 'ledger-adjust',
  'check-bounce': 'ledger-adjust', 'bounce-repay': 'ledger-record',
  'lock-settings': 'fund-manage', 'period-lock': 'fund-manage', 'period-unlock': 'fund-manage',
  'fund-create': 'fund-manage', 'fund-rename': 'fund-manage', 'fund-close': 'fund-manage', 'account-opening': 'fund-manage'
};

/** The field a LedgerError is about: the form's own mapping, else the message's first word when it is a field. */
export function fieldOf(ledgerForm: LedgerForm, message: string): string | undefined {
  // A line's refusal goes under that row's field, the key the lines field shows it at: "lines[1].amount" (ngdpbase #1913).
  const row = /^(lines\[\d+\])(?:\.(\w+))?/.exec(message);
  if (row) return row[2] ? `${row[1]}.${row[2] === 'details' ? 'amount' : row[2]}` : 'lines';
  for (const [pattern, field] of ledgerForm.messageFields ?? []) if (pattern.test(message)) return field;
  const first = message.split(/[\s':]/, 1)[0];
  return ledgerForm.definition.fields.some(f => f.name === first) ? first : undefined;
}

export async function registerForms(engine: Engine, host: AddonHost): Promise<void> {
  const log = (message: string): void => { host.logger.info(message); };
  const forms = engine.getManager<FormsAddonLike>('FormsAddon');
  const definitions = engine.getManager<FormsDataManagerLike>('FormsDataManager');
  if (!forms || !definitions) { log('[accounting] Forms add-on not enabled: treasurer screens are off; the API still works'); return; }

  for (const ledgerForm of LEDGER_FORMS) {
    const { id } = ledgerForm.definition;
    // Registered on every start, as the system (ngdpbase #1973): the site's copy is replaced when this
    // add-on's version is newer, and is read-only on the site.
    await definitions.registerShippedForm('accounting', ledgerForm.definition, host.systemContext(`accounting: shipped form ${id}`));

    forms.registerHandler(id, async (submission, { req }) => {
      const ledger = engine.getManager<LedgerManager>('LedgerManager');
      const receipts = engine.getManager<ReceiptManager>('ReceiptManager');
      if (!ledger || !receipts) return { ok: false, error: 'The ledger is not available on this site' };
      try {
        const ctx = host.ApiContext.from(req as never, engine as never);
        return { ok: true, ...(await ledgerForm.run({ ledger, receipts }, ctx, submission.data)) };
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err; // a permission refusal is the forms add-on's to answer
        const field = fieldOf(ledgerForm, err.message);
        return { ok: false, error: err.message, ...(field ? { fields: { [field]: err.message } } : {}) };
      }
    });
  }
}
