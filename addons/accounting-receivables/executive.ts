/**
 * The receivables card on ngdpbase's Executive Hub, `/executive` (ngdpbase#2094,
 * D-050): what units owe, how many owe, the liens and write-offs standing, and
 * the last month invoiced. Core shows it only to a viewer the decision point
 * permits `account-read`, and calls `summary(ctx)` with that viewer's context, so
 * ReceivablesManager's own door decides what is read.
 */
import type { ActorContext } from '@jwilleke/ngdpbase-types';
import type ReceivablesManager from './managers/ReceivablesManager.js';

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

/** The caller ReceivablesManager asks with, for a viewer's context: a refusal is just a refusal (the hub says the figures could not be read). */
function viewerActor(ctx: ActorContext) {
  const username = (ctx as { username?: unknown } | null)?.username;
  return {
    ipAddress: undefined, subject: ctx,
    actingUsername: () => (typeof username === 'string' && username !== '' ? username : 'anonymous'),
    enforceDeny: async (permission: string): Promise<never> => { throw Object.assign(new Error(`not permitted: ${permission}`), { status: 403 }); }
  };
}

const counted = (n: number, money: string): string => (n ? `${n} (${money})` : '0');

/** The receivables card; `label` is the site's name for its charges (Assessments, Rent, Dues). */
export function receivablesExecutiveCard(dues: Pick<ReceivablesManager, 'executiveSummary'>, formatMoney: (minor: number) => string, label: () => { plural: string }): ExecutiveCard {
  return {
    addonName: 'accounting-receivables',
    title: label().plural,
    icon: 'fas fa-file-invoice',
    adminUrl: '/view/account-balances',
    surface: 'executive',
    permission: 'account-read',
    summary: async (ctx) => {
      const s = await dues.executiveSummary(viewerActor(ctx));
      return {
        figures: [
          { label: 'Owed by units', value: formatMoney(s.outstanding) },
          { label: 'Units owing', value: s.unitsOwing },
          { label: 'Liens', value: counted(s.liens.count, formatMoney(s.liens.total)) },
          { label: 'Written off', value: counted(s.writeOffs.count, formatMoney(s.writeOffs.total)) }
        ],
        message: s.lastInvoicedMonth ? `Invoices last issued for ${s.lastInvoicedMonth}` : 'No invoices issued yet'
      };
    }
  };
}
