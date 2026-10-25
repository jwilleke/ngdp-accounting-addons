/**
 * ReceivablesPlugin — invoices and balances drawn on a page for the person viewing it:
 *
 *   [{Receivables view='prepare'}]                 this month: each billing address's charge, late charges, balance and amount owed
 *   [{Receivables view='prepare' month='next'}]     current (the default), next, previous, or YYYY-MM
 *   [{Receivables view='invoices' month='2026-10'}] invoices, newest first (blank month: all; voided='true' adds voided ones)
 *   [{Receivables view='balances'}]                each account: invoiced, paid, balance or credit
 *
 * Every read goes through ReceivablesManager as the viewer, so its permissions decide
 * (ledger-read: these name accounts and what they owe).
 */
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';
import type ReceivablesManager from '../managers/ReceivablesManager.js';

type Params = Record<string, string | number | boolean>;
/** A month parameter: current, next or previous (from today), else as given (YYYY-MM). */
function monthParam(value: unknown, today: Date): string {
  const offset = { current: 0, next: 1, previous: -1 }[String(value ?? 'current')];
  if (offset === undefined) return String(value);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
}

const note = (f: PluginFormatters, text: string): string => `<p class="text-muted"><em>${f.escapeHtml(text)}</em></p>`;

export async function renderReceivablesView(f: PluginFormatters, dues: ReceivablesManager, viewer: unknown, currency: string, params: Params, today: Date = new Date()): Promise<string> {
  const { escapeHtml, formatAsTable, formatMoney, parseBoolParam } = f;
  const money = (cents: number) => escapeHtml(formatMoney(cents, currency));
  const balance = (cents: number) => (cents < 0 ? `${money(-cents)} credit` : money(cents));
  const actor = {
    ipAddress: undefined, subject: (viewer ?? null) as never, actingUsername: () => 'viewer',
    enforceDeny: async (permission: string) => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
  try {
    const view = String(params.view ?? 'prepare');
    if (view === 'prepare') {
      const month = monthParam(params.month, today);
      const rows = await dues.prepareMonth(actor, month);
      const totals = rows.filter(r => !r.invoiced && !r.problem);
      const who = (r: { label: string; partyName: string }) => `${escapeHtml(r.label)}${r.partyName ? `<br><small>${escapeHtml(r.partyName)}</small>` : ''}`;
      return `<p class="text-muted">${escapeHtml(month)}: ${totals.length} to invoice, ${money(totals.reduce((t, r) => t + r.owed, 0))} owed</p>`
        + formatAsTable(['Account', 'Charge', 'Due', 'Late charges', 'Brought forward', 'Amount owed', 'Invoice'],
          rows.map(r => r.problem ? [who(r), '', '', '', '', '', `not billable: ${escapeHtml(r.problem)}`] : [who(r), r.charge ? money(r.charge.amount) : '', escapeHtml(r.charge?.dueDate ?? ''),
            r.lateCharges.map(l => `${money(l.amount)} on ${escapeHtml(l.appliesToNumber)}`).join('<br>'),
            balance(r.previous), `<strong>${money(r.owed)}</strong>`, r.invoiced ? escapeHtml(r.invoiced) : 'not yet']),
          { sortable: true, emptyMessage: 'Nothing is charged this month.' });
    }
    if (view === 'invoices') {
      const month = typeof params.month === 'string' && params.month !== '' ? params.month : undefined;
      const invoices = await dues.listInvoices(actor, { month, includeVoided: parseBoolParam(params.voided as string | undefined, false) });
      return formatAsTable(['Invoice', 'Account', 'Month', 'Due', 'Charged', 'Owed when issued', 'Left to pay', 'Status'],
        invoices.map(i => [`<a href="/api/accounting-receivables/invoices/${encodeURIComponent(i.id)}">${escapeHtml(i.number)}</a>`, `${escapeHtml(i.accountLabel)}${i.partyName ? `<br><small>${escapeHtml(i.partyName)}</small>` : ''}`,
          escapeHtml(i.month), escapeHtml(i.dueDate), money(i.total), money(i.owed), i.status === 'issued' ? money(i.remaining) : '',
          i.status === 'voided' ? `voided: ${escapeHtml(i.voidReason ?? '')}` : (i.emailedTo ? 'issued · emailed' : 'issued')]),
        { sortable: true, emptyMessage: 'No invoices.' });
    }
    if (view === 'balances') {
      const rows = await dues.balances(actor);
      return formatAsTable(['Account', 'Invoiced', 'Paid', 'Balance'],
        rows.map(r => [escapeHtml(r.label), money(r.invoiced), money(r.paid), `<strong>${balance(r.balance)}</strong>`]),
        { sortable: true, emptyMessage: 'No accounts.' });
    }
    return note(f, `Unknown view '${view}'; use prepare, invoices or balances.`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return note(f, 'You may not see the accounts.');
    if ((err as { name?: string }).name === 'LedgerError') return note(f, (err as Error).message);
    return note(f, 'The accounts could not be shown.');
  }
}

const ReceivablesPlugin = {
  name: 'Receivables',
  description: 'Invoices and account balances for the site\'s charges, for those allowed to see them',
  author: 'jwilleke',
  version: '0.1.0',
  async execute(context: { engine: { getManager<T = unknown>(name: string): T | null | undefined }; userContext?: unknown; formatters: PluginFormatters }, params: Params): Promise<string> {
    const dues = context.engine.getManager<ReceivablesManager>('ReceivablesManager');
    const ledger = context.engine.getManager<{ currencyCode(): string }>('LedgerManager');
    if (!dues || !ledger) return note(context.formatters, 'Invoices are not available on this site.');
    // Fetched so the cached page depends on the accounts' topic too (ngdpbase caching guide: plugins declare nothing).
    const source = dues.accountsManagerName();
    if (source) context.engine.getManager(source);
    return renderReceivablesView(context.formatters, dues, context.userContext, ledger.currencyCode(), params);
  }
};

export default ReceivablesPlugin;
