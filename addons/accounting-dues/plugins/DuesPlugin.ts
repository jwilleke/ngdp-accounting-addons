/**
 * DuesPlugin — dues drawn on a page for the person viewing it:
 *
 *   [{Dues view='prepare'}]                 this month: each account's charge, late charges, balance and amount owed
 *   [{Dues view='prepare' month='2026-11'}]
 *   [{Dues view='invoices' month='2026-10'}] invoices, newest first (blank month: all; voided='true' adds voided ones)
 *   [{Dues view='balances'}]                each account: invoiced, paid, balance or credit
 *
 * Every read goes through DuesManager as the viewer, so its permissions decide
 * (ledger-read: these name accounts and what they owe).
 */
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';
import type DuesManager from '../managers/DuesManager.js';

type Params = Record<string, string | number | boolean>;
const note = (f: PluginFormatters, text: string): string => `<p class="text-muted"><em>${f.escapeHtml(text)}</em></p>`;

export async function renderDuesView(f: PluginFormatters, dues: DuesManager, viewer: unknown, currency: string, params: Params, today: Date = new Date()): Promise<string> {
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
      const month = typeof params.month === 'string' && params.month !== '' ? params.month : today.toISOString().slice(0, 7);
      const rows = await dues.prepareMonth(actor, month);
      const totals = rows.filter(r => !r.invoiced);
      return `<p class="text-muted">${escapeHtml(month)}: ${totals.length} to invoice, ${money(totals.reduce((t, r) => t + r.owed, 0))} owed</p>`
        + formatAsTable(['Account', 'Charge', 'Due', 'Late charges', 'Brought forward', 'Amount owed', 'Invoice'],
          rows.map(r => [escapeHtml(r.label), r.charge ? money(r.charge.amount) : '', escapeHtml(r.charge?.dueDate ?? ''),
            r.lateCharges.map(l => `${money(l.amount)} on ${escapeHtml(l.appliesToNumber)}`).join('<br>'),
            balance(r.previous), `<strong>${money(r.owed)}</strong>`, r.invoiced ? escapeHtml(r.invoiced) : 'not yet']),
          { sortable: true, emptyMessage: 'Nothing is charged this month.' });
    }
    if (view === 'invoices') {
      const month = typeof params.month === 'string' && params.month !== '' ? params.month : undefined;
      const invoices = await dues.listInvoices(actor, { month, includeVoided: parseBoolParam(params.voided as string | undefined, false) });
      return formatAsTable(['Invoice', 'Account', 'Month', 'Due', 'Charged', 'Owed when issued', 'Left to pay', 'Status'],
        invoices.map(i => [`<a href="/api/accounting-dues/invoices/${encodeURIComponent(i.id)}">${escapeHtml(i.number)}</a>`, escapeHtml(i.accountLabel),
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
    return note(f, `Dues: unknown view '${view}'; use prepare, invoices or balances.`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return note(f, 'You may not see the accounts.');
    if ((err as { name?: string }).name === 'LedgerError') return note(f, (err as Error).message);
    return note(f, 'The accounts could not be shown.');
  }
}

const DuesPlugin = {
  name: 'Dues',
  description: 'Invoices and account balances for dues or assessments, for those allowed to see them',
  author: 'jwilleke',
  version: '0.1.0',
  async execute(context: { engine: { getManager<T = unknown>(name: string): T | null | undefined }; userContext?: unknown; formatters: PluginFormatters }, params: Params): Promise<string> {
    const dues = context.engine.getManager<DuesManager>('DuesManager');
    const ledger = context.engine.getManager<{ currencyCode(): string }>('LedgerManager');
    if (!dues || !ledger) return note(context.formatters, 'Dues are not available on this site.');
    return renderDuesView(context.formatters, dues, context.userContext, ledger.currencyCode(), params);
  }
};

export default DuesPlugin;
