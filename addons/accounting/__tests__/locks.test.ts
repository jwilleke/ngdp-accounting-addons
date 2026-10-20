/**
 * Period locks (#19): the treasurer chooses month, quarter, half-year or year
 * and the fiscal year's first month; a locked period takes no new entries,
 * voids or corrections until it is unlocked, with a reason.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openTestLedgerDatabase, testLedgerParts } from './host.js';
import LedgerManager, { periodEnds, type LedgerActor, type LedgerAuditRecord, type LedgerDb } from '../managers/LedgerManager.js';
import { LEDGER_FORMS, fieldOf } from '../forms.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'receipt-refund', 'fund-manage'];
const decide = async (subject: unknown, { action }: { action: string }) =>
  ({ permit: Boolean((subject as { granted?: string[] } | null)?.granted?.includes(action)), applicable: true, reason: 'test' });
const actor = (granted: string[] = ALL): LedgerActor => ({
  ipAddress: undefined, actingUsername: () => 'tess', subject: { username: 'tess', granted } as never,
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

test('period ends follow the chosen period and the fiscal year start', () => {
  expect(periodEnds({ period: 'quarter', fiscalStartMonth: 7 }, '2026-01-01', '2026-12-31')).toEqual(['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31']);
  expect(periodEnds({ period: 'half-year', fiscalStartMonth: 1 }, '2025-12-31', '2026-12-31')).toEqual(['2026-06-30', '2026-12-31']);
  expect(periodEnds({ period: 'year', fiscalStartMonth: 10 }, '2025-01-01', '2026-12-31')).toEqual(['2025-09-30', '2026-09-30']);
  expect(periodEnds({ period: 'month', fiscalStartMonth: 1 }, '2026-01-31', '2026-03-15')).toEqual(['2026-02-28']);
});

describe('period locks', () => {
  let provider: { handle: unknown; close(): void };
  let ledger: LedgerManager;
  let audit: LedgerAuditRecord[];
  let fundId: string;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    audit = [];
    ledger = new LedgerManager({ ...testLedgerParts, db: provider.handle as LedgerDb, currency: 'USD', decide,
      now: () => new Date('2026-10-20T12:00:00Z'), recordAudit: (r) => { audit.push(r); return Promise.resolve(); } });
    fundId = (await ledger.createFund(actor(), { name: 'General', openingDate: '2026-01-01' })).id;
  });

  afterEach(() => provider.close());

  const out = (date: string) => ledger.postTransaction(actor(), { direction: 'out', amount: 100, date, fundId, category: '6200', memo: 'paper' });

  test('the treasurer chooses the period; locking offers only ended period ends after the current lock', async () => {
    await expect(ledger.setLockSettings(actor(['ledger-record']), { period: 'quarter', fiscalStartMonth: 1 })).rejects.toThrow('refused: fund-manage');
    await ledger.setLockSettings(actor(), { period: 'quarter', fiscalStartMonth: 1 });
    const offered = (await ledger.toFormOptions({ list: 'lockable-periods' }, { username: 'tess', granted: ALL })).map(o => o.value);
    expect(offered.slice(0, 3)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31']);
    await expect(ledger.lockPeriod(actor(), '2026-08-31')).rejects.toThrow('throughDate: 2026-08-31 is not the end of a quarter that has ended');
    await expect(ledger.lockPeriod(actor(), '2026-12-31')).rejects.toThrow('is not the end of a quarter that has ended');
    expect(await ledger.lockPeriod(actor(), '2026-09-30')).toEqual({ lockedThrough: '2026-09-30' });
    await expect(ledger.lockPeriod(actor(), '2026-06-30')).rejects.toThrow('everything through 2026-09-30 is already locked');
    expect(await ledger.lockStatus(actor())).toEqual({ period: 'quarter', fiscalStartMonth: 1, lockedThrough: '2026-09-30' });
    expect(audit.map(r => r.action)).toEqual(['fund-create', 'lock-settings', 'period-lock']);
  });

  test('nothing dated in a locked period can be added, voided or corrected; the open period works as before', async () => {
    const early = await out('2026-09-15');
    await ledger.lockPeriod(actor(), '2026-09-30');
    await expect(out('2026-09-20')).rejects.toThrow('date: 2026-09-20 is in a locked period (locked through 2026-09-30)');
    await expect(ledger.voidTransaction(actor(), early.id, 'oops')).rejects.toThrow('transactionId: 2026-09-15 is in a locked period');
    await expect(ledger.postReceipt(actor(), { amount: 100, date: '2026-08-01', fundId, category: '4200', partyName: 'Pat', paymentMethod: '10', memo: 'gift' }, { provider: 'manual' }))
      .rejects.toThrow('is in a locked period');
    await expect(ledger.createFund(actor(), { name: 'Roof', openingDate: '2026-09-01' })).rejects.toThrow('openingDate: 2026-09-01 is in a locked period');
    expect((await out('2026-10-01')).date).toBe('2026-10-01');
    expect(fieldOf(LEDGER_FORMS.find(f => f.definition.id === 'ledger-entry')!, 'date: 2026-09-20 is in a locked period (locked through 2026-09-30)')).toBe('date');
  });

  test('unlocking takes the latest lock off, with a reason, and the one before stands', async () => {
    await ledger.lockPeriod(actor(), '2026-08-31');
    await ledger.lockPeriod(actor(), '2026-09-30');
    await expect(ledger.unlockPeriod(actor(), ' ')).rejects.toThrow(/reason is required/);
    expect(await ledger.unlockPeriod(actor(), 'a September check was missed')).toEqual({ lockedThrough: '2026-08-31' });
    expect((await out('2026-09-20')).date).toBe('2026-09-20');
    await expect(out('2026-08-20')).rejects.toThrow('locked through 2026-08-31');
    await ledger.unlockPeriod(actor(), 'year-end review');
    await expect(ledger.unlockPeriod(actor(), 'again')).rejects.toThrow('nothing is locked');
    expect(audit.filter(r => r.action === 'period-unlock').map(r => r.reason)).toEqual(['a September check was missed', 'year-end review']);
  });
});
