/**
 * Donations for ngdpbase's accounting add-on (D-036; docs/guides/donations-guide.md,
 * the source of truth). A gift is a receipt line with gift details: this
 * add-on registers the `gift` kind and the receipt slip's quid pro quo
 * disclosure with the accounting add-on's LedgerManager, and ships the gift
 * screen. It calls the accounting add-on's managers and never its database
 * (operator, 2026-10-20).
 *
 * Configuration keys:
 *   ngdpbase.addons.accounting-donations.enabled     — true/false (defaults to false)
 *   ngdpbase.addons.accounting-donations.categories  — chart codes a gift may use, e.g. ["4200"]
 *   ngdpbase.addons.accounting-donations.wording     — { "quid-pro-quo": "…{amount}…{deductible}…{goods}…{value}" }
 *
 * The exported `name` MUST equal `ngdpbase.slug` in package.json.
 */
import type { AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import { DEFAULT_QUID_PRO_QUO, giftSlipNotes, giftValidator, type GiftSettings, type ReceiptLike } from './gift.js';
import { registerGiftForms } from './forms.js';
import DonationManager, { type DonationsDb, type LedgerLike as DonationLedger } from './managers/DonationManager.js';
import { DONATIONS_LEDGER_TABLE, DONATIONS_MIGRATIONS } from './managers/migrations.js';
import DonationsPlugin from './plugins/DonationsPlugin.js';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  registerManager(name: string, manager: unknown): void;
}

/** The slice of the accounting add-on's LedgerManager this add-on calls. */
interface LedgerLike extends DonationLedger {
  registerLineDetails(kind: string, definition: ReturnType<typeof giftValidator>): void;
  registerSlipNotes(notes: (receipt: ReceiptLike) => string[]): void;
}

interface DatabaseManagerLike {
  isEnabled(): boolean;
  openAddonDatabase<Handle>(owner: string, options: { migrations: unknown[]; ledgerTable: string }): Handle;
}

let unavailable: string | null = 'not registered yet';

const AccountingDonationsAddon = {
  name: 'accounting-donations',
  version: '0.1.0',
  description: 'Donations: gifts on receipts, and the receipt slip\'s quid pro quo disclosure',
  author: 'jwilleke',
  dependencies: ['accounting'],
  optionalDependencies: ['forms'],

  async register(engine: Engine, _config: Record<string, unknown>, host: AddonHost): Promise<void> {
    const ledger = engine.getManager<LedgerLike>('LedgerManager');
    if (!ledger) {
      unavailable = 'the accounting add-on is not running';
      host.logger.warn(`[accounting-donations] Not started: ${unavailable}`);
      return;
    }
    // Donations' own database (operator, 2026-10-20): in-kind gifts and pledges. A failure to open it
    // leaves register(), so the add-on is reported as not loaded.
    const databases = engine.getManager<DatabaseManagerLike>('DatabaseManager');
    if (!databases?.isEnabled()) {
      unavailable = "the site's database is off";
      host.logger.warn(`[accounting-donations] Not started: ${unavailable}`);
      return;
    }
    const db = databases.openAddonDatabase<DonationsDb>('accounting-donations', { migrations: DONATIONS_MIGRATIONS, ledgerTable: DONATIONS_LEDGER_TABLE });
    const auditSink = engine.getManager<Parameters<typeof host.recordAuditEvent>[0]>('AuditManager');
    const pdp = engine.getManager<{ decide(subject: unknown, request: { action: string }): Promise<Decision> }>('PolicyDecisionPoint');
    const config = engine.getManager<{ getProperty(key: string, fallback?: unknown): unknown }>('ConfigurationManager');
    const plugins = engine.getManager<{ formatters: { formatMoney(minor: number, currency: string): string } }>('PluginManager');
    const setting = (key: string, fallback: unknown) => config?.getProperty(`ngdpbase.addons.accounting-donations.${key}`, fallback);
    const settings: GiftSettings = {
      categories: () => {
        const value = setting('categories', []);
        return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
      },
      quidProQuo: () => {
        const wording = setting('wording', {}) as Record<string, unknown> | null;
        return typeof wording?.['quid-pro-quo'] === 'string' ? wording['quid-pro-quo'] : DEFAULT_QUID_PRO_QUO;
      },
      formatMoney: (minor) => plugins?.formatters.formatMoney(minor, ledger.currencyCode()) ?? String(minor)
    };
    const donations = new DonationManager({
      host, db, ledger, categories: settings.categories, formatMoney: settings.formatMoney,
      recordAudit: async (record) => { await host.recordAuditEvent(auditSink, { ...record, result: 'success' } as never); },
      decide: async (subject, request) => (pdp ? pdp.decide(subject, request) : { permit: false, applicable: false, reason: 'no_decision_point' })
    });
    ledger.registerLineDetails('gift', giftValidator({ ...settings, pledgeIsOpen: (id) => donations.pledgeIsOpen(id) }));
    ledger.registerSlipNotes(giftSlipNotes(settings));
    engine.registerManager('DonationManager', donations);
    await engine.getManager<{ registerPlugin(name: string, plugin: unknown): Promise<void> }>('PluginManager')?.registerPlugin('Donations', DonationsPlugin);
    await registerGiftForms(engine, host);
    unavailable = null;
    host.logger.info('[accounting-donations] Gifts ready');
  },

  status(): { healthy: boolean; message: string } {
    return unavailable ? { healthy: false, message: `Donations are off: ${unavailable}` } : { healthy: true, message: 'Gifts ready' };
  }
};

export default AccountingDonationsAddon;
