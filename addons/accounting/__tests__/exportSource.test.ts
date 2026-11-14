/**
 * The ledger as an ICE export source (ngdpbase#2174, slice 4): the CSV download
 * runs through core's export engine, and keeps everything the old download
 * had: the ledger-export permission, the step-up (a recent sign-in), and the
 * audit record (who, period, row count, SHA-256) written before any row is
 * handed over.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ActorContext, IceExportSource, IceItem } from '@jwilleke/ngdpbase-types';
import { openTestLedgerDatabase, testLedgerParts } from './host.js';
import LedgerManager, { type LedgerActor, type LedgerAuditRecord, type LedgerDb } from '../managers/LedgerManager.js';
import { ledgerExportRef, ledgerExportSource, parseLedgerExportRef } from '../exportSource.js';

const ALL = ['ledger-summary-read', 'ledger-read', 'ledger-record', 'ledger-adjust', 'ledger-export', 'fund-manage'];
const TRANSACTION_COLUMNS = ['id', 'date', 'direction', 'amount_minor', 'amount', 'currency', 'fund_id', 'fund', 'account_id', 'account', 'category', 'party_person_id', 'party_name',
  'payment_method', 'payment_method_id', 'provider', 'confirmation_number', 'document_number', 'source_type', 'source_id', 'status', 'voids_id',
  'voided_by_id', 'void_reason', 'transfer_id', 'memo', 'created_by', 'created_at'];

/** The treasurer who writes the books (the old, request-shaped actor). */
const writer = (): LedgerActor => ({
  ipAddress: '203.0.113.7',
  subject: { username: 'tess', roles: ['treasurer'], isAuthenticated: true, ipAddress: '203.0.113.7', granted: ALL } as never,
  actingUsername: () => 'tess',
  enforceDeny: (p: string) => Promise.reject(Object.assign(new Error(`refused: ${p}`), { status: 403 }))
});

/** What the export engine hands the source: the user's context, not a request. */
const user = (granted: string[] = ALL, extra: Record<string, unknown> = {}): ActorContext =>
  ({ username: 'tess', roles: ['treasurer'], isAuthenticated: true, ipAddress: '203.0.113.7', granted, ...extra }) as never;

const info = { format: 'core.csv-file', note: () => undefined };
const OCT = ledgerExportRef('transactions', { from: '2026-10-01', to: '2026-10-31' });

