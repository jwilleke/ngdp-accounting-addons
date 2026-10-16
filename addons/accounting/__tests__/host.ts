/**
 * The host ngdpbase hands this add-on's register() (#1813), built the way core
 * builds it: from this add-on's own default-config.json, so a test that records
 * an audit event this add-on does not declare fails as it would on a site.
 */
import { readFileSync } from 'node:fs';
import { buildAddonHost } from '../../../dist/src/utils/addonHost.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;

export const testHost = buildAddonHost('accounting', defaults);
