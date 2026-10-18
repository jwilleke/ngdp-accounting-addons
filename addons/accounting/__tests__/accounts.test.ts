/**
 * Accounts (D-031): where the money sits, beside the fund it is for. Cash on
 * Hand is built in, bank accounts come from configuration, the method picks
 * where a receipt lands, and accounts added up equal funds added up.
 *
 * Each test opens the accounting database in memory, as ngdpbase's
 * openAddonDatabase opens it; nothing touches a data directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from './host.js';
import LedgerManager, { CASH_ON_HAND, accountsFrom, type LedgerActor, type LedgerAuditRecord, type LedgerDb } from '../managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'ledger-export', 'fund-manage'];

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });

const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined,
  subject: { username: 'tess', roles: ['treasurer'], isAuthenticated: true, granted } as never,
  actingUsername: () => 'tess',
  enforceDeny: (permission: string) => Promise.reject(Object.assign(new Error(`refused: ${permission}`), { status: 403 }))
});

const TWO_BANKS = {
  checking: { name: 'Checking', kind: 'bank', default: true },
  savings: { name: 'Savings', kind: 'bank' }
};

describe('accountsFrom', () => {
  test('Cash on Hand comes first and is built in; the shipped Checking is the default', () => {
    const accounts = accountsFrom(testLedgerParts.accounts());
    expect(accounts.map(a => [a.id, a.name, a.kind, a.isDefault])).toEqual([
      [CASH_ON_HAND, 'Cash on Hand', 'cash', false],
      ['checking', 'Checking', 'bank', true]
    ]);
  });

  test('false removes a shipped account; a bad entry is skipped with a warning; one default is kept', () => {
    const warnings: string[] = [];
    const accounts = accountsFrom({
      checking: false, 'Bad Id': { name: 'x' }, 'cash-on-hand': { name: 'mine' }, vault: { kind: 'safe' },
      a: { name: 'A', default: true }, b: { name: 'B', default: true }
    }, (m) => warnings.push(m));
    expect(accounts.map(a => a.id)).toEqual([CASH_ON_HAND, 'a', 'b']);
    expect(accounts.filter(a => a.isDefault).map(a => a.id)).toEqual(['a']);
    expect(warnings.join('\n')).toMatch(/Bad Id[\s\S]*built in[\s\S]*kind must be 'bank'[\s\S]*several accounts are marked default/);
  });

  test('with no bank account, nothing is the default and the site is told', () => {
    const warnings: string[] = [];
    expect(accountsFrom({}, (m) => warnings.push(m)).some(a => a.isDefault)).toBe(false);
    expect(warnings).toEqual(['[accounting] no bank account is configured: everything lands in Cash on Hand']);
  });
});

describe('the ledger\'s accounts', () => {
  let provider: { handle: unknown; close(): void };
  let db: LedgerDb;
  let audit: LedgerAuditRecord[];
  let configured: Record<string, unknown>;
  let ledger: LedgerManager;

  beforeEach(() => {
    provider = openTestLedgerDatabase();
    db = provider.handle as unknown as LedgerDb;
    audit = [];
    configured = { ...TWO_BANKS };
    ledger = new LedgerManager({ ...testLedgerParts, db, decide, currency: 'USD',
      accounts: () => configured,
      recordAudit: (record) => { audit.push(record); return Promise.resolve(); }
    });
  });

  afterEach(() => {
    provider.close();
  });

  const fund = (name: string, openingBalance = 0) => ledger.createFund(actor(), { name, openingBalance, openingDate: '2026-01-01' });
  const receipt = (fundId: string, amount: number, paymentMethod: string, extra: Record<string, unknown> = {}) =>
    ledger.postReceipt(actor(), { fundId, amount, date: '2026-10-18', category: '4100', partyName: 'Pat', paymentMethod, memo: 'dues', ...extra }, { provider: 'manual' });
  const balanceOf = async (accountId: string) => (await ledger.accountBalances(actor())).find(b => b.accountId === accountId)?.balance;

  test('cash, checks and card land in Cash on Hand; ACH, Zelle and bank transfers in the default bank account', async () => {
    const general = await fund('General');
    const landed = await Promise.all(['10', '20', '48', '2', '68', '30'].map(async m => [m, (await receipt(general.id, 100, m)).accountId]));
    expect(landed).toEqual([['10', CASH_ON_HAND], ['20', CASH_ON_HAND], ['48', CASH_ON_HAND], ['2', 'checking'], ['68', 'checking'], ['30', 'checking']]);
  });

  test('the treasurer can name the account instead', async () => {
    const general = await fund('General');
    expect((await receipt(general.id, 100, '20', { accountId: 'savings' })).accountId).toBe('savings');
  });

  test('money out comes from the default bank account unless named; cash paid out comes from Cash on Hand', async () => {
    const general = await fund('General');
    const out = (extra: Record<string, unknown>) =>
      ledger.postTransaction(actor(), { direction: 'out', amount: 50, date: '2026-10-18', fundId: general.id, category: '5200', memo: 'supplies', ...extra });
    expect((await out({})).accountId).toBe('checking');
    expect((await out({ paymentMethod: '10' })).accountId).toBe(CASH_ON_HAND);
    expect((await out({ accountId: 'savings' })).accountId).toBe('savings');
  });

  test('an unknown or closed account is refused', async () => {
    const general = await fund('General');
    await expect(receipt(general.id, 100, '20', { accountId: 'nowhere' })).rejects.toThrow('unknown account');
    configured = { ...TWO_BANKS, savings: { name: 'Savings', active: false } };
    await expect(receipt(general.id, 100, '20', { accountId: 'savings' })).rejects.toThrow("account 'Savings' is closed");
  });

  test('a refund is paid back from the account its method picks, or the one named', async () => {
    const general = await fund('General');
    const cash = await receipt(general.id, 1000, '10');
    expect((await ledger.refundReceipt(actor(), cash.id, { amount: 100, date: '2026-10-18', memo: 'overpaid' })).accountId).toBe(CASH_ON_HAND);
    expect((await ledger.refundReceipt(actor(), cash.id, { amount: 100, date: '2026-10-18', memo: 'overpaid', paymentMethod: '20' })).accountId).toBe(CASH_ON_HAND);
    expect((await ledger.refundReceipt(actor(), cash.id, { amount: 100, date: '2026-10-18', memo: 'overpaid', paymentMethod: '68' })).accountId).toBe('checking');
  });

  test('moving money between funds leaves every account as it was', async () => {
    const general = await fund('General', 1000);
    const roof = await fund('Roof');
    await receipt(general.id, 500, '68');
    const balances = async () => (await ledger.accountBalances(actor())).map(b => [b.accountId, b.balance]);
    const before = await balances();
    const [out, into] = await ledger.transferBetweenFunds(actor(), { fromFundId: general.id, toFundId: roof.id, amount: 300, date: '2026-10-18', memo: 'roof' });
    expect(out.accountId).toBe(into.accountId);
    expect(await balances()).toEqual(before);
  });

  describe('opening balances', () => {
    test('need fund-manage, are set once, and are audited', async () => {
      await expect(ledger.setAccountOpening(actor(['ledger-record']), 'checking', { openingBalance: 5000 })).rejects.toThrow('refused: fund-manage');
      const set = await ledger.setAccountOpening(actor(), 'checking', { openingBalance: 5000, openingDate: '2026-01-01' });
      expect(set).toMatchObject({ accountId: 'checking', openingBalance: 5000, openingDate: '2026-01-01', balance: 5000 });
      expect(audit.at(-1)).toMatchObject({ action: 'account-opening', resource: 'checking', metadata: { openingBalance: 5000, openingDate: '2026-01-01' } });
      await expect(ledger.setAccountOpening(actor(), 'checking', { openingBalance: 1 })).rejects.toThrow('already has its opening balance');
    });

    test('the same opening submitted several times at once is set once; the others are refused cleanly', async () => {
      const results = await Promise.allSettled([1, 2, 3, 4].map(() =>
        ledger.setAccountOpening(actor(), 'checking', { openingBalance: 5000, openingDate: '2026-01-01' })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter(r => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason.message).toBe("account 'Checking' already has its opening balance");
      }
    });

    test('the database refuses to change one', async () => {
      await ledger.setAccountOpening(actor(), CASH_ON_HAND, { openingBalance: 200, openingDate: '2026-01-01' });
      expect(() => db.prepare('UPDATE accounting_account_openings SET opening_balance = 1').run()).toThrow(/do not change/);
      expect(() => db.prepare('DELETE FROM accounting_account_openings').run()).toThrow(/do not change/);
    });
  });

  test('accounts added up equal funds added up', async () => {
    const general = await fund('General', 7000);
    const roof = await fund('Roof', 3000);
    await ledger.setAccountOpening(actor(), 'checking', { openingBalance: 9000, openingDate: '2026-01-01' });
    await ledger.setAccountOpening(actor(), CASH_ON_HAND, { openingBalance: 1000, openingDate: '2026-01-01' });
    await receipt(general.id, 2500, '20');
    await receipt(roof.id, 400, '68');
    await ledger.postTransaction(actor(), { direction: 'out', amount: 600, date: '2026-10-18', fundId: roof.id, category: '5200', memo: 'shingles' });
    const funds = (await ledger.fundBalances(actor())).reduce((t, b) => t + b.balance, 0);
    const accounts = await ledger.accountBalances(actor());
    expect(accounts.reduce((t, b) => t + b.balance, 0)).toBe(funds);
    expect(accounts.map(a => [a.accountId, a.balance])).toEqual([[CASH_ON_HAND, 3500], ['checking', 8800], ['savings', 0]]);

    const summary = await ledger.periodSummary(actor(), ledger.period({ month: '2026-10' }));
    expect(summary.accounts.map(a => [a.accountId, a.start, a.moneyIn, a.moneyOut, a.end])).toEqual([
      [CASH_ON_HAND, 1000, 2500, 0, 3500], ['checking', 9000, 400, 600, 8800], ['savings', 0, 0, 0, 0]
    ]);
    expect(summary.accounts.reduce((t, a) => t + a.end, 0)).toBe(summary.totals.end);
  });

  test('an account dropped from configuration keeps its history, takes no new entries, and is reported', async () => {
    const general = await fund('General');
    await receipt(general.id, 100, '20', { accountId: 'savings' });
    configured = { checking: TWO_BANKS.checking };
    const savings = (await ledger.listAccounts(actor())).find(a => a.id === 'savings');
    expect(savings).toMatchObject({ configured: false, active: false });
    expect(await balanceOf('savings')).toBe(100);
    expect(ledger.droppedAccounts()).toEqual(['savings']);
    await expect(receipt(general.id, 100, '20', { accountId: 'savings' })).rejects.toThrow("account 'savings' is no longer configured");
  });

  test('an entry\'s account never changes', async () => {
    const general = await fund('General');
    const r = await receipt(general.id, 100, '20');
    expect(() => db.prepare("UPDATE accounting_transactions SET account_id = 'savings' WHERE id = ?").run(r.id)).toThrow(/money never changes/);
  });

  test('the form offers the active, configured accounts; the export names each entry\'s account', async () => {
    const general = await fund('General');
    await receipt(general.id, 100, '68');
    expect(await ledger.toFormOptions({ list: 'accounts' }, { username: 'tess', granted: ALL })).toEqual([
      { value: CASH_ON_HAND, label: 'Cash on Hand' }, { value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }
    ]);
    const file = await ledger.exportCsv(actor(), 'transactions', ledger.period({ month: '2026-10' }));
    const [header, row] = file.body.split('\r\n');
    expect(header).toContain('fund_id,fund,account_id,account,category');
    expect(row).toContain(',checking,Checking,');
  });
});

test('upgrading the database puts every earlier entry in Checking', () => {
  const [first, accounts] = ACCOUNTING_MIGRATIONS;
  const handle = openAddonTestDatabase<LedgerDb & { exec(sql: string): unknown; close(): void }>('accounting',
    { migrations: [first] as never, ledgerTable: ACCOUNTING_LEDGER_TABLE });
  try {
    handle.prepare("INSERT INTO accounting_funds (id, name, opening_date, created_by, created_at) VALUES ('f', 'General', '2026-01-01', 'tess', 'now')").run();
    handle.prepare(`INSERT INTO accounting_transactions (id, direction, amount, currency, date, fund_id, category, source_type, status, memo, created_by, created_at)
      VALUES ('t', 'in', 100, 'USD', '2026-10-01', 'f', '4100', 'receipt', 'posted', 'dues', 'tess', 'now')`).run();
    accounts.up(handle);
    expect(handle.prepare("SELECT account_id FROM accounting_transactions WHERE id = 't'").get()).toEqual({ account_id: 'checking' });
  } finally {
    handle.close();
  }
});
