/**
 * LedgerPlugin — the ledger, shown live on a page for the person viewing it.
 *
 *   [{Ledger view='balances'}]                       fund balances, with a total
 *   [{Ledger view='entries' max='20'}]               latest entries, newest first
 *   [{Ledger view='entries' fund='<fund id>' voided='true'}]
 *   [{Ledger view='summary' month='previous'}]       a period: per fund start/in/out/end, per category income/expense
 *   [{Ledger view='summary' from='2026-01-01' to='2026-06-30' export='true'}]   with CSV download links
 *
 * Every read goes through LedgerManager as the viewer (viewerActor), so the
 * ledger's own permissions decide: balances need ledger-summary-read, entries
 * need ledger-read, a summary needs ledger-summary-read (no names). The
 * download links lead to /api/accounting/export, which asks ledger-export and
 * a fresh sign-in itself. The rendered page is cached per set of roles and
 * re-rendered after the ledger's next write (the ledger bumps its topic).
 * Formatting comes from ngdpbase's shared plugin helpers.
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
import type { FundBalance, LedgerActor, PeriodSummary, Transaction } from '../managers/LedgerManager.js';

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

function summaryTables(s: PeriodSummary, withExport: boolean): string {
  const money = (cents: number) => escapeHtml(formatMoney(cents, s.currency));
  const heading = `<p class="text-muted">${escapeHtml(s.period.from)} to ${escapeHtml(s.period.to)}</p>`;
  const funds = formatAsTable(
    ['Fund', 'Start', 'Opened', 'In', 'Out', 'End'],
    s.funds.map(f => [
      escapeHtml(f.name) + (f.active ? '' : ' <span class="text-muted">(closed)</span>'),
      money(f.start), f.opened ? money(f.opened) : '', money(f.moneyIn), money(f.moneyOut), `<strong>${money(f.end)}</strong>`
    ]),
    {
      emptyMessage: 'No funds in this period.',
      footer: ['<strong>Total</strong>', money(s.totals.start), s.totals.opened ? money(s.totals.opened) : '', money(s.totals.moneyIn), money(s.totals.moneyOut), `<strong>${money(s.totals.end)}</strong>`]
    }
  );
  const net = s.totals.income - s.totals.expense;
  const categories = formatAsTable(
    ['Category', 'Income', 'Expense'],
    s.categories.map(c => [escapeHtml(c.label ? `${c.category} ${c.label}` : c.category), c.income ? money(c.income) : '', c.expense ? money(c.expense) : '']),
    {
      emptyMessage: 'No income or expense in this period.',
      footer: [`<strong>Total</strong> (net ${money(net)})`, money(s.totals.income), money(s.totals.expense)]
    }
  );
  const link = (kind: string, label: string) =>
    `<a class="btn btn-sm btn-outline-secondary me-2" href="/api/accounting/export?kind=${kind}&amp;from=${encodeURIComponent(s.period.from)}&amp;to=${encodeURIComponent(s.period.to)}">${label}</a>`;
  const downloads = withExport ? `<p>${link('transactions', 'Download entries (CSV)')}${link('funds', 'Download fund summary (CSV)')}</p>` : '';
  return `${heading}\n<h4>Funds</h4>\n${funds}\n<h4>Income and expense by category</h4>\n<p class="text-muted small">Transfers between funds are left out: they net to zero.</p>\n${categories}\n${downloads}`;
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
  if (view === 'summary') {
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const period = ledger.period({ month: str(params.month), from: str(params.from), to: str(params.to) });
    return summaryTables(await ledger.periodSummary(actor, period), parseBoolParam(params.export as string | undefined, false));
  }
  return note(`Ledger: unknown view '${view}'; use balances, entries or summary.`);
}

/**
 * The tables for one view, read as `actor` (the request's context). A refusal
 * or a bad parameter is a short note, not an error page.
 */
export async function renderLedgerView(ledger: LedgerManager, actor: LedgerActor, params: PluginParams): Promise<string> {
  try {
    return await render(ledger, actor, params);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return note('You may not see the ledger.');
    if (status === 400) return note(`Ledger: ${(err as Error).message}`);
    return note('The ledger could not be shown.');
  }
}

const LedgerPlugin = {
  name: 'Ledger',
  description: 'Fund balances, entries and period summaries, for those allowed to see them',
  author: 'jwilleke',
  version: '0.2.0',

  // Drawn on the server like every plugin. While the page is cached, ngdpbase
  // records that it read LedgerManager, and re-renders it after the ledger's
  // next write bumps that topic (caching-developer-guide.md).
  async execute(context: { engine: { getManager<T = unknown>(name: string): T | null | undefined }; userContext?: unknown }, params: PluginParams): Promise<string> {
    const ledger = context.engine.getManager<LedgerManager>('LedgerManager');
    if (!ledger) return note('The ledger is not available on this site.');
    return renderLedgerView(ledger, ledger.viewerActor(context.userContext), params);
  }
};

export default LedgerPlugin;
