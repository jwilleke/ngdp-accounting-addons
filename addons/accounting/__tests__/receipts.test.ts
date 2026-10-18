/**
 * Receipts: money coming in (D-028, D-029). Numbered R-0001 onwards and never
 * reused; all money in is a receipt; a mistake is voided and recorded again; a
 * refund is a linked out entry; every money movement says why.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testLedgerParts } from './host.js';
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
      expect(first).toMatchObject({ direction: 'in', amount: 5_000, provider: 'manual', confirmationNumber: 'R-0001', paymentMethod: '20', paymentMethodId: '1042', partyName: 'Ann Lee', memo: 'October dues', sourceType: 'receipt' });
      expect(second.confirmationNumber).toBe('R-0002');
      expect(await balance()).toBe(8_500);
      expect(audit.map(r => `${r.eventType}/${r.action}`)).toEqual(['ledger-record/receipt-record', 'ledger-record/receipt-record']);
    });

    test('numbers are never reused: a voided receipt keeps its number', async () => {
      const wrong = await receipts.recordReceipt(actor(), dues(50_000));
      await ledger.voidTransaction(actor(), wrong.id, 'typed 500.00 for 50.00');
      const again = await receipts.recordReceipt(actor(), dues(5_000));
      expect(again.confirmationNumber).toBe('R-0002');
      expect((await ledger.listTransactions(actor(), { includeVoided: true })).find(t => t.id === wrong.id)).toMatchObject({ status: 'voided', confirmationNumber: 'R-0001' });
    });

    test('the payer, the method and the reason are required', async () => {
      await expect(receipts.recordReceipt(actor(), dues(100, { partyName: '' }))).rejects.toThrow(/partyName is required/);
      await expect(receipts.recordReceipt(actor(), dues(100, { paymentMethod: '' }))).rejects.toThrow(/paymentMethod is required/);
      await expect(receipts.recordReceipt(actor(), dues(100, { memo: ' ' }))).rejects.toThrow(/memo is required/);
      await expect(receipts.recordReceipt(actor(), dues(100, { paymentMethod: 'cash' }))).rejects.toThrow(/UN\/CEFACT/);
    });

    test('what it pays for is kept when given, both parts or neither', async () => {
      const r = await receipts.recordReceipt(actor(), dues(100, { reference: { type: 'dues-invoice', id: 'inv-7' } }));
      expect(r).toMatchObject({ sourceType: 'dues-invoice', sourceId: 'inv-7' });
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
      expect(refund).toMatchObject({ direction: 'out', amount: 2_000, fundId, category: '4100', partyName: 'Ann Lee', paymentMethod: '20', sourceType: 'receipt-refund', sourceId: r.id, memo: 'paid twice' });
      expect((await ledger.getTransaction(actor(), r.id)).status).toBe('posted');
      expect(await balance()).toBe(4_000);
      expect(audit.at(-1)).toMatchObject({ eventType: 'receipt-refund', action: 'receipt-refund', severity: 'high', resource: r.id, reason: 'paid twice', metadata: { receipt: 'R-0001', amount: 2_000 } });
    });

    test('partial refunds add up to at most the receipt; a blank amount refunds what is left', async () => {
      const r = await receipts.recordReceipt(actor(), dues(5_000));
      await receipts.refundReceipt(actor(), r.id, { amount: 3_000, date: '2026-10-19', memo: 'part' });
      await expect(receipts.refundReceipt(actor(), r.id, { amount: 2_500, date: '2026-10-19', memo: 'too much' })).rejects.toThrow(/more than is left to refund \(\$20\.00\)/);
      expect((await receipts.refundReceipt(actor(), r.id, { date: '2026-10-19', memo: 'the rest' })).amount).toBe(2_000);
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