describe('the ledger as an export source', () => {
  let provider: { handle: unknown; close(): void };
  let audit: LedgerAuditRecord[];
  let auditFails: boolean;
  let ledger: LedgerManager;
  let source: IceExportSource;

  beforeEach(async () => {
    provider = openTestLedgerDatabase();
    audit = [];
    auditFails = false;
    ledger = new LedgerManager({ ...testLedgerParts,
      db: provider.handle as unknown as LedgerDb,
      currency: 'USD',
      now: () => new Date('2026-10-15T12:00:00Z'),
      recordAudit: (r) => (auditFails ? Promise.reject(new Error('audit down')) : (audit.push(r), Promise.resolve())),
      categories: () => ({ '4100': 'Dues', '5200': 'Supplies' }),
      // The decision point's three answers: permit, no, and "you hold it, but sign in again" (reason 'step-up').
      decide: async (subject, { action }) => {
        const s = subject as { granted?: string[]; stale?: boolean } | null;
        const holds = !!s?.granted?.includes(action);
        if (holds && s?.stale && action === 'ledger-export') return { permit: false, applicable: true, reason: 'step-up', policyIds: [] };
        return { permit: holds, applicable: true, reason: 'test', policyIds: [] };
      }
    });
    const general = (await ledger.createFund(writer(), { name: 'General', openingBalance: 10000, openingDate: '2026-09-01' })).id;
    await ledger.postReceipt(writer(), { amount: 20000, date: '2026-10-03', fundId: general, category: '4100', partyName: 'Pat', paymentMethod: '20', memo: 'dues' } as never, { provider: 'manual' });
    await ledger.postTransaction(writer(), { direction: 'out', amount: 3000, date: '2026-10-04', fundId: general, category: '5200', memo: '=SUM(A1)' });
    audit = [];
    source = ledgerExportSource(ledger);
  });

  afterEach(() => {
    provider.close();
  });

  const rowsOf = (items: IceItem[] | null): Record<string, unknown>[] => (items ?? []).map(i => (i.data as { properties: Record<string, unknown> }).properties);

  test('is one record source, named ledger', () => {
    expect(source.name).toBe('ledger');
    expect(source.yields).toBe('record');
  });

  test('a reader with ledger-export and a recent sign-in gets one record per row, with the old columns in the old order', async () => {
    expect(await source.mayExport(OCT, user())).toBe(true);
    const items = await source.read(OCT, user(), info);
    expect(items).toHaveLength(3); // the opening balance's receipt, the dues receipt and the supplies entry dated in October
    expect(items?.every(i => i.kind === 'record' && i.name === 'ledger-transactions-2026-10-01-to-2026-10-31')).toBe(true);
    expect(Object.keys(rowsOf(items)[0])).toEqual(TRANSACTION_COLUMNS);
    expect(rowsOf(items).map(r => r.amount_minor)).toContain(20000);
    expect(rowsOf(items).find(r => r.amount_minor === 20000)).toMatchObject({ amount: '200.00', currency: 'USD', fund: 'General', status: 'posted' });
  });

  test('the fund summary is the second kind, with the old columns', async () => {
    const items = await source.read(ledgerExportRef('funds', { from: '2026-10-01', to: '2026-10-31' }), user(), info);
    expect(items).toHaveLength(1);
    expect(Object.keys(rowsOf(items)[0])).toEqual(['fund_id', 'fund', 'active', 'currency', 'start_minor', 'opened_minor', 'in_minor', 'out_minor', 'end_minor', 'start', 'opened', 'in', 'out', 'end']);
    expect(rowsOf(items)[0]).toMatchObject({ fund: 'General', in_minor: 20000, out_minor: 3000 });
  });

  test('without ledger-export, mayExport says no, read refuses, and nothing is recorded', async () => {
    const reader = user(['ledger-summary-read', 'ledger-read']);
    expect(await source.mayExport(OCT, reader)).toBe(false);
    expect(await source.read(OCT, reader, info)).toBeNull();
    expect(audit).toEqual([]);
  });

  test('without a recent sign-in, read refuses and hands over no rows; the action is still offered', async () => {
    const stale = user(ALL, { stale: true });
    expect(await source.mayExport(OCT, stale)).toBe(true); // they hold it: the engine's page asks them to sign in again
    expect(await source.read(OCT, stale, info)).toBeNull();
    expect(audit).toEqual([]);
  });

  test('the audit record has who, the period, the row count and the SHA-256 of the CSV, and is written before the rows go out', async () => {
    const items = await source.read(OCT, user(), info);
    expect(audit).toHaveLength(1);
    const direct = await ledger.exportCsv(writer(), 'transactions', { from: '2026-10-01', to: '2026-10-31' });
    expect(audit[0]).toMatchObject({ action: 'ledger-export', user: 'tess', severity: 'high', resource: 'transactions:2026-10-01..2026-10-31',
      metadata: { kind: 'transactions', from: '2026-10-01', to: '2026-10-31', rows: items?.length, sha256: direct.sha256 } });
    expect(audit[0].metadata.sha256).toBe(createHash('sha256').update(direct.body).digest('hex'));
    expect(audit[0].metadata).toMatchObject({ via: 'ice' });
  });

  test('if the audit record cannot be written there are no rows', async () => {
    auditFails = true;
    await expect(source.read(OCT, user(), info)).rejects.toThrow(/audit down/);
  });

  test('an empty period hands over nothing and records nothing', async () => {
    expect(await source.read(ledgerExportRef('transactions', { from: '2020-01-01', to: '2020-01-31' }), user(), info)).toBeNull();
    expect(audit).toEqual([]);
  });

  test('the old download and the engine give the same rows: one code path', async () => {
    const file = await ledger.exportCsv(writer(), 'transactions', { from: '2026-10-01', to: '2026-10-31' });
    const items = await source.read(OCT, user(), info);
    expect(items).toHaveLength(file.rows);
    expect(file.body.split('\r\n')[0]).toBe(TRANSACTION_COLUMNS.join(','));
  });

  test.each([
    '', 'transactions', 'transactions:', 'transactions:2026-10-01', 'transactions:2026-10-01..', 'transactions:..2026-10-31',
    'entries:2026-10-01..2026-10-31', 'Transactions:2026-10-01..2026-10-31', ' transactions:2026-10-01..2026-10-31',
    'transactions:2026-10-31..2026-10-01', 'transactions:2026-02-31..2026-03-01', 'transactions:2026-13-01..2026-13-02',
    'transactions:2026-10-01..2026-10-31 ', 'transactions:2026-10-01..2026-10-31\n', 'transactions:2026-10-01..2026-10-31&kind=funds',
    'transactions:2026-1-1..2026-10-31', "funds:2026-10-01..2026-10-31'; DROP TABLE accounting_transactions;--", '{"kind":"funds"}', 'x'.repeat(10_000)
  ])('junk ref %j is refused by both mayExport and read, and records nothing', async (ref) => {
    expect(parseLedgerExportRef(ref)).toBeNull();
    expect(await source.mayExport(ref, user())).toBe(false);
    expect(await source.read(ref, user(), info)).toBeNull();
    expect(audit).toEqual([]);
  });

  test('a good ref round-trips', () => {
    expect(parseLedgerExportRef(OCT)).toEqual({ kind: 'transactions', period: { from: '2026-10-01', to: '2026-10-31' } });
    expect(OCT).toBe('transactions:2026-10-01..2026-10-31');
  });
});
