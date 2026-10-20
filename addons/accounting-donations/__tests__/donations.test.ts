/**
 * In-kind gifts and pledges (D-036), in the donations add-on's own database:
 * described not valued; pledges outside the ledger, with gifts that name them
 * counted as given. Money goes through the accounting add-on's ledger.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAddonHost, openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import DonationManager, { type DonationsDb } from '../managers/DonationManager.js';
import { DONATIONS_LEDGER_TABLE, DONATIONS_MIGRATIONS } from '../managers/migrations.js';
import { giftValidator } from '../gift.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const host = buildAddonHost('accounting-donations', defaults);

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'fund-manage', 'donation-record'];
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess', granted } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

describe('donations', () => {
  let ledgerDb: { handle: unknown; close(): void };
  let ownDb: DonationsDb & { close(): void };
  let ledger: LedgerManager;
  let donations: DonationManager;
  let audit: Record<string, unknown>[];
  let fundId: string;

  beforeEach(async () => {
    ledgerDb = openTestLedgerDatabase();
    ownDb = openAddonTestDatabase<DonationsDb & { close(): void }>('accounting-donations',
      { migrations: DONATIONS_MIGRATIONS as never, ledgerTable: DONATIONS_LEDGER_TABLE }, { slug: 'accounting-donations', defaults });
    audit = [];
    ledger = new LedgerManager({ ...testLedgerParts, db: ledgerDb.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(), decide });
    donations = new DonationManager({ host, db: ownDb, ledger: ledger as never, decide, categories: () => ['4200'], formatMoney: (m) => `$${(m / 100).toFixed(2)}`,
      recordAudit: async (r) => { audit.push(r); } });
    ledger.registerLineDetails('gift', giftValidator({ categories: () => ['4200'], quidProQuo: () => '', formatMoney: String, pledgeIsOpen: (id) => donations.pledgeIsOpen(id) }));
    fundId = (await ledger.createFund(actor(), { name: 'Building' })).id;
  });

  afterEach(() => { ledgerDb.close(); ownDb.close(); });

  const gift = (amount: number, pledgeId?: string) => ledger.postReceipt(actor(), {
    date: '2026-10-20', partyName: 'Pat Lee', paymentMethod: '20', memo: 'pledge payment',
    lines: [{ amount, fundId, category: '4200', details: { gift: { pledgeId } } }]
  }, { provider: 'manual' });

  test('an in-kind gift is described, never valued, and voided with a reason', async () => {
    const g = await donations.recordInKind(actor(), { donorName: 'Pat Lee', date: '2026-10-20', description: 'Dell laptop, used' });
    expect(g).toMatchObject({ donorName: 'Pat Lee', description: 'Dell laptop, used', status: 'posted' });
    expect(Object.keys(g)).not.toContain('value');
    expect(audit.at(-1)).toMatchObject({ action: 'inkind-record', resource: g.id });
    await expect(donations.recordInKind(actor(['ledger-read']), { donorName: 'x', date: '2026-10-20', description: 'y' })).rejects.toThrow('refused: donation-record');
    expect((await donations.voidInKind(actor(), g.id, 'entered twice')).status).toBe('voided');
    expect(await donations.listInKind(actor())).toEqual([]);
    expect(() => ownDb.prepare('DELETE FROM accounting_donations_inkind').run()).toThrow(/never deleted/);
  });

  test('a pledge stays outside the ledger; gifts that name it count as given', async () => {
    const p = await donations.createPledge(actor(), { donorName: 'Pat Lee', amount: 120_000, fundId, startDate: '2026-01-01', endDate: '2026-12-31', schedule: 'monthly', memo: 'roof' });
    expect(p).toMatchObject({ amount: 120_000, given: 0, remaining: 120_000, status: 'open' });
    expect((await ledger.fundBalances(actor()))[0].balance).toBe(0);
    await gift(10_000, p.id);
    await gift(10_000, p.id);
    await gift(5_000);
    expect((await donations.listPledges(actor()))[0]).toMatchObject({ given: 20_000, remaining: 100_000 });
    await expect(gift(100, 'nope')).rejects.toThrow('details.gift.pledgeId names no open pledge');
    await donations.cancelPledge(actor(), p.id, 'donor moved away');
    await expect(gift(100, p.id)).rejects.toThrow('names no open pledge');
    expect(await donations.listPledges(actor())).toEqual([]);
  });

  test('a pledge needs an open fund and a sensible schedule and dates', async () => {
    await expect(donations.createPledge(actor(), { donorName: 'Pat', amount: 100, fundId: 'nope', startDate: '2026-01-01' })).rejects.toThrow('fundId: unknown fund');
    await expect(donations.createPledge(actor(), { donorName: 'Pat', amount: 100, fundId, startDate: '2026-02-01', endDate: '2026-01-01' })).rejects.toThrow('endDate cannot be before startDate');
    await expect(donations.createPledge(actor(), { donorName: 'Pat', amount: 100, fundId, startDate: '2026-01-01', schedule: 'weekly' })).rejects.toThrow('schedule must be one of');
  });

  test('the forms offer open pledges with what is left', async () => {
    const p = await donations.createPledge(actor(), { donorName: 'Pat Lee', amount: 50_000, fundId, startDate: '2026-01-01' });
    await gift(20_000, p.id);
    expect(await donations.toFormOptions({ list: 'open-pledges' }, { username: 'tess', granted: ALL })).toEqual([
      { value: p.id, amount: 30_000, label: 'Pat Lee · $500.00 pledged · $300.00 left' }
    ]);
    expect(await donations.toFormOptions({ list: 'open-pledges' }, { username: 'x', granted: [] })).toEqual([]);
  });
});
