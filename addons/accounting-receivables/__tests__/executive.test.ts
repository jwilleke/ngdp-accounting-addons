/**
 * The executive role (ngdpbase#2094, D-050): what this add-on's own policy grants it.
 */
import { readFileSync } from 'node:fs';
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

describe('the Executive Hub card', () => {
  test('is registered only on a core with the hub', () => {
    const registered: unknown[] = [];
    const card = { addonName: 'accounting-receivables', title: 'x', icon: 'x', adminUrl: '/', surface: 'executive' as const, permission: 'account-read', summary: async () => ({ figures: [] }) };
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c) }, card)).toBe(false);
    expect(registerExecutiveCard({ registerDashboardCard: (c) => registered.push(c), executiveCardsFor: () => [] }, card)).toBe(true);
    expect(registered).toEqual([card]);
  });
});
