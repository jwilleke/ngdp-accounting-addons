/**
 * A year-end giving statement's content and page (D-036, donations guide): a
 * donor's gifts for the year (receipt lines with gift details naming them, net
 * of refunds, bounced checks left out), their in-kind gifts (described, never
 * valued), the totals, and the site's wording. Pure: DonationManager gathers
 * the data and stores what this renders.
 */

export interface StatementGift {
  receiptNumber: string | null; date: string; amount: number; deductible: number;
  goodsValue: number; goodsDescription: string | null;
}

export interface StatementContent {
  donor: { type: 'person' | 'organization'; id: string; name: string };
  year: number;
  gifts: StatementGift[];
  inKind: { date: string; description: string }[];
  total: number;
  deductible: number;
}

export interface StatementWording {
  organization: { name: string; taxId: string; address: string };
  intro: string;
  noGoods: string;
  goodsNote: string;
  taxIdNote: string;
}

export const DEFAULT_WORDING = {
  intro: 'Thank you for your support of {organization}. This statement lists your contributions received in {year}.',
  noGoods: 'No goods or services were provided in exchange for these contributions.',
  goodsNote: 'Where goods or services were provided in exchange for a contribution, their value is shown, and only the amount above it is deductible.',
  taxIdNote: '{organization} is a tax-exempt organization. Its federal tax identification number is {taxId}.'
};

/** The donor's year, from receipts and refunds read through the ledger. */
export function giftsFor(
  donorId: string, year: number,
  receipts: { number: string | null; date: string; status: string; bounced?: boolean; lines: { id: string; amount: number; status: string; details: Record<string, Record<string, unknown>> }[] }[],
  refunds: { status: string; lines: { amount: number; status: string; receiptLineId: string | null }[] }[]
): StatementGift[] {
  const refunded = new Map<string, number>();
  for (const r of refunds) if (r.status === 'posted') for (const l of r.lines) {
    if (l.status === 'posted' && l.receiptLineId) refunded.set(l.receiptLineId, (refunded.get(l.receiptLineId) ?? 0) + l.amount);
  }
  const gifts: StatementGift[] = [];
  for (const r of receipts) {
    if (r.status !== 'posted' || r.bounced || Number(r.date.slice(0, 4)) !== year) continue;
    for (const l of r.lines) {
      const gift = l.details.gift as { donor?: { id?: string }; goodsValue?: number; goodsDescription?: string | null } | undefined;
      if (l.status !== 'posted' || gift?.donor?.id !== donorId) continue;
      const amount = l.amount - (refunded.get(l.id) ?? 0);
      if (amount <= 0) continue;
      const goodsValue = Math.min(gift.goodsValue ?? 0, amount);
      gifts.push({ receiptNumber: r.number, date: r.date, amount, deductible: amount - goodsValue, goodsValue, goodsDescription: gift.goodsDescription ?? null });
    }
  }
  return gifts.sort((a, b) => a.date.localeCompare(b.date));
}

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** The statement page, exactly as it is stored and sent. */
export function renderStatement(c: StatementContent, w: StatementWording, formatMoney: (minor: number) => string, issuedOn: string): string {
  const values = { organization: w.organization.name, year: String(c.year), taxId: w.organization.taxId };
  const anyGoods = c.gifts.some(g => g.goodsValue > 0);
  const rows = c.gifts.map(g => `<tr><td>${esc(g.date)}</td><td>${esc(g.receiptNumber ?? '')}</td><td class="amount">${esc(formatMoney(g.amount))}</td>`
    + (anyGoods ? `<td>${g.goodsValue > 0 ? `${esc(g.goodsDescription ?? 'goods or services')}: ${esc(formatMoney(g.goodsValue))}` : ''}</td>` : '')
    + `<td class="amount">${esc(formatMoney(g.deductible))}</td></tr>`).join('');
  const inKind = c.inKind.length
    ? `<h2>Gifts of goods or services</h2><p>Described, not valued: the value of a non-cash gift is for you to determine.</p><ul>${c.inKind.map(i => `<li>${esc(i.date)}: ${esc(i.description)}</li>`).join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(String(c.year))} giving statement · ${esc(c.donor.name)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; } .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; } td, th { padding: 0.35rem 0.25rem; border-bottom: 1px solid #ddd; text-align: left; }
  .amount { text-align: right; } tfoot td { font-weight: 600; border-bottom: none; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>${esc(String(c.year))} giving statement</h1>
<p class="muted">${esc(w.organization.name)}${w.organization.address ? `<br>${esc(w.organization.address)}` : ''}</p>
<p><strong>${esc(c.donor.name)}</strong></p>
<p>${esc(fill(w.intro, values))}</p>
<table><thead><tr><th>Date</th><th>Receipt</th><th class="amount">Amount</th>${anyGoods ? '<th>Goods or services received</th>' : ''}<th class="amount">Deductible</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="2">Total</td><td class="amount">${esc(formatMoney(c.total))}</td>${anyGoods ? '<td></td>' : ''}<td class="amount">${esc(formatMoney(c.deductible))}</td></tr></tfoot></table>
<p>${esc(anyGoods ? w.goodsNote : w.noGoods)}</p>
${inKind}
${w.organization.taxId ? `<p class="muted">${esc(fill(w.taxIdNote, values))}</p>` : ''}
<p class="muted">Issued ${esc(issuedOn)}.</p>
</body></html>`;
}
