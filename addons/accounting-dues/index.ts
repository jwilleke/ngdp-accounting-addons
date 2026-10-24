/**
 * Dues and assessments for ngdpbase's accounting add-on (D-035). Invoices are
 * kept in this add-on's own database, outside the ledger, which holds only
 * money that moved; a payment is a receipt line with `dues` details, registered
 * here with the accounting add-on's LedgerManager. It calls the accounting
 * add-on's managers and never its database.
 *
 * Configuration keys:
 *   ngdpbase.addons.accounting-dues.enabled           — true/false (defaults to false)
 *   ngdpbase.addons.accounting-dues.accounts-manager  — the manager holding the accounts billed (AccommodationManager)
 *   ngdpbase.addons.accounting-dues.billing-manager   — the manager holding each account's billing parties (ResidencyManager)
 *   ngdpbase.addons.accounting-dues.categories        — chart codes a payment may use; the first is what invoices charge
 *   ngdpbase.addons.accounting-dues.label             — { "singular": "Assessment", "plural": "Assessments" }
 *   ngdpbase.addons.accounting-dues.organization      — { "name", "address", "pay-to" } on every invoice
 *
 * The exported `name` MUST equal `ngdpbase.slug` in package.json.
 */
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import { duesValidator } from './billing.js';
import { registerDuesForms } from './forms.js';
import DuesManager, { accountLabel, type AccountSource, type BillingSource, type DuesDb, type LedgerLike as DuesLedger } from './managers/DuesManager.js';
import { DUES_LEDGER_TABLE, DUES_MIGRATIONS } from './managers/migrations.js';
import DuesPlugin from './plugins/DuesPlugin.js';
import duesRoutes from './routes/api.js';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  registerManager(name: string, manager: unknown): void;
  app?: { use(route: string, handler: unknown): void };
  createRouter(): import('express').Router;
}

/** The slice of the accounting add-on's LedgerManager this add-on calls. */
interface LedgerLike extends DuesLedger {
  registerLineDetails(kind: string, definition: ReturnType<typeof duesValidator>): { lines(): { amount: number; details: Record<string, unknown> }[] };
}

interface DatabaseManagerLike {
  isEnabled(): boolean;
  openAddonDatabase<Handle>(owner: string, options: { migrations: unknown[]; ledgerTable: string }): Handle;
}

let unavailable: string | null = 'not registered yet';
/** What the profile card needs, set by register() (ngdpbase's profile hook, #534, calls the module, not a manager). */
let profile: { dues: DuesManager; escapeHtml(s: string): string; money(minor: number): string; title: () => string } | null = null;

