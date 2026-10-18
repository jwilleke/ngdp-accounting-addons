/**
 * The monthly summary and the CSV export (issue #7, MVP part): totals that
 * reconcile with the ledger, transfers left out of income and expense, and an
 * export that is permissioned, audited with its hash, and refused without a
 * record. Each test opens its own temporary database and removes only it.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { testLedgerParts, testFormatters } from './host.js';
import { openTestLedgerDatabase } from './host.js';
import LedgerManager, { type LedgerActor, type LedgerAuditRecord, type LedgerDb } from '../managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';
import { renderLedgerView } from '../plugins/LedgerPlugin.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'ledger-export', 'fund-manage'];
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: '203.0.113.7',
  subject: { username: 'tess', roles: ['treasurer'], isAuthenticated: true, ipAddress: '203.0.113.7', granted } as never,
  actingUsername: () => 'tess',
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

describe('reports', () => {
  let provider: { handle: unknown; close(): void };
  let audit: LedgerAuditRecord[];
  let auditFails: boolean;
  let ledger: LedgerManager;
  let general: string;
  let roof: string;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    audit = [];
    auditFails = false;
    ledger = new LedgerManager({ ...testLedgerParts,
      db: provider.handle as unknown as LedgerDb,
      currency: 'USD',
      now: () => new Date('2026-10-15T12:00:00Z'),
      recordAudit: (r) => (auditFails ? Promise.reject(new Error('audit down')) : (audit.push(r), Promise.resolve())),
      categories: () => ({ '4100': 'Dues', '5200': 'Supplies' }),
      // A caller with a `granted` list gets what it names; a page viewer (the plugin) may read everything.
      decide: async (subject, { action }) => {
        const granted = (subject as { granted?: string[] } | null)?.granted;
        return { permit: granted ? granted.includes(action) : true, applicable: true, reason: 'test' };
      }
    });
    // September: General opens with $100, $50 dues. October: $200 dues, $30 supplies,
    // a $40 transfer to Roof, a $10 receipt voided and recorded again as $12. Roof opens in October with $5.
    // Money in is a receipt (D-029); every entry says why.
    const receive = (amount: number, date: string, extra: Record<string, unknown> = {}) =>
      ledger.postReceipt(actor(), { amount, date, fundId: general, category: '4100', partyName: 'Pat', paymentMethod: '20', memo: 'dues', ...extra } as never, { provider: 'manual' });
    general = (await ledger.createFund(actor(), { name: 'General', openingBalance: 10000, openingDate: '2026-09-01' })).id;
    await receive(5000, '2026-09-20');
    roof = (await ledger.createFund(actor(), { name: 'Roof', openingBalance: 500, openingDate: '2026-10-02' })).id;
    await receive(20000, '2026-10-03');
    await ledger.postTransaction(actor(), { direction: 'out', amount: 3000, date: '2026-10-04', fundId: general, category: '5200', memo: '=SUM(A1)' });
    await ledger.transferBetweenFunds(actor(), { fromFundId: general, toFundId: roof, amount: 4000, date: '2026-10-05', memo: 'roof reserve' });
    const wrong = await receive(1000, '2026-10-06');
    await ledger.voidTransaction(actor(), wrong.id, 'typo');
    await receive(1200, '2026-10-06');
    audit = [];
  });

  afterEach(() => {
    provider.close();
  });

  test('period: current, previous, a named month, and explicit dates', () => {
    expect(ledger.period()).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(ledger.period({ month: 'previous' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(ledger.period({ month: '2024-02' })).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(ledger.period({ from: '2026-01-01', to: '2026-06-30' })).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(() => ledger.period({ month: '2026-13' })).toThrow(/month/);
    expect(() => ledger.period({ from: '2026-02-01', to: '2026-01-01' })).toThrow(/after/);
  });

  test('October: per fund start, opened, in, out, end; categories without the transfer', async () => {
    const s = await ledger.periodSummary(actor(['ledger-summary-read']), ledger.period({ month: '2026-10' }));
    expect(s.funds).toEqual([
      { fundId: general, name: 'General', active: true, start: 15000, opened: 0, moneyIn: 21200, moneyOut: 7000, end: 29200 },
      { fundId: roof, name: 'Roof', active: true, start: 0, opened: 500, moneyIn: 4000, moneyOut: 0, end: 4500 }
    ]);
    expect(s.categories).toEqual([
      { category: '4100', label: 'Dues', income: 21200, expense: 0 },
      { category: '5200', label: 'Supplies', income: 0, expense: 3000 }
    ]);
    expect(s.totals).toEqual({ start: 15000, opened: 500, moneyIn: 25200, moneyOut: 7000, end: 33700, income: 21200, expense: 3000 });
  });

  test('the summary reconciles with the ledger: each fund\'s end is its balance', async () => {
    const s = await ledger.periodSummary(actor(), { from: '2026-09-01', to: '2026-10-31' });
    const balances = new Map((await ledger.fundBalances(actor())).map(b => [b.fundId, b.balance]));
    for (const f of s.funds) expect(f.end).toBe(balances.get(f.fundId));
  });

  test('a fund opened after the period is not in it', async () => {
    const s = await ledger.periodSummary(actor(), ledger.period({ month: '2026-09' }));
    expect(s.funds.map(f => f.name)).toEqual(['General']);
  });

  test('the transactions CSV: every entry dated in the period, voided ones with their status, audited with its hash', async () => {
    const file = await ledger.exportCsv(actor(), 'transactions', ledger.period({ month: '2026-10' }));
    const lines = file.body.trimEnd().split('\r\n');
    expect(lines[0].split(',').slice(0, 6)).toEqual(['id', 'date', 'direction', 'amount_minor', 'amount', 'currency']);
    expect(file.rows).toBe(6); // a receipt, an out entry, 2 transfer legs, the voided receipt and the one recorded again
    expect(lines).toHaveLength(7);
    expect(file.body).toContain(',voided,');
    expect(file.body).toContain(",'=SUM(A1),"); // a formula-like memo is neutralised
    expect(file.body).toContain(',20000,200.00,USD,');
    expect(file.sha256).toBe(createHash('sha256').update(file.body).digest('hex'));
    expect(file.filename).toBe('ledger-transactions-2026-10-01-to-2026-10-31.csv');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'ledger-export', user: 'tess', severity: 'high', metadata: { kind: 'transactions', from: '2026-10-01', to: '2026-10-31', rows: 6, sha256: file.sha256 } });
  });

  test('the funds CSV is the period summary per fund', async () => {
    const file = await ledger.exportCsv(actor(), 'funds', ledger.period({ month: '2026-10' }));
    expect(file.body.split('\r\n')[1]).toBe(`${general},General,true,USD,15000,0,21200,7000,29200,150.00,0.00,212.00,70.00,292.00`);
  });

  test('no ledger-export, no file and no record', async () => {
    await expect(ledger.exportCsv(actor(['ledger-summary-read', 'ledger-read']), 'transactions', ledger.period())).rejects.toThrow(/ledger-export/);
    expect(audit).toEqual([]);
  });

  test('if the audit record cannot be written, there is no file', async () => {
    auditFails = true;
    await expect(ledger.exportCsv(actor(), 'transactions', ledger.period())).rejects.toThrow(/audit down/);
  });

  test('[{Ledger view=summary}] shows the period, with download links only when asked', async () => {
    const render = (params: Record<string, string>) => renderLedgerView(testFormatters, ledger, ledger.viewerActor({ username: 'board' }), params);
    const html = await render({ view: 'summary', month: '2026-10' });
    expect(html).toContain('2026-10-01 to 2026-10-31');
    expect(html).toContain('<strong>$292.00</strong>');
    expect(html).toContain('4100 Dues');
    expect(html).not.toContain('/api/accounting/export');
    const withLinks = await render({ view: 'summary', month: '2026-10', export: 'true' });
    expect(withLinks).toContain('/api/accounting/export?kind=transactions&amp;from=2026-10-01&amp;to=2026-10-31');
    expect(await render({ view: 'summary', month: 'May' })).toContain('month must be current, previous or YYYY-MM');
  });
});
