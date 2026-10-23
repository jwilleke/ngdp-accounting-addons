/**
 * Invoices (D-035), in the dues add-on's own database, outside the ledger:
 * each month evaluated on its own, payments as receipt lines with `dues`
 * details, prepayment as credit, late charges proposed and added only when
 * asked. Money goes through the accounting add-on's ledger.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAddonHost, openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import DuesManager, { type AccountSource, type DuesDb, type OwnerSource } from '../managers/DuesManager.js';
import { DUES_LEDGER_TABLE, DUES_MIGRATIONS } from '../managers/migrations.js';
import { duesValidator } from '../billing.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const host = buildAddonHost('accounting-dues', defaults);

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'fund-manage', 'receipt-refund', 'invoice-issue'];
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess', granted } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

/** Two units, as AccommodationManager gives them: one with two owners, one prepaying. */
const units: AccountSource = {
  list: () => [{ id: 'P-1', unitNumber: '1' }, { id: 'P-2', unitNumber: '2' }],
  get: (id) => units.list().find(u => u.id === id),
  assessment: (id) => (id === 'P-1' ? { amount: 41000, period: 'monthly', datedue: 1 } : { amount: 30000, period: 'monthly', datedue: 1 }),
  lateCharges: () => [
    { id: 'late-10', daysLate: 10, amount: 1000, annualPercent: null, repeat: 'once' },
    { id: 'late-60', daysLate: 60, amount: 5000, annualPercent: 8, repeat: 'monthly' }
  ]
};

/** Their owners, as ResidencyManager gives them; the dates asked for are kept. */
const ownersAsked: (string | undefined)[] = [];
const residents: OwnerSource = {
  owners: async (_ctx, id, options) => {
    ownersAsked.push(options?.on);
    return id === 'P-1'
      ? [{ username: 'pat', name: 'Pat Lee', email: 'pat@example.org' }, { username: 'sam', name: 'Sam Lee', email: null }]
      : [{ username: 'jo', name: 'Jo Park', email: 'jo@example.org' }];
  }
};

