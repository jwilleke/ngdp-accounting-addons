/**
 * LedgerPlugin — the ledger, shown live on a page for the person viewing it.
 *
 *   [{Ledger view='balances'}]                       fund balances, with a total
 *   [{Ledger view='accounts'}]                       account balances (where the money sits), with a total (D-031)
 *   [{Ledger view='entries' max='20'}]               latest entries, newest first, with receipt and deposit numbers
 *   [{Ledger view='deposits'}]                       deposits, newest first, with their receipts and cleared dates (D-031, D-032)
 *   [{Ledger view='deposits' cleared='false'}]       deposits not yet cleared: deposits in transit
 *   [{Ledger view='lock'}]                           how periods are locked, and through when (#19)
 *   [{Ledger view='bounces' settled='false'}]        bounced checks with what is owed, repaid and still owed (D-032)
 *   [{Ledger view='entries' fund='<fund id>' voided='true'}]
 *   [{Ledger view='summary' month='previous'}]       a period: per fund start/in/out/end, per category income/expense
 *   [{Ledger view='summary' from='2026-01-01' to='2026-06-30' export='true'}]   with CSV download links
 *
 * Every read goes through LedgerManager as the viewer (viewerActor), so the
 * ledger's own permissions decide: balances need ledger-summary-read, entries
 * need ledger-read, a summary needs ledger-summary-read (no names). The
 * download links lead to /api/accounting/export, which asks ledger-export and
 * a fresh sign-in itself. ngdpbase caches the rendered page per viewer
 * (username and roles) and re-renders it after the ledger's next write (the
 * ledger bumps its topic).
 * Formatting comes from ngdpbase's plugin helpers, which PluginManager hands
 * every plugin as `context.formatters` (#1820).
 */
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';
import type LedgerManager from '../managers/LedgerManager.js';
import { CASH_ON_HAND, accountLabel } from '../managers/LedgerManager.js';
import type { AccountBalance, Bounce, Deposit, FundBalance, LedgerActor, PeriodSummary } from '../managers/LedgerManager.js';

type PluginParams = Record<string, string | number | boolean>;

const DEFAULT_MAX_ENTRIES = 20;

const note = (f: PluginFormatters, text: string): string => `<p class="text-muted"><em>${f.escapeHtml(text)}</em></p>`;

/**
 * Every ledger table sorts by clicking a heading (ngdpbase's tableSort.js, which
 * reorders the body only, so a totals row stays last). A money or marked-up
 * cell sorts on its plain value: cents, or the bare name.
 */
function sortOn<T>(items: T[], columns: Record<number, (item: T) => string | number>): Record<number, (row: string[], rowIndex: number) => string> {
  return Object.fromEntries(Object.entries(columns).map(([col, pick]) => [col, (_row: string[], i: number) => String(pick(items[i]))]));
}

function balancesTable(f: PluginFormatters, rows: FundBalance[], currency: string): string {
  const { escapeHtml, formatAsTable, formatMoney } = f;
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
      sortable: true,
      cellDataSort: sortOn(rows, { 0: r => r.name, 1: r => r.openingBalance, 2: r => r.totalIn, 3: r => r.totalOut, 4: r => r.balance }),
      emptyMessage: 'No funds yet.',
      footer: ['<strong>Total</strong>', money(sum(r => r.openingBalance)), money(sum(r => r.totalIn)), money(sum(r => r.totalOut)), `<strong>${money(sum(r => r.balance))}</strong>`]
    }
  );
}

const accountName = (f: PluginFormatters, name: string, configured: boolean): string =>
  f.escapeHtml(name) + (configured ? '' : ' <span class="text-muted">(no longer configured)</span>');

/** Said when the two ways of counting the same money disagree: an account's opening balance is missing or wrong. */
const disagreement = (f: PluginFormatters, funds: number, accounts: number, currency: string): string =>
  funds === accounts ? '' : note(f, `The accounts add up to ${f.formatMoney(accounts, currency)} and the funds to ${f.formatMoney(funds, currency)}. They count the same money: check the accounts' opening balances.`);

