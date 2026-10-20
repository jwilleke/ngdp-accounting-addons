/**
 * Gifts (D-036): a receipt line with gift details, stored by the accounting
 * add-on through LedgerManager.registerLineDetails, and the receipt slip's quid
 * pro quo disclosure through registerSlipNotes. Uses the accounting add-on's
 * own ledger and test host, as a site would: this add-on calls its managers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testLedgerParts } from '../../accounting/__tests__/host.js';
import LedgerManager, { type LedgerActor, type LedgerDb } from '../../accounting/managers/LedgerManager.js';
import { DEFAULT_QUID_PRO_QUO, giftSlipNotes, giftValidator, type GiftSettings } from '../gift.js';
import { GIFT_FORM, giftField, giftFromForm } from '../forms.js';

const actor: LedgerActor = {
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess' } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
};

describe('gifts', () => {
  let provider: { handle: unknown; close(): void };
  let ledger: LedgerManager;
  let fundId: string;
  const settings: GiftSettings = { categories: () => ['4200'], quidProQuo: () => DEFAULT_QUID_PRO_QUO, formatMoney: (m) => `$${(m / 100).toFixed(2)}` };

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    ledger = new LedgerManager({ ...testLedgerParts, db: provider.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(),
      decide: async () => ({ permit: true, applicable: true, reason: 'test' }) });
    ledger.registerLineDetails('gift', giftValidator(settings));
    ledger.registerSlipNotes(giftSlipNotes(settings) as never);
    fundId = (await ledger.createFund(actor, { name: 'General' })).id;
  });

  afterEach(() => provider.close());

  const gift = (amount: number, details: Record<string, unknown> = {}, category = '4200') =>
    ledger.postReceipt(actor, {
      date: '2026-10-20', partyName: 'Pat Lee', paymentMethod: '20', paymentMethodId: '881', memo: 'Gala',
      lines: [{ amount, fundId, category, details: { gift: details } }]
    }, { provider: 'manual' });

  test('a gift is a receipt line in a donation category, its deductible amount worked out', async () => {
    const r = await gift(10_000, { goodsValue: 4_000, goodsDescription: 'dinner for one' });
    expect(r.number).toBe('R-0001');
    expect(r.lines[0].details.gift).toEqual({ goodsValue: 4_000, goodsDescription: 'dinner for one', anonymous: false, deductible: 6_000, pledgeId: null });
    expect((await gift(2_500, { anonymous: true })).lines[0].details.gift).toEqual({ goodsValue: 0, goodsDescription: null, anonymous: true, deductible: 2_500, pledgeId: null });
  });

  test('what is wrong with a gift is refused, naming the field', async () => {
    await expect(gift(100, {}, '4100')).rejects.toThrow('lines[0].category: 4100 is not a donation category (4200)');
    await expect(gift(100, { goodsValue: 200, goodsDescription: 'x' })).rejects.toThrow('goodsValue cannot be more than the gift');
    await expect(gift(100, { goodsValue: 50 })).rejects.toThrow('goodsDescription is required when goods or services were received');
    expect(giftField('lines[0]: details.gift.goodsDescription is required when goods or services were received')).toBe('goodsDescription');
  });

  test('the slip discloses what is deductible for a gift over $75 with goods or services, and only then', async () => {
    const gala = await gift(10_000, { goodsValue: 4_000, goodsDescription: 'dinner for one' });
    expect((await ledger.receiptSlip(actor, gala.id)).notes).toEqual([
      'Of your gift of $100.00, $60.00 is deductible for federal income tax purposes. You received dinner for one, valued at $40.00.'
    ]);
    expect((await ledger.receiptSlip(actor, (await gift(7_500, { goodsValue: 1_000, goodsDescription: 'mug' })).id)).notes).toEqual([]);
    expect((await ledger.receiptSlip(actor, (await gift(10_000)).id)).notes).toEqual([]);
  });

  test('the form makes one gift line from what the treasurer typed', () => {
    expect(GIFT_FORM.fields.find(f => f.name === 'category')?.optionsSource).toBe('fetch:DonationManager.toFormOptions(list=gift-categories)');
    expect(giftFromForm({ amount: 5_000, date: '2026-10-20', fundId: 'f', category: '4200', partyName: 'Pat', paymentMethod: '20', memo: 'gift', anonymous: 'on', goodsValue: '' }))
      .toMatchObject({ partyName: 'Pat', lines: [{ amount: 5_000, fundId: 'f', category: '4200', details: { gift: { goodsValue: undefined, anonymous: true } } }] });
  });
});
