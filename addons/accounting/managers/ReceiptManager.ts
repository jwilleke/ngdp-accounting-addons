/**
 * ReceiptManager — money coming in (D-028), through the providers a site
 * enables (D-004, D-017): the manual provider (cash, check and other money the
 * treasurer records by hand) is always there; online providers (Stripe) come
 * later.
 *
 * It decides which provider a receipt goes through and what that provider can
 * do; the ledger does the rest. Every receipt is posted by
 * LedgerManager.postReceipt and every refund by LedgerManager.refundReceipt,
 * which ask the decision point, number the receipt, audit and write: one door
 * (D-014). Other add-ons (dues, donations, events) will record receipts here,
 * never in the ledger directly.
 *
 * Configuration: `ngdpbase.addons.accounting.receiptproviders`, a list of
 * `{ "id": "<provider>", "enabled": true, ... }` entries, merged by `id`.
 */
import type LedgerManager from './LedgerManager.js';
import { LedgerError, MANUAL_PROVIDER, type LedgerActor, type NewReceipt, type Receipt, type ReceiptRefund, type Refund } from './LedgerManager.js';

/** What a provider can do (D-004). */
export type ReceiptCapability = 'manualEntry' | 'checkout' | 'sync' | 'refund' | 'import';

export interface ReceiptProvider {
  readonly id: string;
  readonly capabilities: readonly ReceiptCapability[];
}

/** Money the treasurer records by hand: cash, checks, bank transfers. Refunds are recorded by hand too. */
export const MANUAL_RECEIPT_PROVIDER: ReceiptProvider = Object.freeze({ id: MANUAL_PROVIDER, capabilities: ['manualEntry', 'refund'] as const });

/** The providers this add-on ships. Stripe joins this list when it is built (#3). */
const SHIPPED: Readonly<Record<string, ReceiptProvider>> = { [MANUAL_PROVIDER]: MANUAL_RECEIPT_PROVIDER };

/**
 * The enabled providers from the configuration list. The manual provider is
 * always included, so receipts work with nothing configured. An entry naming a
 * provider this add-on does not ship is skipped, with a warning.
 */
export function receiptProvidersFrom(entries: unknown, warn: (message: string) => void = () => undefined): ReceiptProvider[] {
  const enabled = new Map<string, ReceiptProvider>([[MANUAL_PROVIDER, MANUAL_RECEIPT_PROVIDER]]);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const { id, enabled: on } = (entry ?? {}) as { id?: unknown; enabled?: unknown };
    if (typeof id !== 'string' || on !== true) continue;
    const provider = SHIPPED[id];
    if (provider) enabled.set(id, provider);
    else warn(`[accounting] receipt provider '${id}' is not available in this version; skipped`);
  }
  return [...enabled.values()];
}

export default class ReceiptManager {
  private readonly byId: ReadonlyMap<string, ReceiptProvider>;

  constructor(private readonly ledger: LedgerManager, providers: readonly ReceiptProvider[]) {
    this.byId = new Map(providers.map(p => [p.id, p]));
  }

  /** The enabled providers and what each can do. */
  providers(): ReceiptProvider[] {
    return [...this.byId.values()];
  }

  /**
   * Record money received by hand, through a provider that allows it (the
   * manual provider unless another is named). The ledger numbers it: R-0001, … A receipt has one or more lines (D-033).
   */
  async recordReceipt(actor: LedgerActor, input: NewReceipt, provider: string = MANUAL_PROVIDER): Promise<Receipt> {
    this.provider(provider, 'manualEntry');
    return this.ledger.postReceipt(actor, input, { provider });
  }

  /**
   * Return all or part of a receipt to the payer. For the manual provider the
   * money goes back by hand and this records it; an online provider will make
   * the refund through its service first.
   */
  async refundReceipt(actor: LedgerActor, receiptId: string, input: ReceiptRefund): Promise<Refund> {
    this.provider(MANUAL_PROVIDER, 'refund');
    return this.ledger.refundReceipt(actor, receiptId, input);
  }

  private provider(id: string, capability: ReceiptCapability): ReceiptProvider {
    const provider = this.byId.get(id);
    if (!provider) throw new LedgerError(400, `receipt provider '${id}' is not enabled on this site`);
    if (!provider.capabilities.includes(capability)) throw new LedgerError(400, `receipt provider '${id}' cannot ${capability === 'manualEntry' ? 'record receipts by hand' : capability}`);
    return provider;
  }
}