describe('dues', () => {
  let ledgerDb: { handle: unknown; close(): void };
  let ownDb: DuesDb & { close(): void };
  let ledger: LedgerManager;
  let dues: DuesManager;
  let audit: Record<string, unknown>[];
  let sent: { to: string; subject: string }[];
  let fundId: string;
  let today: string;
  let bumps: number;
  let sending: boolean;

  beforeEach(async () => {
    ledgerDb = openTestLedgerDatabase();
    ownDb = openAddonTestDatabase<DuesDb & { close(): void }>('accounting-dues',
      { migrations: DUES_MIGRATIONS as never, ledgerTable: DUES_LEDGER_TABLE }, { slug: 'accounting-dues', defaults });
    audit = [];
    sent = [];
    bumps = 0;
    sending = true;
    ownersAsked.length = 0;
    today = '2026-09-01';
    ledger = new LedgerManager({ ...testLedgerParts, db: ledgerDb.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(), decide });
    dues = new DuesManager({
      host, db: ownDb, ledger: ledger as never, decide, accounts: () => units, owners: () => residents, categories: () => ['4100'],
      label: () => ({ singular: 'Assessment', plural: 'Assessments' }), formatMoney: (m) => `$${(m / 100).toFixed(2)}`,
      recordAudit: async (r) => { audit.push(r); }, changed: async () => { bumps++; }, now: () => new Date(`${today}T12:00:00Z`),
      email: () => ({ sendTo: async (to: string, subject: string) => { sent.push({ to, subject }); } }), sendToOwners: () => sending
    });
    ledger.registerLineDetails('dues', duesValidator({ categories: () => ['4100'], accountExists: (id) => dues.accountExists(id), invoiceOf: (id) => dues.invoiceOf(id) }));
    fundId = (await ledger.createFund(actor(), { name: 'Operating' })).id;
  });

  afterEach(() => { ledgerDb.close(); ownDb.close(); });

  const pay = (account: string, amount: number, date: string, invoiceId?: string) => ledger.postReceipt(actor(), {
    date, partyName: account, paymentMethod: '20', memo: 'assessment',
    lines: [{ amount, fundId, category: '4100', details: { dues: { account, invoiceId } } }]
  }, { provider: 'manual' });

  test('each month is evaluated on its own; an account is invoiced once a month', async () => {
    expect((await dues.prepareMonth(actor(), '2026-09')).map(r => [r.label, r.owed, r.invoiced])).toEqual([['1', 41000, null], ['2', 30000, null]]);
    expect(await dues.issueMonth(actor(), { month: '2026-09', email: true })).toEqual({ issued: 2, emailed: 2, notEmailed: [], held: false });
    expect(sent.map(s => s.to)).toEqual(['pat@example.org', 'jo@example.org']);
    const [two, one] = await dues.listInvoices(actor());
    expect([one!.number, two!.number]).toEqual(['I-0001', 'I-0002']);
    expect(one).toMatchObject({ accountId: 'P-1', month: '2026-09', dueDate: '2026-09-01', total: 41000, owed: 41000, remaining: 41000, emailedTo: 'pat@example.org' });
    expect(one!.owners).toEqual([{ username: 'pat', name: 'Pat Lee' }, { username: 'sam', name: 'Sam Lee' }]);
    expect(one!.html).toContain('Pat Lee, Sam Lee');
    // Owners are those on the invoice's due date.
    expect(ownersAsked).toEqual(['2026-09-01', '2026-09-01']);
    expect(audit.at(-1)).toMatchObject({ action: 'invoice-issue', resource: 'invoices:2026-09' });
    expect(bumps).toBe(1);
    // Once invoiced, the month shows the invoice's own figures.
    expect((await dues.prepareMonth(actor(), '2026-09')).map(r => [r.previous, r.owed, r.invoiced])).toEqual([[0, 41000, 'I-0001'], [0, 30000, 'I-0002']]);
    expect((await dues.issueMonth(actor(), { month: '2026-09' })).issued).toBe(0);
    expect(bumps).toBe(1);
    expect((await ledger.fundBalances(actor()))[0]!.balance).toBe(0);
    expect(() => ownDb.prepare('DELETE FROM accounting_dues_invoices').run()).toThrow(/never deleted/);
    await expect(dues.issueMonth(actor(['ledger-read']), { month: '2026-10' })).rejects.toThrow('refused: invoice-issue');
  });

  test('payments settle invoices; money paid ahead is credit, and a fully paid invoice is not sent', async () => {
    await dues.issueMonth(actor(), { month: '2026-09' });
    await pay('P-1', 41000, '2026-09-03');
    await pay('P-2', 90000, '2026-09-02');
    expect((await dues.balances(actor())).map(b => [b.label, b.balance])).toEqual([['1', 0], ['2', -60000]]);
    today = '2026-10-01';
    const oct = await dues.prepareMonth(actor(), '2026-10');
    expect(oct.map(r => [r.label, r.previous, r.owed])).toEqual([['1', 0, 41000], ['2', -60000, 0]]);
    expect(await dues.issueMonth(actor(), { month: '2026-10', email: true })).toEqual({ issued: 2, emailed: 1, notEmailed: [], held: false });
    const p2 = (await dues.listInvoices(actor(), { accountId: 'P-2', month: '2026-10' }))[0]!;
    expect(p2).toMatchObject({ owed: 0, remaining: 0 });
    expect(p2.html).toContain('Paid in full');
    expect(sent.map(s => s.to)).toEqual(['pat@example.org']);
  });

  test('late charges are proposed, added only when asked, and never made twice', async () => {
    await dues.issueMonth(actor(), { month: '2026-09' });
    await pay('P-2', 30000, '2026-09-02');
    today = '2026-10-01';
    const [p1] = await dues.prepareMonth(actor(), '2026-10');
    expect(p1!.lateCharges.map(l => [l.ruleId, l.amount, l.appliesToNumber])).toEqual([['late-10', 1000, 'I-0001']]);
    expect(p1).toMatchObject({ previous: 41000, total: 42000, owed: 83000 });
    // Not asked: the month is invoiced without them.
    await dues.issueMonth(actor(), { month: '2026-10', account: 'P-1' });
    expect((await dues.listInvoices(actor(), { accountId: 'P-1', month: '2026-10' }))[0]!.total).toBe(41000);
    // Asked, next month: on September's I-0001 (61 days) the once rule, still not made, and $50 plus a
    // month's 8% on $410.00; on October's I-0003 (31 days) the once rule.
    today = '2026-11-01';
    await dues.issueMonth(actor(), { month: '2026-11', account: 'P-1', lateCharges: true });
    const nov = (await dues.listInvoices(actor(), { accountId: 'P-1', month: '2026-11' }))[0]!;
    expect(nov.number).toBe('I-0004');
    expect(nov.lines.map(l => [l.kind, l.amount])).toEqual([['charge', 41000], ['late-charge', 1000], ['late-charge', 5273], ['late-charge', 1000]]);
    // December: the monthly rule again on I-0001, and now on I-0003; the once rules only on November's I-0004.
    today = '2026-12-01';
    const dec = (await dues.prepareMonth(actor(), '2026-12')).find(r => r.accountId === 'P-1')!;
    expect(dec.lateCharges.map(l => [l.ruleId, l.appliesToNumber, l.amount])).toEqual([
      ['late-60', 'I-0001', 5273], ['late-60', 'I-0003', 5273], ['late-10', 'I-0004', 1000]
    ]);
  });

  test('while send-to-owners is off, nothing is sent to owners, even with the email box ticked', async () => {
    sending = false;
    expect(await dues.issueMonth(actor(), { month: '2026-09', email: true })).toEqual({ issued: 2, emailed: 0, notEmailed: [], held: true });
    expect(sent).toEqual([]);
    expect((await dues.listInvoices(actor()))[0]!.emailedTo).toBeNull();
  });

  test('a void frees the month; a refunded payment counts no more', async () => {
    await dues.issueMonth(actor(), { month: '2026-09' });
    const inv = (await dues.listInvoices(actor(), { accountId: 'P-1' }))[0]!;
    await expect(dues.voidInvoice(actor(), inv.id, '')).rejects.toThrow('reason is required');
    expect((await dues.voidInvoice(actor(), inv.id, 'wrong amount')).status).toBe('voided');
    expect((await dues.issueMonth(actor(), { month: '2026-09', account: 'P-1' })).issued).toBe(1);
    const receipt = await pay('P-1', 41000, '2026-09-03');
    expect((await dues.balances(actor()))[0]!.balance).toBe(0);
    await ledger.refundReceipt(actor(), receipt.id, { date: '2026-09-04', memo: 'paid twice', lines: [{ receiptLineId: receipt.lines[0]!.id, amount: 1000 }] });
    expect((await dues.balances(actor()))[0]!.balance).toBe(1000);
  });

  test('a payment line names an account, in a dues category, and only its own invoices', async () => {
    await dues.issueMonth(actor(), { month: '2026-09' });
    const [p2inv] = await dues.listInvoices(actor(), { accountId: 'P-2' });
    await expect(pay('P-9', 100, '2026-09-03')).rejects.toThrow('details.dues.account names no account');
    await expect(pay('P-1', 100, '2026-09-03', p2inv!.id)).rejects.toThrow('an invoice of another account');
    await expect(ledger.postReceipt(actor(), { date: '2026-09-03', partyName: 'x', paymentMethod: '20', memo: 'x',
      lines: [{ amount: 100, fundId, category: '4200', details: { dues: { account: 'P-1' } } }] }, { provider: 'manual' })).rejects.toThrow('not a dues category');
    expect((await dues.toFormOptions({ list: 'open-invoices' }, { username: 'tess', granted: ALL })).map(o => o.label))
      .toEqual(['I-0002 · 2 · 2026-09 · $300.00 left', 'I-0001 · 1 · 2026-09 · $410.00 left']);
    expect(await dues.toFormOptions({ list: 'open-invoices' }, { username: 'x', granted: [] })).toEqual([]);
  });
});
