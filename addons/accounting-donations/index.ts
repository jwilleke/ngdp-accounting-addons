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
import type { ActorContext, AddonHost, Decision } from '@jwilleke/ngdpbase-types';
import { DEFAULT_QUID_PRO_QUO, giftSlipNotes, giftValidator, type GiftSettings, type ReceiptLike } from './gift.js';
import { registerGiftForms } from './forms.js';
import DonationManager, { type Contacts, type DonationOptions, type DonationsDb, type LedgerLike as DonationLedger } from './managers/DonationManager.js';
import { DONATIONS_LEDGER_TABLE, DONATIONS_MIGRATIONS } from './managers/migrations.js';
import DonationsPlugin from './plugins/DonationsPlugin.js';
import donationRoutes from './routes/api.js';
import { DEFAULT_WORDING } from './managers/statement.js';

interface Engine {
  getManager<T = unknown>(name: string): T | null | undefined;
  registerManager(name: string, manager: unknown): void;
  app?: { use(route: string, handler: unknown): void };
  createRouter(): import('express').Router;
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
/** What the profile card needs, set by register() (ngdpbase's profile hook, #534, calls the module, not a manager). */
let profile: { donations: DonationManager; escapeHtml(s: string): string; money(minor: number): string } | null = null;

const AccountingDonationsAddon = {
  name: 'accounting-donations',
  version: '0.2.0',
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
      // Donors are core's contacts (ngdpbase #1930): persons and organizations, through their doors.
      wording: () => {
        const org = (setting('organization', {}) ?? {}) as Record<string, unknown>;
        const words = (setting('wording', {}) ?? {}) as Record<string, unknown>;
        const pick = (key: string, fallback: string) => (typeof words[key] === 'string' && words[key] !== '' ? words[key] as string : fallback);
        const str = (v: unknown) => (typeof v === 'string' ? v : '');
        return {
          organization: { name: str(org.name) || 'the organization', taxId: str(org.taxId), address: str(org.address) },
          intro: pick('statement-intro', DEFAULT_WORDING.intro), noGoods: pick('no-goods', DEFAULT_WORDING.noGoods),
          goodsNote: pick('goods-note', DEFAULT_WORDING.goodsNote), taxIdNote: pick('tax-id', DEFAULT_WORDING.taxIdNote)
        };
      },
      email: () => engine.getManager<NonNullable<ReturnType<NonNullable<DonationOptions['email']>>>>('EmailManager'),
      pdf: () => engine.getManager<NonNullable<ReturnType<NonNullable<DonationOptions['pdf']>>>>('ExportManager'),
      personOf: async (actor) => {
        if (!actor.subject) return null;
        const persons = engine.getManager<{ getByUserIdentifier(ctx: ActorContext, u: string): Promise<{ '@id': string } | null> }>('IdentityManager');
        return (await persons?.getByUserIdentifier(actor.subject, actor.actingUsername()))?.['@id'] ?? null;
      },
      contacts: () => ({
        persons: engine.getManager<NonNullable<Contacts['persons']>>('IdentityManager'),
        organizations: engine.getManager<NonNullable<Contacts['organizations']>>('OrganizationManager')
      }),
      recordAudit: async (record) => { await host.recordAuditEvent(auditSink, { ...record, result: 'success' } as never); },
      decide: async (subject, request) => (pdp ? pdp.decide(subject, request) : { permit: false, applicable: false, reason: 'no_decision_point' })
    });
    ledger.registerLineDetails('gift', giftValidator({ ...settings, pledgeIsOpen: (id) => donations.pledgeIsOpen(id) }));
    ledger.registerSlipNotes(giftSlipNotes(settings));
    engine.registerManager('DonationManager', donations);
    await engine.getManager<{ registerPlugin(name: string, plugin: unknown): Promise<void> }>('PluginManager')?.registerPlugin('Donations', DonationsPlugin);
    engine.app?.use('/api/accounting-donations', donationRoutes(engine, host));
    await registerGiftForms(engine, host);
    const fmt = engine.getManager<{ formatters: { escapeHtml(s: string): string } }>('PluginManager')?.formatters;
    // Core's escaper (PluginManager formatters); without it the card stays off rather than escape by hand.
    profile = fmt ? { donations, escapeHtml: (s) => fmt.escapeHtml(s), money: settings.formatMoney } : null;
    unavailable = null;
    host.logger.info('[accounting-donations] Gifts ready');
  },

  /**
   * The signed-in donor's own giving on their profile (D-037): each year's gifts and
   * statements. Nothing for someone with no gifts, or without ledger-self.
   */
  async profileSection(user: { username: string }, ctx: ActorContext): Promise<{ title: string; html: string } | null> {
    if (!profile) return null;
    // The signed-in user's own context, as core's profile hook hands it (ngdpbase #2018).
    const actor = {
      ipAddress: undefined, actingUsername: () => user.username, subject: ctx,
      enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
    };
    let years;
    try { years = await profile.donations.myGiving(actor); } catch { return null; }
    if (!years.length) return null;
    const { escapeHtml: esc, money } = profile;
    const rows = years.map(y => `<tr><td>${y.year}</td><td>${y.giftCount}</td><td class="text-end">${esc(money(y.total))}</td><td class="text-end">${esc(money(y.deductible))}</td><td>`
      + (y.statements.map(s => `<a href="/api/accounting-donations/my-statements/${encodeURIComponent(s.id)}">statement, issued ${esc(s.issuedAt.slice(0, 10))}</a>`).join('<br>') || 'not issued yet')
      + '</td></tr>').join('');
    return { title: 'Your giving', html: `<table class="table table-sm"><thead><tr><th>Year</th><th>Gifts</th><th class="text-end">Total</th><th class="text-end">Deductible</th><th>Statement</th></tr></thead><tbody>${rows}</tbody></table>` };
  },

  status(): { healthy: boolean; message: string } {
    return unavailable ? { healthy: false, message: `Donations are off: ${unavailable}` } : { healthy: true, message: 'Gifts ready' };
  }
};

export default AccountingDonationsAddon;
