/**
 * Receipts: money coming in (D-028, D-029). Numbered R-0001 onwards and never
 * reused; all money in is a receipt; a mistake is voided and recorded again; a
 * refund is a linked out entry; every money movement says why.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openAddonTestDatabase } from '@jwilleke/ngdpbase-types/testing';
import { openTestLedgerDatabase, testLedgerParts } from './host.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';
import LedgerManager, { type LedgerActor, type LedgerAuditRecord, type LedgerDb, type NewReceipt } from '../managers/LedgerManager.js';
import ReceiptManager, { MANUAL_RECEIPT_PROVIDER, receiptProvidersFrom } from '../managers/ReceiptManager.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'fund-manage'];

class Refused extends Error {
  constructor(public readonly permission: string) { super(`refused: ${permission}`); }
}

const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });

const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: '203.0.113.7',
  subject: { username: 'treasurer-tess', roles: ['treasurer'], isAuthenticated: true, granted } as never,
  actingUsername: () => 'treasurer-tess',
  enforceDeny: (permission: string) => Promise.reject(new Refused(permission))
});

describe('receipts', () => {
  let provider: { handle: unknown; close(): void };
  let db: LedgerDb;
  let audit: LedgerAuditRecord[];
  let ledger: LedgerManager;
  let receipts: ReceiptManager;
  let fundId: string;

  const dues = (amount: number, extra: Partial<NewReceipt> = {}): NewReceipt =>
    ({ amount, date: '2026-10-18', fundId, category: '4100', partyName: 'Ann Lee', paymentMethod: '20', paymentMethodId: '1042', memo: 'October dues', ...extra });
  const balance = async () => (await ledger.fundBalances(actor()))[0].balance;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    db = provider.handle as LedgerDb;
    audit = [];
    ledger = new LedgerManager({ ...testLedgerParts, db, decide, currency: 'USD', recordAudit: (r) => { audit.push(r); return Promise.resolve(); } });
    receipts = new ReceiptManager(ledger, [MANUAL_RECEIPT_PROVIDER]);
    fundId = (await ledger.createFund(actor(), { name: 'General', openingBalance: 1_000 })).id;
    audit.length = 0;
  });

  afterEach(() => provider.close());

  describe('recording', () => {
    test('a receipt is money in, numbered R-0001 onwards, from the manual provider', async () => {
      const first = await receipts.recordReceipt(actor(), dues(5_000));
      const second = await receipts.recordReceipt(actor(), dues(2_500, { paymentMethod: '10', paymentMethodId: undefined }));
      expect(first).toMatchObject({ kind: 'receipt', total: 5_000, provider: 'manual', number: 'R-0001', paymentMethod: '20', paymentMethodId: '1042', partyName: 'Ann Lee', memo: 'October dues', reference: null });
      expect(first.lines).toMatchObject([{ amount: 5_000, fundId, category: '4100', memo: 'October dues', status: 'posted' }]);
      expect(second.number).toBe('R-0002');
      expect(await balance()).toBe(8_500);
      expect(audit.map(r => `${r.eventType}/${r.action}`)).toEqual(['ledger-record/receipt-record', 'ledger-record/receipt-record']);
    });

    test('numbers are never reused: a voided receipt keeps its number', async () => {
      const wrong = await receipts.recordReceipt(actor(), dues(50_000));
      await ledger.voidTransaction(actor(), wrong.id, 'typed 500.00 for 50.00');
      const again = await receipts.recordReceipt(actor(), dues(5_000));
      expect(again.number).toBe('R-0002');
      expect(await ledger.getDocument(actor(), wrong.id)).toMatchObject({ status: 'voided', number: 'R-0001', voidReason: 'typed 500.00 for 50.00' });
      expect((await ledger.getTransaction(actor(), wrong.lines[0].id)).status).toBe('voided');
    });

    test('the payer, the method and the reason are required', async () => {
      await expect(receipts.recordReceipt(actor(), dues(100, { partyName: '' }))).rejects.toThrow(/partyName is required/);
      await expect(receipts.recordReceipt(actor(), dues(100, { paymentMethod: '' }))).rejects.toThrow(/paymentMethod is required/);
      await expect(receipts.recordReceipt(actor(), dues(100, { memo: ' ' }))).rejects.toThrow(/memo is required/);
      await expect(receipts.recordReceipt(actor(), dues(100, { paymentMethod: 'cash' }))).rejects.toThrow(/UN\/CEFACT/);
    });

    test('what it pays for is kept when given, both parts or neither', async () => {
      const r = await receipts.recordReceipt(actor(), dues(100, { reference: { type: 'dues-invoice', id: 'inv-7' } }));
      expect(r.reference).toEqual({ type: 'dues-invoice', id: 'inv-7' });
      expect(await ledger.getTransaction(actor(), r.lines[0].id)).toMatchObject({ sourceType: 'dues-invoice', sourceId: 'inv-7' });
      await expect(receipts.recordReceipt(actor(), dues(100, { reference: { type: 'dues-invoice', id: '' } }))).rejects.toThrow(/both a type and an id/);
    });

    test('recording needs ledger-record, refused before anything is written', async () => {
      await expect(receipts.recordReceipt(actor(['ledger-read']), dues(100))).rejects.toMatchObject({ permission: 'ledger-record' });
      expect(audit).toEqual([]);
      expect(await balance()).toBe(1_000);
    });

    test('a provider receipt keeps its own number, and the same one never posts twice', async () => {
      const online = { provider: 'stripe', confirmationNumber: 'pi_123' };
      await ledger.postReceipt(actor(), dues(700), online);
      await expect(ledger.postReceipt(actor(), dues(700), online)).rejects.toThrow();
      await expect(ledger.postReceipt(actor(), dues(700), { provider: 'stripe' })).rejects.toThrow(/confirmationNumber is required/);
      expect(await balance()).toBe(1_700);
    });
  });

  describe('all money in is a receipt', () => {
    test('a plain in entry is refused; money out still is an entry, and needs a reason', async () => {
      await expect(ledger.postTransaction(actor(), { direction: 'in', amount: 100, date: '2026-10-18', fundId, category: '4100', memo: 'x' }))
        .rejects.toThrow(/recorded as a receipt/);
      await expect(ledger.postTransaction(actor(), { direction: 'out', amount: 100, date: '2026-10-18', fundId, category: '5200' }))
        .rejects.toThrow(/memo is required/);
      expect((await ledger.postTransaction(actor(), { direction: 'out', amount: 100, date: '2026-10-18', fundId, category: '5200', memo: 'stamps' })).direction).toBe('out');
    });

    test('a receipt is corrected by voiding it and recording it again, not by a replacement', async () => {
      const wrong = await receipts.recordReceipt(actor(), dues(100));
      await expect(ledger.voidTransaction(actor(), wrong.id, 'wrong amount', { direction: 'in', amount: 120, date: '2026-10-18', fundId, category: '4100', memo: 'dues' }))
        .rejects.toThrow(/voiding it and recording a new receipt/);
    });

    test('a transfer needs a reason too', async () => {
      const roof = await ledger.createFund(actor(), { name: 'Roof' });
      await expect(ledger.transferBetweenFunds(actor(), { fromFundId: fundId, toFundId: roof.id, amount: 100, date: '2026-10-18' })).rejects.toThrow(/memo is required/);
    });
  });

  describe('refunds', () => {
    test('a refund is an out entry linked to the receipt, in its fund and category; the receipt stays posted', async () => {
      const r = await receipts.recordReceipt(actor(), dues(5_000));
      const refund = await receipts.refundReceipt(actor(), r.id, { amount: 2_000, date: '2026-10-19', memo: 'paid twice' });
      expect(refund).toMatchObject({ kind: 'refund', number: 'RF-0001', receiptId: r.id, total: 2_000, partyName: 'Ann Lee', paymentMethod: '20', memo: 'paid twice' });
      expect(refund.lines).toMatchObject([{ amount: 2_000, fundId, category: '4100', receiptLineId: r.lines[0].id }]);
      expect(await ledger.getTransaction(actor(), refund.lines[0].id)).toMatchObject({ direction: 'out', sourceType: 'receipt-refund', sourceId: r.id, documentId: refund.id });
      expect((await ledger.getDocument(actor(), r.id)).status).toBe('posted');
      expect(await balance()).toBe(4_000);
      expect(audit.at(-1)).toMatchObject({ eventType: 'receipt-refund', action: 'receipt-refund', severity: 'high', resource: r.id, reason: 'paid twice', metadata: { receipt: 'R-0001', amount: 2_000 } });
    });

    test('partial refunds add up to at most the receipt; a blank amount refunds what is left', async () => {
      const r = await receipts.recordReceipt(actor(), dues(5_000));
      await receipts.refundReceipt(actor(), r.id, { amount: 3_000, date: '2026-10-19', memo: 'part' });
      await expect(receipts.refundReceipt(actor(), r.id, { amount: 2_500, date: '2026-10-19', memo: 'too much' })).rejects.toThrow(/more than is left to refund \(\$20\.00\)/);
      expect((await receipts.refundReceipt(actor(), r.id, { date: '2026-10-19', memo: 'the rest' })).total).toBe(2_000);
      await expect(receipts.refundReceipt(actor(), r.id, { date: '2026-10-19', memo: 'again' })).rejects.toThrow(/already fully refunded/);
    });

    test('only a posted receipt is refunded, with a reason', async () => {
      const r = await receipts.recordReceipt(actor(), dues(100));
      const out = await ledger.postTransaction(actor(), { direction: 'out', amount: 50, date: '2026-10-18', fundId, category: '5200', memo: 'stamps' });
      await expect(receipts.refundReceipt(actor(), out.id, { date: '2026-10-19', memo: 'x' })).rejects.toThrow(/only a receipt/);
      await expect(receipts.refundReceipt(actor(), r.id, { date: '2026-10-19', memo: '' })).rejects.toThrow(/memo is required/);
      await ledger.voidTransaction(actor(), r.id, 'entered twice');
      await expect(receipts.refundReceipt(actor(), r.id, { date: '2026-10-19', memo: 'x' })).rejects.toThrow(/is voided/);
    });

    test('a receipt with refunds is not voided until its refunds are', async () => {
      const r = await receipts.recordReceipt(actor(), dues(100));
      const refund = await receipts.refundReceipt(actor(), r.id, { date: '2026-10-19', memo: 'returned' });
      await expect(ledger.voidTransaction(actor(), r.id, 'wrong')).rejects.toThrow(/void the refunds first/);
      await ledger.voidTransaction(actor(), refund.id, 'refund was a mistake');
      await ledger.voidTransaction(actor(), r.id, 'wrong');
      expect(await balance()).toBe(1_000);
    });

    test('the refund form lists receipts for a reader of the ledger; refunding still needs receipt-refund', async () => {
      const r = await receipts.recordReceipt(actor(), dues(100));
      const reader = { username: 'board-bea', granted: ['ledger-read', 'ledger-summary-read'] };
      expect((await ledger.toFormOptions({ list: 'receipts' }, reader)).map(o => o.value)).toEqual([r.id]);
      expect(await ledger.toFormOptions({ list: 'receipts' }, { username: 'nobody', granted: [] })).toEqual([]);
    });

    test('refunding needs receipt-refund, refused before anything is written', async () => {
      const r = await receipts.recordReceipt(actor(), dues(100));
      audit.length = 0;
      await expect(receipts.refundReceipt(actor(ALL.filter(p => p !== 'receipt-refund')), r.id, { date: '2026-10-19', memo: 'x' }))
        .rejects.toMatchObject({ permission: 'receipt-refund' });
      expect(audit).toEqual([]);
    });
  });

  describe('lines (D-033)', () => {
    const repay = (extra: Partial<NewReceipt> = {}): NewReceipt => ({
      date: '2026-10-19', partyName: 'Pat Payer', paymentMethod: '20', paymentMethodId: '4471', memo: 'bounced check repaid',
      lines: [{ amount: 5_000, fundId, category: '4100' }, { amount: 1_500, fundId, category: '6100', memo: 'fee repaid' }, { amount: 1_000, fundId, category: '8900' }],
      ...extra
    });

    test('one receipt, one number, several lines, each counted in its own category', async () => {
      const r = await receipts.recordReceipt(actor(), repay());
      expect(r).toMatchObject({ number: 'R-0001', total: 7_500 });
      expect(r.lines.map(l => [l.amount, l.category, l.memo])).toEqual([[5_000, '4100', 'bounced check repaid'], [1_500, '6100', 'fee repaid'], [1_000, '8900', 'bounced check repaid']]);
      expect(await balance()).toBe(8_500);
      const summary = await ledger.periodSummary(actor(), ledger.period({ month: '2026-10' }));
      expect(summary.categories.map(c => [c.category, c.income])).toEqual([['4100', 5_000], ['6100', 1_500], ['8900', 1_000]]);
      expect(new Set(r.lines.map(l => l.id)).size).toBe(3);
    });

    test('lines can be in different funds; one payment lands in one account', async () => {
      const roof = await ledger.createFund(actor(), { name: 'Roof' });
      const r = await receipts.recordReceipt(actor(), repay({ lines: [{ amount: 5_000, fundId, category: '4100' }, { amount: 2_500, fundId: roof.id, category: '4200' }] }));
      const entries = await Promise.all(r.lines.map(l => ledger.getTransaction(actor(), l.id)));
      expect(entries.map(e => [e.fundId, e.accountId])).toEqual([[fundId, 'cash-on-hand'], [roof.id, 'cash-on-hand']]);
    });

    test('a refusal names the line it is about', async () => {
      await expect(receipts.recordReceipt(actor(), repay({ lines: [{ amount: 100, fundId, category: '4100' }, { amount: 0, fundId, category: '4100' }] })))
        .rejects.toThrow('lines[1].amount must be a whole number of cents, more than 0');
      await expect(receipts.recordReceipt(actor(), repay({ lines: [] }))).rejects.toThrow('lines: a receipt needs at least one line');
      expect(await balance()).toBe(1_000);
    });

    test('a line of a receipt is never voided alone: the receipt is voided whole', async () => {
      const r = await receipts.recordReceipt(actor(), repay());
      await expect(ledger.voidTransaction(actor(), r.lines[1].id, 'x')).rejects.toThrow('this entry is a line of R-0001; void the receipt instead');
      await ledger.voidTransaction(actor(), r.id, 'wrong payer');
      expect((await ledger.getDocument(actor(), r.id)).lines.every(l => l.status === 'voided')).toBe(true);
      expect(await balance()).toBe(1_000);
    });

    test('a refund names the receipt lines it gives back, never more than is left on each, and is numbered RF-', async () => {
      const r = await receipts.recordReceipt(actor(), repay());
      const [, fee, penalty] = r.lines;
      await expect(receipts.refundReceipt(actor(), r.id, { date: '2026-10-20', memo: 'x' })).rejects.toThrow('lines: R-0001 has several lines; name the lines to refund');
      const waived = await receipts.refundReceipt(actor(), r.id, { date: '2026-10-20', memo: 'penalty waived', lines: [{ receiptLineId: penalty.id, amount: 1_000 }] });
      expect(waived).toMatchObject({ number: 'RF-0001', total: 1_000 });
      expect(waived.lines).toMatchObject([{ category: '8900', amount: 1_000, receiptLineId: penalty.id }]);
      await expect(receipts.refundReceipt(actor(), r.id, { date: '2026-10-20', memo: 'again', lines: [{ receiptLineId: penalty.id, amount: 1 }] }))
        .rejects.toThrow('lines[0].receiptLineId: this line is already fully refunded');
      await expect(receipts.refundReceipt(actor(), r.id, { date: '2026-10-20', memo: 'too much', lines: [{ receiptLineId: fee.id, amount: 1_000 }, { receiptLineId: fee.id, amount: 1_000 }] }))
        .rejects.toThrow('lines[1].amount is more than is left to refund ($5.00)');
      expect((await receipts.refundReceipt(actor(), r.id, { date: '2026-10-21', memo: 'fee back', lines: [{ receiptLineId: fee.id, amount: 1_500 }] })).number).toBe('RF-0002');
      const options = await ledger.toFormOptions({ list: 'refundable-lines' }, { username: 'tess', granted: ALL });
      expect(options.map(o => o.value)).toEqual([r.lines[0].id]);
    });
  });

  describe('providers', () => {
    test('the manual provider is always there; unknown ones are skipped with a warning', () => {
      const warnings: string[] = [];
      const providers = receiptProvidersFrom([{ id: 'manual', enabled: false }, { id: 'stripe', enabled: true }, { id: 'zelle', enabled: false }], (m) => warnings.push(m));
      expect(providers.map(p => p.id)).toEqual(['manual']);
      expect(warnings).toEqual(["[accounting] receipt provider 'stripe' is not available in this version; skipped"]);
      expect(receiptProvidersFrom(undefined).map(p => p.id)).toEqual(['manual']);
    });

    test('a receipt through a provider that is not enabled is refused', async () => {
      await expect(receipts.recordReceipt(actor(), dues(100), 'stripe')).rejects.toThrow(/'stripe' is not enabled/);
    });
  });
});

test('upgrading the database turns each receipt into a one-line receipt and numbers the refunds RF- in order (D-033)', async () => {
  const [funds, accounts, deposits, documents, ...later] = ACCOUNTING_MIGRATIONS;
  const handle = openAddonTestDatabase<LedgerDb & { close(): void }>('accounting',
    { migrations: [funds, accounts, deposits] as never, ledgerTable: ACCOUNTING_LEDGER_TABLE });
  try {
    const row = (id: string, direction: 'in' | 'out', amount: number, extra: string, at: string) => handle.prepare(`INSERT INTO accounting_transactions
      (id, direction, amount, currency, date, fund_id, account_id, category, party_name, payment_method, provider, confirmation_number,
       source_type, source_id, status, memo, created_by, created_at)
      VALUES (?, ?, ?, 'USD', '2026-10-01', 'f', 'checking', '4100', 'Ann', '20', ${extra}, 'posted', 'old', 'tess', ?)`).run(id, direction, amount, at);
    handle.prepare("INSERT INTO accounting_funds (id, name, opening_date, created_by, created_at) VALUES ('f', 'General', '2026-01-01', 'tess', 'now')").run();
    row('r1', 'in', 5_000, "'manual', 'R-0001', 'receipt', NULL", '2026-10-01T10:00:00Z');
    row('r2', 'in', 700, "'manual', 'R-0002', 'dues-invoice', 'inv-7'", '2026-10-01T11:00:00Z');
    row('x2', 'out', 300, "NULL, NULL, 'receipt-refund', 'r1'", '2026-10-02T09:00:00Z');
    row('x1', 'out', 200, "NULL, NULL, 'receipt-refund', 'r1'", '2026-10-01T12:00:00Z');
    documents.up(handle as never);
    for (const migration of later) migration.up(handle as never);

    const upgraded = new LedgerManager({ ...testLedgerParts, db: handle, decide, currency: 'USD', recordAudit: () => Promise.resolve() });
    expect(await upgraded.getDocument(actor(), 'r1')).toMatchObject({ kind: 'receipt', number: 'R-0001', total: 5_000, lines: [{ id: 'r1', amount: 5_000 }] });
    expect(await upgraded.getDocument(actor(), 'r2')).toMatchObject({ number: 'R-0002', reference: { type: 'dues-invoice', id: 'inv-7' } });
    expect(await upgraded.getDocument(actor(), 'x1')).toMatchObject({ kind: 'refund', number: 'RF-0001', receiptId: 'r1', lines: [{ id: 'x1', receiptLineId: 'r1' }] });
    expect(await upgraded.getDocument(actor(), 'x2')).toMatchObject({ number: 'RF-0002' });
    const next = await upgraded.postReceipt(actor(), { amount: 100, date: '2026-10-05', fundId: 'f', category: '4100', partyName: 'Bo', paymentMethod: '10', memo: 'dues' }, { provider: 'manual' });
    expect(next.number).toBe('R-0003');
    expect((await upgraded.refundReceipt(actor(), 'r1', { amount: 100, date: '2026-10-06', memo: 'more' })).number).toBe('RF-0003');
  } finally {
    handle.close();
  }
});
