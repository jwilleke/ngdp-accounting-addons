/**
 * The pages this add-on seeds (ngdpbase#2094, operator 2026-10-29): no page carries
 * an audience; a screen is gated by the permission its data or its action asks.
 * The treasurer's forms are drawn only for a viewer who may submit them, and the
 * start-up pass takes the old shipped audience off pages a site already has.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { formatters } from '@jwilleke/ngdpbase-types/testing';
import { FOLIO_ITEM_VOID_FORM, FOLIO_LIEN_FORM, FOLIO_OPENING_FORM, FOLIO_WRITE_OFF_FORM, FORM_PERMISSIONS, ISSUE_FORM, PAYMENT_FORM, VOID_FORM } from '../forms.js';
import { gatedForm, NOT_PERMITTED } from '../plugins/gatedForm.js';
import { clearShippedAudience, shippedPageUuids, type PageDoor } from '../pageAudience.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const declared = Object.keys(defaults['ngdpbase.permissions.definitions'] as Record<string, unknown>);
/** Permissions a form here asks that another add-on or core declares. */
const elsewhere = ['ledger-record', 'form-submit'];
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
    const ids = [PAYMENT_FORM, ISSUE_FORM, VOID_FORM, FOLIO_OPENING_FORM, FOLIO_WRITE_OFF_FORM, FOLIO_LIEN_FORM, FOLIO_ITEM_VOID_FORM].map(f => f.id);
    for (const page of pages) {
      expect(page.body, page.title).not.toContain('[{Form ');
      for (const [, id] of page.body.matchAll(/\[\{Receivables view='form' id='([a-z-]+)'\}\]/g)) expect(ids, page.title).toContain(id);
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
  const render = (granted: string[] | null, id = 'folio-write-off') => {
    const drawn: unknown[] = [];
    const context = { engine: engine(granted ?? [], drawn), userContext: granted ? { username: 'tess', granted } : undefined, pageName: 'The page', formatters };
    return gatedForm(context, id, FORM_PERMISSIONS).then(html => ({ html, drawn, context }));
  };

  test("is core's Form, with the viewer's context, for a viewer who may submit it", async () => {
    const { html, drawn, context } = await render(['invoice-issue', 'form-submit']);
    expect(html).toBe('<form>');
    expect(drawn).toEqual([{ plugin: 'Form', pageName: 'The page', params: { id: 'folio-write-off' }, context }]);
  });

  test('is a short note for anyone else: without the permission, without form-submit, or signed out', async () => {
    for (const granted of [['form-submit'], ['invoice-issue'], null]) {
      const { html, drawn } = await render(granted);
      expect(html).toContain(formatters.escapeHtml(NOT_PERMITTED));
      expect(drawn).toEqual([]);
    }
    expect((await render(['invoice-issue', 'form-submit'], 'no-such-form')).html).toContain("No form");
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
      'u-shipped': { title: 'Shipped', content: 'body', metadata: { addon: 'accounting-receivables', audience: ['treasurer'], slug: 'shipped' } },
      'u-site': { title: 'Site set', content: 'body', metadata: { addon: 'accounting-receivables', audience: ['treasurer', 'board'] } },
      'u-done': { title: 'Done', content: 'body', metadata: { addon: 'accounting-receivables' } },
      'u-other': { title: 'Another add-on', content: 'body', metadata: { addon: 'phr', audience: ['treasurer'] } }
    });
    const lines = log();
    expect(await clearShippedAudience(pagesDoor, ctx, 'accounting-receivables', ['u-shipped', 'u-site', 'u-done', 'u-other', 'u-missing'], lines)).toEqual(['Shipped']);
    expect(saves).toEqual([{ name: 'Shipped', content: 'body', metadata: { addon: 'accounting-receivables', slug: 'shipped' }, ctx, options: { skipValidation: true, preserveLastModified: true } }]);
    expect(lines.lines.some(l => l.startsWith('warn:') && l.includes("'Site set' keeps its audience"))).toBe(true);
  });

  test('does nothing without a page door, and nothing the second time', async () => {
    expect(await clearShippedAudience(null, {}, 'accounting-receivables', ['u'], log())).toEqual([]);
    const { pagesDoor, saves } = door({ u: { title: 'Done', content: 'b', metadata: { addon: 'accounting-receivables' } } });
    expect(await clearShippedAudience(pagesDoor, {}, 'accounting-receivables', ['u'], log())).toEqual([]);
    expect(saves).toEqual([]);
  });
});
