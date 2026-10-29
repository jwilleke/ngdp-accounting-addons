/**
 * The pages this add-on seeds (ngdpbase#2094, operator 2026-10-29): no page carries
 * an audience; a screen is gated by the permission its data or its action asks.
 * The treasurer's forms are drawn only for a viewer who may submit them, and the
 * start-up pass takes the old shipped audience off pages a site already has.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { formatters } from '@jwilleke/ngdpbase-types/testing';
import { DONATION_FORM, DONOR_FORM, FORM_PERMISSIONS, INKIND_FORM, PLEDGE_FORM, STATEMENT_ISSUE_FORM, STATEMENT_REISSUE_FORM } from '../forms.js';
import { gatedForm, NOT_PERMITTED } from '../plugins/gatedForm.js';
import { clearShippedAudience, shippedPageUuids, type PageDoor } from '../pageAudience.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const declared = Object.keys(defaults['ngdpbase.permissions.definitions'] as Record<string, unknown>);
/** Permissions a form here asks that another add-on or core declares. */
const elsewhere = ['ledger-record', 'identity-manage', 'form-submit'];
const dir = new URL('../pages/', import.meta.url);
const pages = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
  const text = readFileSync(new URL(f, dir), 'utf8');
  const front = text.split('\n---')[0]!;
  return { file: f, title: /^title: (.*)$/m.exec(front)![1]!, uuid: /^uuid: (.*)$/m.exec(front)![1]!, front, body: text.slice(front.length) };
});

describe('the seeded pages', () => {
  test('carry no audience', () => {
    for (const page of pages) expect(page.front, page.title).not.toMatch(/^audience:/m);
  });

  test("draw each of the treasurer's forms through the gated view, never core's Form plugin directly", () => {
    const ids = [DONATION_FORM, INKIND_FORM, PLEDGE_FORM, DONOR_FORM, STATEMENT_ISSUE_FORM, STATEMENT_REISSUE_FORM].map(f => f.id);
    for (const page of pages) {
      expect(page.body, page.title).not.toContain('[{Form ');
      for (const [, id] of page.body.matchAll(/\[\{Donations view='form' id='([a-z-]+)'\}\]/g)) expect(ids, page.title).toContain(id);
    }
    // Every form has the permission its manager asks, declared here or by core or another add-on.
    expect(Object.keys(FORM_PERMISSIONS).sort()).toEqual([...ids].sort());
    for (const permission of Object.values(FORM_PERMISSIONS)) expect([...declared, ...elsewhere]).toContain(permission);
  });

  test('the shipped uuids are the seed files', () => {
    expect(shippedPageUuids().sort()).toEqual(pages.map(p => p.uuid).sort());
  });
});

describe('a gated form', () => {
  const engine = (granted: string[], drawn: unknown[]) => ({
    getManager: <T>(name: string): T | null => (name === 'PolicyDecisionPoint'
      ? { permits: async (ctx: { granted?: string[] }, action: string) => Boolean(ctx?.granted?.includes(action)) }
      : name === 'PluginManager'
        ? { execute: async (plugin: string, pageName: string, params: Record<string, unknown>, context: unknown) => { drawn.push({ plugin, pageName, params, context }); return '<form>'; } }
        : null) as T
  });
  const render = (granted: string[] | null, id = 'pledge-create') => {
    const drawn: unknown[] = [];
    const context = { engine: engine(granted ?? [], drawn), userContext: granted ? { username: 'tess', granted } : undefined, pageName: 'The page', formatters };
    return gatedForm(context, id, FORM_PERMISSIONS).then(html => ({ html, drawn, context }));
  };

  test("is core's Form, with the viewer's context, for a viewer who may submit it", async () => {
    const { html, drawn, context } = await render(['donation-record', 'form-submit']);
    expect(html).toBe('<form>');
    expect(drawn).toEqual([{ plugin: 'Form', pageName: 'The page', params: { id: 'pledge-create' }, context }]);
  });

  test('is a short note for anyone else: without the permission, without form-submit, or signed out', async () => {
    for (const granted of [['form-submit'], ['donation-record'], null]) {
      const { html, drawn } = await render(granted);
      expect(html).toContain(formatters.escapeHtml(NOT_PERMITTED));
      expect(drawn).toEqual([]);
    }
    expect((await render(['donation-record', 'form-submit'], 'no-such-form')).html).toContain("No form");
  });
});

describe('the upgrade pass', () => {
  const door = (stored: Record<string, { title: string; content: string; metadata: Record<string, unknown> }>) => {
    const saves: { name: string; content: string; metadata: Record<string, unknown>; ctx: unknown; options?: Record<string, unknown> }[] = [];
    const pagesDoor: PageDoor = {
      getPage: async (id) => stored[id] ?? null,
      savePage: async (name, content, metadata, ctx, options) => { saves.push({ name, content, metadata, ctx, options }); }
    };
    return { pagesDoor, saves };
  };
  const log = () => { const lines: string[] = []; return { lines, info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`warn: ${m}`) }; };

  test('takes the shipped audience off its own pages, through the page door, as the system, keeping body and date', async () => {
    const ctx = { username: 'system', reason: 'take the shipped audience off' };
    const { pagesDoor, saves } = door({
      'u-shipped': { title: 'Shipped', content: 'body', metadata: { addon: 'accounting-donations', audience: ['treasurer'], slug: 'shipped' } },
      'u-site': { title: 'Site set', content: 'body', metadata: { addon: 'accounting-donations', audience: ['treasurer', 'board'] } },
      'u-done': { title: 'Done', content: 'body', metadata: { addon: 'accounting-donations' } },
      'u-other': { title: 'Another add-on', content: 'body', metadata: { addon: 'phr', audience: ['treasurer'] } }
    });
    const lines = log();
    expect(await clearShippedAudience(pagesDoor, ctx, 'accounting-donations', ['u-shipped', 'u-site', 'u-done', 'u-other', 'u-missing'], lines)).toEqual(['Shipped']);
    expect(saves).toEqual([{ name: 'Shipped', content: 'body', metadata: { addon: 'accounting-donations', slug: 'shipped' }, ctx, options: { skipValidation: true, preserveLastModified: true } }]);
    expect(lines.lines.some(l => l.startsWith('warn:') && l.includes("'Site set' keeps its audience"))).toBe(true);
  });

  test('does nothing without a page door, and nothing the second time', async () => {
    expect(await clearShippedAudience(null, {}, 'accounting-donations', ['u'], log())).toEqual([]);
    const { pagesDoor, saves } = door({ u: { title: 'Done', content: 'b', metadata: { addon: 'accounting-donations' } } });
    expect(await clearShippedAudience(pagesDoor, {}, 'accounting-donations', ['u'], log())).toEqual([]);
    expect(saves).toEqual([]);
  });
});
