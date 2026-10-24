/**
 * Accounting add-on for ngdpbase: the base add-on, holding the shared ledger
 * (docs/plans/ledger-design.md, decision D-016).
 *
 * register() opens the accounting database through ngdpbase's DatabaseManager
 * (the one path to a database), builds the audit door on ngdpbase's
 * recordAuditEvent, registers LedgerManager, and mounts the API. When the site
 * has not turned the database on, the add-on mounts nothing and says why in
 * status().
 *
 * Configuration keys:
 *   ngdpbase.addons.accounting.enabled — true/false (defaults to false)
 *   ngdpbase.default.currency          — ISO 4217 code read from ngdpbase; USD until ngdpbase ships it
 *   ngdpbase.addons.accounting.categories — { "<code>": { "name", "type", "detailType" } }, the chart (D-023, D-034)
 *   ngdpbase.addons.accounting.bank-charges-category, .other-income-category, .bounced-check-penalty (D-032)
 *   ngdpbase.addons.accounting.accounts — { "<id>": { "name", "kind": "bank", "default", "active" } } bank accounts (D-031)
 *   ngdpbase.addons.accounting.receiptproviders — [{ "id": "manual", "enabled": true }, …] (D-017, D-029)
 *
 * With the forms add-on enabled, the treasurer's screens are forms on locked
 * pages this add-on ships (forms.ts, pages/).
 *
 * The exported `name` MUST equal `ngdpbase.slug` in package.json (#927).
 */
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import apiRoutes from './routes/api.js';
import { registerForms } from './forms.js';
import LedgerPlugin from './plugins/LedgerPlugin.js';
import LedgerManager, { accountsFrom, categoriesFrom, type LedgerDb, type RecordAudit } from './managers/LedgerManager.js';
import ReceiptManager, { receiptProvidersFrom } from './managers/ReceiptManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from './managers/migrations.js';

interface PolicyDecisionPointLike { decide(subject: unknown, request: { action: string }): Promise<Decision> }
interface PluginManagerLike { registerPlugin(name: string, plugin: unknown): Promise<void> }
interface CacheManagerLike { bump(topic: string): Promise<unknown> }
interface PluginManagerFormatters { formatters: { formatMoney(minor: number, currency: string): string } }
interface ExportManagerLike { toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string }

/** Until ngdpbase ships a site-wide currency (ngdpbase#1711). */
const FALLBACK_CURRENCY = 'USD';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  registerManager(name: string, manager: unknown): void;
  app?: { use(route: string, handler: unknown): void };
  createRouter(): import('express').Router;
}

interface DatabaseManagerLike {
  isEnabled(): boolean;
  openAddonDatabase<Handle>(owner: string, options: { migrations: unknown[]; ledgerTable: string }): Handle;
}

let unavailable: string | null = 'not registered yet';