const AccountingDuesAddon = {
  name: 'accounting-dues',
  version: '0.1.0',
  description: 'Dues and assessments: monthly invoices, payments, credits and late charges',
  author: 'jwilleke',
  dependencies: ['accounting'],
  optionalDependencies: ['forms', 'accommodation'],

  async register(engine: Engine, _config: Record<string, unknown>, host: AddonHost): Promise<void> {
    const ledger = engine.getManager<LedgerLike>('LedgerManager');
    if (!ledger) {
      unavailable = 'the accounting add-on is not running';
      host.logger.warn(`[accounting-dues] Not started: ${unavailable}`);
      return;
    }
    const databases = engine.getManager<DatabaseManagerLike>('DatabaseManager');
    if (!databases?.isEnabled()) {
      unavailable = "the site's database is off";
      host.logger.warn(`[accounting-dues] Not started: ${unavailable}`);
      return;
    }
    const db = databases.openAddonDatabase<DuesDb>('accounting-dues', { migrations: DUES_MIGRATIONS, ledgerTable: DUES_LEDGER_TABLE });
    const auditSink = engine.getManager<Parameters<typeof host.recordAuditEvent>[0]>('AuditManager');
    const pdp = engine.getManager<{ decide(subject: unknown, request: { action: string }): Promise<Decision> }>('PolicyDecisionPoint');
    const config = engine.getManager<{ getProperty(key: string, fallback?: unknown): unknown }>('ConfigurationManager');
    const plugins = engine.getManager<{ formatters: { formatMoney(minor: number, currency: string): string } }>('PluginManager');
    const setting = (key: string, fallback: unknown) => config?.getProperty(`ngdpbase.addons.accounting-dues.${key}`, fallback);
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
      return { singular: str(l.singular, 'Dues'), plural: str(l.plural, 'Dues') };
    };
    const formatMoney = (minor: number) => plugins?.formatters.formatMoney(minor, ledger.currencyCode()) ?? String(minor);
    // The ledger's reader of this add-on's own `dues` lines, handed over when the kind is registered below.
    let duesLines: { lines(): { amount: number; details: Record<string, unknown> }[] } | null = null;
    const dues = new DuesManager({
      host, db, ledger, accounts, billing, categories, payments: () => duesLines?.lines() ?? [], accountsManager: sourceName,
      changed: async () => { await cache?.bump('DuesManager'); },
      sendToOwners: () => setting('send-to-owners', false) === true,
      label,
      wording: () => {
        const org = (setting('organization', {}) ?? {}) as Record<string, unknown>;
        return { organization: { name: str(org.name), address: str(org.address), payTo: str(org['pay-to']) } };
      },
      formatMoney,
      email: () => engine.getManager<{ sendTo(to: string, subject: string, text: string, html?: string): Promise<void> }>('EmailManager'),
      recordAudit: async (record) => { await host.recordAuditEvent(auditSink, { ...record, result: 'success' } as never); },
      decide: async (subject, request) => (pdp ? pdp.decide(subject, request) : { permit: false, applicable: false, reason: 'no_decision_point' })
    });
    duesLines = ledger.registerLineDetails('dues', duesValidator({ categories, accountExists: (id) => dues.accountExists(id), invoiceOf: (id) => dues.invoiceOf(id), partiesOf: (id) => dues.partiesOf(id) }));
    engine.registerManager('DuesManager', dues);
    await engine.getManager<{ registerPlugin(name: string, plugin: unknown): Promise<void> }>('PluginManager')?.registerPlugin('Dues', DuesPlugin);
    engine.app?.use('/api/accounting-dues', duesRoutes(engine, host));
    await registerDuesForms(engine, host, (id) => {
      const unit = accounts()?.get(id);
      return unit ? accountLabel(unit) : id;
    });
    if (!accounts()) host.logger.warn(`[accounting-dues] ${sourceName} is not running: there are no accounts to bill until it is`);
    if (!billing()) host.logger.warn(`[accounting-dues] ${billingName} is not running: no invoice can be issued until it is`);
    const fmt = engine.getManager<{ formatters: { escapeHtml(s: string): string } }>('PluginManager')?.formatters;
    // Core's escaper (PluginManager formatters); without it the card stays off rather than escape by hand.
    profile = fmt ? { dues, escapeHtml: (s) => fmt.escapeHtml(s), money: formatMoney, title: () => `Your ${label().plural.toLowerCase()}` } : null;
    unavailable = null;
    host.logger.info('[accounting-dues] Invoices ready');
  },

  /**
   * The signed-in owner's own bills on their profile (D-037, D-038): for each
   * billing party they are on, its invoices, what is paid and left, and the
   * balance. Nothing for someone who is billed nothing.
   */
  async profileSection(user: { username: string }, ctx: ActorContext): Promise<{ title: string; html: string } | null> {
    if (!profile) return null;
    // The signed-in user's own context, as core's profile hook hands it (ngdpbase #2018).
    const actor = {
      ipAddress: undefined, actingUsername: () => user.username, subject: ctx,
      enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
    };
    let parties;
    try { parties = await profile.dues.myDues(actor); } catch { return null; }
    if (!parties.length) return null;
    const { escapeHtml: esc, money } = profile;
    const balance = (m: number) => esc(m < 0 ? `${money(-m)} credit` : money(m));
    const html = parties.map(p => `<p><strong>${esc(p.label)}</strong> · ${esc(p.partyName)} · balance <strong>${balance(p.balance)}</strong></p>`
      + '<table class="table table-sm"><thead><tr><th>Invoice</th><th>Month</th><th>Due</th><th class="text-end">Charged</th><th class="text-end">Paid</th><th class="text-end">Left to pay</th></tr></thead><tbody>'
      + p.invoices.map(i => `<tr><td><a href="/api/accounting-dues/my-invoices/${encodeURIComponent(i.id)}">${esc(i.number)}</a></td><td>${esc(i.month)}</td><td>${esc(i.dueDate)}</td>`
        + `<td class="text-end">${esc(money(i.total))}</td><td class="text-end">${esc(money(i.paid))}</td><td class="text-end">${esc(money(i.remaining))}</td></tr>`).join('')
      + '</tbody></table>').join('');
    return { title: profile.title(), html };
  },

  status(): { healthy: boolean; message: string } {
    return unavailable ? { healthy: false, message: `Dues are off: ${unavailable}` } : { healthy: true, message: 'Invoices ready' };
  }
};

export default AccountingDuesAddon;
