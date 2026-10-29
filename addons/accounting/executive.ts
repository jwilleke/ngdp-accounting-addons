/**
 * The accounting add-on's card on ngdpbase's Executive Hub, `/executive`
 * (ngdpbase#2094, D-050): what the funds hold, cash not yet deposited, how far the
 * books are locked, and, for a viewer who may read the ledger's entries, what waits
 * on the treasurer. Core shows it only to a viewer the decision point permits
 * `ledger-summary-read`, and calls `summary(ctx)` with that viewer's context, so the
 * ledger's own doors decide what is read.
 */
import type { ActorContext } from '@jwilleke/ngdpbase-types';
import type LedgerManager from './managers/LedgerManager.js';

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

/**
 * Register the card on a core that has the Executive Hub. An older core would take
 * it for an `/admin` card, so there it is left out. True when registered.
 */
export function registerExecutiveCard(registry: CardRegistry | null | undefined, card: ExecutiveCard): boolean {
  if (!registry || typeof registry.executiveCardsFor !== 'function') return false;
  registry.registerDashboardCard(card);
  return true;
}

const counted = (n: number, money: string): string => (n ? `${n} (${money})` : '0');

/** The accounting card: `formatMoney` formats minor units in the ledger's currency, as every ledger view does. */
export function ledgerExecutiveCard(ledger: Pick<LedgerManager, 'executiveSummary' | 'viewerActor'>, formatMoney: (minor: number) => string): ExecutiveCard {
  return {
    addonName: 'accounting',
    title: 'Accounting',
    icon: 'fas fa-book',
    adminUrl: '/view/accounting',
    surface: 'executive',
    permission: 'ledger-summary-read',
    summary: async (ctx) => {
      const s = await ledger.executiveSummary(ledger.viewerActor(ctx));
      const figures: { label: string; value: string | number }[] = [
        { label: 'Funds', value: formatMoney(s.fundsTotal) },
        { label: 'Open funds', value: s.openFunds },
        { label: 'Cash not yet deposited', value: formatMoney(s.cashOnHand) }
      ];
      if (s.pending) {
        figures.push(
          { label: 'Receipts waiting for a deposit', value: counted(s.pending.receiptsToDeposit.count, formatMoney(s.pending.receiptsToDeposit.total)) },
          { label: 'Deposits not cleared', value: counted(s.pending.depositsNotCleared.count, formatMoney(s.pending.depositsNotCleared.total)) },
          { label: 'Bounced checks still owed', value: counted(s.pending.bouncesOwed.count, formatMoney(s.pending.bouncesOwed.total)) }
        );
      }
      return { figures, message: s.lockedThrough ? `Books locked through ${s.lockedThrough}` : 'No period is locked yet' };
    }
  };
}