const AccountingAddon = {
  name: 'accounting',
  version: '0.1.0',
  description: 'Accounting for ngdpbase: funds, a single-entry ledger and its audit trail',
  author: 'jwilleke',
  dependencies: [] as string[],
  // Forms carries the treasurer's screens: load it first when the site has it, but run
  // without it (the ledger API still works). ngdpbase v5.9.0 (#1808); older cores ignore it.
  optionalDependencies: ['forms'],

  // Core values arrive as `host` (ngdpbase v5.11.0, #1813), never imported from core's files.
  async register(engine: Engine, _config: Record<string, unknown>, host: AddonHost): Promise<void> {
    const { logger, recordAuditEvent } = host;
    const databases = engine.getManager<DatabaseManagerLike>('DatabaseManager');
    if (!databases?.isEnabled()) {
      unavailable = "the site's database is off — set ngdpbase.database.provider to 'sqlite' and restart";
      logger.warn(`[accounting] Not started: ${unavailable}`);
      return;
    }

    const db = databases.openAddonDatabase<LedgerDb>('accounting', {
      migrations: ACCOUNTING_MIGRATIONS,
      ledgerTable: ACCOUNTING_LEDGER_TABLE
    });

    const auditSink = engine.getManager<Parameters<typeof recordAuditEvent>[0]>('AuditManager');
    const recordAudit: RecordAudit = async (record) => {
      // A refuse event that cannot be written throws here, and the money action stops.
      await recordAuditEvent(auditSink, { ...record, result: 'success' });
    };

    const config = engine.getManager<{ getProperty(key: string, fallback?: unknown): unknown }>('ConfigurationManager');
    const configured = config?.getProperty('ngdpbase.default.currency', FALLBACK_CURRENCY);
    const currency = typeof configured === 'string' && configured !== '' ? configured : FALLBACK_CURRENCY;

    const pdp = engine.getManager<PolicyDecisionPointLike>('PolicyDecisionPoint');
    // The ledger asks ngdpbase's decision point for every action (D-025).
    const decide = async (subject: unknown, request: { action: string }): Promise<Decision> =>
      pdp ? pdp.decide(subject, request) : { permit: false, applicable: false, reason: 'no_decision_point' };
    const categories = (): unknown => config?.getProperty('ngdpbase.addons.accounting.categories', {});

    const accounts = (): unknown => config?.getProperty('ngdpbase.addons.accounting.accounts', {});
    const bouncedChecks = () => ({
      bankChargesCategory: config?.getProperty('ngdpbase.addons.accounting.bank-charges-category', ''),
      otherIncomeCategory: config?.getProperty('ngdpbase.addons.accounting.other-income-category', ''),
      penalty: config?.getProperty('ngdpbase.addons.accounting.bounced-check-penalty', 0)
    });

    // The owner bumps (ngdpbase caching guide): pages that read the ledger re-render after each write.
    const cache = engine.getManager<CacheManagerLike>('CacheManager');
    const dataChanged = async (): Promise<void> => { await cache?.bump('LedgerManager'); };

    // Shared capabilities belong to their manager (ngdpbase v5.12.0): the money
    // formatter to PluginManager (#1820), the one CSV writer to ExportManager (#1819).
    const managerOf = <T>(name: string): T => {
      const manager = engine.getManager<T>(name);
      if (!manager) throw new Error(`accounting: ngdpbase's ${name} is not available`);
      return manager;
    };
    const formatMoney = (minor: number, code: string): string =>
      managerOf<PluginManagerFormatters>('PluginManager').formatters.formatMoney(minor, code);
    const toCsv: ExportManagerLike['toCsv'] = (headers, rows) => managerOf<ExportManagerLike>('ExportManager').toCsv(headers, rows);

    // A person's own receipts (D-037): core's person for a username, read when asked.
    const personOf = async (actor: { readonly subject: ActorContext | null; actingUsername(): string }): Promise<string | null> => {
      if (!actor.subject) return null;
      const persons = engine.getManager<{ getByUserIdentifier(ctx: ActorContext, u: string): Promise<{ '@id': string } | null> }>('PersonManager');
      return (await persons?.getByUserIdentifier(actor.subject, actor.actingUsername()))?.['@id'] ?? null;
    };
    const ledger = new LedgerManager({ host, db, recordAudit, currency, decide, categories, accounts, bouncedChecks, dataChanged, formatMoney, toCsv, personOf });
    engine.registerManager('LedgerManager', ledger);
    // Say once, at startup, what the account configuration gets wrong; history is never lost (D-031).
    accountsFrom(accounts(), (m) => logger.warn(m));
    // The chart, and the two categories a bounced check needs (D-032, D-034).
    const chart = new Map(categoriesFrom(categories(), (m) => logger.warn(m)).map(c => [c.code, c]));
    for (const [key, wanted] of [['bank-charges-category', 'expense'], ['other-income-category', 'other-income']] as const) {
      const code = config?.getProperty(`ngdpbase.addons.accounting.${key}`, '');
      const found = typeof code === 'string' ? chart.get(code) : undefined;
      if (!found) logger.warn(`[accounting] ${key} names no category in the chart: the bounced-check form stays off until it does`);
      else if (found.type !== wanted) logger.warn(`[accounting] ${key} names '${found.code} ${found.name}', a ${found.type} category; expected ${wanted}`);
    }
    for (const id of ledger.droppedAccounts()) {
      logger.warn(`[accounting] account '${id}' is named by ledger entries but no longer configured: it is shown as no longer configured`);
    }
    // Money coming in, through the providers the site enables (D-028, D-029); the manual provider is always there.
    const receiptProviders = receiptProvidersFrom(config?.getProperty('ngdpbase.addons.accounting.receiptproviders', []), (m) => logger.warn(m));
    engine.registerManager('ReceiptManager', new ReceiptManager(ledger, receiptProviders));
    engine.app?.use('/api/accounting', apiRoutes(engine, host));
    await engine.getManager<PluginManagerLike>('PluginManager')?.registerPlugin('Ledger', LedgerPlugin);
    await registerForms(engine, host);
    unavailable = null;
    logger.info(`[accounting] Ledger ready (currency ${currency})`);
  },

  /** Surfaced in the admin add-on dashboard. */
  status(): { healthy: boolean; message: string } {
    return unavailable ? { healthy: false, message: `Accounting is off: ${unavailable}` } : { healthy: true, message: 'Ledger ready' };
  }
};

export default AccountingAddon;
