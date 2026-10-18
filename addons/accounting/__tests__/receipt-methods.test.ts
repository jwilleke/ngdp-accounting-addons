/**
 * docs/receipt-methods.md is the source of truth for receipt methods. The
 * code's list must be exactly its rows marked "Implemented: yes", with the same
 * labels and codes, in the same order.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { CASH_ON_HAND_METHODS, MANUAL_PAYMENT_MEANS } from '../managers/LedgerManager.js';

const doc = readFileSync(new URL('../../../docs/receipt-methods.md', import.meta.url), 'utf8');

/** The rows of the "The methods" table: label, code (backticks removed), Implemented and Starting account. */
function documentedMethods(): { label: string; code: string; implemented: string; starting: string }[] {
  const section = doc.split('## The methods')[1]?.split('\n## ')[0] ?? '';
  return section.split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| Label') && !line.startsWith('| ---'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .map(([label, code, , implemented, , , starting]) => ({ label, code: code.replace(/`/g, ''), implemented, starting }));
}

test('the docs table is found and every row says whether it is implemented', () => {
  const rows = documentedMethods();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.implemented).toMatch(/^(yes|no|no, later)$/);
});

test('the form offers exactly the documented methods marked implemented, in order', () => {
  const implemented = documentedMethods().filter(r => r.implemented === 'yes').map(r => ({ value: r.code, label: r.label }));
  expect([...MANUAL_PAYMENT_MEANS]).toEqual(implemented);
});

test('the methods that land in Cash on Hand are exactly the documented ones (D-031)', () => {
  const rows = documentedMethods();
  for (const row of rows) expect(row.starting).toMatch(/^(Cash on Hand|default bank account)$/);
  expect([...CASH_ON_HAND_METHODS]).toEqual(rows.filter(r => r.starting === 'Cash on Hand').map(r => r.code));
});
