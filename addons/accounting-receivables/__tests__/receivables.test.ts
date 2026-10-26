/**
 * Invoices (D-035), in the receivables add-on's own database, outside the ledger:
 * each month evaluated on its own, payments as receipt lines with `receivable`
 * details, prepayment as credit, late charges proposed and added only when
 * asked. Money goes through the accounting add-on's ledger.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAddonHost, openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import ReceivablesManager, { type AccountSource, type BillingSource, type ReceivablesDb, type IdentitySource } from '../managers/ReceivablesManager.js';
import { RECEIVABLES_LEDGER_TABLE, RECEIVABLES_MIGRATIONS } from '../managers/migrations.js';
import { receivableValidator, RETIRED_KIND, retiredKind } from '../billing.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const host = buildAddonHost('accounting-receivables', defaults);

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

/** Owners as core's identity records: Sam has no email. */
const PEOPLE: Record<string, { name: string; email?: string }> = {
  'urn:pat': { name: 'Pat Lee', email: 'pat@example.org' }, 'urn:sam': { name: 'Sam Lee' }, 'urn:jo': { name: 'Jo Park', email: 'jo@example.org' }
};
const identities: IdentitySource = {
  getById: async (_ctx, id) => (PEOPLE[id] ? { '@id': id, ...PEOPLE[id] } : null),
  getByUserIdentifier: async (_ctx, username) => ({ '@id': `urn:${username}` })
};

/**
 * Accommodation's billing (ngdpbase#2042): where each unit's invoices go, and its owners by @id and share.
 * P-1 is Pat and Sam's at one address, unless a test splits it 60/40 over two addresses, or gives it no
 * billing address. Who owns what today is `owning`; the dates asked are kept.
 */
const billingAsked: (string | undefined)[] = [];
let p1: 'joint' | 'split' | 'no-address' = 'joint';
let owning: Record<string, string[]> = {};
const residents: BillingSource = {
  billing: async (_ctx, id, options) => {
    billingAsked.push(options?.on);
    if (id === 'P-2') return { period: { id: 'period-P-2-jo', from: '2020-01-01' }, billing: [{ address: 'Jo Park\n2 Fairway Dr', share: 100 }], owners: [{ '@id': 'urn:jo', share: 100 }] };
    if (p1 === 'no-address') throw new Error('unit P-1: no billing address; an owner or the treasurer sets one');
    const holders = Object.keys(owning).filter(u => owning[u]!.includes('P-1')).sort();
    const owners = holders.map(u => ({ '@id': `urn:${u}`, share: 100 / holders.length }));
    // The ownership period changes when the owners change (D-048).
    const period = { id: `period-P-1-${holders.join('-')}`, from: holders.includes('kim') ? '2026-09-15' : '2020-01-01' };
    return p1 === 'joint'
      ? { period, billing: [{ address: 'Pat Lee & Sam Lee\n1 Fairway Dr\nMount Vernon, OH 43050', share: 100 }], owners }
      : { period, billing: [{ address: 'Pat Lee\n1 Fairway Dr', share: 60 }, { address: 'Sam Lee\n9 Elm St', share: 40 }], owners };
  },
  ownUnits: async (ctx) => (owning[(ctx as { username: string }).username] ?? []).map(id => ({ id, as: ['owner'] }))
};

