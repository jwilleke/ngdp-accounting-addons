/**
 * An invoice's page (D-035), exactly as it is stored and sent: one account's
 * charges for a month, the balance brought forward (a credit when negative),
 * the amount owed, and the billing party it is addressed to. Pure: ReceivablesManager gathers the
 * data and stores what this renders.
 */

export interface InvoiceContent {
  number: string;
  accountLabel: string;
  month: string;
  date: string;
  dueDate: string;
  lines: { description: string; amount: number; kind?: string }[];
  /** The unit's charge lines at their full amounts, shown under the charge (none: the charge alone). */
  chargeLines?: { description: string; amount: number }[];
  /** The billing entry's share of the unit's charge, in percent; below 100 it is shown as "Your share". */
  share?: number;
  /** Owed before this invoice; negative is a credit. */
  previous: number;
  total: number;
  owed: number;
  /** Where the invoice goes: the billing address as typed, lines kept (D-047). */
  billTo: string;
  /** The module's word for the charge, e.g. Assessment. */
  label: string;
}

/** schema.org PostalAddress, as the accommodation add-on keeps it. */
export interface PostalAddress { streetAddress: string; addressLocality?: string; addressRegion?: string; postalCode?: string }

export interface InvoiceWording { organization: { name: string; address: string; payTo: string } }

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function renderInvoice(c: InvoiceContent, w: InvoiceWording, formatMoney: (minor: number) => string): string {
  const money = (m: number) => esc(formatMoney(m));
  const row = (l: { description: string; amount: number }, cls = '') => `<tr><td${cls}>${esc(l.description)}</td><td class="amount">${money(l.amount)}</td></tr>`;
  const share = c.share ?? 100;
  // The charge's parts at their full amounts, then, for a party paying part of the unit, its share: the amount it owes.
  const charge = (l: { description: string; amount: number }) => !c.chargeLines?.length ? row(l)
    : `<tr><td colspan="2">${esc(l.description)}</td></tr>`
      + c.chargeLines.map(p => row(p, ' class="part"')).join('')
      + (share < 100 ? row({ description: `Your share: ${share}%`, amount: l.amount }) : '');
  const rows = c.lines.map(l => l.kind === 'charge' ? charge(l) : row(l)).join('');
  const brought = c.previous === 0 ? ''
    : `<tr><td>${c.previous > 0 ? 'Balance brought forward' : 'Credit brought forward'}</td><td class="amount">${c.previous > 0 ? '' : '−'}${money(Math.abs(c.previous))}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${esc(c.number)} · ${esc(c.accountLabel)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; } .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; } td, th { padding: 0.35rem 0.25rem; border-bottom: 1px solid #ddd; text-align: left; }
  .amount { text-align: right; } .part { padding-left: 1.25rem; } tfoot td { font-weight: 600; border-bottom: none; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>Invoice ${esc(c.number)}</h1>
<p class="muted">${esc(w.organization.name)}${w.organization.address ? `<br>${esc(w.organization.address)}` : ''}</p>
<p><strong>${esc(c.accountLabel)}</strong>${c.billTo.split(/\r?\n/).filter(l => l.trim()).map(l => `<br>${esc(l.trim())}`).join('')}</p>
<p>${esc(c.label)} for ${esc(c.month)} · issued ${esc(c.date)} · due ${esc(c.dueDate)}</p>
<table><tbody>${brought}${rows}</tbody>
<tfoot><tr><td>Amount owed</td><td class="amount">${money(c.owed)}</td></tr></tfoot></table>
${c.owed === 0 ? '<p>Paid in full: nothing is owed.</p>' : ''}
${w.organization.payTo ? `<p class="muted">Please send payment to: ${esc(w.organization.payTo)}</p>` : ''}
</body></html>`;
}
