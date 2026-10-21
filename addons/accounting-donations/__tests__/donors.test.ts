/**
 * Donors are core's contacts (ngdpbase #1930): persons and organizations,
 * reached through their doors with the caller's context. A gift keeps the
 * donor's name as well as the @id, since a deleted account deletes its person.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAddonHost, openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import DonationManager, { type DonationsDb } from '../managers/DonationManager.js';
import { DONATIONS_LEDGER_TABLE, DONATIONS_MIGRATIONS } from '../managers/migrations.js';
import { giftValidator } from '../gift.js';
import { giftFromForm } from '../forms.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const host = buildAddonHost('accounting-donations', defaults);

class ContactRefusedError extends Error {
  constructor(public readonly permission: string) { super(`refused: ${permission}`); this.name = 'ContactRefusedError'; }
}

/** Core's doors, as the tests need them: each call takes the caller's context first and asks its permission. */
function fakeContacts() {
  const people = new Map<string, Record<string, unknown>>();
  const orgs = new Map<string, Record<string, unknown>>();
  const may = (ctx: unknown, perm: string) => { if (!(ctx as { granted?: string[] } | null)?.granted?.includes(perm)) throw new ContactRefusedError(perm); };
  let n = 0;
  const door = (store: Map<string, Record<string, unknown>>) => ({
    list: async (ctx: unknown) => { may(ctx, 'contact-read'); return [...store.values()]; },
    get: async (ctx: unknown, id: string) => { may(ctx, 'contact-read'); return store.get(id) ?? null; },
    create: async (ctx: unknown, input: Record<string, unknown>) => { may(ctx, 'contact-manage'); const rec = { ...input, '@id': `urn:uuid:${++n}` }; store.set(rec['@id'], rec); return rec; }
  });
  return { persons: door(people), organizations: door(orgs), people, orgs };
}

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'fund-manage', 'donation-record', 'contact-read', 'contact-manage'];
const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess', granted } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

describe('donors', () => {
  let ledgerDb: { handle: unknown; close(): void };
  let ownDb: DonationsDb & { close(): void };
  let ledger: LedgerManager;
  let donations: DonationManager;
  let contacts: ReturnType<typeof fakeContacts>;

  beforeEach(async () => {
    ledgerDb = openTestLedgerDatabase();
    ownDb = openAddonTestDatabase<DonationsDb & { close(): void }>('accounting-donations',
      { migrations: DONATIONS_MIGRATIONS as never, ledgerTable: DONATIONS_LEDGER_TABLE }, { slug: 'accounting-donations', defaults });
    contacts = fakeContacts();
    ledger = new LedgerManager({ ...testLedgerParts, db: ledgerDb.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(), decide });
    donations = new DonationManager({ host, db: ownDb, ledger: ledger as never, decide, categories: () => ['4200'], formatMoney: String,
      recordAudit: async () => undefined, contacts: () => contacts as never });
    ledger.registerLineDetails('gift', giftValidator({ categories: () => ['4200'], quidProQuo: () => '', formatMoney: String }));
  });

  afterEach(() => { ledgerDb.close(); ownDb.close(); });

  test('a new donor is a person or an organization in core\'s contacts; a person can give on behalf of one', async () => {
    const acme = await donations.addDonor(actor(), { type: 'organization', name: 'Acme Corp', email: 'give@acme.example' });
    expect(acme).toEqual({ type: 'organization', id: 'urn:uuid:1', name: 'Acme Corp' });
    const jane = await donations.addDonor(actor(), { type: 'person', givenName: 'Jane', familyName: 'Roe', email: 'jane@example.com',
      streetAddress: '1 Main St', addressLocality: 'Columbus', addressRegion: 'OH', postalCode: '43215', organization: `organization|${acme.id}`, role: 'Treasurer' });
    expect(jane).toMatchObject({ type: 'person', name: 'Jane Roe' });
    expect(contacts.people.get(jane.id)).toMatchObject({ affiliation: [{ organization: acme.id, role: 'Treasurer' }],
      address: { '@type': 'PostalAddress', streetAddress: '1 Main St', postalCode: '43215' } });
    await expect(donations.addDonor(actor(['contact-read']), { type: 'organization', name: 'X' })).rejects.toMatchObject({ name: 'ContactRefusedError', permission: 'contact-manage' });
    await expect(donations.addDonor(actor(), { type: 'person', givenName: 'Only' })).rejects.toThrow('familyName is required');
  });

  test('the donor list offers people and organizations to a viewer who may read contacts, and nothing otherwise', async () => {
    await donations.addDonor(actor(), { type: 'organization', name: 'Acme Corp' });
    await donations.addDonor(actor(), { type: 'person', givenName: 'Jane', familyName: 'Roe', email: 'jane@example.com' });
    expect(await donations.toFormOptions({ list: 'donors' }, { username: 'tess', granted: ALL })).toEqual([
      { value: 'organization|urn:uuid:1', label: 'Acme Corp (organization)' },
      { value: 'person|urn:uuid:2', label: 'Jane Roe · jane@example.com' }
    ]);
    expect(await donations.toFormOptions({ list: 'organizations' }, { username: 'tess', granted: ALL })).toHaveLength(1);
    expect(await donations.toFormOptions({ list: 'donors' }, { username: 'board', granted: ['ledger-read'] })).toEqual([]);
  });

  test('a gift keeps its donor\'s id and name; a donor deleted since is refused on a new gift', async () => {
    const jane = await donations.addDonor(actor(), { type: 'person', givenName: 'Jane', familyName: 'Roe' });
    const fundId = (await ledger.createFund(actor(), { name: 'General' })).id;
    const donor = await donations.donor(actor(), `person|${jane.id}`);
    const receipt = await ledger.postReceipt(actor(), giftFromForm({ amount: 5_000, date: '2026-10-21', fundId, category: '4200', paymentMethod: '20', memo: 'gift' }, donor) as never, { provider: 'manual' });
    expect(receipt).toMatchObject({ partyName: 'Jane Roe', partyPersonId: jane.id });
    expect(receipt.lines[0].details.gift.donor).toEqual({ type: 'person', id: jane.id, name: 'Jane Roe' });
    contacts.people.delete(jane.id);
    await expect(donations.donor(actor(), `person|${jane.id}`)).rejects.toThrow('donor: this donor no longer exists');
    expect((await ledger.getDocument(actor(), receipt.id)).partyName).toBe('Jane Roe');
    await expect(donations.donor(actor(), 'nobody')).rejects.toThrow('donor: not a donor from the list');
  });
});
