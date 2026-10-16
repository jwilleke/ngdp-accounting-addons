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
 *   ngdpbase.addons.accounting.categories — { "<UCOA code>": "<label>" } for the entry form (D-023)
 *
 * With the forms add-on enabled, the treasurer's screens are forms on locked
 * pages this add-on ships (forms.ts, pages/).
 *
 * The exported `name` MUST equal `ngdpbase.slug` in package.json (#927).
 */
import type { Decision } from '../../dist/src/types/Policy.js';
import type { AddonHost } from '../../dist/src/utils/addonHost.js';
import apiRoutes from './routes/api.js';
import { registerForms } from './forms.js';
import LedgerPlugin from './plugins/LedgerPlugin.js';
import LedgerManager, { type LedgerDb, type RecordAudit } from './managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from './managers/migrations.js';

interface PolicyDecisionPointLike { decide(subject: unknown, request: { action: string }): Promise<Decision> }
interface PluginManagerLike { registerPlugin(name: string, plugin: unknown): Promise<void> }
interface CacheManagerLike { bump(topic: string): Promise<unknown> }

/** Until ngdpbase ships a site-wide currency (ngdpbase#1711). */
const FALLBACK_CURRENCY = 'USD';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  registerManager(name: string, manager: unknown): void;
  app?: { use(route: string, handler: unknown): void };
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
    const categories = (): Record<string, string> => {
      const value = config?.getProperty('ngdpbase.addons.accounting.categories', {});
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
    };

    // The owner bumps (ngdpbase caching guide): pages that read the ledger re-render after each write.
    const cache = engine.getManager<CacheManagerLike>('CacheManager');
    const dataChanged = async (): Promise<void> => { await cache?.bump('LedgerManager'); };

    engine.registerManager('LedgerManager', new LedgerManager({ host, db, recordAudit, currency, decide, categories, dataChanged }));
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
