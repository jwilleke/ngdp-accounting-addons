/**
 * The ledger (docs/plans/ledger-design.md): balances, transfers, voids, the
 * rules the database enforces, permissions at the door, and "no money moves
 * without a record".
 *
 * Each test opens a real encrypted database through ngdpbase's own
 * SqliteDatabaseProvider, in its own temporary folder, and removes only that
 * folder afterwards — never a live data directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import SqliteDatabaseProvider from '../../../dist/src/providers/SqliteDatabaseProvider.js';
import LedgerManager, { LedgerError, type LedgerActor, type LedgerAuditRecord, type LedgerDb } from '../managers/LedgerManager.js';
import { ACCOUNTING_LEDGER_TABLE, ACCOUNTING_MIGRATIONS } from '../managers/migrations.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'fund-manage'];

class Refused extends Error {
  constructor(public readonly permission: string) { super(`refused: ${permission}`); }
}

const actor = (granted: string[] = ALL, username = 'treasurer-tess'): LedgerActor => ({
  ipAddress: '203.0.113.7',
  actingUsername: () => username,
  requirePermission: (permission: string) => (granted.includes(permission) ? Promise.resolve() : Promise.reject(new Refused(permission)))
});

describe('LedgerManager', () => {
  let dir: string;
  let provider: SqliteDatabaseProvider;
  let db: LedgerDb & { exec(sql: string): unknown };
  let audit: LedgerAuditRecord[];
  let auditFails: boolean;
  let ledger: LedgerManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-ledger-'));
    provider = new SqliteDatabaseProvider(path.join(dir, 'accounting.db'), 'test-key-not-a-secret', ACCOUNTING_MIGRATIONS as never, ACCOUNTING_LEDGER_TABLE);
    db = provider.handle as unknown as LedgerDb & { exec(sql: string): unknown };
    audit = [];
    auditFails = false;
    ledger = new LedgerManager({
      db,
      currency: 'USD',
      recordAudit: (record) => {
        if (auditFails) return Promise.reject(new Error('Audit write failed for ledger-record, which is declared on-failure: refuse'));
        audit.push(record);
        return Promise.resolve();
      }
    });
  });

  afterEach(() => {
    provider.close();
    // Only this test's temporary folder.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const fund = (name: string, openingBalance = 0) => ledger.createFund(actor(), { name, openingBalance, openingDate: '2026-01-01' });
  const entry = (fundId: string, direction: 'in' | 'out', amount: number, extra: Record<string, unknown> = {}) =>
    ledger.postTransaction(actor(), { fundId, direction, amount, date: '2026-10-08', category: '4010', ...extra });

  test('the migration is recorded in the add-on\'s own ledger table', () => {
    const rows = db.prepare(`SELECT id FROM ${ACCOUNTING_LEDGER_TABLE}`).all() as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(ACCOUNTING_MIGRATIONS.map(m => m.id));
  });

  describe('balances', () => {
    test('a fund\'s balance is its opening balance plus posted money in, minus posted money out', async () => {
      const general = await fund('General', 10_000);
      await entry(general.id, 'in', 2_500);
      await entry(general.id, 'out', 700);
      const [balance] = await ledger.fundBalances(actor());
      expect(balance).toMatchObject({ name: 'General', openingBalance: 10_000, totalIn: 2_500, totalOut: 700, balance: 11_800 });
    });

    test('every entry carries the site currency', async () => {
      const general = await fund('General');
      expect((await entry(general.id, 'in', 100)).currency).toBe('USD');
      expect(() => new LedgerManager({ db, currency: 'usd', recordAudit: () => Promise.resolve() })).toThrow(/ISO 4217/);
    });
  });

  describe('transfers', () => {
    test('a transfer moves money between two funds and leaves the total unchanged', async () => {
      const general = await fund('General', 5_000);
      const building = await fund('Building', 1_000);
      const before = (await ledger.fundBalances(actor())).reduce((sum, b) => sum + b.balance, 0);
      const [out, into] = await ledger.transferBetweenFunds(actor(), { fromFundId: general.id, toFundId: building.id, amount: 1_500, date: '2026-10-08' });
      expect(out.transferId).toBe(into.transferId);
      const balances = Object.fromEntries((await ledger.fundBalances(actor())).map(b => [b.name, b.balance]));
      expect(balances).toEqual({ Building: 2_500, General: 3_500 });
      expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(before);
    });

    test('voiding one half of a transfer voids both halves, and allows no replacement', async () => {
      const a = await fund('A', 1_000);
      const b = await fund('B');
      const [out] = await ledger.transferBetweenFunds(actor(), { fromFundId: a.id, toFundId: b.id, amount: 400, date: '2026-10-08' });
      await expect(ledger.voidTransaction(actor(), out.id, 'wrong fund', { fundId: a.id, direction: 'in', amount: 1, date: '2026-10-08', category: '4010' }))
        .rejects.toThrow(/voided as a pair/);
      const { voided } = await ledger.voidTransaction(actor(), out.id, 'wrong fund');
      expect(voided.map(t => t.status)).toEqual(['voided', 'voided']);
      expect((await ledger.fundBalances(actor())).map(x => x.balance)).toEqual([1_000, 0]);
    });
  });

  describe('voids', () => {
    test('a void keeps the original, links its replacement, and only the replacement counts', async () => {
      const general = await fund('General');
      const wrong = await entry(general.id, 'in', 5_000);
      const { voided, replacement } = await ledger.voidTransaction(actor(), wrong.id, 'typed 50.00 for 5.00',
        { fundId: general.id, direction: 'in', amount: 500, date: '2026-10-08', category: '4010' });
      expect(voided[0]).toMatchObject({ id: wrong.id, status: 'voided', voidReason: 'typed 50.00 for 5.00', voidedById: replacement?.id });
      expect(replacement).toMatchObject({ voidsId: wrong.id, status: 'posted', sourceType: 'adjustment' });
      expect((await ledger.fundBalances(actor()))[0].balance).toBe(500);
      expect((await ledger.listTransactions(actor(), { includeVoided: true })).map(t => t.id)).toContain(wrong.id);
    });

    test('a void needs a reason, and an entry is voided only once', async () => {
      const general = await fund('General');
      const t = await entry(general.id, 'in', 100);
      await expect(ledger.voidTransaction(actor(), t.id, '  ')).rejects.toThrow(/reason is required/);
      await ledger.voidTransaction(actor(), t.id, 'duplicate');
      await expect(ledger.voidTransaction(actor(), t.id, 'again')).rejects.toThrow(/already voided/);
    });
  });

  describe('the database refuses what the ledger must never do', () => {
    test('an entry\'s money cannot be changed, and an entry cannot be deleted', async () => {
      const general = await fund('General');
      const t = await entry(general.id, 'in', 100);
      expect(() => db.prepare('UPDATE accounting_transactions SET amount = 1 WHERE id = ?').run(t.id)).toThrow(/money never changes/);
      expect(() => db.prepare('UPDATE accounting_transactions SET fund_id = ? WHERE id = ?').run('x', t.id)).toThrow(/money never changes/);
      expect(() => db.prepare('DELETE FROM accounting_transactions WHERE id = ?').run(t.id)).toThrow(/never deleted/);
    });

    test('status only goes from posted to voided, once, with a reason', async () => {
      const general = await fund('General');
      const t = await entry(general.id, 'in', 100);
      expect(() => db.prepare("UPDATE accounting_transactions SET status = 'voided' WHERE id = ?").run(t.id)).toThrow();
      db.prepare("UPDATE accounting_transactions SET status = 'voided', void_reason = 'r' WHERE id = ?").run(t.id);
      expect(() => db.prepare("UPDATE accounting_transactions SET status = 'posted', void_reason = NULL WHERE id = ?").run(t.id)).toThrow(/posted to voided, once/);
    });

    test('history is append-only, funds are never deleted, and opening balances never change', async () => {
      const general = await fund('General', 100);
      expect(() => db.prepare('UPDATE accounting_history SET actor = ?').run('someone')).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM accounting_history').run()).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM accounting_funds WHERE id = ?').run(general.id)).toThrow(/never deleted/);
      expect(() => db.prepare('UPDATE accounting_funds SET opening_balance = 5 WHERE id = ?').run(general.id)).toThrow(/opening balance/);
    });

    test('an entry must belong to a fund that exists', () => {
      expect(() => db.exec(`INSERT INTO accounting_transactions (id, direction, amount, currency, date, fund_id, category, source_type, status, created_by, created_at)
        VALUES ('t', 'in', 1, 'USD', '2026-10-08', 'no-such-fund', '4010', 'manual', 'posted', 'x', 'x')`)).toThrow(/unknown fund/);
    });
  });

  describe('no money moves without a record', () => {
    test('when the audit record cannot be written, nothing is posted and nothing enters history', async () => {
      const general = await fund('General');
      const historyBefore = count('accounting_history');
      auditFails = true;
      await expect(entry(general.id, 'in', 100)).rejects.toThrow(/on-failure: refuse/);
      expect(count('accounting_transactions')).toBe(0);
      expect(count('accounting_history')).toBe(historyBefore);
    });

    test('each action is recorded under its permission\'s audit event, with the acting user', async () => {
      const a = await fund('A', 1_000);
      const b = await fund('B');
      const t = await entry(a.id, 'in', 100);
      await ledger.voidTransaction(actor(), t.id, 'test');
      await ledger.transferBetweenFunds(actor(), { fromFundId: a.id, toFundId: b.id, amount: 10, date: '2026-10-08' });
      await ledger.closeFund(actor(), b.id, 'event over');
      expect(audit.map(r => `${r.eventType}/${r.action}`)).toEqual([
        'fund-manage/fund-create', 'fund-manage/fund-create', 'ledger-record/ledger-post',
        'ledger-adjust/ledger-void', 'ledger-adjust/ledger-transfer', 'fund-manage/fund-close'
      ]);
      expect(audit.every(r => r.user === 'treasurer-tess' && r.ipAddress === '203.0.113.7')).toBe(true);
    });
  });

  describe('permissions at the door', () => {
    test('each action refuses without its own permission, before anything is recorded or written', async () => {
      const general = await fund('General');
      const t = await entry(general.id, 'in', 100);
      audit.length = 0;
      const nobody = actor([]);
      const attempts: [string, () => Promise<unknown>][] = [
        ['fund-manage', () => ledger.createFund(nobody, { name: 'X' })],
        ['fund-manage', () => ledger.closeFund(nobody, general.id)],
        ['ledger-record', () => ledger.postTransaction(nobody, { fundId: general.id, direction: 'in', amount: 1, date: '2026-10-08', category: '4010' })],
        ['ledger-adjust', () => ledger.voidTransaction(nobody, t.id, 'x')],
        ['ledger-adjust', () => ledger.transferBetweenFunds(nobody, { fromFundId: general.id, toFundId: general.id, amount: 1, date: '2026-10-08' })],
        ['ledger-read', () => ledger.listTransactions(nobody)],
        ['ledger-summary-read', () => ledger.fundBalances(nobody)]
      ];
      for (const [permission, attempt] of attempts) {
        await expect(attempt()).rejects.toMatchObject({ permission });
      }
      expect(audit).toEqual([]);
      expect(count('accounting_transactions')).toBe(1);
    });

    test('the permission decides, whatever the role is called', async () => {
      const general = await fund('General');
      const bookkeeper = actor(['ledger-record'], 'not-a-treasurer');
      expect((await ledger.postTransaction(bookkeeper, { fundId: general.id, direction: 'out', amount: 1, date: '2026-10-08', category: '5010' })).createdBy).toBe('not-a-treasurer');
    });
  });

  describe('input', () => {
    test('amounts are whole cents above 0, dates are YYYY-MM-DD, payment methods are UN/CEFACT codes, and closed funds take no entries', async () => {
      const general = await fund('General');
      await expect(entry(general.id, 'in', 10.5)).rejects.toThrow(/whole number of cents/);
      await expect(entry(general.id, 'in', 0)).rejects.toThrow(/more than 0/);
      await expect(entry(general.id, 'in', 1, { date: '10/08/2026' })).rejects.toThrow(/YYYY-MM-DD/);
      await expect(entry(general.id, 'in', 1, { paymentMethod: 'cash' })).rejects.toThrow(/UN\/CEFACT/);
      expect((await entry(general.id, 'in', 1, { paymentMethod: '20', paymentMethodId: '1042' })).paymentMethod).toBe('20');
      await ledger.closeFund(actor(), general.id);
      await expect(entry(general.id, 'in', 1)).rejects.toThrow(/is closed/);
      await expect(entry('no-such-fund', 'in', 1)).rejects.toBeInstanceOf(LedgerError);
    });

    test('fund names are unique', async () => {
      await fund('General');
      await expect(fund('General')).rejects.toThrow(/already exists/);
    });
  });

  describe('every committed write says the ledger changed (the owner bumps)', () => {
    let changes: number;
    let tracked: LedgerManager;

    beforeEach(() => {
      changes = 0;
      tracked = new LedgerManager({
        db, currency: 'USD', recordAudit: (r) => { audit.push(r); return Promise.resolve(); },
        dataChanged: () => { changes++; }
      });
    });

    test('once per write: fund create, rename and close; entry; void; transfer', async () => {
      const a = await tracked.createFund(actor(), { name: 'General' });
      const b = await tracked.createFund(actor(), { name: 'Roof' });
      await tracked.updateFund(actor(), b.id, { name: 'Roof Reserve' });
      const t = await tracked.postTransaction(actor(), { direction: 'in', amount: 500, date: '2026-10-10', fundId: a.id, category: '4100' });
      await tracked.voidTransaction(actor(), t.id, 'typo');
      await tracked.transferBetweenFunds(actor(), { fromFundId: a.id, toFundId: b.id, amount: 100, date: '2026-10-10' });
      await tracked.closeFund(actor(), b.id, 'done');
      expect(changes).toBe(7);
    });

    test('a refused or invalid write says nothing', async () => {
      const f = await tracked.createFund(actor(), { name: 'General' });
      changes = 0;
      await expect(tracked.postTransaction(actor([]), { direction: 'in', amount: 5, date: '2026-10-10', fundId: f.id, category: '4100' })).rejects.toThrow();
      await expect(tracked.postTransaction(actor(), { direction: 'in', amount: -5, date: '2026-10-10', fundId: f.id, category: '4100' })).rejects.toThrow();
      expect(changes).toBe(0);
    });

    test('a failure to say so does not undo the write', async () => {
      const failing = new LedgerManager({ db, currency: 'USD', recordAudit: () => Promise.resolve(), dataChanged: () => { throw new Error('cache down'); } });
      const f = await failing.createFund(actor(), { name: 'General' });
      expect((await failing.listFunds(actor())).map(x => x.id)).toEqual([f.id]);
    });
  });
});
