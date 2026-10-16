/**
 * The host ngdpbase hands this add-on's register() (#1813), built the way core
 * builds it: from this add-on's own default-config.json, so a test that records
 * an audit event this add-on does not declare fails as it would on a site.
 */
import { readFileSync } from 'node:fs';
import { buildAddonHost } from '../../../dist/src/utils/addonHost.js';
import * as pluginFormatters from '../../../dist/src/utils/pluginFormatters.js';
import ExportManager from '../../../dist/src/managers/ExportManager.js';
import type { PluginFormatters } from '../../../dist/src/plugins/types.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;

export const testHost = buildAddonHost('accounting', defaults);

/** The plugin helpers PluginManager hands every plugin as `context.formatters` (#1820). */
export const testFormatters: PluginFormatters = Object.freeze({ ...pluginFormatters });

/** ngdpbase's one CSV writer, ExportManager.toCsv (#1819); it needs no engine. */
const exportManager = Object.create(ExportManager.prototype) as ExportManager;

/** What index.ts hands LedgerManager from ngdpbase, here built the same way. */
export const testLedgerParts = {
  host: testHost,
  formatMoney: testFormatters.formatMoney,
  toCsv: (headers: readonly string[], rows: readonly (readonly unknown[])[]): string => exportManager.toCsv(headers, rows)
};
