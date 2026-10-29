/**
 * The executive role (ngdpbase#2094, D-050): this add-on declares no read
 * permission of its own (its reads ask the accounting add-on's ledger-read, which
 * accounting grants the role), and the donations card on core's Executive Hub.
 * Money goes through the accounting add-on's ledger, in memory.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAddonHost, openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import DonationManager, { type DonationsDb } from '../managers/DonationManager.js';
import { DONATIONS_LEDGER_TABLE, DONATIONS_MIGRATIONS } from '../managers/migrations.js';
import { donationValidator } from '../donation.js';
import { DONATION_FORM } from '../forms.js';
import { donationsExecutiveCard, registerExecutiveCard } from '../executive.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const accountingDefaults = JSON.parse(readFileSync(new URL('../../accounting/config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const host = buildAddonHost('accounting-donations', defaults);
type Policy = { id: string; subjects: { type: string; value: string }[]; actions: string[] };

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'receipt-refund', 'fund-manage', 'donation-record'];
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess', granted } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});
const money = (m: number) => `$${(m / 100).toFixed(2)}`;

describe('the executive role', () => {
  test('is granted nothing here: the reads ask accounting\'s ledger-read, which accounting\'s policy grants it', () => {
    const own = (defaults['ngdpbase.access.policies'] as Policy[]).filter(p => p.subjects.some(s => s.value === 'executive'));
    expect(own).toEqual([]);
    const accounting = (accountingDefaults['ngdpbase.access.policies'] as Policy[]).find(p => p.id === 'accounting-executive')!;
    expect(accounting.actions).toContain('ledger-read');
    for (const write of ['donation-record', 'statement-issue']) expect(accounting.actions).not.toContain(write);
  });

  test("the form's Anonymous box promises what is kept: anonymous to the public, not to the board (operator, 2026-10-29)", () => {
    const box = DONATION_FORM.fields.find(f => f.name === 'anonymous')!;
    expect(box.label).toBe("Anonymous: don't show my name publicly; the board and treasurer will still see it");
  });

  test('the top-donors setting ships as 3', () => {
    expect(defaults['ngdpbase.addons.accounting-donations.executive-top-donors']).toBe(3);
  });
});

describe('the Executive Hub card', () => {
  let ledgerDb: { handle: unknown; close(): void };
  let ownDb: DonationsDb & { close(): void };
  let ledger: LedgerManager;
  let donations: DonationManager;
  let fundId: string;
  let top: number;

  beforeEach(async () => {
    ledgerDb = openTestLedgerDatabase();
    ownDb = openAddonTestDatabase<DonationsDb & { close(): void }>('accounting-donations',
      { migrations: DONATIONS_MIGRATIONS as never, ledgerTable: DONATIONS_LEDGER_TABLE }, { slug: 'accounting-donations', defaults });
    ledger = new LedgerManager({ ...testLedgerParts, db: ledgerDb.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(), decide });
    top = 2;
    let lines: ReturnType<LedgerManager['registerLineDetails']> | null = null;
    donations = new DonationManager({ host, db: ownDb, ledger: ledger as never, decide, categories: () => ['4200'], formatMoney: money,
      recordAudit: async () => undefined, donationLines: (range) => lines?.lines(range) ?? [], topDonors: () => top });
    lines = ledger.registerLineDetails('donation', donationValidator({ categories: () => ['4200'], quidProQuo: () => '', formatMoney: String, pledgeIsOpen: (id) => donations.pledgeIsOpen(id) }));
    fundId = (await ledger.createFund(actor(), { name: 'Building', openingDate: '2025-01-01' })).id;
  });

  afterEach(() => { ledgerDb.close(); ownDb.close(); });

  const give = (amount: number, date: string, donor: { id: string; name: string } | null, anonymous = false) => ledger.postReceipt(actor(), {
    date, partyName: donor?.name ?? 'Collection plate', paymentMethod: '10', memo: 'donation',
    lines: [{ amount, fundId, category: '4200', details: { donation: { donor: donor ? { type: 'person', ...donor } : null, anonymous } } }]
  }, { provider: 'manual' });
  const pat = { id: 'urn:pat', name: 'Pat Lee' };
  const jo = { id: 'urn:jo', name: 'Jo Park' };
  const kim = { id: 'urn:kim', name: 'Kim Ito' };

  test("shows this year's donations, the donors, and the largest donors by name; anonymous gifts are counted, never named", async () => {
    const card = donationsExecutiveCard(donations, money, () => 2026);
    expect(card).toMatchObject({ addonName: 'accounting-donations', surface: 'executive', permission: 'ledger-read', adminUrl: '/view/donation-statements' });
    await give(90_000, '2025-12-31', kim); // last year
    await give(10_000, '2026-01-15', pat);
    await give(15_000, '2026-06-01', pat);
    const joGift = await give(30_000, '2026-03-01', jo);
    await ledger.refundReceipt(actor(), joGift.id, { amount: 10_000, date: '2026-03-10', memo: 'part back' });
    await give(5_000, '2026-04-01', kim);
    await give(2_500, '2026-05-01', null); // the collection plate
    await give(99_000, '2026-07-01', { id: 'urn:quiet', name: 'Quinn Quiet' }, true); // recorded as anonymous
    await donations.recordInKind(actor(), { donorName: 'Pat Lee', date: '2026-02-01', description: 'Chairs' });
    await donations.recordInKind(actor(), { donorName: 'Pat Lee', date: '2025-02-01', description: 'Tables' });

    const s = await card.summary({ username: 'bea', granted: ['ledger-read'] } as never);
    expect(s.figures).toEqual([
      { label: 'Donations in 2026', value: '$1515.00' },
      { label: 'Gifts', value: 6 },
      { label: 'Donors', value: 3 },
      { label: 'In-kind donations', value: 1 },
      { label: 'Anonymous gifts', value: '2 ($1015.00)' }
    ]);
    expect(s.message).toBe('Largest donors: Pat Lee ($250.00), Jo Park ($200.00)');
    expect(s.message).not.toContain('Quinn');

    top = 0;
    expect((await card.summary({ username: 'bea', granted: ['ledger-read'] } as never)).message).toBe('');
    await expect(card.summary({ username: 'sam', granted: ['ledger-summary-read'] } as never)).rejects.toThrow('not permitted: ledger-read');
  });

  test('is registered only on a core with the hub', () => {
    const registered: unknown[] = [];
    const card = donationsExecutiveCard(donations, money, () => 2026);
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c) }, card)).toBe(false);
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c), executiveCardsFor: () => [] }, card)).toBe(true);
    expect(registered).toEqual([card]);
  });
});
