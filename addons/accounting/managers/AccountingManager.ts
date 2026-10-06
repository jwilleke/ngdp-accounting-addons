/**
 * AccountingManager — data layer for the accounting addon.
 *
 * Registered on the engine as 'AccountingManager' during register(), so other
 * addons and plugins reach it with engine.getManager('AccountingManager').
 *
 * Note what the constructor does NOT take: a way to reach the network of its
 * own. `fetchJson` is injected by register(), built there on the host's guarded
 * fetch under the instance's egress policy. An addon that calls bare `fetch`
 * bypasses that policy completely, so the manager is handed the one door it is
 * allowed to use rather than being trusted to pick the right one (#1133, #1244).
 */

/** Injected by register(); index.ts shows how it is built. */
export type FetchJson = (url: string) => Promise<unknown>;

export default class AccountingManager {
  private records: unknown[] = [];

  constructor(
    protected readonly engine: unknown,
    protected readonly dataPath: string,
    private readonly fetchJson: FetchJson
  ) {}

  /** Called once during register(). Load persisted state here. */
  async load(): Promise<void> {
    // Replace with real loading. dataPath is resolved by the addon's
    // register() via ConfigurationManager.resolveDataPath, so it already
    // respects the instance's data directory.
    this.records = [];
  }

  list(): unknown[] {
    return this.records;
  }

  /**
   * Pull records from an operator-supplied URL.
   *
   * The call goes through the injected fetchJson, so the egress policy decides
   * whether the address may be reached — a loopback or LAN URL is refused there,
   * not here, and a redirect is re-checked on every hop. Nothing in this file
   * needs to know the policy exists.
   */
  async refresh(sourceUrl: string): Promise<number> {
    const body = await this.fetchJson(sourceUrl);
    this.records = Array.isArray(body) ? body : [];
    return this.records.length;
  }

  /** Surfaced in the admin addon dashboard. */
  status(): { healthy: boolean; records: number } {
    return { healthy: true, records: this.records.length };
  }
}
