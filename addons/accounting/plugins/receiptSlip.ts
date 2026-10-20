/**
 * The printable receipt slip: one receipt, its lines and the notes modules add
 * (a gift's quid pro quo disclosure, D-036). A plain page the treasurer prints
 * or saves as PDF from the browser, and hands to the payer.
 */
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';
import type { ReceiptSlip } from '../managers/LedgerManager.js';

export interface SlipNames {
  organization: string;
  funds: Map<string, string>;
  categories: Map<string, string>;
  methods: Map<string, string>;
}

export function renderReceiptSlip(f: Pick<PluginFormatters, 'escapeHtml' | 'formatMoney'>, slip: ReceiptSlip, names: SlipNames): string {
  const { escapeHtml: esc, formatMoney } = f;
  const r = slip.receipt;
  const money = (cents: number) => esc(formatMoney(cents, slip.currency));
  const method = r.paymentMethod ? names.methods.get(r.paymentMethod) ?? r.paymentMethod : '';
  const rows = r.lines.map(l => `<tr><td>${esc(names.categories.get(l.category) ?? l.category)}</td><td>${esc(names.funds.get(l.fundId) ?? l.fundId)}</td><td class="amount">${money(l.amount)}</td></tr>`).join('');
  const notes = slip.notes.map(n => `<p class="note">${esc(n)}</p>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(r.number ?? '')}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; } .org { color: #555; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; } td, th { padding: 0.35rem 0.25rem; border-bottom: 1px solid #ddd; text-align: left; }
  .amount { text-align: right; } tfoot td { font-weight: 600; border-bottom: none; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; } dt { color: #555; }
  .note { border-left: 3px solid #999; padding-left: 0.6rem; } .voided { color: #b00; font-weight: 600; }
  @media print { body { margin: 0; } .noprint { display: none; } }
</style></head><body>
<h1>Receipt ${esc(r.number ?? '')}</h1>
<p class="org">${esc(names.organization)}</p>
${r.status === 'voided' ? `<p class="voided">Voided: ${esc(r.voidReason ?? '')}</p>` : ''}
<dl>
  <dt>Date</dt><dd>${esc(r.date)}</dd>
  <dt>Received from</dt><dd>${esc(r.partyName ?? '')}</dd>
  <dt>Method</dt><dd>${esc(method)}${r.paymentMethodId ? ` · ${esc(r.paymentMethodId)}` : ''}</dd>
  <dt>For</dt><dd>${esc(r.memo)}</dd>
</dl>
<table><thead><tr><th>What</th><th>Fund</th><th class="amount">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="2">Total</td><td class="amount">${money(r.total)}</td></tr></tfoot></table>
${notes}
<p class="noprint"><button onclick="window.print()">Print</button></p>
</body></html>`;
}
