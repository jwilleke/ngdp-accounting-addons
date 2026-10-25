/**
 * The billing rules (D-035), on their own: a month's charge, how payments settle
 * invoices, late charges, and billing entries' shares.
 */
import { describe, expect, test } from 'vitest';
import { billingMonth, chargeFor, daysBetween, lateChargesDue, settle, splitByShare, type LateChargeRule } from '../billing.js';

const RULES: LateChargeRule[] = [
  { id: 'late-10', daysLate: 10, amount: 1000, annualPercent: null, repeat: 'once' },
  { id: 'late-60', daysLate: 60, amount: 5000, annualPercent: 8, repeat: 'monthly' }
];

describe('billing', () => {
  test('a monthly charge falls due every month; an annual one only in its month', () => {
    expect(chargeFor({ amount: 41000, period: 'monthly', datedue: 1 }, '2026-10')).toEqual({ dueDate: '2026-10-01', amount: 41000 });
    expect(chargeFor({ amount: 120000, period: 'annual', datedue: '06-01' }, '2026-06')).toEqual({ dueDate: '2026-06-01', amount: 120000 });
    expect(chargeFor({ amount: 120000, period: 'annual', datedue: '06-01' }, '2026-07')).toBeNull();
    expect(chargeFor(null, '2026-07')).toBeNull();
    expect(() => billingMonth('2026-13')).toThrow('month must be a month as YYYY-MM');
  });

  test('payments settle the oldest invoice first; a named invoice first; the rest is credit', () => {
    const invoices = [
      { id: 'b', number: 'I-0002', dueDate: '2026-10-01', total: 400 },
      { id: 'a', number: 'I-0001', dueDate: '2026-09-01', total: 400 }
    ];
    expect(settle(invoices, [{ amount: 500, invoiceId: null }])).toEqual({ paid: new Map([['a', 400], ['b', 100]]), credit: 0 });
    expect(settle(invoices, [{ amount: 500, invoiceId: 'b' }])).toEqual({ paid: new Map([['a', 100], ['b', 400]]), credit: 0 });
    expect(settle(invoices, [{ amount: 1000, invoiceId: null }]).credit).toBe(200);
  });

  test('late charges: once per late invoice, or each month; simple interest at rate ÷ 12', () => {
    expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30);
    const invoices = [{ id: 'a', number: 'I-0001', dueDate: '2026-08-01', total: 41000 }];
    const due = lateChargesDue(invoices, new Map(), RULES, '2026-10-01', new Set());
    expect(due).toEqual([
      { ruleId: 'late-10', appliesTo: 'a', appliesToNumber: 'I-0001', amount: 1000, key: 'late-10|a', daysLate: 61 },
      { ruleId: 'late-60', appliesTo: 'a', appliesToNumber: 'I-0001', amount: 5000 + 273, key: 'late-60|a|2026-10', daysLate: 61 }
    ]);
    // Already made: the once rule never again; the monthly one again next month.
    const made = new Set(due.map(d => d.key));
    expect(lateChargesDue(invoices, new Map(), RULES, '2026-10-01', made)).toEqual([]);
    expect(lateChargesDue(invoices, new Map(), RULES, '2026-11-01', made).map(d => d.key)).toEqual(['late-60|a|2026-11']);
    // Paid: no late charge; exactly the rule's days late: none yet.
    expect(lateChargesDue(invoices, new Map([['a', 41000]]), RULES, '2026-11-01', new Set())).toEqual([]);
    expect(lateChargesDue([{ ...invoices[0]!, dueDate: '2026-09-21' }], new Map(), RULES, '2026-10-01', new Set())).toEqual([]);
  });

  test('billing entries split a charge by share, to the cent', () => {
    expect(splitByShare(41001, [{ share: 60 }, { share: 40 }])).toEqual([24601, 16400]);
    expect(splitByShare(100, [{ share: 100 / 3 }, { share: 100 / 3 }, { share: 100 / 3 }])).toEqual([34, 33, 33]);
  });
});
