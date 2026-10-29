/**
 * Dues and assessments for ngdpbase's accounting add-on (D-035). Invoices are
 * kept in this add-on's own database, outside the ledger, which holds only
 * money that moved; a payment is a receipt line with `receivable` details, registered
 * here with the accounting add-on's LedgerManager. It calls the accounting
 * add-on's managers and never its database.
 *
 * Configuration keys:
 *   ngdpbase.addons.accounting-receivables.enabled           — true/false (defaults to false)
 *   ngdpbase.addons.accounting-receivables.accounts-manager  — the manager holding the accounts billed (AccommodationManager)
 *   ngdpbase.addons.accounting-receivables.billing-manager   — the manager holding each account's billing parties (ResidencyManager)
 *   ngdpbase.addons.accounting-receivables.categories        — chart codes a payment may use; the first is what invoices charge
 *   ngdpbase.addons.accounting-receivables.label             — { "singular": "Assessment", "plural": "Assessments" }
 *   ngdpbase.addons.accounting-receivables.organization      — { "name", "address", "pay-to" } on every invoice
 *
 * The exported `name` MUST equal `ngdpbase.slug` in package.json.
 */
import type { ActorContext, AddonHost, BackgroundJobManager, Decision, PluginFormatters } from '@jwilleke/ngdpbase-types';
import { receivableValidator, RETIRED_KIND, retiredKind } from './billing.js';
import { registerReceivableForms } from './forms.js';
import { receivablesExecutiveCard, registerExecutiveCard, type CardRegistry } from './executive.js';
import ReceivablesManager, { accountLabel, type AccountSource, type BillingSource, type ReceivablesDb, type ReceivablesOptions, type IdentitySource, type LedgerLike as ReceivablesLedger } from './managers/ReceivablesManager.js';
import { RECEIVABLES_LEDGER_TABLE, RECEIVABLES_MIGRATIONS } from './managers/migrations.js';
import ReceivablesPlugin from './plugins/ReceivablesPlugin.js';
import receivableRoutes from './routes/api.js';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  registerManager(name: string, manager: unknown): void;
  app?: { use(route: string, handler: unknown): void };
  createRouter(): import('express').Router;
}

/** The slice of the accounting add-on's LedgerManager this add-on calls. */
interface LedgerLike extends ReceivablesLedger {
  registerLineDetails(kind: string, definition: ReturnType<typeof receivableValidator>): { lines(): { amount: number; details: Record<string, unknown> }[] };
}

interface DatabaseManagerLike {
  isEnabled(): boolean;
  openAddonDatabase<Handle>(owner: string, options: { migrations: unknown[]; ledgerTable: string }): Handle;
}

let unavailable: string | null = 'not registered yet';

/** The scheduled invoice run's job id (D-035): its own policy and its paused switch name it. */
export const ISSUE_JOB = 'accounting-receivables.issue-invoices';

/**
 * The month's invoices on the 1st at 06:00, in the site's time zone (D-035,
 * #11). Shipped paused (`ngdpbase.jobs.accounting-receivables.issue-invoices.enabled`
 * is false here); a site resumes it on Admin → Scheduled Jobs and moves the day
 * with BackgroundJobManager's own keys. A scheduled run acts as the job, which
 * this add-on's policy grants only invoice-issue and ledger-read; Run now acts
 * as the admin who clicked.
 */
function registerScheduledRun(engine: Engine, host: AddonHost, dues: ReceivablesManager): void {
  const jobs = engine.getManager<Pick<BackgroundJobManager, 'registerJob' | 'scheduleTimeZone'>>('BackgroundJobManager');
  if (!jobs) { host.logger.warn('[accounting-receivables] BackgroundJobManager is not running: the scheduled invoice run is off'); return; }
  jobs.registerJob({
    id: ISSUE_JOB,
    displayName: 'Accounting Receivables — Issue the month\'s invoices',
    schedule: 'start-of-month 06:00',
    catchUp: 'latest',
    overlap: 'skip',
    async run(_progress, ctx) {
      // The local month the slot falls in, as core says (#1998); a run started by hand is this month.
      const { year, month } = host.zonedParts(ctx.slot ? new Date(ctx.slot) : new Date(), jobs.scheduleTimeZone());
      const actor = {
        ipAddress: undefined, subject: ctx, actingUsername: () => ctx.username,
        enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
      };
      return dues.scheduledRun(actor, `${year}-${String(month).padStart(2, '0')}`);
    }
  });
}
/** What the profile card needs, set by register() (ngdpbase's profile hook, #534, calls the module, not a manager). */
let profile: { dues: ReceivablesManager; f: PluginFormatters; money(minor: number): string; title: () => string } | null = null;

