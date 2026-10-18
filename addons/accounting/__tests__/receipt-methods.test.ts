/**
 * docs/receipt-methods.md is the source of truth for receipt methods. The
 * code's list must be exactly its rows marked "Implemented: yes", with the same
 * labels and codes, in the same order.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { MANUAL_PAYMENT_MEANS } from '../managers/LedgerManager.js';

const doc = readFileSync(new URL('../../../docs/receipt-methods.md', import.meta.url), 'utf8');

/** The rows of the "The methods" table: label, code (backticks removed) and Implemented. */
function documentedMethods(): { label: string; code: string; implemented: string }[] {
  const section = doc.split('## The methods')[1]?.split('\n## ')[0] ?? '';
  return section.split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| Label') && !line.startsWith('| ---'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .map(([label, code, , implemented]) => ({ label, code: code.replace(/`/g, ''), implemented }));
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
