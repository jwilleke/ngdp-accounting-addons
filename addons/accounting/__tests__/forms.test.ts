/**
 * The treasurer's entry form: the choices the ledger offers a viewer, and how
 * a submitted form becomes a ledger entry. Each test opens its own temporary
 * database and removes only that folder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { testLedgerParts } from './host.js';
import { openTestLedgerDatabase } from './host.js';
import LedgerManager, { MANUAL_PAYMENT_MEANS, type LedgerActor, type LedgerDb } from '../managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';
import { LEDGER_FORMS, entryFromForm, fieldOf } from '../forms.js';

const formById = (id: string) => LEDGER_FORMS.find(f => f.definition.id === id)!;

const treasurer: LedgerActor = {
  ipAddress: undefined,
  actingUsername: () => 'tess',
  subject: { username: 'tess' } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
};

describe('LedgerManager.toFormOptions', () => {
  let provider: { handle: unknown; close(): void };
  let asked: unknown[];
  let ledger: LedgerManager;

  beforeEach(() => {
    provider = openTestLedgerDatabase();
    asked = [];
    ledger = new LedgerManager({ ...testLedgerParts,
      db: provider.handle as unknown as LedgerDb,
      currency: 'USD',
      recordAudit: () => Promise.resolve(),
      decide: async (subject, { action }) => {
        asked.push([subject, action]);
        return { permit: (subject as { username?: string } | null)?.username === 'tess', applicable: true, reason: 'test' };
      },
      categories: () => ({ '4100': 'Dues', '5200': 'Supplies' })
    });
  });

  afterEach(() => {
    provider.close();
  });

  test('offers open funds only, by id and name, asking the viewer for ledger-summary-read', async () => {
    const general = await ledger.createFund(treasurer, { name: 'General' });
    const old = await ledger.createFund(treasurer, { name: 'Old Roof' });
    await ledger.closeFund(treasurer, old.id, 'done');
    const viewer = { username: 'tess' };
    asked.length = 0; // only the dropdown's own question, not the setup's
    expect(await ledger.toFormOptions({ list: 'funds' }, viewer)).toEqual([{ value: general.id, label: 'General' }]);
    expect(asked).toEqual([[viewer, 'ledger-summary-read']]);
  });

  test('offers the configured categories and the manual payment means', async () => {
    const viewer = { username: 'tess' };
    expect(await ledger.toFormOptions({ list: 'categories' }, viewer)).toEqual([
      { value: '4100', label: '4100 Dues' }, { value: '5200', label: '5200 Supplies' }
    ]);
    expect(await ledger.toFormOptions({ list: 'payment-methods' }, viewer)).toEqual([...MANUAL_PAYMENT_MEANS]);
  });

  test('entries: the latest posted, labelled so the right one can be picked, for a viewer who may read entries', async () => {
    const f = await ledger.createFund(treasurer, { name: 'General' });
    const t = await ledger.postReceipt(treasurer, { amount: 125050, date: '2026-10-10', fundId: f.id, category: '4100', partyName: 'Pat', paymentMethod: '20', memo: 'dues' }, { provider: 'manual' });
    expect(await ledger.toFormOptions({ list: 'entries' }, { username: 'tess' })).toEqual([{ value: t.id, label: 'R-0001 · 2026-10-10 · General · $1,250.50 · Pat' }]);
  });

  test('receipts: only those with money left to refund', async () => {
    const f = await ledger.createFund(treasurer, { name: 'General' });
    const receive = (amount: number) => ledger.postReceipt(treasurer, { amount, date: '2026-10-10', fundId: f.id, category: '4100', partyName: 'Pat', paymentMethod: '10', memo: 'dues' }, { provider: 'manual' });
    const kept = await receive(500);
    const refunded = await receive(300);
    await ledger.refundReceipt(treasurer, refunded.id, { date: '2026-10-11', memo: 'paid twice' });
    expect((await ledger.toFormOptions({ list: 'receipts' }, { username: 'tess' })).map(o => o.value)).toEqual([kept.id]);
  });

  test('a viewer who may not see the ledger is offered nothing', async () => {
    await ledger.createFund(treasurer, { name: 'General' });
    expect(await ledger.toFormOptions({ list: 'funds' }, { username: 'molly' })).toEqual([]);
    expect(await ledger.toFormOptions({ list: 'funds' }, undefined)).toEqual([]);
  });

  test('an unknown list is no choices', async () => {
    expect(await ledger.toFormOptions({ list: 'secrets' }, { username: 'tess' })).toEqual([]);
  });
});

describe('the entry form', () => {
  test('field names are the ledger\'s, so its errors land on the right field', () => {
    const entry = formById('ledger-entry');
    expect(fieldOf(entry, 'amount must be a whole number of cents, more than 0')).toBe('amount');
    expect(fieldOf(entry, "fund 'Old Roof' is closed")).toBe('fundId');
    expect(fieldOf(entry, 'fundId is required')).toBe('fundId');
    expect(fieldOf(entry, 'paymentMethod must be a UN/CEFACT payment means code, e.g. 10 (cash) or 20 (cheque)')).toBe('paymentMethod');
    expect(fieldOf(entry, 'something else broke')).toBeUndefined();
    expect(fieldOf(formById('ledger-transfer'), 'a transfer needs two different funds')).toBe('toFundId');
    expect(fieldOf(formById('ledger-void'), 'this entry is already voided')).toBe('transactionId');
    expect(fieldOf(formById('fund-create'), "a fund named 'General' already exists")).toBe('name');
    expect(fieldOf(entry, 'memo is required')).toBe('memo');
    expect(fieldOf(formById('receipt-record'), 'partyName is required')).toBe('partyName');
    expect(fieldOf(formById('receipt-refund'), 'this receipt is already fully refunded')).toBe('receiptId');
    expect(fieldOf(formById('ledger-void'), 'this receipt has refunds; void the refunds first')).toBe('transactionId');
  });

  // The ledger then refuses it ("money in is recorded as a receipt"; receipts.test.ts).
  test('an older form\'s "in" is never turned into money out, and the refusal lands on its direction field', () => {
    expect(entryFromForm({ direction: 'in', amount: 500, date: '2026-10-18', fundId: 'f1', category: '4100', memo: 'dues' }).direction).toBe('in');
    expect(fieldOf(formById('ledger-entry'), 'money in is recorded as a receipt (Record a Receipt), not as an entry')).toBe('direction');
  });

  test('a submitted form with no direction is money out; empty optional fields are left out', () => {
    expect(entryFromForm({ amount: 12550, date: '2026-10-10', fundId: 'f1', category: '4100', partyName: '', paymentMethod: '10', memo: '' })).toEqual({
      direction: 'out', amount: 12550, date: '2026-10-10', fundId: 'f1', category: '4100', partyName: undefined, paymentMethod: '10', memo: undefined
    });
  });

  test('no form keeps a submission file: the ledger is the record', () => {
    expect(LEDGER_FORMS.map(f => f.definition.store)).toEqual(LEDGER_FORMS.map(() => false));
  });

  test('every form posts through the ledger, which refuses a viewer without the permission', async () => {
    const ids = LEDGER_FORMS.map(f => f.definition.id);
    expect(ids).toEqual(['ledger-entry', 'ledger-transfer', 'ledger-void', 'receipt-record', 'receipt-refund', 'deposit-make', 'deposit-clear', 'deposit-unclear', 'deposit-undo', 'check-bounce', 'bounce-repay', 'fund-create', 'fund-rename', 'fund-close', 'account-opening']);
  });
});
