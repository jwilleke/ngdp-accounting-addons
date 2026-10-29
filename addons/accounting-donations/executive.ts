/**
 * The donations card on ngdpbase's Executive Hub, `/executive` (ngdpbase#2094,
 * D-050): this year's donations, how many gifts and donors, and the largest donors
 * by name; nothing the organization holds is hidden from the board. Core shows it
 * only to a viewer the decision point permits `ledger-read` (the permission every
 * donor-naming read here asks), and calls `summary(ctx)` with that viewer's
 * context, so DonationManager's own door decides what is read.
 */
import type { ActorContext } from '@jwilleke/ngdpbase-types';
import type DonationManager from './managers/DonationManager.js';

/**
 * Core's executive card (AddonsManager's `AddonDashboardCard` with `surface:
 * 'executive'`, ngdpbase 5.37.0, #2093). Named here because the published
 * `@jwilleke/ngdpbase-types` 5.37.0 still declares the card without `surface`,
 * `permission` and `summary`; import core's type once a release exports them.
 */
export interface ExecutiveCard {
  addonName: string;
  title: string;
  icon: string;
  adminUrl: string;
  surface: 'executive';
  permission: string;
  summary(ctx: ActorContext): Promise<{ figures: { label: string; value: string | number }[]; message?: string }>;
}

/** The slice of core's AddonsManager the card needs. `executiveCardsFor` is how a core with the hub is told from an older one. */
export interface CardRegistry {
  registerDashboardCard(card: ExecutiveCard): void;
  executiveCardsFor?: unknown;
}

/** Register the card on a core that has the Executive Hub; an older core would take it for an `/admin` card. True when registered. */
export function registerExecutiveCard(registry: CardRegistry | null | undefined, card: ExecutiveCard): boolean {
  if (!registry || typeof registry.executiveCardsFor !== 'function') return false;
  registry.registerDashboardCard(card);
  return true;
}

/** The caller DonationManager asks with, for a viewer's context: a refusal is just a refusal (the hub says the figures could not be read). */
function viewerActor(ctx: ActorContext) {
  const username = (ctx as { username?: unknown } | null)?.username;
  return {
    ipAddress: undefined, subject: ctx,
    actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
    enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
}

/** The donations card; `year` is this year in the site's time zone. */
export function donationsExecutiveCard(donations: Pick<DonationManager, 'executiveSummary'>, formatMoney: (minor: number) => string, year: () => number): ExecutiveCard {
  return {
    addonName: 'accounting-donations',
    title: 'Donations',
    icon: 'fas fa-hand-holding-heart',
    adminUrl: '/view/donation-statements',
    surface: 'executive',
    permission: 'ledger-read',
    summary: async (ctx) => {
      const s = await donations.executiveSummary(viewerActor(ctx), year());
      const figures: { label: string; value: string | number }[] = [
        { label: `Donations in ${s.year}`, value: formatMoney(s.total) },
        { label: 'Gifts', value: s.donationCount },
        { label: 'Donors', value: s.donorCount },
        { label: 'In-kind donations', value: s.inKindCount }
      ];
      if (s.anonymous.count) figures.push({ label: 'Anonymous gifts', value: `${s.anonymous.count} (${formatMoney(s.anonymous.total)})` });
      const message = s.topDonors.length ? `Largest donors: ${s.topDonors.map(d => `${d.name} (${formatMoney(d.total)})`).join(', ')}` : '';
      return { figures, message };
    }
  };
}
