/**
 * An invoice's page (D-035), exactly as it is stored and sent: one account's
 * charges for a month, the balance brought forward (a credit when negative),
 * the amount owed, and each owner's share of it. Pure: DuesManager gathers the
 * data and stores what this renders.
 */

export interface InvoiceContent {
  number: string;
  accountLabel: string;
  month: string;
  date: string;
  dueDate: string;
  lines: { description: string; amount: number }[];
  /** Owed before this invoice; negative is a credit. */
  previous: number;
  total: number;
  owed: number;
  owners: { name: string; share: number }[];
  /** The module's word for the charge, e.g. Assessment. */
  label: string;
}

export interface InvoiceWording { organization: { name: string; address: string; payTo: string } }

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Each owner's part of an amount by share, in cents; the rounding remainder goes to the first owners. */
export function splitByShare(amount: number, owners: { share: number }[]): number[] {
  if (!owners.length) return [];
  const raw = owners.map(o => Math.floor(amount * o.share / 100));
  let rest = amount - raw.reduce((t, x) => t + x, 0);
  for (let i = 0; rest > 0 && i < raw.length; i++, rest--) raw[i] = (raw[i] as number) + 1;
  return raw;
}

export function renderInvoice(c: InvoiceContent, w: InvoiceWording, formatMoney: (minor: number) => string): string {
  const money = (m: number) => esc(formatMoney(m));
  const rows = c.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="amount">${money(l.amount)}</td></tr>`).join('');
  const brought = c.previous === 0 ? ''
    : `<tr><td>${c.previous > 0 ? 'Balance brought forward' : 'Credit brought forward'}</td><td class="amount">${c.previous > 0 ? '' : '−'}${money(Math.abs(c.previous))}</td></tr>`;
  const parts = splitByShare(c.owed, c.owners);
  const owners = c.owners.length > 1
    ? `<h2>Owners' shares</h2><table><tbody>${c.owners.map((o, i) => `<tr><td>${esc(o.name)}</td><td>${esc(String(Math.round(o.share * 100) / 100))}%</td><td class="amount">${money(parts[i] ?? 0)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${esc(c.number)} · ${esc(c.accountLabel)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; } .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; } td, th { padding: 0.35rem 0.25rem; border-bottom: 1px solid #ddd; text-align: left; }
  .amount { text-align: right; } tfoot td { font-weight: 600; border-bottom: none; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>Invoice ${esc(c.number)}</h1>
<p class="muted">${esc(w.organization.name)}${w.organization.address ? `<br>${esc(w.organization.address)}` : ''}</p>
<p><strong>${esc(c.accountLabel)}</strong><br>${esc(c.owners.map(o => o.name).join(', '))}</p>
<p>${esc(c.label)} for ${esc(c.month)} · issued ${esc(c.date)} · due ${esc(c.dueDate)}</p>
<table><tbody>${brought}${rows}</tbody>
<tfoot><tr><td>Amount owed</td><td class="amount">${money(c.owed)}</td></tr></tfoot></table>
${c.owed === 0 ? '<p>Paid in full: nothing is owed.</p>' : ''}
${owners}
${w.organization.payTo ? `<p class="muted">Please send payment to: ${esc(w.organization.payTo)}</p>` : ''}
</body></html>`;
}
