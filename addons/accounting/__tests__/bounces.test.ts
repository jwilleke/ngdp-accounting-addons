/**
 * Bounced checks (D-032): the receipt never changes; a returned-check entry and
 * the bank's fee take the money back out of the bank account; the payer owes
 * check + fee + penalty, repaid by receipts whose lines fill check, then fee,
 * then penalty.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testFormatters, testLedgerParts } from './host.js';
import LedgerManager, { CASH_ON_HAND, type Fund, type LedgerActor, type LedgerAuditRecord, type LedgerDb, type Receipt } from '../managers/LedgerManager.js';
import { renderLedgerView } from '../plugins/LedgerPlugin.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'ledger-export', 'fund-manage'];
const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });

const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined,
  subject: { username: 'tess', roles: ['treasurer'], isAuthenticated: true, granted } as never,
  actingUsername: () => 'tess',
  enforceDeny: (permission: string) => Promise.reject(Object.assign(new Error(`refused: ${permission}`), { status: 403 }))
});

describe('bounced checks', () => {
  let provider: { handle: unknown; close(): void };
  let audit: LedgerAuditRecord[];
  let settings: { bankChargesCategory?: unknown; otherIncomeCategory?: unknown; penalty?: unknown };
  let ledger: LedgerManager;
  let general: Fund;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    audit = [];
    settings = { bankChargesCategory: '6100', otherIncomeCategory: '8900', penalty: 2_500 };
    ledger = new LedgerManager({ ...testLedgerParts, db: provider.handle as LedgerDb, decide, currency: 'USD',
      categories: () => defaults['ngdpbase.addons.accounting.categories'], bouncedChecks: () => settings,
      recordAudit: (r) => { audit.push(r); return Promise.resolve(); } });
    general = await ledger.createFund(actor(), { name: 'General', openingDate: '2026-01-01' });
  });

  afterEach(() => provider.close());

  const check = (amount = 5_000, paymentMethod = '20') =>
    ledger.postReceipt(actor(), { amount, date: '2026-10-01', fundId: general.id, category: '4100', partyName: 'Pat', paymentMethod, paymentMethodId: '4471', memo: 'dues' }, { provider: 'manual' });
  const deposited = async (r: Receipt) => {
    await ledger.makeDeposit(actor(), { accountId: 'checking', date: '2026-10-02', receiptIds: [r.id], total: r.total });
    return r;
  };
  const balances = async () => Object.fromEntries((await ledger.accountBalances(actor())).map(b => [b.accountId, b.balance]));
  const fundBalance = async () => (await ledger.fundBalances(actor()))[0].balance;

  test('takes the check and the fee back out of the bank; the payer owes check + fee + penalty; the receipt stays', async () => {
    const r = await deposited(await check());
    expect(await balances()).toEqual({ [CASH_ON_HAND]: 0, checking: 5_000 });
    const b = await ledger.recordBounce(actor(), r.id, { date: '2026-10-09', fee: 1_500 });
    expect(b).toMatchObject({ receiptNumber: 'R-0001', depositNumber: 'D-0001', checkAmount: 5_000, fee: 1_500, penalty: 2_500, owed: 9_000, repaid: 0, stillOwed: 9_000 });
    expect(await balances()).toEqual({ [CASH_ON_HAND]: 0, checking: -1_500 });
    expect(await fundBalance()).toBe(-1_500);
    expect((await ledger.getDocument(actor(), r.id)).status).toBe('posted');
    const summary = await ledger.periodSummary(actor(), ledger.period({ month: '2026-10' }));
    expect(summary.categories.map(c => [c.category, c.income, c.expense])).toEqual([['4100', 5_000, 5_000], ['6100', 0, 1_500]]);
    expect(audit.at(-1)).toMatchObject({ action: 'check-bounce', eventType: 'ledger-adjust', metadata: { receipt: 'R-0001', fee: 1_500, penalty: 2_500 } });
  });

  test('only a deposited check, once, not before its deposit; needs ledger-adjust', async () => {
    const cash = await deposited(await check(100, '10'));
    await expect(ledger.recordBounce(actor(), cash.id, { date: '2026-10-09' })).rejects.toThrow('R-0001 was not paid by check');
    const undeposited = await check(100);
    await expect(ledger.recordBounce(actor(), undeposited.id, { date: '2026-10-09' })).rejects.toThrow('R-0002 is not in a deposit');
    const r = await deposited(await check(200));
    await expect(ledger.recordBounce(actor(['ledger-read', 'ledger-record']), r.id, { date: '2026-10-09' })).rejects.toThrow('refused: ledger-adjust');
    await expect(ledger.recordBounce(actor(), r.id, { date: '2026-10-01' })).rejects.toThrow('cannot come back before its deposit D-0002');
    await ledger.recordBounce(actor(), r.id, { date: '2026-10-09', penalty: 0 });
    await expect(ledger.recordBounce(actor(), r.id, { date: '2026-10-09' })).rejects.toThrow('R-0003 has already bounced');
  });

  test('afterwards the receipt is not refunded or voided, and its deposit is not undone', async () => {
    const r = await deposited(await check());
    await ledger.recordBounce(actor(), r.id, { date: '2026-10-09' });
    await expect(ledger.refundReceipt(actor(), r.id, { date: '2026-10-10', memo: 'x' })).rejects.toThrow('this receipt bounced');
    await expect(ledger.voidTransaction(actor(), r.id, 'x')).rejects.toThrow('this receipt bounced');
    const [d] = await ledger.listDeposits(actor());
    await expect(ledger.undoDeposit(actor(), d.id, 'x')).rejects.toThrow('deposit D-0001 has a bounced check (R-0001); it cannot be undone');
  });

  test('a repayment is one receipt whose lines fill check, then fee, then penalty; short leaves the rest owed', async () => {
    const r = await deposited(await check());
    const b = await ledger.recordBounce(actor(), r.id, { date: '2026-10-09', fee: 1_500 });
    const first = await ledger.repayBounce(actor(), b.id, { amount: 6_000, date: '2026-10-12', paymentMethod: '10' });
    expect(first.lines.map(l => [l.category, l.amount])).toEqual([['4100', 5_000], ['6100', 1_000]]);
    expect(first.reference).toEqual({ type: 'bounced-check', id: b.id });
    expect((await ledger.listBounces(actor()))[0]).toMatchObject({ repaid: 6_000, stillOwed: 3_000 });
    await expect(ledger.repayBounce(actor(), b.id, { amount: 3_001, date: '2026-10-13', paymentMethod: '10' })).rejects.toThrow('amount is more than is still owed ($30.00)');
    const rest = await ledger.repayBounce(actor(), b.id, { amount: 3_000, date: '2026-10-13', paymentMethod: '68' });
    expect(rest.lines.map(l => [l.category, l.amount])).toEqual([['6100', 500], ['8900', 2_500]]);
    expect(await ledger.listBounces(actor(), { settled: true })).toHaveLength(1);
    expect(await ledger.listBounces(actor(), { settled: false })).toHaveLength(0);
    // The fund is whole again, and the penalty is income.
    expect(await fundBalance()).toBe(5_000 + 2_500);
  });

  test('is off until the chart names a bank-charges expense and an other-income category', async () => {
    const r = await deposited(await check());
    settings = { bankChargesCategory: '4100', otherIncomeCategory: '8900' };
    await expect(ledger.recordBounce(actor(), r.id, { date: '2026-10-09' }))
      .rejects.toThrow('bounced checks are off: ngdpbase.addons.accounting.bank-charges-category must name a category of type expense in the chart');
  });

  test('the forms offer deposited checks and what is owed; the Bounced Checks page shows it', async () => {
    const r = await deposited(await check());
    const viewer = { username: 'tess', granted: ALL };
    expect((await ledger.toFormOptions({ list: 'bounceable-receipts' }, viewer)).map(o => o.value)).toEqual([r.id]);
    const b = await ledger.recordBounce(actor(), r.id, { date: '2026-10-09', fee: 1_500 });
    expect(await ledger.toFormOptions({ list: 'bounceable-receipts' }, viewer)).toEqual([]);
    expect(await ledger.toFormOptions({ list: 'unsettled-bounces' }, viewer)).toEqual([{ value: b.id, amount: 9_000, label: 'R-0001 · Pat · $90.00 still owed' }]);
    const html = await renderLedgerView(testFormatters, ledger, ledger.viewerActor(viewer), { view: 'bounces', settled: 'false' });
    expect(html).toContain('R-0001');
    expect(html).toContain('$90.00');
  });
});
