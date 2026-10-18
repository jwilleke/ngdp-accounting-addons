/**
 * The host ngdpbase hands this add-on's register() (#1813), built the way core
 * builds it: from this add-on's own default-config.json, so a test that records
 * an audit event this add-on does not declare fails as it would on a site.
 */
import { readFileSync } from 'node:fs';
import { buildAddonHost, formatters, openAddonTestDatabase, toCsv } from '@jwilleke/ngdpbase-types/testing';
import type { PluginFormatters } from '@jwilleke/ngdpbase-types';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;

export const testHost = buildAddonHost('accounting', defaults);

/** The plugin helpers PluginManager hands every plugin as `context.formatters` (#1820). */
export const testFormatters: PluginFormatters = formatters;

/** What index.ts hands LedgerManager from ngdpbase, here built the same way. */
export const testLedgerParts = {
  host: testHost,
  formatMoney: testFormatters.formatMoney,
  toCsv
};

/**
 * The accounting database as ngdpbase's DatabaseManager.openAddonDatabase opens it, in memory:
 * the same migrations and triggers, checked against this add-on's own declaration (#1860).
 */
export function openTestLedgerDatabase(): { handle: unknown; close(): void } {
  const handle = openAddonTestDatabase<{ close(): void }>('accounting',
    { migrations: ACCOUNTING_MIGRATIONS as never, ledgerTable: ACCOUNTING_LEDGER_TABLE },
    { slug: 'accounting', defaults });
  return { handle, close: () => handle.close() };
}
