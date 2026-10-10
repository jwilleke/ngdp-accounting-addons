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
import { ENTRY_FORM, entryFromForm, fieldOf } from '../forms.js';

const treasurer: LedgerActor = {
  ipAddress: undefined,
  actingUsername: () => 'tess',
  requirePermission: () => Promise.resolve()
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
      viewerMay: async (viewer, permission) => { asked.push([viewer, permission]); return (viewer as { username?: string } | undefined)?.username === 'tess'; },
      categories: () => ({ '4100': 'Dues', '5200': 'Supplies' })
    });
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('offers open funds only, by id and name, asking the viewer for ledger-record', async () => {
    const general = await ledger.createFund(treasurer, { name: 'General' });
    const old = await ledger.createFund(treasurer, { name: 'Old Roof' });
    await ledger.closeFund(treasurer, old.id, 'done');
    const viewer = { username: 'tess' };
    expect(await ledger.toFormOptions({ list: 'funds' }, viewer)).toEqual([{ value: general.id, label: 'General' }]);
    expect(asked).toEqual([[viewer, 'ledger-record']]);
  });

  test('offers the configured categories and the manual payment means', async () => {
    const viewer = { username: 'tess' };
    expect(await ledger.toFormOptions({ list: 'categories' }, viewer)).toEqual([
      { value: '4100', label: '4100 Dues' }, { value: '5200', label: '5200 Supplies' }
    ]);
    expect(await ledger.toFormOptions({ list: 'payment-methods' }, viewer)).toEqual([...MANUAL_PAYMENT_MEANS]);
  });

  test('a viewer who may not record an entry is offered nothing', async () => {
    await ledger.createFund(treasurer, { name: 'General' });
    expect(await ledger.toFormOptions({ list: 'funds' }, { username: 'molly' })).toEqual([]);
    expect(await ledger.toFormOptions({ list: 'funds' }, undefined)).toEqual([]);
  });

  test('an unknown list is no choices', async () => {
    expect(await ledger.toFormOptions({ list: 'secrets' }, { username: 'tess' })).toEqual([]);
  });
});

describe('the entry form', () => {
  test('its field names are the ledger\'s, so errors land on the right field', () => {
    expect(fieldOf('amount must be a whole number of cents, more than 0')).toBe('amount');
    expect(fieldOf("fund 'Old Roof' is closed")).toBe('fundId');
    expect(fieldOf('fundId is required')).toBe('fundId');
    expect(fieldOf('paymentMethod must be a UN/CEFACT payment means code, e.g. 10 (cash) or 20 (cheque)')).toBe('paymentMethod');
    expect(fieldOf('something else broke')).toBeUndefined();
  });

  test('a submitted form becomes a ledger entry; empty optional fields are left out', () => {
    expect(entryFromForm({ direction: 'in', amount: 12550, date: '2026-10-10', fundId: 'f1', category: '4100', partyName: '', paymentMethod: '10', memo: '' })).toEqual({
      direction: 'in', amount: 12550, date: '2026-10-10', fundId: 'f1', category: '4100', partyName: undefined, paymentMethod: '10', memo: undefined
    });
  });

  test('the form keeps no submission file: the ledger entry is the record', () => {
    expect(ENTRY_FORM.store).toBe(false);
  });
});
