/**
 * A donation on a receipt line (D-036, docs/guides/donations-guide.md): what this
 * add-on adds to a line through LedgerManager.registerLineDetails, and the
 * quid pro quo disclosure it adds to the receipt slip through
 * registerSlipNotes. The accounting add-on stores both; this add-on keeps no
 * database of its own for them (operator, 2026-10-20).
 */

/** What is stored on a donation line. deductible = the line's amount less goodsValue. */
export interface DonationDetails {
  goodsValue: number;
  goodsDescription: string | null;
  anonymous: boolean;
  deductible: number;
  /** The pledge this donation pays toward, if any. */
  pledgeId: string | null;
  /** The donor, a core contact (ngdpbase #1930), with its name kept: null for anonymous cash. */
  donor: { type: 'person' | 'organization'; id: string; name: string } | null;
}

/** The slice of the accounting add-on's receipt this add-on reads (LedgerManager's Receipt). */
export interface ReceiptLike {
  status: 'posted' | 'voided';
  lines: { amount: number; status: 'posted' | 'voided'; details: Record<string, Record<string, unknown>> }[];
}

export interface DonationSettings {
  /** Category codes a donation may be recorded under (D-036: a donation category in the chart). */
  categories: () => string[];
  /** The disclosure sentence, with {amount}, {deductible}, {goods} and {value}. */
  quidProQuo: () => string;
  formatMoney: (minor: number) => string;
  /** Whether a pledge exists and is open (DonationManager.pledgeIsOpen). */
  pledgeIsOpen?: (id: string) => boolean;
}

/** Above this, in minor units, a donation with goods or services needs the disclosure at the time (IRS Publication 1771). */
export const QUID_PRO_QUO_OVER = 7500;

export const DEFAULT_QUID_PRO_QUO = 'Of your donation of {amount}, {deductible} is deductible for federal income tax purposes. You received {goods}, valued at {value}.';

/** The `donation` kind: checks what a caller sends and returns what is stored. Throws an Error naming the field. */
export function donationValidator(settings: DonationSettings) {
  return {
    validate(data: unknown, line: { amount: number; category: string }): Record<string, unknown> {
      const d = (data ?? {}) as { goodsValue?: unknown; goodsDescription?: unknown; anonymous?: unknown; pledgeId?: unknown; donor?: unknown };
      if (typeof data !== 'object' || Array.isArray(data)) throw new Error('details.donation must be an object');
      const allowed = settings.categories();
      if (!allowed.includes(line.category)) throw new Error(`category: ${line.category} is not a donation category (${allowed.join(', ') || 'none set'})`);
      const goodsValue = d.goodsValue === undefined || d.goodsValue === null ? 0 : d.goodsValue;
      if (typeof goodsValue !== 'number' || !Number.isSafeInteger(goodsValue) || goodsValue < 0) throw new Error('details.donation.goodsValue must be a whole number of cents, 0 or more');
      if (goodsValue > line.amount) throw new Error('details.donation.goodsValue cannot be more than the donation');
      const description = typeof d.goodsDescription === 'string' && d.goodsDescription.trim() !== '' ? d.goodsDescription.trim() : null;
      if (goodsValue > 0 && !description) throw new Error('details.donation.goodsDescription is required when goods or services were received');
      if (description && description.length > 200) throw new Error('details.donation.goodsDescription is longer than 200 characters');
      if (d.anonymous !== undefined && typeof d.anonymous !== 'boolean') throw new Error('details.donation.anonymous must be true or false');
      const pledgeId = typeof d.pledgeId === 'string' && d.pledgeId !== '' ? d.pledgeId : null;
      if (d.pledgeId !== undefined && d.pledgeId !== null && d.pledgeId !== '' && typeof d.pledgeId !== 'string') throw new Error('details.donation.pledgeId must be text');
      if (pledgeId && !settings.pledgeIsOpen?.(pledgeId)) throw new Error('details.donation.pledgeId names no open pledge');
      const donor = d.donor === undefined || d.donor === null ? null : d.donor as { type?: unknown; id?: unknown; name?: unknown };
      if (donor && ((donor.type !== 'person' && donor.type !== 'organization') || typeof donor.id !== 'string' || donor.id === '' || typeof donor.name !== 'string' || donor.name === '')) {
        throw new Error('details.donation.donor must be { type: person or organization, id, name }');
      }
      const donation: DonationDetails = { goodsValue, goodsDescription: description, anonymous: d.anonymous === true, deductible: line.amount - goodsValue, pledgeId,
        donor: donor ? { type: donor.type as 'person' | 'organization', id: donor.id as string, name: donor.name as string } : null };
      return donation as unknown as Record<string, unknown>;
    }
  };
}

/** The disclosure for each posted donation line over $75 where the donor received goods or services. */
export function donationSlipNotes(settings: DonationSettings) {
  return (receipt: ReceiptLike): string[] => receipt.lines
    .filter(l => l.status === 'posted' && l.details.donation)
    .map(l => ({ amount: l.amount, donation: l.details.donation as unknown as DonationDetails }))
    .filter(({ amount, donation }) => donation.goodsValue > 0 && amount > QUID_PRO_QUO_OVER)
    .map(({ amount, donation }) => settings.quidProQuo()
      .replace('{amount}', settings.formatMoney(amount))
      .replace('{deductible}', settings.formatMoney(donation.deductible))
      .replace('{goods}', donation.goodsDescription ?? 'goods or services')
      .replace('{value}', settings.formatMoney(donation.goodsValue)));
}