const AccountingReceivablesAddon = {
  name: 'accounting-receivables',
  version: '0.5.0',
  description: 'Receivables: monthly invoices for assessments, rent or dues; payments, credits and late charges',
  author: 'jwilleke',
  dependencies: ['accounting'],
  optionalDependencies: ['forms', 'accommodation'],

  async register(engine: Engine, _config: Record<string, unknown>, host: AddonHost): Promise<void> {
    const ledger = engine.getManager<LedgerLike>('LedgerManager');
    if (!ledger) {
      unavailable = 'the accounting add-on is not running';
      host.logger.warn(`[accounting-receivables] Not started: ${unavailable}`);
      return;
    }
    const databases = engine.getManager<DatabaseManagerLike>('DatabaseManager');
    if (!databases?.isEnabled()) {
      unavailable = "the site's database is off";
      host.logger.warn(`[accounting-receivables] Not started: ${unavailable}`);
      return;
    }
    const db = databases.openAddonDatabase<ReceivablesDb>('accounting-receivables', { migrations: RECEIVABLES_MIGRATIONS, ledgerTable: RECEIVABLES_LEDGER_TABLE });
    const auditSink = engine.getManager<Parameters<typeof host.recordAuditEvent>[0]>('AuditManager');
    const pdp = engine.getManager<{ decide(subject: unknown, request: { action: string }): Promise<Decision> }>('PolicyDecisionPoint');
    const config = engine.getManager<{ getProperty(key: string, fallback?: unknown): unknown }>('ConfigurationManager');
    const plugins = engine.getManager<{ formatters: { formatMoney(minor: number, currency: string): string } }>('PluginManager');
    const setting = (key: string, fallback: unknown) => config?.getProperty(`ngdpbase.addons.accounting-receivables.${key}`, fallback);
    const str = (v: unknown, fallback = '') => (typeof v === 'string' && v !== '' ? v : fallback);
    const sourceName = str(setting('accounts-manager', 'AccommodationManager'), 'AccommodationManager');
    const accounts = () => engine.getManager<AccountSource>(sourceName);
    const billingName = str(setting('billing-manager', 'ResidencyManager'), 'ResidencyManager');
    const billing = () => engine.getManager<BillingSource>(billingName);
    const categories = () => {
      const value = setting('categories', []);
      return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
    };
    // The owner bumps (ngdpbase caching guide): pages that show invoices re-render after each write.
    const cache = engine.getManager<{ bump(topic: string): Promise<unknown> }>('CacheManager');
    const label = () => {
      const l = (setting('label', {}) ?? {}) as Record<string, unknown>;
      return { singular: str(l.singular, 'Charge'), plural: str(l.plural, 'Charges') };
    };
    const formatMoney = (minor: number) => plugins?.formatters.formatMoney(minor, ledger.currencyCode()) ?? String(minor);
    // The ledger's reader of this add-on's own `receivable` lines, handed over when the kind is registered below.
    let receivableLines: { lines(): { amount: number; details: Record<string, unknown> }[] } | null = null;
    let retiredLines: { lines(): { amount: number; details: Record<string, unknown> }[] } | null = null;
    const dues = new ReceivablesManager({
      host, db, ledger, accounts, billing, categories, payments: () => [...(receivableLines?.lines() ?? []), ...(retiredLines?.lines() ?? [])],
      identities: () => engine.getManager<IdentitySource>('IdentityManager'), accountsManager: sourceName,
      changed: async () => { await cache?.bump('ReceivablesManager'); },
      sendToOwners: () => setting('send-to-owners', false) === true,
      label,
      wording: () => {
        const org = (setting('organization', {}) ?? {}) as Record<string, unknown>;
        return { organization: { name: str(org.name), address: str(org.address), payTo: str(org['pay-to']) } };
      },
      formatMoney,
      email: () => engine.getManager<NonNullable<ReturnType<NonNullable<ReceivablesOptions['email']>>>>('EmailManager'),
      notifyIssuers: async (title, message) => {
        // The holders of invoice-issue (ngdpbase: notify a permission's holders, never a role name). No one
        // holding it means log only: an empty targetUsers would notify everyone.
        const holders = await engine.getManager<{ usersHolding(permission: string): Promise<string[] | null> }>('PolicyDecisionPoint')?.usersHolding('invoice-issue');
        if (!holders?.length) { host.logger.info(`[accounting-receivables] ${title}: ${message} (no one holds invoice-issue to tell)`); return; }
        await engine.getManager<{ addNotification(n: Record<string, unknown>): Promise<unknown> }>('NotificationManager')
          ?.addNotification({ type: 'system', level: 'info', title, message, targetUsers: holders });
      },
      pdf: () => engine.getManager<NonNullable<ReturnType<NonNullable<ReceivablesOptions['pdf']>>>>('ExportManager'),
      recordAudit: async (record) => { await host.recordAuditEvent(auditSink, { ...record, result: 'success' } as never); },
      decide: async (subject, request) => (pdp ? pdp.decide(subject, request) : { permit: false, applicable: false, reason: 'no_decision_point' })
    });
    receivableLines = ledger.registerLineDetails('receivable', receivableValidator({ categories, accountExists: (id) => dues.accountExists(id), invoiceOf: (id) => dues.invoiceOf(id),
      assignedFolioId: (account) => dues.assignedFolioId(account), folioOfAccount: (account, folio) => dues.folioOfAccount(account, folio) }));
    // Payments recorded before the rename: read as they are, never rewritten; no new ones (ngdpbase#2042).
    retiredLines = ledger.registerLineDetails(RETIRED_KIND, retiredKind);
    engine.registerManager('ReceivablesManager', dues);
    await engine.getManager<{ registerPlugin(name: string, plugin: unknown): Promise<void> }>('PluginManager')?.registerPlugin('Receivables', ReceivablesPlugin);
    engine.app?.use('/api/accounting-receivables', receivableRoutes(engine, host));
    await registerReceivableForms(engine, host, (id) => {
      const unit = accounts()?.get(id);
      return unit ? accountLabel(unit) : id;
    });
    // The board's card on core's Executive Hub (ngdpbase#2094, D-050), for holders of account-read.
    registerExecutiveCard(engine.getManager<CardRegistry>('AddonsManager'), receivablesExecutiveCard(dues, formatMoney, label));
    if (!accounts()) host.logger.warn(`[accounting-receivables] ${sourceName} is not running: there are no accounts to bill until it is`);
    registerScheduledRun(engine, host, dues);
    if (!billing()) host.logger.warn(`[accounting-receivables] ${billingName} is not running: no invoice can be issued until it is`);
    const fmt = engine.getManager<{ formatters: PluginFormatters }>('PluginManager')?.formatters;
    // Core's formatters (escapeHtml, formatAsTable); without them the card stays off rather than build HTML by hand.
    profile = fmt ? { dues, f: fmt, money: formatMoney, title: () => `Your ${label().plural.toLowerCase()}` } : null;
    unavailable = null;
    host.logger.info('[accounting-receivables] Invoices ready');
  },

  /**
   * The signed-in owner's own bills on their profile (D-044, D-047): for each
   * unit they own today, its whole account, every billing entry's invoices with
   * what is paid and left, and the unit's balance; for a unit they no longer
   * own, the invoices issued while they did. Nothing for someone never billed.
   */
  async profileSection(user: { username: string }, ctx: ActorContext): Promise<{ title: string; html: string } | null> {
    if (!profile) return null;
    // The signed-in user's own context, as core's profile hook hands it (ngdpbase #2018).
    const actor = {
      ipAddress: undefined, actingUsername: () => user.username, subject: ctx,
      enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
    };
    let units;
    try { units = await profile.dues.myAccounts(actor); } catch { return null; }
    if (!units.length) return null;
    const { f, money } = profile;
    const esc = (s: string) => f.escapeHtml(s);
    const balance = (m: number) => esc(m < 0 ? `${money(-m)} credit` : money(m));
    const html = units.map(u => `<p><strong>${esc(u.label)}</strong> · ${esc(u.folio)}${u.current ? '' : ' · from when you were an owner'} · balance <strong>${balance(u.balance)}</strong></p>`
      + f.formatAsTable(['Invoice', 'Month', 'Due', 'Billed to', 'Charged', 'Paid', 'Left to pay'],
        u.invoices.map(i => [`<a href="/api/accounting-receivables/my-invoices/${encodeURIComponent(i.id)}">${esc(i.number)}</a>`, esc(i.month), esc(i.dueDate), esc(i.billedTo),
          esc(money(i.total)), esc(money(i.paid)), esc(money(i.remaining))]))).join('');
    return { title: profile.title(), html };
  },

  status(): { healthy: boolean; message: string } {
    return unavailable ? { healthy: false, message: `Invoices are off: ${unavailable}` } : { healthy: true, message: 'Invoices ready' };
  }
};

export default AccountingReceivablesAddon;
