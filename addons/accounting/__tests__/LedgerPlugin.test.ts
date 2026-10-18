/**
 * [{Ledger}]: the ledger drawn for the viewer, through the ledger's own
 * permissions, with ngdpbase's shared plugin formatting. Each test opens its
 * own temporary database and removes only that folder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { testLedgerParts, testFormatters } from './host.js';
import { openTestLedgerDatabase } from './host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';
import LedgerPlugin, { renderLedgerView } from '../plugins/LedgerPlugin.js';

const treasurer: LedgerActor = {
  ipAddress: undefined, actingUsername: () => 'setup', subject: { username: 'setup' } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
};

/** Who holds what, for the test's decision point. `setup` writes the test data. */
const GRANTS: Record<string, string[]> = {
  tess: ['ledger-summary-read', 'ledger-read', 'ledger-record'],
  setup: ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'fund-manage'],
  board: ['ledger-summary-read']
};

describe('LedgerPlugin', () => {
  let provider: { handle: unknown; close(): void };
  let ledger: LedgerManager;
  // What /api/accounting/view renders for a reader (the page itself holds only a placeholder).
  const render = (viewer: string | null, params: Record<string, string>) =>
    renderLedgerView(testFormatters, ledger, ledger.viewerActor(viewer ? { username: viewer } : null), params);

  beforeEach(() => {
    provider = openTestLedgerDatabase();
    ledger = new LedgerManager({ ...testLedgerParts,
      db: provider.handle as unknown as LedgerDb,
      currency: 'USD',
      recordAudit: () => Promise.resolve(),
      decide: async (subject, { action }) => ({
        permit: (GRANTS[(subject as { username?: string } | null)?.username ?? ''] ?? []).includes(action), applicable: true, reason: 'test'
      })
    });
  });

  afterEach(() => {
    provider.close();
  });

  test('balances: money in the site currency, escaped names, and a total', async () => {
    const general = await ledger.createFund(treasurer, { name: 'General <main>', openingBalance: 10000 });
    await ledger.createFund(treasurer, { name: 'Roof' });
    await ledger.postReceipt(treasurer, { amount: 125050, date: '2026-10-10', fundId: general.id, category: '4100', partyName: 'Pat', paymentMethod: '20', memo: 'dues' }, { provider: 'manual' });
    const html = await render('board', { view: 'balances' });
    expect(html).toContain('General &lt;main&gt;');
    expect(html).toContain('<strong>$1,350.50</strong>');
    expect(html).toMatch(/<tfoot><tr><td><strong>Total<\/strong><\/td><td>\$100\.00<\/td><td>\$1,250\.50<\/td><td>\$0\.00<\/td><td><strong>\$1,350\.50<\/strong><\/td><\/tr><\/tfoot>/);
  });

  test('tables sort by heading, money on its cents and names without markup', async () => {
    await ledger.createFund(treasurer, { name: 'General <main>', openingBalance: 125050 });
    const html = await render('board', { view: 'balances' });
    expect(html).toContain('<table class="plugin-table sortable">');
    expect(html).toContain('<td data-sort="General &lt;main&gt;">');
    expect(html).toContain('<td data-sort="125050">$1,250.50</td>');
  });

  test('balances with no funds says so', async () => {
    expect(await render('board', { view: 'balances' })).toContain('No funds yet.');
  });

  test('entries: newest first, limited by max, for a viewer who may read entries', async () => {
    const f = await ledger.createFund(treasurer, { name: 'General' });
    for (const [date, amount] of [['2026-10-01', 100], ['2026-10-03', 300], ['2026-10-02', 200]] as const) {
      await ledger.postTransaction(treasurer, { direction: 'out', amount, date, fundId: f.id, category: '5200', memo: `m${amount}` });
    }
    const html = await render('tess', { view: 'entries', max: '2' });
    expect(html.indexOf('2026-10-03')).toBeLessThan(html.indexOf('2026-10-02'));
    expect(html).not.toContain('2026-10-01');
    expect(html).toContain('$3.00');
  });

  test('a viewer without ledger-read is refused entries but may see balances', async () => {
    expect(await render('board', { view: 'entries' })).toContain('You may not see the ledger.');
    expect(await render(null, { view: 'balances' })).toContain('You may not see the ledger.');
  });

  test('the plugin draws the view on the server, as the viewer', async () => {
    await ledger.createFund(treasurer, { name: 'General' });
    const html = await LedgerPlugin.execute({ engine: { getManager: <T>() => ledger as unknown as T }, userContext: { username: 'board' }, formatters: testFormatters }, { view: 'balances' });
    expect(html).toContain('General');
    expect(await LedgerPlugin.execute({ engine: { getManager: <T>() => ledger as unknown as T }, userContext: null, formatters: testFormatters }, { view: 'balances' })).toContain('You may not see the ledger.');
  });

  test('an unknown view says which views exist', async () => {
    expect(await render('tess', { view: 'secrets' })).toContain('use balances, accounts, entries, deposits or summary');
  });
});
