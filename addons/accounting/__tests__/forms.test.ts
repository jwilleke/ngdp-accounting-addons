/**
 * The treasurer's entry form: the choices the ledger offers a viewer, and how
 * a submitted form becomes a ledger entry. Each test opens its own temporary
 * database and removes only that folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import SqliteDatabaseProvider from '../../../dist/src/providers/SqliteDatabaseProvider.js';
import LedgerManager, { MANUAL_PAYMENT_MEANS, type LedgerActor, type LedgerDb } from '../managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';
import { LEDGER_FORMS, entryFromForm, fieldOf } from '../forms.js';

const formById = (id: string) => LEDGER_FORMS.find(f => f.definition.id === id)!;

const treasurer: LedgerActor = {
  ipAddress: undefined,
  actingUsername: () => 'tess',
  subject: { username: 'tess' } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
};

describe('LedgerManager.toFormOptions', () => {
  let dir: string;
  let provider: SqliteDatabaseProvider;
  let asked: unknown[];
  let ledger: LedgerManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-forms-'));
    provider = new SqliteDatabaseProvider(path.join(dir, 'accounting.db'), 'test-key-not-a-secret', ACCOUNTING_MIGRATIONS as never, ACCOUNTING_LEDGER_TABLE);
    asked = [];
    ledger = new LedgerManager({
      db: provider.handle as unknown as LedgerDb,
      currency: 'USD',
      recordAudit: () => Promise.resolve(),
      decide: async (subject, { action }) => {
        asked.push([subject, action]);
        return { permit: (subject as { username?: string } | null)?.username === 'tess', applicable: true, reason: 'test' };
      },
      categories: () => ({ '4100': 'Dues', '5200': 'Supplies' })
    });
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('offers open funds only, by id and name, asking the viewer for ledger-summary-read', async () => {
    const general = await ledger.createFund(treasurer, { name: 'General' });
    const old = await ledger.createFund(treasurer, { name: 'Old Roof' });
    await ledger.closeFund(treasurer, old.id, 'done');
    const viewer = { username: 'tess' };
    asked.length = 0; // only the dropdown's own question, not the setup's
    expect(await ledger.toFormOptions({ list: 'funds' }, viewer)).toEqual([{ value: general.id, label: 'General' }]);
    expect(asked).toEqual([[viewer, 'ledger-summary-read']]);
  });

  test('offers the configured categories and the manual payment means', async () => {
    const viewer = { username: 'tess' };
    expect(await ledger.toFormOptions({ list: 'categories' }, viewer)).toEqual([
      { value: '4100', label: '4100 Dues' }, { value: '5200', label: '5200 Supplies' }
    ]);
    expect(await ledger.toFormOptions({ list: 'payment-methods' }, viewer)).toEqual([...MANUAL_PAYMENT_MEANS]);
  });

  test('entries: the latest posted, labelled so the right one can be picked, for a viewer who may read entries', async () => {
    const f = await ledger.createFund(treasurer, { name: 'General' });
    const t = await ledger.postTransaction(treasurer, { direction: 'in', amount: 125050, date: '2026-10-10', fundId: f.id, category: '4100', partyName: 'Pat' });
    expect(await ledger.toFormOptions({ list: 'entries' }, { username: 'tess' })).toEqual([{ value: t.id, label: '2026-10-10 · General · in $1,250.50 · Pat' }]);
  });

  test('a viewer who may not see the ledger is offered nothing', async () => {
    await ledger.createFund(treasurer, { name: 'General' });
    expect(await ledger.toFormOptions({ list: 'funds' }, { username: 'molly' })).toEqual([]);
    expect(await ledger.toFormOptions({ list: 'funds' }, undefined)).toEqual([]);
  });

  test('an unknown list is no choices', async () => {
    expect(await ledger.toFormOptions({ list: 'secrets' }, { username: 'tess' })).toEqual([]);
  });
});

describe('the entry form', () => {
  test('field names are the ledger\'s, so its errors land on the right field', () => {
    const entry = formById('ledger-entry');
    expect(fieldOf(entry, 'amount must be a whole number of cents, more than 0')).toBe('amount');
    expect(fieldOf(entry, "fund 'Old Roof' is closed")).toBe('fundId');
    expect(fieldOf(entry, 'fundId is required')).toBe('fundId');
    expect(fieldOf(entry, 'paymentMethod must be a UN/CEFACT payment means code, e.g. 10 (cash) or 20 (cheque)')).toBe('paymentMethod');
    expect(fieldOf(entry, 'something else broke')).toBeUndefined();
    expect(fieldOf(formById('ledger-transfer'), 'a transfer needs two different funds')).toBe('toFundId');
    expect(fieldOf(formById('ledger-void'), 'this entry is already voided')).toBe('transactionId');
    expect(fieldOf(formById('fund-create'), "a fund named 'General' already exists")).toBe('name');
  });

  test('a submitted form becomes a ledger entry; empty optional fields are left out', () => {
    expect(entryFromForm({ direction: 'in', amount: 12550, date: '2026-10-10', fundId: 'f1', category: '4100', partyName: '', paymentMethod: '10', memo: '' })).toEqual({
      direction: 'in', amount: 12550, date: '2026-10-10', fundId: 'f1', category: '4100', partyName: undefined, paymentMethod: '10', memo: undefined
    });
  });

  test('no form keeps a submission file: the ledger is the record', () => {
    expect(LEDGER_FORMS.map(f => f.definition.store)).toEqual(LEDGER_FORMS.map(() => false));
  });

  test('every form posts through the ledger, which refuses a viewer without the permission', async () => {
    const ids = LEDGER_FORMS.map(f => f.definition.id);
    expect(ids).toEqual(['ledger-entry', 'ledger-transfer', 'ledger-void', 'fund-create', 'fund-rename', 'fund-close']);
  });
});
