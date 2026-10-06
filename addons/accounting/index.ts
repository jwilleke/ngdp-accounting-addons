/**
 * Accounting addon for ngdpbase.
 *
 * Addon code runs in the ngdpbase process. Every check that enforces a
 * runtime property of src/ applies here identically (this addon's README.md,
 * "Rules an addon lives under"): outbound HTTP goes through the host's
 * guardedFetch (built once below and injected), a permission decision is
 * ctx.requirePermission on a forwarded subject, and a mutating browser
 * request carries the CSRF token. The generated route, view and manager
 * already do all three — keep it that way.
 *
 * Configuration keys (in app-custom-config.json):
 *   ngdpbase.addons.accounting.enabled   — true/false (REQUIRED; defaults to false)
 *   ngdpbase.addons.accounting.dataPath  — override the data directory
 *
 * The exported `name` below MUST equal the `ngdpbase.slug` in package.json.
 * AddonsManager treats the manifest slug as authoritative and warns loudly on a
 * mismatch, because the config key follows the slug, not this label (#927).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { guardedFetch } from '../../dist/src/http/guardedFetch.js';
import { resolveEgressPolicy } from '../../dist/src/http/egressPolicy.js';
import apiRoutes from './routes/api.js';
import AccountingManager from './managers/AccountingManager.js';
import AccountingPlugin from './plugins/AccountingPlugin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Engine {
  getManager<T = unknown>(name: string): T | null;
  registerManager(name: string, manager: unknown): void;
  /** The Express app, present once the host has built it; routes and views mount here. */
  app?: {
    use(route: string, handler: unknown): void;
    get(setting: string): unknown;
    set(setting: string, value: unknown): void;
  };
}

const AccountingAddon = {
  name: 'accounting',
  version: '1.0.0',
  description: 'Accounting addon for ngdpbase',
  author: 'ngdpbase',
  dependencies: [] as string[],

  async register(engine: Engine, config: Record<string, unknown>): Promise<void> {
    const cm = engine.getManager<{
      resolveDataPath(n: string): string;
      getProperty?(k: string, f?: unknown): unknown;
    }>('ConfigurationManager');

    // The ONE way this addon reaches the network (#1133): the host's guarded
    // fetch under the instance's egress policy, read per call so an operator
    // tightening it is honoured without a restart. The manager is handed this
    // and has no other door — see AccountingManager's constructor.
    const readConfig = (key: string, fallback?: unknown): unknown => cm?.getProperty?.(key, fallback) ?? fallback;
    const fetchJson = async (url: string): Promise<unknown> => {
      const { policy } = resolveEgressPolicy(readConfig);
      const res = await guardedFetch(url, { policy });
      if (res.status < 200 || res.status >= 300) throw new Error(`${url}: HTTP ${res.status}`);
      return JSON.parse(res.body.toString('utf8')) as unknown;
    };

    const dataPath = typeof config['dataPath'] === 'string' && config['dataPath'] !== ''
      ? config['dataPath'] as string
      : (cm?.resolveDataPath('accounting') ?? './data/accounting');

    const accounting = new AccountingManager(engine, dataPath, fetchJson);
    await accounting.load();
    engine.registerManager('AccountingManager', accounting);

    const pluginManager = engine.getManager<{
      registerPlugin(name: string, plugin: unknown): Promise<void>;
    }>('PluginManager');
    if (pluginManager) {
      await pluginManager.registerPlugin('Accounting', AccountingPlugin);
    }

    // Views render with the host's layout; routes mount under the addon's own
    // prefix. Appending to `views` rather than replacing it keeps the host's
    // own templates — header and footer included — resolvable.
    const views = (engine.app?.get('views') as string | string[] | undefined) ?? [];
    engine.app?.set('views', [...[views].flat(), path.join(__dirname, 'views')]);
    engine.app?.use('/api/accounting', apiRoutes(engine));

    // Static assets, if this addon ships any under public/.
    // engine.app?.use('/addons/accounting', express.static(path.join(__dirname, 'public')));
    void __dirname;
  },

  /** Optional. Surfaced in the admin addon dashboard. */
  status(): { healthy: boolean } {
    return { healthy: true };
  }
};

export default AccountingAddon;
