/**
 * Donations for ngdpbase's accounting add-on (D-036; docs/guides/donations-guide.md,
 * the source of truth). A donation is a receipt line with donation details: this
 * add-on registers the `donation` kind and the receipt slip's quid pro quo
 * disclosure with the accounting add-on's LedgerManager, and ships the donation
 * screen. It calls the accounting add-on's managers and never its database
 * (operator, 2026-10-20).
 *
 * Configuration keys:
 *   ngdpbase.addons.accounting-donations.enabled     — true/false (defaults to false)
 *   ngdpbase.addons.accounting-donations.categories  — chart codes a donation may use, e.g. ["4200"]
 *   ngdpbase.addons.accounting-donations.wording     — { "quid-pro-quo": "…{amount}…{deductible}…{goods}…{value}" }
 *   ngdpbase.addons.accounting-donations.executive-top-donors — how many of the year's largest donors the Executive Hub card names (3)
 *
 * The exported `name` MUST equal `ngdpbase.slug` in package.json.
 */
import type { ActorContext, AddonHost, Decision, PluginFormatters } from '@jwilleke/ngdpbase-types';
import { DEFAULT_QUID_PRO_QUO, donationSlipNotes, donationValidator, type DonationSettings, type ReceiptLike } from './donation.js';
import { registerDonationForms } from './forms.js';
import DonationManager, { type Contacts, type DonationLine, type DonationOptions, type DonationsDb, type LedgerLike as DonationLedger } from './managers/DonationManager.js';
import { donationsExecutiveCard, registerExecutiveCard, type CardRegistry } from './executive.js';
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
  /** Returns this add-on's reader of its own `donation` lines (the accounting add-on's LineDetailsReader). */
  registerLineDetails(kind: string, definition: ReturnType<typeof donationValidator>): { lines(range?: { from?: string; to?: string }): DonationLine[] };
  registerSlipNotes(notes: (receipt: ReceiptLike) => string[]): void;
}

interface DatabaseManagerLike {
  isEnabled(): boolean;
  openAddonDatabase<Handle>(owner: string, options: { migrations: unknown[]; ledgerTable: string }): Handle;
}

let unavailable: string | null = 'not registered yet';
/** What the profile card needs, set by register() (ngdpbase's profile hook, #534, calls the module, not a manager). */
let profile: { donations: DonationManager; f: PluginFormatters; money(minor: number): string } | null = null;

const AccountingDonationsAddon = {
  name: 'accounting-donations',
  version: '0.3.0',
  description: 'Donations: donations on receipts, and the receipt slip\'s quid pro quo disclosure',
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
    // Donations' own database (operator, 2026-10-20): in-kind donations and pledges. A failure to open it
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
    const settings: DonationSettings = {
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
    // The ledger's reader of this add-on's own `donation` lines, handed over when the kind is registered below.
    let donationLines: ReturnType<LedgerLike['registerLineDetails']> | null = null;
    const donations = new DonationManager({
      host, db, ledger, categories: settings.categories, formatMoney: settings.formatMoney,
      donationLines: (range) => donationLines?.lines(range) ?? [],
      topDonors: () => {
        const n = setting('executive-top-donors', 3);
        return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 3;
      },
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
      // The owner bumps (ngdpbase caching guide): pages that show donations re-render after each write.
      changed: async () => { await engine.getManager<{ bump(topic: string): Promise<unknown> }>('CacheManager')?.bump('DonationManager'); },
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
    donationLines = ledger.registerLineDetails('donation', donationValidator({ ...settings, pledgeIsOpen: (id) => donations.pledgeIsOpen(id) }));
    ledger.registerSlipNotes(donationSlipNotes(settings));
    engine.registerManager('DonationManager', donations);
    await engine.getManager<{ registerPlugin(name: string, plugin: unknown): Promise<void> }>('PluginManager')?.registerPlugin('Donations', DonationsPlugin);
    engine.app?.use('/api/accounting-donations', donationRoutes(engine, host));
    await registerDonationForms(engine, host);
    // The board's card on core's Executive Hub (ngdpbase#2094, D-050), for holders of ledger-read: this year, in the site's time zone.
    const jobs = engine.getManager<{ scheduleTimeZone(): string }>('BackgroundJobManager');
    const thisYear = () => (jobs ? host.zonedParts(new Date(), jobs.scheduleTimeZone()).year : new Date().getFullYear());
    registerExecutiveCard(engine.getManager<CardRegistry>('AddonsManager'), donationsExecutiveCard(donations, settings.formatMoney, thisYear));
    const fmt = engine.getManager<{ formatters: PluginFormatters }>('PluginManager')?.formatters;
    // Core's formatters (escapeHtml, formatAsTable); without them the card stays off rather than build HTML by hand.
    profile = fmt ? { donations, f: fmt, money: settings.formatMoney } : null;
    unavailable = null;
    host.logger.info('[accounting-donations] Donations ready');
  },

  /**
   * The signed-in donor's own donations on their profile (D-037): each year's donations and
   * statements. Nothing for someone with no donations, or without ledger-self.
   */
  async profileSection(user: { username: string }, ctx: ActorContext): Promise<{ title: string; html: string } | null> {
    if (!profile) return null;
    // The signed-in user's own context, as core's profile hook hands it (ngdpbase #2018).
    const actor = {
      ipAddress: undefined, actingUsername: () => user.username, subject: ctx,
      enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
    };
    let years;
    try { years = await profile.donations.myDonations(actor); } catch { return null; }
    if (!years.length) return null;
    const { f, money } = profile;
    const esc = (s: string) => f.escapeHtml(s);
    return { title: 'Your donations', html: f.formatAsTable(['Year', 'Donations', 'Total', 'Deductible', 'Statement'],
      years.map(y => [String(y.year), String(y.donationCount), esc(money(y.total)), esc(money(y.deductible)),
        y.statements.map(s => `<a href="/api/accounting-donations/my-statements/${encodeURIComponent(s.id)}">statement, issued ${esc(s.issuedAt.slice(0, 10))}</a>`).join('<br>') || 'not issued yet'])) };
  },

  status(): { healthy: boolean; message: string } {
    return unavailable ? { healthy: false, message: `Donations are off: ${unavailable}` } : { healthy: true, message: 'Donations ready' };
  }
};

export default AccountingDonationsAddon;
