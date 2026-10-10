/**
 * LedgerPlugin — the ledger, drawn live into a page for the person viewing it.
 *
 *   [{Ledger view='balances'}]                       fund balances, with a total
 *   [{Ledger view='entries' max='20'}]               latest entries, newest first
 *   [{Ledger view='entries' fund='<fund id>' voided='true'}]
 *
 * Every read goes through LedgerManager as the viewer (viewerActor), so the
 * ledger's own permissions decide: balances need ledger-summary-read, entries
 * need ledger-read. Nothing is copied into the page; the page holds only the
 * plugin call. Formatting comes from ngdpbase's shared plugin helpers.
 */
import {
  applyMax,
  escapeHtml,
  formatAsTable,
  formatMoney,
  parseBoolParam,
  parseMaxParam
} from '../../../dist/src/utils/pluginFormatters.js';
import type LedgerManager from '../managers/LedgerManager.js';
import type { FundBalance, LedgerActor, Transaction } from '../managers/LedgerManager.js';

interface PluginContext {
  engine: { getManager<T = unknown>(name: string): T | null | undefined };
  userContext?: unknown;
}
type PluginParams = Record<string, string | number | boolean>;

const DEFAULT_MAX_ENTRIES = 20;

const note = (text: string): string => `<p class="text-muted"><em>${escapeHtml(text)}</em></p>`;

function balancesTable(rows: FundBalance[], currency: string): string {
  const money = (cents: number) => escapeHtml(formatMoney(cents, currency));
  const sum = (pick: (r: FundBalance) => number) => rows.reduce((total, r) => total + pick(r), 0);
  return formatAsTable(
    ['Fund', 'Opening', 'In', 'Out', 'Balance'],
    rows.map(r => [
      escapeHtml(r.name) + (r.active ? '' : ' <span class="text-muted">(closed)</span>'),
      money(r.openingBalance),
      money(r.totalIn),
      money(r.totalOut),
      `<strong>${money(r.balance)}</strong>`
    ]),
    {
      emptyMessage: 'No funds yet.',
      footer: ['<strong>Total</strong>', money(sum(r => r.openingBalance)), money(sum(r => r.totalIn)), money(sum(r => r.totalOut)), `<strong>${money(sum(r => r.balance))}</strong>`]
    }
  );
}

function entriesTable(entries: Transaction[], fundNames: Map<string, string>): string {
  const money = (t: Transaction) => escapeHtml(formatMoney(t.amount, t.currency));
  return formatAsTable(
    ['Date', 'Fund', 'Category', 'In', 'Out', 'Paid by / to', 'Memo', 'Status'],
    entries.map(t => [
      escapeHtml(t.date),
      escapeHtml(fundNames.get(t.fundId) ?? t.fundId),
      escapeHtml(t.category),
      t.direction === 'in' ? money(t) : '',
      t.direction === 'out' ? money(t) : '',
      escapeHtml(t.partyName ?? ''),
      escapeHtml(t.memo),
      t.status === 'voided' ? `voided: ${escapeHtml(t.voidReason ?? '')}` : 'posted'
    ]),
    { emptyMessage: 'No entries yet.' }
  );
}

async function render(ledger: LedgerManager, actor: LedgerActor, params: PluginParams): Promise<string> {
  const view = String(params.view ?? 'balances');
  if (view === 'balances') {
    return balancesTable(await ledger.fundBalances(actor), ledger.currencyCode());
  }
  if (view === 'entries') {
    const fund = typeof params.fund === 'string' && params.fund !== '' ? params.fund : undefined;
    const includeVoided = parseBoolParam(params.voided as string | undefined, false);
    const max = parseMaxParam(params.max as string | number | undefined, DEFAULT_MAX_ENTRIES);
    const entries = await ledger.listTransactions(actor, { fundId: fund, includeVoided });
    const newestFirst = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const fundNames = new Map((await ledger.fundBalances(actor)).map(f => [f.fundId, f.name]));
    return entriesTable(applyMax(newestFirst, max), fundNames);
  }
  return note(`Ledger: unknown view '${view}'; use balances or entries.`);
}

const LedgerPlugin = {
  name: 'Ledger',
  description: 'Fund balances and ledger entries, live, for those allowed to see them',
  author: 'jwilleke',
  version: '0.1.0',

  async execute(context: PluginContext, params: PluginParams): Promise<string> {
    const ledger = context.engine.getManager<LedgerManager>('LedgerManager');
    if (!ledger) return note('The ledger is not available on this site.');
    try {
      return await render(ledger, ledger.viewerActor(context.userContext), params);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) return note('You may not see the ledger.');
      return note('The ledger could not be shown.');
    }
  }
};

export default LedgerPlugin;
