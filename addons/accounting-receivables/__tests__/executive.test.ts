/**
 * The executive role (ngdpbase#2094, D-050): what this add-on's own policy grants
 * it, and which of the treasurer's pages it reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { registerExecutiveCard } from '../executive.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
type Policy = { id: string; effect: string; subjects: { type: string; value: string }[]; actions: string[] };
const policies = defaults['ngdpbase.access.policies'] as Policy[];
const declared = Object.keys(defaults['ngdpbase.permissions.definitions'] as Record<string, unknown>);

describe('the executive policy', () => {
  test("grants the executive role every unit's account, and nothing that issues or records", () => {
    const executive = policies.filter(p => p.subjects.some(s => s.type === 'role' && s.value === 'executive'));
    expect(executive.map(p => [p.id, p.effect, p.actions])).toEqual([['accounting-receivables-executive', 'allow', ['account-read']]]);
    for (const action of executive[0]!.actions) expect(declared).toContain(action);
    expect(executive[0]!.actions).not.toContain('invoice-issue');
  });
});

describe("the treasurer's pages", () => {
  test("the pages that show units' accounts admit the executive role; the pages that issue or record stay the treasurer's", () => {
    const dir = new URL('../pages/', import.meta.url);
    const pages = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
      const front = readFileSync(new URL(f, dir), 'utf8').split('\n---')[0]!;
      return { title: /^title: (.*)$/m.exec(front)![1]!, audience: /^audience:\n((?:  - .*\n?)+)/m.exec(front)![1]!.match(/- (\S+)/g)!.map(m => m.slice(2)) };
    });
    const reading = ['Account Balances', 'Folios', 'Invoices'];
    for (const page of pages) expect(page.audience, page.title).toEqual(reading.includes(page.title) ? ['treasurer', 'executive'] : ['treasurer']);
    expect(pages.filter(p => p.audience.includes('executive')).map(p => p.title).sort()).toEqual(reading);
  });
});

describe('the Executive Hub card', () => {
  test('is registered only on a core with the hub', () => {
    const registered: unknown[] = [];
    const card = { addonName: 'accounting-receivables', title: 'x', icon: 'x', adminUrl: '/', surface: 'executive' as const, permission: 'account-read', summary: async () => ({ figures: [] }) };
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c) }, card)).toBe(false);
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c), executiveCardsFor: () => [] }, card)).toBe(true);
    expect(registered).toEqual([card]);
  });
});
