/**
 * The starter chart (D-034): categories follow QuickBooks' types, detail types
 * and names; receipts offer income, money out the rest; the categories a
 * bounced check needs are named in configuration (D-032).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testLedgerParts } from './host.js';
import LedgerManager, { categoriesFrom, type LedgerDb } from '../managers/LedgerManager.js';

const defaults = JSON.parse(readFileSync(new URL('../config/default-config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const shipped = defaults['ngdpbase.addons.accounting.categories'];

describe('the shipped chart', () => {
  test('is the D-034 list, every category with a type and a QuickBooks detail type', () => {
    const warnings: string[] = [];
    const chart = categoriesFrom(shipped, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(chart).toHaveLength(23);
    expect(chart.every(c => c.detailType)).toBe(true);
    expect(chart.find(c => c.code === '6100')).toEqual({ code: '6100', name: 'Bank Charges', type: 'expense', detailType: 'Bank Charges' });
    expect(chart.find(c => c.code === '8900')).toMatchObject({ name: 'Other Miscellaneous Income', type: 'other-income' });
  });

  test('the numbering follows the types: 4000s income, 5000s cost of goods, 6000s–7000s expenses, 8000s other income', () => {
    const want = { 4: 'income', 5: 'cost-of-goods', 6: 'expense', 7: 'expense', 8: 'other-income' } as Record<string, string>;
    for (const c of categoriesFrom(shipped)) expect(c.type).toBe(want[c.code[0]]);
  });

  test('names the bank-charges and other-income categories, and ships no penalty', () => {
    const codes = new Set(categoriesFrom(shipped).map(c => c.code));
    expect(codes.has(defaults['ngdpbase.addons.accounting.bank-charges-category'] as string)).toBe(true);
    expect(codes.has(defaults['ngdpbase.addons.accounting.other-income-category'] as string)).toBe(true);
    expect(defaults['ngdpbase.addons.accounting.bounced-check-penalty']).toBe(0);
  });
});

describe('categoriesFrom', () => {
  test('a site adds, renames and removes one code at a time; the older "code": "name" still works', () => {
    const chart = categoriesFrom({ '6100': { name: 'Bank fees', type: 'expense' }, '4100': false, '4150': 'Fundraising dinner', '9100': 'Penalties & Settlements' });
    expect(chart).toEqual([
      { code: '4150', name: 'Fundraising dinner', type: 'income', detailType: null },
      { code: '6100', name: 'Bank fees', type: 'expense', detailType: null },
      { code: '9100', name: 'Penalties & Settlements', type: 'other-expense', detailType: null }
    ]);
  });

  test('skips what it cannot use, and says why', () => {
    const warnings: string[] = [];
    expect(categoriesFrom({ 'a b': 'x', '4200': { type: 'income' }, '123': 'No type from a 3-digit code', '4300': { name: 'Grants', type: 'asset' } }, (m) => warnings.push(m))).toEqual([]);
    const said = warnings.join('\n');
    expect(said).toContain("category 'a b': the code must be letters, digits, dots or dashes");
    expect(said).toContain("category '123': type must be one of");
    expect(said).toContain("category '4200' has no name");
    expect(said).toContain("category '4300': type must be one of");
  });
});

describe('category choices', () => {
  let provider: { handle: unknown; close(): void };
  let ledger: LedgerManager;

  beforeEach(() => {
    provider = openTestLedgerDatabase();
    ledger = new LedgerManager({ ...testLedgerParts, db: provider.handle as LedgerDb, currency: 'USD', recordAudit: () => Promise.resolve(),
      decide: async () => ({ permit: true, applicable: true, reason: 'test' }), categories: () => shipped });
  });

  afterEach(() => {
    provider.close();
  });

  test('receipts offer income; money out offers cost of goods and expenses', async () => {
    const viewer = { username: 'tess' };
    const income = await ledger.toFormOptions({ list: 'categories', kind: 'in' }, viewer);
    const out = await ledger.toFormOptions({ list: 'categories', kind: 'out' }, viewer);
    expect(income.map(o => o.value)).toEqual(['4100', '4200', '4300', '4400', '4500', '8100', '8900']);
    expect(out.map(o => o.value)).toEqual(['5100', '6100', '6200', '6300', '6400', '6500', '6600', '6700', '6800', '6900', '7000', '7100', '7200', '7300', '7400', '7900']);
    expect(income[0]).toEqual({ value: '4100', label: '4100 Dues and memberships' });
    expect(await ledger.toFormOptions({ list: 'categories' }, viewer)).toHaveLength(23);
  });
});
