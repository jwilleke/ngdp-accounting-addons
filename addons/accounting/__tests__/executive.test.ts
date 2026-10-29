/**
 * The executive role (ngdpbase#2094, D-050): what this add-on's own policy grants
 * it, which of the treasurer's pages it reads, and the card on core's Executive
 * Hub. Each test opens the accounting database in memory; nothing touches a data
 * directory.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testFormatters, testLedgerParts } from './host.js';
import LedgerManager, { type Fund, type LedgerActor, type LedgerDb } from '../managers/LedgerManager.js';
import { ledgerExecutiveCard, registerExecutiveCard, type ExecutiveCard } from '../executive.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
type Policy = { id: string; effect: string; subjects: { type: string; value: string }[]; actions: string[] };
const policies = defaults['ngdpbase.access.policies'] as Policy[];
const declared = Object.keys(defaults['ngdpbase.permissions.definitions'] as Record<string, unknown>);

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'ledger-export', 'fund-manage'];
const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const subject = (granted: string[]) => ({ username: 'tess', isAuthenticated: true, granted });
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, subject: subject(granted) as never, actingUsername: () => 'tess',
  enforceDeny: (permission: string) => Promise.reject(Object.assign(new Error(`refused: ${permission}`), { status: 403 }))
});

describe('the executive policy', () => {
  const executive = policies.filter(p => p.subjects.some(s => s.type === 'role' && s.value === 'executive'));

  test('grants the executive role every read, and the CSV downloads, and nothing that records', () => {
    expect(executive.map(p => [p.id, p.effect])).toEqual([['accounting-executive', 'allow']]);
    expect(executive[0]!.actions).toEqual(['ledger-summary-read', 'ledger-read', 'ledger-export']);
    for (const write of ['ledger-record', 'ledger-adjust', 'receipt-refund', 'fund-manage', 'form-submit']) expect(executive[0]!.actions).not.toContain(write);
    // A user's own receipts are theirs (ledger-self, every account through vault-owner); not the board's to be granted.
    expect(executive[0]!.actions).not.toContain('ledger-self');
  });

  test('names only permissions this add-on declares', () => {
    for (const action of executive[0]!.actions) expect(declared).toContain(action);
  });
});

describe("the treasurer's pages", () => {
  const dir = new URL('../pages/', import.meta.url);
  const pages = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const front = readFileSync(new URL(f, dir), 'utf8').split('\n---')[0]!;
    return { title: /^title: (.*)$/m.exec(front)![1]!, audience: /^audience:\n((?:  - .*\n?)+)/m.exec(front)?.[1]?.match(/- (\S+)/g)?.map(m => m.slice(2)) ?? null };
  });
  const reading = ['Accounting', 'Bounced Checks', 'Deposits', 'Ledger', 'Monthly Summary'];

  test('the pages that show the books admit the executive role; the pages that record stay the treasurer\'s', () => {
    for (const page of pages) {
      if (page.audience === null) continue; // the help page, for everyone
      expect(page.audience, page.title).toEqual(reading.includes(page.title) ? ['treasurer', 'executive'] : ['treasurer']);
    }
    expect(pages.filter(p => p.audience?.includes('executive')).map(p => p.title).sort()).toEqual(reading);
  });
});

describe('the Executive Hub card', () => {
  let provider: { handle: unknown; close(): void };
  let ledger: LedgerManager;
  let general: Fund;
  let card: ExecutiveCard;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    ledger = new LedgerManager({ ...testLedgerParts, db: provider.handle as LedgerDb, decide, currency: 'USD',
      categories: () => defaults['ngdpbase.addons.accounting.categories'], bouncedChecks: () => ({ bankChargesCategory: '6100', otherIncomeCategory: '8900', penalty: 0 }),
      now: () => new Date('2026-10-20T12:00:00Z'), recordAudit: () => Promise.resolve() });
    general = await ledger.createFund(actor(), { name: 'General', openingBalance: 100_000, openingDate: '2026-01-01' });
    await ledger.createFund(actor(), { name: 'Roof', openingDate: '2026-01-01' });
    card = ledgerExecutiveCard(ledger, (m) => testFormatters.formatMoney(m, 'USD'));
  });

  afterEach(() => provider.close());

  const receipt = (amount: number, paymentMethod: string, date = '2026-10-01') =>
    ledger.postReceipt(actor(), { fundId: general.id, amount, date, category: '4100', partyName: 'Pat', paymentMethod, memo: 'dues' }, { provider: 'manual' });

  test('is registered on a core with the hub, gated by ledger-summary-read, and left out on an older core', () => {
    const registered: unknown[] = [];
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c) }, card)).toBe(false);
    expect(registerExecutiveCard(null, card)).toBe(false);
    expect(registered).toEqual([]);
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c), executiveCardsFor: () => [] }, card)).toBe(true);
    expect(registered).toEqual([card]);
    expect(card).toMatchObject({ addonName: 'accounting', surface: 'executive', permission: 'ledger-summary-read', adminUrl: '/view/accounting' });
    expect(declared).toContain(card.permission);
  });

  test('shows the funds, the cash not yet deposited, what waits on the treasurer, and the lock, read as the viewer', async () => {
    const cleared = await receipt(5_000, '20');
    const bounced = await receipt(3_000, '20');
    const waiting = await receipt(2_000, '10');
    await receipt(7_000, '68'); // Zelle lands in the bank, not in Cash on Hand
    const first = await ledger.makeDeposit(actor(), { accountId: 'checking', date: '2026-10-02', receiptIds: [cleared.id], total: 5_000 });
    await ledger.clearDeposit(actor(), first.id, '2026-10-03');
    await ledger.makeDeposit(actor(), { accountId: 'checking', date: '2026-10-02', receiptIds: [bounced.id], total: 3_000 });
    await ledger.recordBounce(actor(), bounced.id, { date: '2026-10-09', fee: 1_500 });
    await ledger.setLockSettings(actor(), { period: 'month', fiscalStartMonth: 1 });
    await ledger.lockPeriod(actor(), '2026-09-30');
    expect(waiting.total).toBe(2_000);

    const executive = await card.summary(subject(['ledger-summary-read', 'ledger-read', 'ledger-export']) as never);
    // 1,000.00 opening + 170.00 received − 30.00 bounced − 15.00 fee
    expect(executive.figures).toEqual([
      { label: 'Funds', value: '$1,125.00' },
      { label: 'Open funds', value: 2 },
      { label: 'Cash not yet deposited', value: '$20.00' },
      { label: 'Receipts waiting for a deposit', value: '1 ($20.00)' },
      { label: 'Deposits not cleared', value: '1 ($30.00)' },
      { label: 'Bounced checks still owed', value: '1 ($45.00)' }
    ]);
    expect(executive.message).toBe('Books locked through 2026-09-30');

    // A viewer with the summary only sees no pending items; one without it is refused.
    const summaryOnly = await card.summary(subject(['ledger-summary-read']) as never);
    expect(summaryOnly.figures.map(f => f.label)).toEqual(['Funds', 'Open funds', 'Cash not yet deposited']);
    await expect(card.summary(subject([]) as never)).rejects.toThrow('not permitted: ledger-summary-read');
  });

  test('with nothing pending and nothing locked, says so', async () => {
    const s = await card.summary(subject(['ledger-summary-read', 'ledger-read']) as never);
    expect(s.figures.slice(3).map(f => f.value)).toEqual(['0', '0', '0']);
    expect(s.message).toBe('No period is locked yet');
  });
});

describe("a module's reader of its own lines, by date", () => {
  test('keeps only receipts dated in the range, net of refunds made later', async () => {
    const provider = openTestLedgerDatabase();
    try {
      const ledger = new LedgerManager({ ...testLedgerParts, db: provider.handle as LedgerDb, decide, currency: 'USD', recordAudit: () => Promise.resolve() });
      const reader = ledger.registerLineDetails('note', { validate: (data) => data as Record<string, unknown> });
      const fund = await ledger.createFund(actor(), { name: 'General', openingDate: '2025-01-01' });
      const post = (amount: number, date: string) => ledger.postReceipt(actor(), { date, partyName: 'Pat', paymentMethod: '20', memo: 'gift',
        lines: [{ amount, fundId: fund.id, category: '4200', details: { note: { n: date } } }] }, { provider: 'manual' });
      await post(1_000, '2025-12-31');
      const kept = await post(2_000, '2026-03-01');
      await post(4_000, '2027-01-01');
      await ledger.refundReceipt(actor(), kept.id, { amount: 500, date: '2027-02-01', memo: 'part back' });
      expect(reader.lines().map(l => l.amount).sort((a, b) => a - b)).toEqual([1_000, 1_500, 4_000]);
      expect(reader.lines({ from: '2026-01-01', to: '2026-12-31' }).map(l => [l.date, l.amount])).toEqual([['2026-03-01', 1_500]]);
      expect(() => reader.lines({ from: '2026-1-1' })).toThrow('from');
    } finally {
      provider.close();
    }
  });
});
