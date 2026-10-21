/**
 * Year-end giving statements (D-036): per donor and year, from gift lines that
 * name them (net of refunds, bounced checks left out) and their in-kind gifts;
 * kept exactly as issued; reissued with the old one superseded; emailed to the
 * donor's address on file.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAddonHost, openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import DonationManager, { type DonationsDb } from '../managers/DonationManager.js';
import { DONATIONS_LEDGER_TABLE, DONATIONS_MIGRATIONS } from '../managers/migrations.js';
import { DEFAULT_WORDING } from '../managers/statement.js';
import { giftValidator } from '../gift.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const host = buildAddonHost('accounting-donations', defaults);
const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'fund-manage', 'donation-record', 'statement-issue', 'contact-read', 'contact-manage'];
const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess', granted } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

describe('giving statements', () => {
  let ledgerDb: { handle: unknown; close(): void };
  let ownDb: DonationsDb & { close(): void };
  let ledger: LedgerManager;
  let donations: DonationManager;
  let sent: { to: string; subject: string; html?: string }[];
  let audit: Record<string, unknown>[];
  let fundId: string;
  const people = new Map<string, Record<string, unknown>>([
    ['urn:uuid:jane', { '@id': 'urn:uuid:jane', name: 'Jane Roe', email: 'jane@example.com' }],
    ['urn:uuid:bo', { '@id': 'urn:uuid:bo', name: 'Bo Diaz' }]
  ]);
  const jane = { type: 'person' as const, id: 'urn:uuid:jane', name: 'Jane Roe' };
  const bo = { type: 'person' as const, id: 'urn:uuid:bo', name: 'Bo Diaz' };

  beforeEach(async () => {
    ledgerDb = openTestLedgerDatabase();
    ownDb = openAddonTestDatabase<DonationsDb & { close(): void }>('accounting-donations',
      { migrations: DONATIONS_MIGRATIONS as never, ledgerTable: DONATIONS_LEDGER_TABLE }, { slug: 'accounting-donations', defaults });
    sent = []; audit = [];
    ledger = new LedgerManager({ ...testLedgerParts, db: ledgerDb.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(), decide,
      categories: () => ({ '4200': 'Donations and gifts', '6100': { name: 'Bank Charges', type: 'expense' }, '8900': { name: 'Other Miscellaneous Income', type: 'other-income' } }),
      bouncedChecks: () => ({ bankChargesCategory: '6100', otherIncomeCategory: '8900', penalty: 0 }) });
    const door = { get: async (_ctx: unknown, id: string) => people.get(id) ?? null, list: async () => [...people.values()] };
    donations = new DonationManager({ host, db: ownDb, ledger: ledger as never, decide, categories: () => ['4200'], formatMoney: (m) => `$${(m / 100).toFixed(2)}`,
      recordAudit: async (r) => { audit.push(r); }, contacts: () => ({ persons: door, organizations: door }) as never,
      wording: () => ({ organization: { name: 'Fairways Fund', taxId: '12-3456789', address: '1 Fairway Dr' }, intro: DEFAULT_WORDING.intro, noGoods: DEFAULT_WORDING.noGoods, goodsNote: DEFAULT_WORDING.goodsNote, taxIdNote: DEFAULT_WORDING.taxIdNote }),
      email: () => ({ sendTo: async (to: string, subject: string, _text: string, html?: string) => { sent.push({ to, subject, html }); } }),
      now: () => new Date('2027-01-15T12:00:00Z') });
    ledger.registerLineDetails('gift', giftValidator({ categories: () => ['4200'], quidProQuo: () => '', formatMoney: String }));
    fundId = (await ledger.createFund(actor(), { name: 'General', openingDate: '2026-01-01' })).id;
  });

  afterEach(() => { ledgerDb.close(); ownDb.close(); });

  const gift = (donor: typeof jane, amount: number, date: string, extra: Record<string, unknown> = {}) => ledger.postReceipt(actor(), {
    date, partyName: donor.name, paymentMethod: '20', memo: 'gift',
    lines: [{ amount, fundId, category: '4200', details: { gift: { donor, ...extra } } }]
  }, { provider: 'manual' });

  test('a donor\'s year: their gifts net of refunds, their in-kind gifts, and the totals', async () => {
    await gift(jane, 10_000, '2026-03-01', { goodsValue: 4_000, goodsDescription: 'gala dinner' });
    const second = await gift(jane, 5_000, '2026-06-01');
    await gift(jane, 9_999, '2027-01-02');
    await gift(bo, 2_500, '2026-05-01');
    await ledger.refundReceipt(actor(), second.id, { amount: 1_000, date: '2026-06-02', memo: 'paid twice' });
    await donations.recordInKind(actor(), { donorName: 'Jane Roe', donorPersonId: jane.id, date: '2026-09-01', description: 'Dell laptop, used' });
    const year = await donations.yearOverview(actor(), 2026);
    expect(year.map(d => [d.donor.name, d.giftCount, d.total, d.deductible, d.inKindCount, d.statement])).toEqual([
      ['Bo Diaz', 1, 2_500, 2_500, 0, null], ['Jane Roe', 2, 14_000, 10_000, 1, null]
    ]);
    const preview = await donations.previewStatement(actor(), `person|${jane.id}`, 2026);
    expect(preview).toContain('gala dinner: $40.00');
    expect(preview).toContain('Dell laptop, used');
    expect(preview).toContain('12-3456789');
    expect(preview).not.toContain('$99.99');
  });

  test('issuing stores each statement exactly as issued, emails it, and skips donors who already have one', async () => {
    await gift(jane, 10_000, '2026-03-01');
    await gift(bo, 2_500, '2026-05-01');
    await expect(donations.issueStatements(actor(['ledger-read']), { year: 2026 })).rejects.toThrow('refused: statement-issue');
    expect(await donations.issueStatements(actor(), { year: 2026, email: true })).toEqual({ issued: 2, emailed: 1, notEmailed: ['Bo Diaz'] });
    expect(sent.map(s => [s.to, s.subject])).toEqual([['jane@example.com', '2026 giving statement from Fairways Fund']]);
    const first = (await donations.listStatements(actor(), { year: 2026 })).find(st => st.donor.id === jane.id)!;
    expect(first).toMatchObject({ emailedTo: 'jane@example.com', total: 10_000 });
    expect(sent[0].html).toBe(first.html);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await donations.issueStatements(actor(), { year: 2026 })).toEqual({ issued: 0, emailed: 0, notEmailed: [] });
    await expect(donations.issueStatements(actor(), { year: 2026, donor: `person|${jane.id}` })).rejects.toThrow('already has a 2026 statement; reissue it instead');
    expect(() => ownDb.prepare("UPDATE accounting_donations_statements SET total = 1").run()).toThrow(/never changes/);
    expect(audit.find(a => a.action === 'statement-issue')).toMatchObject({ metadata: { year: 2026, count: 2, email: true } });
  });

  test('a gift voided or bounced after issue flags the statement; reissuing supersedes it with the reason', async () => {
    const a = await gift(jane, 10_000, '2026-03-01');
    const b = await gift(jane, 5_000, '2026-04-01');
    await donations.issueStatements(actor(), { year: 2026 });
    await ledger.voidTransaction(actor(), b.id, 'wrong donor');
    expect((await donations.yearOverview(actor(), 2026))[0].statement).toMatchObject({ needsReissue: true });
    const [old] = await donations.listStatements(actor(), { year: 2026 });
    const fresh = await donations.reissueStatement(actor(), old.id, 'a gift was voided', { email: true });
    expect(fresh).toMatchObject({ total: 10_000, giftCount: 1, status: 'issued' });
    expect((await donations.listStatements(actor(), { year: 2026, includeSuperseded: true })).find(s => s.id === old.id))
      .toMatchObject({ status: 'superseded', supersededBy: fresh.id, reissueReason: 'a gift was voided' });
    await expect(donations.reissueStatement(actor(), old.id, 'again')).rejects.toThrow('already reissued');
    // A bounced check leaves the statement too: the issued one now needs reissuing.
    await ledger.makeDeposit(actor(), { accountId: 'checking', date: '2026-03-02', receiptIds: [a.id], total: 10_000 });
    await ledger.recordBounce(actor(), a.id, { date: '2026-03-10' });
    expect((await donations.yearOverview(actor(), 2026)).map(d => [d.giftCount, d.total, d.statement?.needsReissue])).toEqual([[0, 0, true]]);
  });
});