function accountsTable(f: PluginFormatters, rows: AccountBalance[], labels: Map<string, string>, fundsTotal: number, currency: string): string {
  const { escapeHtml, formatAsTable, formatMoney } = f;
  const money = (cents: number) => escapeHtml(formatMoney(cents, currency));
  const sum = (pick: (r: AccountBalance) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const table = formatAsTable(
    ['Account', 'Opening', 'In', 'Out', 'Balance'],
    rows.map(r => [
      accountName(f, labels.get(r.accountId) ?? r.name, r.configured) + (r.configured && !r.active ? ' <span class="text-muted">(closed)</span>' : ''),
      r.openingDate ? money(r.openingBalance) : '<span class="text-muted">not set</span>',
      money(r.totalIn),
      money(r.totalOut),
      `<strong>${money(r.balance)}</strong>`
    ]),
    {
      sortable: true,
      cellDataSort: sortOn(rows, { 0: r => r.name, 1: r => r.openingBalance, 2: r => r.totalIn, 3: r => r.totalOut, 4: r => r.balance }),
      emptyMessage: 'No accounts.',
      footer: ['<strong>Total</strong>', money(sum(r => r.openingBalance)), money(sum(r => r.totalIn)), money(sum(r => r.totalOut)), `<strong>${money(sum(r => r.balance))}</strong>`]
    }
  );
  return table + disagreement(f, fundsTotal, sum(r => r.balance), currency);
}

/** Names to show for ids: funds, accounts, and each receipt's standing deposit number. */
interface Names { funds: Map<string, string>; accounts: Map<string, string>; depositOf: Map<string, string> }

/** One row of the entries table: a receipt, a refund, a deposit or a plain entry, each shown once (D-033). */
interface EntryRow {
  date: string; at: string; no: string; fund: string; account: string; category: string;
  moneyIn: number | null; moneyOut: number | null; party: string; memo: string; status: string;
}

function entriesTable(f: PluginFormatters, rows: EntryRow[], currency: string): string {
  const { escapeHtml, formatAsTable, formatMoney } = f;
  const money = (cents: number | null) => (cents === null ? '' : escapeHtml(formatMoney(cents, currency)));
  return formatAsTable(
    ['Date', 'No.', 'Fund', 'Account', 'Category', 'In', 'Out', 'Paid by / to', 'Memo', 'Status'],
    rows.map(r => [escapeHtml(r.date), r.no, r.fund, escapeHtml(r.account), r.category, money(r.moneyIn), money(r.moneyOut),
      escapeHtml(r.party), escapeHtml(r.memo), escapeHtml(r.status)]),
    {
      sortable: true,
      cellDataSort: sortOn(rows, { 1: r => r.no.replace(/<[^>]*>/g, ''), 5: r => r.moneyIn ?? '', 6: r => r.moneyOut ?? '' }),
      emptyMessage: 'No entries yet.'
    }
  );
}

/**
 * The entries table's rows, newest first: each receipt and refund once at its
 * total, with its lines listed in the Category cell; each deposit once (it moves
 * money between accounts, so no In or Out); every other entry as itself.
 */
async function entryRows(f: PluginFormatters, ledger: LedgerManager, actor: LedgerActor, names: Names, fund: string | undefined, includeVoided: boolean): Promise<EntryRow[]> {
  const { escapeHtml, formatMoney } = f;
  const currency = ledger.currencyCode();
  const labels = new Map(ledger.categories().map(c => [c.code, c.name]));
  const category = (code: string) => escapeHtml(labels.has(code) ? `${code} ${labels.get(code)}` : code);
  const fundName = (id: string) => escapeHtml(names.funds.get(id) ?? id);
  const status = (s: 'posted' | 'voided', reason: string | null, word = 'voided') => (s === 'voided' ? `${word}: ${reason ?? ''}` : 'posted');
  const documents = [...await ledger.listDocuments(actor, 'receipt', { includeVoided }), ...await ledger.listDocuments(actor, 'refund', { includeVoided })];
  const numbers = new Map(documents.map(d => [d.id, d.number ?? '']));
  const rows: EntryRow[] = [];
  for (const d of documents) {
    if (fund && !d.lines.some(l => l.fundId === fund)) continue;
    const funds = [...new Set(d.lines.map(l => l.fundId))];
    const split = d.lines.length > 1;
    const deposit = names.depositOf.get(d.id);
    const no = escapeHtml(d.number ?? '') + (deposit ? ` <span class="text-muted">(${escapeHtml(deposit)})</span>` : '')
      + (d.kind === 'refund' ? ` <span class="text-muted">(of ${escapeHtml(numbers.get(d.receiptId) ?? '')})</span>` : '');
    rows.push({
      date: d.date, at: d.createdAt, no,
      fund: funds.map(fundName).join(', '),
      account: names.accounts.get(d.accountId) ?? d.accountId,
      category: split
        ? `<ul class="list-unstyled small mb-0">${d.lines.map(l => `<li>${category(l.category)} · ${escapeHtml(formatMoney(l.amount, currency))}${funds.length > 1 ? ` · ${fundName(l.fundId)}` : ''}</li>`).join('')}</ul>`
        : category(d.lines[0]?.category ?? ''),
      moneyIn: d.kind === 'receipt' ? d.total : null, moneyOut: d.kind === 'refund' ? d.total : null,
      party: d.partyName ?? '', memo: d.memo, status: status(d.status, d.voidReason)
    });
  }
  for (const t of await ledger.listTransactions(actor, { fundId: fund, includeVoided })) {
    if (t.documentId || t.sourceType === 'deposit') continue;
    rows.push({
      date: t.date, at: t.createdAt, no: escapeHtml(t.confirmationNumber ?? ''), fund: fundName(t.fundId),
      account: names.accounts.get(t.accountId) ?? t.accountId, category: category(t.category),
      moneyIn: t.direction === 'in' ? t.amount : null, moneyOut: t.direction === 'out' ? t.amount : null,
      party: t.partyName ?? '', memo: t.memo, status: status(t.status, t.voidReason)
    });
  }
  if (!fund) {
    for (const d of await ledger.listDeposits(actor, { includeVoided })) {
      rows.push({
        date: d.date, at: d.createdAt, no: escapeHtml(d.number), fund: '',
        account: `${names.accounts.get(CASH_ON_HAND) ?? 'Cash on Hand'} → ${names.accounts.get(d.accountId) ?? d.accountId}`,
        category: 'deposit', moneyIn: null, moneyOut: null, party: '',
        memo: d.memo || `Deposit of ${formatMoney(d.total, currency)}`, status: status(d.status, d.voidReason, 'undone')
      });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
}

function depositsTable(f: PluginFormatters, deposits: Deposit[], names: Names & { receiptNumbers: Map<string, string> }, currency: string, emptyMessage = 'No deposits yet.'): string {
  const { escapeHtml, formatAsTable, formatMoney } = f;
  return formatAsTable(
    ['Number', 'Date', 'Account', 'Slip', 'Receipts', 'Total', 'Cleared', 'Status'],
    deposits.map(d => [
      escapeHtml(d.number),
      escapeHtml(d.date),
      escapeHtml(names.accounts.get(d.accountId) ?? d.accountId),
      escapeHtml(d.slipReference ?? ''),
      escapeHtml(d.receipts.map(r => names.receiptNumbers.get(r.receiptId) ?? r.receiptId).join(', ')),
      `<strong>${escapeHtml(formatMoney(d.total, currency))}</strong>`,
      d.clearedDate ? escapeHtml(d.clearedDate) : '<span class="text-muted">not cleared</span>',
      d.status === 'voided' ? `undone: ${escapeHtml(d.voidReason ?? '')}` : 'posted'
    ]),
    {
      sortable: true,
      cellDataSort: sortOn(deposits, { 0: d => d.number.slice(2).padStart(12, '0'), 5: d => d.total }),
      emptyMessage
    }
  );
}

function bouncesTable(f: PluginFormatters, bounces: Bounce[], currency: string, emptyMessage: string): string {
  const { escapeHtml, formatAsTable, formatMoney } = f;
  const money = (cents: number) => escapeHtml(formatMoney(cents, currency));
  return formatAsTable(
    ['Returned', 'Check', 'Paid by', 'Deposit', 'Check amount', 'Fee', 'Penalty', 'Owed', 'Repaid', 'Still owed'],
    bounces.map(b => [escapeHtml(b.date), escapeHtml(b.receiptNumber ?? ''), escapeHtml(b.partyName ?? ''), escapeHtml(b.depositNumber),
      money(b.checkAmount), money(b.fee), money(b.penalty), money(b.owed), money(b.repaid), `<strong>${money(b.stillOwed)}</strong>`]),
    {
      sortable: true,
      cellDataSort: sortOn(bounces, { 4: b => b.checkAmount, 5: b => b.fee, 6: b => b.penalty, 7: b => b.owed, 8: b => b.repaid, 9: b => b.stillOwed }),
      emptyMessage
    }
  );
}

/** The names the entries and deposits tables show; read as the viewer, who already needed ledger-read. */
async function namesFor(ledger: LedgerManager, actor: LedgerActor): Promise<Names> {
  const deposits = await ledger.listDeposits(actor);
  return {
    funds: new Map((await ledger.fundBalances(actor)).map(b => [b.fundId, b.name])),
    accounts: new Map((await ledger.listAccounts(actor)).map(a => [a.id, a.name])),
    depositOf: new Map(deposits.flatMap(d => d.receipts.map(r => [r.receiptId, d.number] as [string, string])))
  };
}

function summaryTables(f: PluginFormatters, s: PeriodSummary, withExport: boolean): string {
  const { escapeHtml, formatAsTable, formatMoney } = f;
  const money = (cents: number) => escapeHtml(formatMoney(cents, s.currency));
  const heading = `<p class="text-muted">${escapeHtml(s.period.from)} to ${escapeHtml(s.period.to)}</p>`;
  const funds = formatAsTable(
    ['Fund', 'Start', 'Opened', 'In', 'Out', 'End'],
    s.funds.map(f => [
      escapeHtml(f.name) + (f.active ? '' : ' <span class="text-muted">(closed)</span>'),
      money(f.start), f.opened ? money(f.opened) : '', money(f.moneyIn), money(f.moneyOut), `<strong>${money(f.end)}</strong>`
    ]),
    {
      sortable: true,
      cellDataSort: sortOn(s.funds, { 0: f => f.name, 1: f => f.start, 2: f => f.opened, 3: f => f.moneyIn, 4: f => f.moneyOut, 5: f => f.end }),
      emptyMessage: 'No funds in this period.',
      footer: ['<strong>Total</strong>', money(s.totals.start), s.totals.opened ? money(s.totals.opened) : '', money(s.totals.moneyIn), money(s.totals.moneyOut), `<strong>${money(s.totals.end)}</strong>`]
    }
  );
  const accounts = formatAsTable(
    ['Account', 'Start', 'Opened', 'In', 'Out', 'End'],
    s.accounts.map(a => [
      accountName(f, a.name, a.configured),
      money(a.start), a.opened ? money(a.opened) : '', money(a.moneyIn), money(a.moneyOut), `<strong>${money(a.end)}</strong>`
    ]),
    {
      sortable: true,
      cellDataSort: sortOn(s.accounts, { 0: a => a.name, 1: a => a.start, 2: a => a.opened, 3: a => a.moneyIn, 4: a => a.moneyOut, 5: a => a.end }),
      emptyMessage: 'No accounts.'
    }
  ) + disagreement(f, s.totals.end, s.accounts.reduce((total, a) => total + a.end, 0), s.currency);
  const net = s.totals.income - s.totals.expense;
  const categories = formatAsTable(
    ['Category', 'Income', 'Expense'],
    s.categories.map(c => [escapeHtml(c.label ? `${c.category} ${c.label}` : c.category), c.income ? money(c.income) : '', c.expense ? money(c.expense) : '']),
    {
      sortable: true,
      cellDataSort: sortOn(s.categories, { 1: c => c.income, 2: c => c.expense }),
      emptyMessage: 'No income or expense in this period.',
      footer: [`<strong>Total</strong> (net ${money(net)})`, money(s.totals.income), money(s.totals.expense)]
    }
  );
  const link = (kind: string, label: string) =>
    `<a class="btn btn-sm btn-outline-secondary me-2" href="/api/accounting/export?kind=${kind}&amp;from=${encodeURIComponent(s.period.from)}&amp;to=${encodeURIComponent(s.period.to)}">${label}</a>`;
  const downloads = withExport ? `<p>${link('transactions', 'Download entries (CSV)')}${link('funds', 'Download fund summary (CSV)')}</p>` : '';
  return `${heading}\n<h4>Funds</h4>\n${funds}\n<h4>Accounts</h4>\n<p class="text-muted small">The same money, by where it sits.</p>\n${accounts}\n<h4>Income and expense by category</h4>\n<p class="text-muted small">Transfers between funds are left out: they net to zero.</p>\n${categories}\n${downloads}`;
}

async function render(f: PluginFormatters, ledger: LedgerManager, actor: LedgerActor, params: PluginParams): Promise<string> {
  const { applyMax, parseBoolParam, parseMaxParam } = f;
  const view = String(params.view ?? 'balances');
  if (view === 'balances') {
    return balancesTable(f, await ledger.fundBalances(actor), ledger.currencyCode());
  }
  if (view === 'accounts') {
    const fundsTotal = (await ledger.fundBalances(actor)).reduce((total, b) => total + b.balance, 0);
    const labels = new Map((await ledger.listAccounts(actor)).map(a => [a.id, accountLabel(a)]));
    return accountsTable(f, await ledger.accountBalances(actor), labels, fundsTotal, ledger.currencyCode());
  }
  if (view === 'entries') {
    const fund = typeof params.fund === 'string' && params.fund !== '' ? params.fund : undefined;
    const includeVoided = parseBoolParam(params.voided as string | undefined, false);
    const max = parseMaxParam(params.max as string | number | undefined, DEFAULT_MAX_ENTRIES);
    const rows = await entryRows(f, ledger, actor, await namesFor(ledger, actor), fund, includeVoided);
    return entriesTable(f, applyMax(rows, max), ledger.currencyCode());
  }
  if (view === 'lock') {
    const status = await ledger.lockStatus(actor);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `<p>Periods are locked by <strong>${f.escapeHtml(status.period)}</strong>; the fiscal year starts in ${months[status.fiscalStartMonth - 1]}. `
      + (status.lockedThrough ? `Everything through <strong>${f.escapeHtml(status.lockedThrough)}</strong> is locked.</p>` : 'Nothing is locked yet.</p>');
  }
  if (view === 'bounces') {
    const settled = params.settled === undefined ? undefined : parseBoolParam(params.settled as string, true);
    return bouncesTable(f, await ledger.listBounces(actor, { settled }), ledger.currencyCode(),
      settled === false ? 'Nothing is owed on a bounced check.' : 'No bounced checks.');
  }
  if (view === 'deposits') {
    const all = await ledger.listDeposits(actor, { includeVoided: parseBoolParam(params.voided as string | undefined, false) });
    // cleared='false': deposits in transit, still waiting on the bank (D-032).
    const deposits = params.cleared === undefined ? all : all.filter(d => d.status === 'posted' && Boolean(d.clearedDate) === parseBoolParam(params.cleared as string, true));
    const receiptNumbers = new Map((await ledger.listDocuments(actor, 'receipt', { includeVoided: true })).map(d => [d.id, d.number ?? d.id]));
    return depositsTable(f, deposits, { ...(await namesFor(ledger, actor)), receiptNumbers }, ledger.currencyCode(), params.cleared === undefined ? undefined : 'Every deposit is cleared.');
  }
  if (view === 'summary') {
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const period = ledger.period({ month: str(params.month), from: str(params.from), to: str(params.to) });
    return summaryTables(f, await ledger.periodSummary(actor, period), parseBoolParam(params.export as string | undefined, false));
  }
  return note(f, `Ledger: unknown view '${view}'; use balances, accounts, entries, deposits, bounces, lock or summary.`);
}

/**
 * The tables for one view, read as `actor` (the request's context). A refusal
 * or a bad parameter is a short note, not an error page.
 */
export async function renderLedgerView(f: PluginFormatters, ledger: LedgerManager, actor: LedgerActor, params: PluginParams): Promise<string> {
  try {
    return await render(f, ledger, actor, params);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return note(f, 'You may not see the ledger.');
    if (status === 400) return note(f, `Ledger: ${(err as Error).message}`);
    return note(f, 'The ledger could not be shown.');
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
  async execute(context: { engine: { getManager<T = unknown>(name: string): T | null | undefined }; userContext?: unknown; formatters: PluginFormatters }, params: PluginParams): Promise<string> {
    const ledger = context.engine.getManager<LedgerManager>('LedgerManager');
    if (!ledger) return note(context.formatters, 'The ledger is not available on this site.');
    return renderLedgerView(context.formatters, ledger, ledger.viewerActor(context.userContext), params);
  }
};

export default LedgerPlugin;
