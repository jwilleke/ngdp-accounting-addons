/**
 * Deposits (D-031): receipts taken from Cash on Hand to a bank account, as one
 * numbered deposit with paired entries per fund. Fund balances never change;
 * account balances do. Undoing a deposit voids its entries and frees its
 * receipts.
 *
 * Each test opens the accounting database in memory, as ngdpbase's
 * openAddonDatabase opens it; nothing touches a data directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testFormatters, testLedgerParts } from './host.js';
import LedgerManager, { CASH_ON_HAND, type Fund, type LedgerActor, type LedgerAuditRecord, type LedgerDb, type Transaction } from '../managers/LedgerManager.js';
import { renderLedgerView } from '../plugins/LedgerPlugin.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'ledger-export', 'fund-manage'];

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });

const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined,
  subject: { username: 'tess', roles: ['treasurer'], isAuthenticated: true, granted } as never,
  actingUsername: () => 'tess',
  enforceDeny: (permission: string) => Promise.reject(Object.assign(new Error(`refused: ${permission}`), { status: 403 }))
});

describe('deposits', () => {
  let provider: { handle: unknown; close(): void };
  let db: LedgerDb;
  let audit: LedgerAuditRecord[];
  let ledger: LedgerManager;
  let general: Fund;
  let roof: Fund;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    db = provider.handle as unknown as LedgerDb;
    audit = [];
    ledger = new LedgerManager({ ...testLedgerParts, db, decide, currency: 'USD',
      recordAudit: (record) => { audit.push(record); return Promise.resolve(); }
    });
    general = await ledger.createFund(actor(), { name: 'General', openingDate: '2026-01-01' });
    roof = await ledger.createFund(actor(), { name: 'Roof', openingDate: '2026-01-01' });
  });

  afterEach(() => {
    provider.close();
  });

  const receipt = (fund: Fund, amount: number, paymentMethod = '20', date = '2026-10-10') =>
    ledger.postReceipt(actor(), { fundId: fund.id, amount, date, category: '4100', partyName: 'Pat', paymentMethod, memo: 'dues' }, { provider: 'manual' });
  const deposit = (receipts: Transaction[], extra: Record<string, unknown> = {}) =>
    ledger.makeDeposit(actor(), { accountId: 'checking', date: '2026-10-12', receiptIds: receipts.map(r => r.id), total: receipts.reduce((t, r) => t + r.amount, 0), ...extra });
  const fundBalances = async () => (await ledger.fundBalances(actor())).map(b => [b.name, b.balance]);
  const accountBalances = async () => (await ledger.accountBalances(actor())).map(b => [b.accountId, b.balance]);

  test('moves the receipts from Cash on Hand to the bank; fund balances stay', async () => {
    const a = await receipt(general, 20000);
    const b = await receipt(general, 5000, '10');
    const c = await receipt(roof, 14000);
    const funds = await fundBalances();
    const made = await deposit([a, b, c], { slipReference: '0042' });
    expect(made).toMatchObject({ number: 'D-0001', accountId: 'checking', total: 39000, slipReference: '0042', status: 'posted' });
    expect(made.receipts).toEqual([{ receiptId: a.id, amount: 20000 }, { receiptId: b.id, amount: 5000 }, { receiptId: c.id, amount: 14000 }]);
    expect(await fundBalances()).toEqual(funds);
    expect(await accountBalances()).toEqual([[CASH_ON_HAND, 0], ['checking', 39000]]);
    // One pair per fund, out of Cash on Hand and into the bank.
    const legs = (await ledger.listTransactions(actor())).filter(t => t.sourceType === 'deposit');
    expect(legs.map(t => [t.fundId, t.accountId, t.direction, t.amount]).sort()).toEqual([
      [general.id, CASH_ON_HAND, 'out', 25000], [general.id, 'checking', 'in', 25000],
      [roof.id, CASH_ON_HAND, 'out', 14000], [roof.id, 'checking', 'in', 14000]
    ].sort());
    expect(legs.every(t => t.memo === 'Deposit D-0001')).toBe(true);
    expect(audit.at(-1)).toMatchObject({ action: 'deposit-make', resource: made.id, metadata: { receipts: ['R-0001', 'R-0002', 'R-0003'], total: 39000 } });
  });

  test('is refused unless the slip total matches the receipts', async () => {
    const a = await receipt(general, 20000);
    await expect(deposit([a], { total: 19999 })).rejects.toThrow('total: the slip says $199.99 but the receipts add up to $200.00');
  });

  test('takes only receipts in Cash on Hand, not voided, not deposited, dated on or before it', async () => {
    const zelle = await receipt(general, 100, '68');
    await expect(deposit([zelle])).rejects.toThrow('R-0001 is not in Cash on Hand');
    const voided = await receipt(general, 100);
    await ledger.voidTransaction(actor(), voided.id, 'typo');
    await expect(deposit([voided])).rejects.toThrow('R-0002 is voided');
    const late = await receipt(general, 100, '20', '2026-10-20');
    await expect(deposit([late])).rejects.toThrow('R-0003 is dated after the deposit');
    const once = await receipt(general, 100);
    await deposit([once]);
    await expect(deposit([once])).rejects.toThrow('R-0004 is already in deposit D-0001');
    const entry = await ledger.postTransaction(actor(), { direction: 'out', amount: 50, date: '2026-10-10', fundId: general.id, category: '5200', memo: 'stamps', paymentMethod: '10' });
    await expect(deposit([entry])).rejects.toThrow('this entry is not a receipt');
    await expect(deposit([])).rejects.toThrow('receiptIds: choose at least one receipt');
  });

  test('goes into an open bank account, never Cash on Hand', async () => {
    const a = await receipt(general, 100);
    await expect(deposit([a], { accountId: CASH_ON_HAND })).rejects.toThrow('a deposit goes into an open bank account');
  });

  test('the same receipts deposited twice at once make one deposit', async () => {
    const a = await receipt(general, 100);
    const results = await Promise.allSettled([deposit([a]), deposit([a])]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ledger.listDeposits(actor())).map(d => d.number)).toEqual(['D-0001']);
  });

  describe('undoing a deposit', () => {
    test('voids its entries, puts its receipts back in Cash on Hand, and never reuses its number', async () => {
      const a = await receipt(general, 20000);
      const made = await deposit([a]);
      await expect(ledger.undoDeposit(actor(['ledger-record']), made.id, 'wrong bank')).rejects.toThrow('refused: ledger-adjust');
      const undone = await ledger.undoDeposit(actor(), made.id, 'wrong bank');
      expect(undone).toMatchObject({ status: 'voided', voidReason: 'wrong bank' });
      expect(await accountBalances()).toEqual([[CASH_ON_HAND, 20000], ['checking', 0]]);
      expect((await ledger.receiptsToDeposit(actor())).map(r => r.id)).toEqual([a.id]);
      expect((await deposit([a])).number).toBe('D-0002');
      await expect(ledger.undoDeposit(actor(), made.id, 'again')).rejects.toThrow('deposit D-0001 is already undone');
      expect(audit.find(r => r.action === 'deposit-undo')).toMatchObject({ resource: made.id, reason: 'wrong bank' });
    });

    test('is the only way to undo its entries, and comes before voiding a receipt in it', async () => {
      const a = await receipt(general, 100);
      await deposit([a]);
      const leg = (await ledger.listTransactions(actor())).find(t => t.sourceType === 'deposit') as Transaction;
      await expect(ledger.voidTransaction(actor(), leg.id, 'oops')).rejects.toThrow('this entry is part of a deposit; undo the deposit instead');
      await expect(ledger.voidTransaction(actor(), a.id, 'oops')).rejects.toThrow('this receipt is in deposit D-0001; undo the deposit first');
    });
  });

  test('the database refuses to change or delete a deposit', async () => {
    const made = await deposit([await receipt(general, 100)]);
    expect(() => db.prepare('UPDATE accounting_deposits SET total = 1 WHERE id = ?').run(made.id)).toThrow(/never changes/);
    expect(() => db.prepare('DELETE FROM accounting_deposits').run()).toThrow(/never deleted/);
    expect(() => db.prepare('DELETE FROM accounting_deposit_receipts').run()).toThrow(/keeps its receipts/);
  });

  test('numbers count only digits, with no upper limit: after D-9999 comes D-10000, and after R-9999, R-10000', async () => {
    db.prepare(`INSERT INTO accounting_deposits (id, number, date, account_id, total, status, created_by, created_at)
      VALUES ('old', 'D-9999', '2026-01-01', 'checking', 1, 'posted', 'tess', 'now')`).run();
    db.prepare(`INSERT INTO accounting_transactions (id, direction, amount, currency, date, fund_id, account_id, category, provider, confirmation_number,
      source_type, status, memo, created_by, created_at) VALUES ('r', 'in', 1, 'USD', '2026-01-01', ?, 'checking', '4100', 'manual', 'R-9999',
      'receipt', 'posted', 'old', 'tess', 'now')`).run(general.id);
    const a = await receipt(general, 100);
    expect(a.confirmationNumber).toBe('R-10000');
    expect((await deposit([a])).number).toBe('D-10000');
  });

  test('the period summary leaves deposits out of income and expense', async () => {
    await deposit([await receipt(general, 100)]);
    const summary = await ledger.periodSummary(actor(), ledger.period({ month: '2026-10' }));
    expect(summary.categories.map(c => [c.category, c.income, c.expense])).toEqual([['4100', 100, 0]]);
  });

  test('the form lists offer bank accounts, receipts to deposit, and standing deposits', async () => {
    const a = await receipt(general, 100);
    const b = await receipt(general, 200);
    const viewer = { username: 'tess', granted: ALL };
    expect(await ledger.toFormOptions({ list: 'bank-accounts' }, viewer)).toEqual([{ value: 'checking', label: 'Checking' }]);
    // Each carries its amount, for the checklist's running total (ngdpbase #1904).
    expect((await ledger.toFormOptions({ list: 'deposit-receipts' }, viewer)).map(o => [o.value, o.amount])).toEqual([[a.id, 100], [b.id, 200]]);
    const made = await deposit([a]);
    expect((await ledger.toFormOptions({ list: 'deposit-receipts' }, viewer)).map(o => o.value)).toEqual([b.id]);
    expect(await ledger.toFormOptions({ list: 'deposits' }, viewer)).toEqual([{ value: made.id, label: 'D-0001 · 2026-10-12 · Checking · $1.00' }]);
    expect((await ledger.toFormOptions({ list: 'entries' }, viewer)).some(o => o.label.includes('Deposit'))).toBe(false);
  });

  test('the ledger shows each receipt\'s deposit number, and the deposits with their receipts', async () => {
    const a = await receipt(general, 100);
    await deposit([a], { slipReference: '0042' });
    const viewer = ledger.viewerActor({ username: 'tess', granted: ALL });
    expect(await renderLedgerView(testFormatters, ledger, viewer, { view: 'entries' })).toContain('R-0001 <span class="text-muted">(D-0001)</span>');
    const html = await renderLedgerView(testFormatters, ledger, viewer, { view: 'deposits' });
    expect(html).toContain('D-0001');
    expect(html).toContain('0042');
    expect(html).toContain('R-0001');
    expect(html).toContain('$1.00');
  });
});
