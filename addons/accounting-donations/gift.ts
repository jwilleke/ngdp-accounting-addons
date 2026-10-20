/**
 * A gift on a receipt line (D-036, docs/guides/donations-guide.md): what this
 * add-on adds to a line through LedgerManager.registerLineDetails, and the
 * quid pro quo disclosure it adds to the receipt slip through
 * registerSlipNotes. The accounting add-on stores both; this add-on keeps no
 * database of its own for them (operator, 2026-10-20).
 */

/** What is stored on a gift line. deductible = the line's amount less goodsValue. */
export interface GiftDetails {
  goodsValue: number;
  goodsDescription: string | null;
  anonymous: boolean;
  deductible: number;
}

/** The slice of the accounting add-on's receipt this add-on reads (LedgerManager's Receipt). */
export interface ReceiptLike {
  status: 'posted' | 'voided';
  lines: { amount: number; status: 'posted' | 'voided'; details: Record<string, Record<string, unknown>> }[];
}

export interface GiftSettings {
  /** Category codes a gift may be recorded under (D-036: a donation category in the chart). */
  categories: () => string[];
  /** The disclosure sentence, with {amount}, {deductible}, {goods} and {value}. */
  quidProQuo: () => string;
  formatMoney: (minor: number) => string;
}

/** Above this, in minor units, a gift with goods or services needs the disclosure at the time (IRS Publication 1771). */
export const QUID_PRO_QUO_OVER = 7500;

export const DEFAULT_QUID_PRO_QUO = 'Of your gift of {amount}, {deductible} is deductible for federal income tax purposes. You received {goods}, valued at {value}.';

/** The `gift` kind: checks what a caller sends and returns what is stored. Throws an Error naming the field. */
export function giftValidator(settings: GiftSettings) {
  return {
    validate(data: unknown, line: { amount: number; category: string }): Record<string, unknown> {
      const d = (data ?? {}) as { goodsValue?: unknown; goodsDescription?: unknown; anonymous?: unknown };
      if (typeof data !== 'object' || Array.isArray(data)) throw new Error('details.gift must be an object');
      const allowed = settings.categories();
      if (!allowed.includes(line.category)) throw new Error(`category: ${line.category} is not a donation category (${allowed.join(', ') || 'none set'})`);
      const goodsValue = d.goodsValue === undefined || d.goodsValue === null ? 0 : d.goodsValue;
      if (typeof goodsValue !== 'number' || !Number.isSafeInteger(goodsValue) || goodsValue < 0) throw new Error('details.gift.goodsValue must be a whole number of cents, 0 or more');
      if (goodsValue > line.amount) throw new Error('details.gift.goodsValue cannot be more than the gift');
      const description = typeof d.goodsDescription === 'string' && d.goodsDescription.trim() !== '' ? d.goodsDescription.trim() : null;
      if (goodsValue > 0 && !description) throw new Error('details.gift.goodsDescription is required when goods or services were received');
      if (description && description.length > 200) throw new Error('details.gift.goodsDescription is longer than 200 characters');
      if (d.anonymous !== undefined && typeof d.anonymous !== 'boolean') throw new Error('details.gift.anonymous must be true or false');
      const gift: GiftDetails = { goodsValue, goodsDescription: description, anonymous: d.anonymous === true, deductible: line.amount - goodsValue };
      return gift as unknown as Record<string, unknown>;
    }
  };
}

/** The disclosure for each posted gift line over $75 where the donor received goods or services. */
export function giftSlipNotes(settings: GiftSettings) {
  return (receipt: ReceiptLike): string[] => receipt.lines
    .filter(l => l.status === 'posted' && l.details.gift)
    .map(l => ({ amount: l.amount, gift: l.details.gift as unknown as GiftDetails }))
    .filter(({ amount, gift }) => gift.goodsValue > 0 && amount > QUID_PRO_QUO_OVER)
    .map(({ amount, gift }) => settings.quidProQuo()
      .replace('{amount}', settings.formatMoney(amount))
      .replace('{deductible}', settings.formatMoney(gift.deductible))
      .replace('{goods}', gift.goodsDescription ?? 'goods or services')
      .replace('{value}', settings.formatMoney(gift.goodsValue)));
}