describe('dues', () => {
  let ledgerDb: { handle: unknown; close(): void };
  let ownDb: ReceivablesDb & { close(): void };
  let ledger: LedgerManager;
  let dues: ReceivablesManager;
  let audit: Record<string, unknown>[];
  let sent: { ctx: unknown; to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[];
  let pdfMode: 'none' | 'unavailable' | 'made';
  let notices: { title: string; message: string }[];
  let fundId: string;
  let today: string;
  let bumps: number;
  let sending: boolean;

  beforeEach(async () => {
    ledgerDb = openTestLedgerDatabase();
    ownDb = openAddonTestDatabase<ReceivablesDb & { close(): void }>('accounting-receivables',
      { migrations: RECEIVABLES_MIGRATIONS as never, ledgerTable: RECEIVABLES_LEDGER_TABLE }, { slug: 'accounting-receivables', defaults });
    audit = [];
    sent = [];
    bumps = 0;
    sending = true;
    pdfMode = 'none';
    notices = [];
    billingAsked.length = 0;
    p1 = 'joint';
    owning = { pat: ['P-1'], sam: ['P-1'], jo: ['P-2'] };
    today = '2026-09-01';
    ledger = new LedgerManager({ ...testLedgerParts, db: ledgerDb.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(), decide });
    let receivableLines: { lines(): { amount: number; details: Record<string, unknown> }[] } | null = null;
    let retiredLines: { lines(): { amount: number; details: Record<string, unknown> }[] } | null = null;
    dues = new ReceivablesManager({
      host, db: ownDb, ledger: ledger as never, decide, payments: () => [...(receivableLines?.lines() ?? []), ...(retiredLines?.lines() ?? [])], accounts: () => units, billing: () => residents, identities: () => identities, categories: () => ['4100'],
      label: () => ({ singular: 'Assessment', plural: 'Assessments' }), formatMoney: (m) => `$${(m / 100).toFixed(2)}`,
      recordAudit: async (r) => { audit.push(r); }, changed: async () => { bumps++; }, now: () => new Date(`${today}T12:00:00Z`),
      email: () => ({ sendTo: async (ctx: unknown, to: string, subject: string, _text: string, _html?: string, options?: { attachments?: { filename: string; contentType: string; content: Buffer }[] }) => {
        sent.push({ ctx, to, subject, attachments: options?.attachments }); } }), sendToOwners: () => sending, notifyIssuers: async (title: string, message: string) => { notices.push({ title, message }); },
      pdf: () => (pdfMode === 'none' ? null : { htmlToPdf: async () => {
        if (pdfMode === 'unavailable') throw Object.assign(new Error('no PDF provider'), { code: 'PDF_UNAVAILABLE' });
        return Buffer.from('%PDF-invoice');
      } })
    });
    receivableLines = ledger.registerLineDetails('receivable', receivableValidator({ categories: () => ['4100'], accountExists: (id) => dues.accountExists(id), invoiceOf: (id) => dues.invoiceOf(id),
      assignedFolioId: (account) => dues.assignedFolioId(account), folioOfAccount: (account, folio) => dues.folioOfAccount(account, folio) }));
    retiredLines = ledger.registerLineDetails(RETIRED_KIND, retiredKind);
    fundId = (await ledger.createFund(actor(), { name: 'Operating' })).id;
  });

  afterEach(() => { ledgerDb.close(); ownDb.close(); });

  const pay = (account: string, amount: number, date: string, invoiceId?: string) => ledger.postReceipt(actor(), {
    date, partyName: account, paymentMethod: '20', memo: 'assessment',
    lines: [{ amount, fundId, category: '4100', details: { receivable: { account, invoiceId } } }]
  }, { provider: 'manual' });

  test('each month is evaluated on its own; an account is invoiced once a month', async () => {
    expect((await dues.prepareMonth(actor(), '2026-09')).map(r => [r.label, r.owed, r.invoiced])).toEqual([['1', 41000, null], ['2', 30000, null]]);
    expect(await dues.issueMonth(actor(), { month: '2026-09', email: true })).toEqual({ issued: 2, emailed: 2, notEmailed: [], held: false, skipped: [] });
    expect(sent.map(s => s.to)).toEqual(['pat@example.org', 'jo@example.org']);
    const [two, one] = await dues.listInvoices(actor());
    expect([one!.number, two!.number]).toEqual(['I-0001', 'I-0002']);
    expect(one).toMatchObject({ accountId: 'P-1', month: '2026-09', dueDate: '2026-09-01', total: 41000, owed: 41000, remaining: 41000, emailedTo: 'pat@example.org' });
    // Where it went as typed, and the owners by @id and share; no names are copied onto it (D-047).
    expect(one).toMatchObject({ party: 'entry-1', partyName: 'Pat Lee & Sam Lee', billingAddress: 'Pat Lee & Sam Lee\n1 Fairway Dr\nMount Vernon, OH 43050',
      ownerIds: [{ '@id': 'urn:pat', share: 50 }, { '@id': 'urn:sam', share: 50 }], owners: [] });
    expect(one!.html).toContain('Pat Lee &amp; Sam Lee<br>1 Fairway Dr<br>Mount Vernon, OH 43050');
    // Billing is the unit's on the charge's due date.
    expect(new Set(billingAsked)).toEqual(new Set(['2026-09-01']));
    expect(audit.at(-1)).toMatchObject({ action: 'invoice-issue', resource: 'invoices:2026-09' });
    expect(bumps).toBe(1);
    // Once invoiced, the month shows the invoice's own figures.
    expect((await dues.prepareMonth(actor(), '2026-09')).map(r => [r.previous, r.owed, r.invoiced])).toEqual([[0, 41000, 'I-0001'], [0, 30000, 'I-0002']]);
    expect((await dues.issueMonth(actor(), { month: '2026-09' })).issued).toBe(0);
    expect(bumps).toBe(1);
    expect((await ledger.fundBalances(actor()))[0]!.balance).toBe(0);
    expect(() => ownDb.prepare('DELETE FROM accounting_receivables_invoices').run()).toThrow(/never deleted/);
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
    expect(await dues.issueMonth(actor(), { month: '2026-10', email: true })).toEqual({ issued: 2, emailed: 1, notEmailed: [], held: false, skipped: [] });
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
    expect(await dues.issueMonth(actor(), { month: '2026-09', email: true })).toEqual({ issued: 2, emailed: 0, notEmailed: [], held: true, skipped: [] });
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

  test('a payment line names an account, in one of its categories, and only its own invoices', async () => {
    await dues.issueMonth(actor(), { month: '2026-09' });
    const [p2inv] = await dues.listInvoices(actor(), { accountId: 'P-2' });
    await expect(pay('P-9', 100, '2026-09-03')).rejects.toThrow('details.receivable.account names no account');
    await expect(pay('P-1', 100, '2026-09-03', p2inv!.id)).rejects.toThrow('an invoice of another account');
    await expect(ledger.postReceipt(actor(), { date: '2026-09-03', partyName: 'x', paymentMethod: '20', memo: 'x',
      lines: [{ amount: 100, fundId, category: '4200', details: { receivable: { account: 'P-1' } } }] }, { provider: 'manual' })).rejects.toThrow('not a category these payments may use');
    expect((await dues.toFormOptions({ list: 'open-invoices' }, { username: 'tess', granted: ALL })).map(o => o.label))
      .toEqual(['I-0002 · 2 · Jo Park · 2026-09 · $300.00 left', 'I-0001 · 1 · Pat Lee & Sam Lee · 2026-09 · $410.00 left']);
    expect(await dues.toFormOptions({ list: 'open-invoices' }, { username: 'x', granted: [] })).toEqual([]);
  });

  test('one invoice per billing address for its share; one balance for the unit, whoever pays (D-047)', async () => {
    p1 = 'split';
    expect((await dues.prepareMonth(actor(), '2026-09')).filter(r => r.accountId === 'P-1').map(r => [r.party, r.partyName, r.charge?.amount, r.owed]))
      .toEqual([['entry-1', 'Pat Lee', 24600, 24600], ['entry-2', 'Sam Lee', 16400, 16400]]);
    // Each invoice is emailed to every owner with an email (Sam has none): owners owe the unit jointly.
    expect(await dues.issueMonth(actor(), { month: '2026-09', account: 'P-1', email: true })).toEqual({ issued: 2, emailed: 2, notEmailed: [], held: false, skipped: [] });
    expect(sent.map(m => m.to)).toEqual(['pat@example.org', 'pat@example.org']);
    const [first, second] = (await dues.listInvoices(actor(), { accountId: 'P-1' })).sort((a, b) => a.number.localeCompare(b.number));
    expect([first!.total, second!.total]).toEqual([24600, 16400]);
    expect(second!.html).toContain('Sam Lee<br>9 Elm St');
    // A payment names only the unit: it settles the unit's oldest invoice, then the next.
    await pay('P-1', 30000, '2026-09-03');
    expect((await dues.listInvoices(actor(), { accountId: 'P-1' })).sort((a, b) => a.number.localeCompare(b.number)).map(i => i.remaining)).toEqual([0, 11000]);
    // October: the unit's balance brought forward is split by the entries' shares; late charges go on the first.
    today = '2026-10-01';
    expect((await dues.prepareMonth(actor(), '2026-10')).filter(r => r.accountId === 'P-1').map(r => [r.party, r.previous, r.lateCharges.length]))
      .toEqual([['entry-1', 6600, 1], ['entry-2', 4400, 0]]);
    expect((await dues.balances(actor())).find(b => b.accountId === 'P-1')!.balance).toBe(24600 + 16400 - 30000);
  });

  test('a unit with no billing address is never invoiced to a guessed one: skipped, and named (D-047)', async () => {
    p1 = 'no-address';
    const rows = await dues.prepareMonth(actor(), '2026-09');
    expect(rows.find(r => r.accountId === 'P-1')).toMatchObject({ problem: 'unit P-1: no billing address; an owner or the treasurer sets one', invoiced: null });
    expect(await dues.issueMonth(actor(), { month: '2026-09' })).toMatchObject({ issued: 1, skipped: ['1: unit P-1: no billing address; an owner or the treasurer sets one'] });
    await expect(dues.issueMonth(actor(), { month: '2026-09', account: 'P-1' })).rejects.toThrow('nothing to invoice');
    expect((await dues.listInvoices(actor(), { accountId: 'P-1' }))).toEqual([]);
  });

  test("a change of owners starts a new folio; the earlier owners' folio keeps its balance, and each owner sees their own (D-048)", async () => {
    p1 = 'split';
    await dues.issueMonth(actor(), { month: '2026-09' });
    // Someone pays, naming only the unit: it goes on the unit's current folio.
    await ledger.postReceipt(actor(), { date: '2026-09-03', partyName: 'Lee Lee', paymentMethod: '20', memo: 'assessment',
      lines: [{ amount: 10000, fundId, category: '4100', details: { receivable: { account: 'P-1' } } }] }, { provider: 'manual' });
    const person = (username: string, granted = ['ledger-self']) => ({ ...actor(granted), actingUsername: () => username, subject: { username, granted } as never });
    const [pat] = await dues.myAccounts(person('pat'));
    expect(pat).toMatchObject({ accountId: 'P-1', folio: 'P-1/F01', current: true, balance: 41000 - 10000 });
    expect(pat!.invoices.map(i => [i.billedTo, i.total, i.paid])).toEqual([['Sam Lee', 16400, 0], ['Pat Lee', 24600, 10000]]);
    expect((await dues.myAccounts(person('sam')))[0]!.invoices).toHaveLength(2);
    expect(await dues.myAccounts(person('kim'))).toEqual([]);
    // Sam sells to Kim: a new ownership period. Until its first invoice Kim sees none of the earlier owners' folio.
    owning = { pat: ['P-1'], kim: ['P-1'], jo: ['P-2'] };
    expect(await dues.myAccounts(person('kim'))).toEqual([]);
    today = '2026-10-01';
    const oct = (await dues.prepareMonth(actor(), '2026-10')).filter(r => r.accountId === 'P-1');
    // The new folio starts at $0 and takes no late charge from the old one; the old folio, still owing, gets
    // only its own late charge, to its last billing address.
    expect(oct.map(r => [r.folio, r.folioId === null, r.charge?.amount ?? null, r.previous, r.lateCharges.map(l => l.ruleId)])).toEqual([
      ['P-1/F01', false, null, 31000, ['late-10', 'late-10']], ['P-1/F02', true, 24600, 0, []], ['P-1/F02', true, 16400, 0, []]]);
    await dues.issueMonth(actor(), { month: '2026-10', account: 'P-1' });
    const folios = await dues.folios(actor(), { accountId: 'P-1' });
    expect(folios.map(f => [f.folio, f.assigned, f.open, f.balance])).toEqual([['P-1/F01', false, true, 31000], ['P-1/F02', true, true, 41000]]);
    // With late charges asked for, the old folio is invoiced its late charges only: no new assessment.
    await dues.issueMonth(actor(), { month: '2026-10', account: 'P-1', lateCharges: true });
    const lateOnly = (await dues.listInvoices(actor(), { accountId: 'P-1', month: '2026-10' })).find(i => i.folio === 'P-1/F01')!;
    expect(lateOnly.lines.map(l => l.kind)).toEqual(['late-charge', 'late-charge']);
    expect(lateOnly).toMatchObject({ total: 2000, previous: 31000 });
    const folioBalances = (await dues.folios(actor(), { accountId: 'P-1' })).map(f => f.balance);
    expect(folioBalances).toEqual([33000, 41000]);
    // Sam keeps seeing his folio, with what it still owes; Kim sees only the new one; Pat both.
    expect((await dues.myAccounts(person('sam'))).map(a => [a.folio, a.current, a.balance])).toEqual([['P-1/F01', false, 33000]]);
    expect((await dues.myAccounts(person('kim'))).map(a => [a.folio, a.current, a.balance])).toEqual([['P-1/F02', true, 41000]]);
    expect((await dues.myAccounts(person('pat'))).map(a => a.folio)).toEqual(['P-1/F01', 'P-1/F02']);
    // A payment naming only the unit now goes on the new folio; one on the old folio names it.
    await ledger.postReceipt(actor(), { date: '2026-10-02', partyName: 'Kim', paymentMethod: '20', memo: 'assessment',
      lines: [{ amount: 41000, fundId, category: '4100', details: { receivable: { account: 'P-1' } } }] }, { provider: 'manual' });
    await ledger.postReceipt(actor(), { date: '2026-10-03', partyName: 'Sam', paymentMethod: '20', memo: 'old debt',
      lines: [{ amount: 1000, fundId, category: '4100', details: { receivable: { account: 'P-1', folio: folios[0]!.id } } }] }, { provider: 'manual' });
    expect((await dues.folios(actor(), { accountId: 'P-1' })).map(f => [f.folio, f.balance])).toEqual([['P-1/F01', 32000], ['P-1/F02', 0]]);
    await expect(ledger.postReceipt(actor(), { date: '2026-10-03', partyName: 'x', paymentMethod: '20', memo: 'x',
      lines: [{ amount: 100, fundId, category: '4100', details: { receivable: { account: 'P-2', folio: folios[0]!.id } } }] }, { provider: 'manual' })).rejects.toThrow('not a folio of that account');
    // The unit's total is its folios added together; the board reads every folio under account-read.
    expect((await dues.balances(actor())).find(b => b.accountId === 'P-1')!.balance).toBe(32000);
    expect((await dues.folios(person('board', ['account-read']))).length).toBe(3);
    await expect(dues.myInvoice(person('kim'), pat!.invoices[0]!.id)).rejects.toThrow('unknown invoice');
    await expect(dues.listInvoices(person('pat'))).rejects.toThrow('refused: ledger-read');
  });

  test('a folio takes a balance brought forward (once), write-offs and liens; each is voided to correct, and a lien leaves the balance (D-048)', async () => {
    await dues.issueMonth(actor(), { month: '2026-09', account: 'P-2' });
    const [f] = await dues.folios(actor(), { accountId: 'P-2' });
    expect(f).toMatchObject({ folio: 'P-2/F01', balance: 30000 });
    const opened = await dues.setOpeningBalance(actor(), { folio: f!.id, amount: 5000, date: '2026-08-31', reason: 'From the old spreadsheet' });
    expect(opened.balance).toBe(35000);
    await expect(dues.setOpeningBalance(actor(), { folio: f!.id, amount: 100, date: '2026-08-31', reason: 'again' })).rejects.toThrow('already has a balance brought forward');
    expect((await dues.writeOff(actor(), { folio: f!.id, amount: 2000, date: '2026-10-01', reason: 'Board forgave the fee' })).balance).toBe(33000);
    const liened = await dues.fileLien(actor(), { folio: f!.id, amount: 33000, date: '2026-10-05', reference: 'Knox County 2026-012345' });
    expect(liened.balance).toBe(33000);
    expect(liened.items.map(i => [i.kind, i.amount, i.reference])).toEqual([['opening', 5000, null], ['write-off', 2000, null], ['lien', 33000, 'Knox County 2026-012345']]);
    await expect(dues.fileLien(actor(), { folio: f!.id, amount: 100, date: '2026-10-05', reference: '' })).rejects.toThrow('reference is required');
    const writeOff = liened.items.find(i => i.kind === 'write-off')!;
    expect((await dues.voidFolioItem(actor(), writeOff.id, 'entered on the wrong folio')).balance).toBe(35000);
    await expect(dues.voidFolioItem(actor(), writeOff.id, 'twice')).rejects.toThrow('already voided');
    // A credit brought forward settles like a payment.
    const opening = (await dues.folios(actor(), { accountId: 'P-2' }))[0]!.items.find(i => i.kind === 'opening')!;
    await dues.voidFolioItem(actor(), opening.id, 'wrong sign');
    expect((await dues.setOpeningBalance(actor(), { folio: f!.id, amount: -5000, date: '2026-08-31', reason: 'Paid ahead' })).balance).toBe(25000);
    await expect(dues.writeOff(actor(['ledger-read']), { folio: f!.id, amount: 1, date: '2026-10-01', reason: 'x' })).rejects.toThrow('refused: invoice-issue');
    expect(audit.filter(a => String(a.action).startsWith('folio-')).map(a => a.action)).toEqual(['folio-opening', 'folio-write-off', 'folio-lien', 'folio-item-void', 'folio-item-void', 'folio-opening']);
  });

  test('an invoice is emailed as the caller, with its PDF attached when the site makes PDFs, else the page alone (#51)', async () => {
    pdfMode = 'unavailable';
    await dues.issueMonth(actor(), { month: '2026-09', account: 'P-2', email: true });
    expect(sent.map(s => [s.to, s.attachments])).toEqual([['jo@example.org', undefined]]);
    expect((sent[0]!.ctx as { username: string }).username).toBe('tess');
    expect((await dues.listInvoices(actor(), { accountId: 'P-2' }))[0]!.pdfSha256).toBeNull();
    pdfMode = 'made';
    await dues.issueMonth(actor(), { month: '2026-09', account: 'P-1', email: true });
    expect(sent.at(-1)!.attachments?.map(a => [a.filename, a.content.toString()])).toEqual([['Invoice I-0002.pdf', '%PDF-invoice']]);
    expect((await dues.listInvoices(actor(), { accountId: 'P-1' }))[0]!.pdfSha256).toBe(createHash('sha256').update('%PDF-invoice').digest('hex'));
  });

  test('the scheduled run issues the month with late charges and email; run again it changes nothing; while held, the issuers are told (D-035, #11)', async () => {
    sending = false;
    expect(await dues.scheduledRun(actor(), '2026-09')).toEqual({ success: true, summary: '2026-09: 2 issued, nothing sent to owners: sending to owners is off on this site' });
    expect(sent).toEqual([]);
    expect(notices).toEqual([{ title: 'Invoices issued for 2026-09', message: '2026-09: 2 issued, nothing sent to owners: sending to owners is off on this site' }]);
    // A retry or a rerun of the same slot: nothing issued twice, nobody told again.
    expect((await dues.scheduledRun(actor(), '2026-09')).summary).toBe('2026-09: 0 issued, nothing sent to owners: sending to owners is off on this site');
    expect(notices).toHaveLength(1);
    // Late charges are included: October's run adds September's unpaid late charge.
    sending = true;
    today = '2026-10-15';
    expect((await dues.scheduledRun(actor(), '2026-10')).summary).toBe('2026-10: 2 issued, 2 emailed');
    expect((await dues.listInvoices(actor(), { accountId: 'P-1', month: '2026-10' }))[0]!.lines.map(l => l.kind)).toEqual(['charge', 'late-charge']);
    expect(notices).toHaveLength(1);
    await expect(dues.scheduledRun(actor(['ledger-read']), '2026-11')).rejects.toThrow('refused: invoice-issue');
  });

  test('the scheduled run names every unit it could not invoice, in its result and to the issuers, even while sending is on (D-047)', async () => {
    p1 = 'no-address';
    const { summary } = await dues.scheduledRun(actor(), '2026-09');
    expect(summary).toBe('2026-09: 1 issued, 1 emailed; not invoiced: 1: unit P-1: no billing address; an owner or the treasurer sets one');
    expect(notices).toEqual([{ title: 'Invoices issued for 2026-09', message: summary }]);
  });

  test("payments recorded under the add-on's old name still count, as they are; no new one may use it (ngdpbase#2042)", async () => {
    await dues.issueMonth(actor(), { month: '2026-09', account: 'P-2' });
    // A payment from before the rename: its line carries details of kind `dues`, stored as written.
    const old = await ledger.postReceipt(actor(), { date: '2026-09-02', partyName: 'Jo Park', paymentMethod: '20', memo: 'assessment',
      lines: [{ amount: 30000, fundId, category: '4100' }] }, { provider: 'manual' });
    (ledgerDb.handle as { prepare(sql: string): { run(...p: unknown[]): unknown } }).prepare('INSERT INTO accounting_line_details (line_id, kind, data) VALUES (?, ?, ?)')
      .run(old.lines[0]!.id, 'dues', JSON.stringify({ account: 'P-2', invoiceId: null }));
    expect((await dues.balances(actor())).find(b => b.accountId === 'P-2')!.balance).toBe(0);
    await expect(ledger.postReceipt(actor(), { date: '2026-09-03', partyName: 'x', paymentMethod: '20', memo: 'x',
      lines: [{ amount: 100, fundId, category: '4100', details: { dues: { account: 'P-2' } } }] }, { provider: 'manual' })).rejects.toThrow('payments are recorded as details.receivable now');
  });

  test('the tables carry the new name; none keeps the old one (ngdpbase#2042)', () => {
    const tables = (ownDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(t => t.name);
    expect(tables.filter(t => t.startsWith('accounting_'))).toEqual(['accounting_receivables_folio_items', 'accounting_receivables_folios', 'accounting_receivables_invoice_lines', 'accounting_receivables_invoices', 'accounting_receivables_schema_migrations', 'accounting_receivables_sequence']);
  });
});
