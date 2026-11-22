/**
 * The ledger as an ICE export source (ngdpbase#2174, slice 4): the CSV
 * download runs through core's export engine. Registered in index.ts as
 * `accounting.ledger`, yielding `record` items that core's `core.csv-file`
 * writes as the CSV.
 *
 * It is the ledger's own door and the only permission: LedgerManager asks
 * ledger-export (and its step-up) and writes the audit record before a row is
 * handed over. The engine hands a context, not a request, so a refusal cannot
 * send anyone to sign in again here: `read` answers null, and nothing is
 * handed over (see the README).
 *
 * `ref` is `<kind>:<from>..<to>`: kind `transactions` or `funds`, both dates
 * YYYY-MM-DD, e.g. `transactions:2026-10-01..2026-10-31`. It is request input
 * and is parsed strictly.
 */
import type { ActorContext, IceExportSource, IceItem } from '@jwilleke/ngdpbase-types';
import type LedgerManager from './managers/LedgerManager.js';
import type { LedgerActor, Period } from './managers/LedgerManager.js';

type Kind = 'transactions' | 'funds';

/** The source's id on the engine: `<slug>.<name>`, what the Export screen's link names. */
export const LEDGER_EXPORT_SOURCE = 'accounting.ledger';

const REF = /^(transactions|funds):(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** A real calendar date: `2026-02-31` is not one, although Date.parse rolls it over. */
function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The ref for an export of `kind` over `period`. */
export function ledgerExportRef(kind: Kind, period: Period): string {
  return `${kind}:${period.from}..${period.to}`;
}

/** A ref as it was built, or null for anything else: junk, a bad date, or from after to. */
export function parseLedgerExportRef(ref: unknown): { kind: Kind; period: Period } | null {
  if (typeof ref !== 'string' || ref.length > 64) return null;
  const m = REF.exec(ref);
  if (!m) return null;
  const [, kind, from, to] = m;
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return null;
  return { kind: kind as Kind, period: { from, to } };
}

/** A refusal from the ledger, turned into "no" for the engine. */
class Refused extends Error {}

/** The engine's context as the ledger's caller: there is no request, so a refusal is just a refusal. */
function actorOf(ctx: ActorContext): LedgerActor {
  const who = ctx as { username?: unknown; ipAddress?: unknown };
  return {
    subject: ctx,
    ipAddress: typeof who.ipAddress === 'string' ? who.ipAddress : undefined,
    actingUsername: () => {
      if (typeof who.username !== 'string' || who.username === '') throw new Refused('no one is signed in');
      return who.username;
    },
    enforceDeny: (permission: string) => Promise.reject(new Refused(`not permitted: ${permission}`))
  };
}

export function ledgerExportSource(ledger: LedgerManager): IceExportSource {
  return {
    name: 'ledger',
    label: 'Ledger (CSV)',
    yields: 'record',
    mayExport: async (ref, ctx) => !!parseLedgerExportRef(ref) && ledger.mayExport(actorOf(ctx)),
    read: async (ref, ctx): Promise<IceItem[] | null> => {
      const parsed = parseLedgerExportRef(ref);
      if (!parsed) return null;
      let file;
      try {
        file = await ledger.exportRecords(actorOf(ctx), parsed.kind, parsed.period, 'ice');
      } catch (err) {
        // No ledger-export, or no recent sign-in: nothing is handed over. Anything else (the audit record could not be written) stops the export.
        if (err instanceof Refused) return null;
        throw err;
      }
      if (file.rows.length === 0) return null;
      // One name on every item: it names the file, as the old download did.
      const name = file.filename.replace(/\.csv$/, '');
      return file.rows.map((row, i): IceItem => ({
        kind: 'record', name,
        data: { id: `${name}-${i + 1}`, properties: Object.fromEntries(file.headers.map((h, c) => [h, row[c] ?? ''])) }
      }));
    }
  };
}
