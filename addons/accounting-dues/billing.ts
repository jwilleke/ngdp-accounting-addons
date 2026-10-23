/**
 * The billing rules of the dues add-on (D-035), pure, so they are tested on
 * their own: what a month charges an account, how payments settle invoices,
 * and which late charges are due. DuesManager gathers the data and stores what
 * these decide.
 *
 * - Each month is evaluated on its own: a monthly charge falls due on its day in
 *   every month, an annual one in its month.
 * - Payments settle invoices in due-date order; a payment naming an invoice
 *   settles that one first. What is left over is the account's credit.
 * - A late charge applies once an invoice is more than its rule's days past due
 *   and still not paid: once per invoice, or once a month while it stays unpaid.
 *   Interest is simple, on what is still owed, at the annual rate ÷ 12, never
 *   compounded (operator, 2026-10-21).
 */

/** What an account is charged and when it falls due (AccommodationManager.assessment). */
export interface Assessment { amount: number; period: 'monthly' | 'annual'; datedue: number | string }

/** A late-charge rule (AccommodationManager.lateCharges). */
export interface LateChargeRule { id: string; daysLate: number; amount: number | null; annualPercent: number | null; repeat: 'once' | 'monthly' }

/** An issued invoice as billing reads it. */
export interface Billed { id: string; number: string; dueDate: string; total: number }

/** A payment toward an account: a posted receipt line's amount less what was refunded. */
export interface Payment { amount: number; invoiceId: string | null }

/** A late charge to add to the next invoice. */
export interface ProposedLateCharge { ruleId: string; appliesTo: string; appliesToNumber: string; amount: number; key: string; daysLate: number }

const MONTH = /^(\d{4})-(\d{2})$/;

/** A month as YYYY-MM, checked; throws naming the field. */
export function billingMonth(value: unknown, field = 'month'): string {
  const m = typeof value === 'string' ? MONTH.exec(value) : null;
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw Object.assign(new Error(`${field} must be a month as YYYY-MM`), { field });
  return value as string;
}

/** The month's charge for an account, or null when nothing falls due in it. */
export function chargeFor(assessment: Assessment | null, month: string): { dueDate: string; amount: number } | null {
  if (!assessment || assessment.amount <= 0) return null;
  if (assessment.period === 'monthly') return { dueDate: `${month}-${String(assessment.datedue).padStart(2, '0')}`, amount: assessment.amount };
  const [mm, dd] = String(assessment.datedue).split('-');
  return month.slice(5) === mm ? { dueDate: `${month}-${dd}`, amount: assessment.amount } : null;
}

/** How payments settle invoices: what each has been paid, and the credit left over. */
export function settle(invoices: Billed[], payments: Payment[]): { paid: Map<string, number>; credit: number } {
  const ordered = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
  const paid = new Map(ordered.map(i => [i.id, 0]));
  const left = (i: Billed) => i.total - (paid.get(i.id) ?? 0);
  let pool = 0;
  for (const p of payments) {
    const named = p.invoiceId ? ordered.find(i => i.id === p.invoiceId) : undefined;
    const toNamed = named ? Math.min(p.amount, Math.max(0, left(named))) : 0;
    if (named) paid.set(named.id, (paid.get(named.id) ?? 0) + toNamed);
    pool += p.amount - toNamed;
  }
  for (const i of ordered) {
    const take = Math.min(pool, Math.max(0, left(i)));
    paid.set(i.id, (paid.get(i.id) ?? 0) + take);
    pool -= take;
  }
  return { paid, credit: pool };
}

/** Whole days from one date (YYYY-MM-DD) to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The late charges due as of a date: for each invoice still owed, each rule it
 * has passed, unless that charge was already made (its key is in `made`).
 */
export function lateChargesDue(invoices: Billed[], paid: Map<string, number>, rules: LateChargeRule[], asOf: string, made: Set<string>): ProposedLateCharge[] {
  const out: ProposedLateCharge[] = [];
  const month = asOf.slice(0, 7);
  for (const inv of [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    const owed = inv.total - (paid.get(inv.id) ?? 0);
    const late = daysBetween(inv.dueDate, asOf);
    if (owed <= 0) continue;
    for (const rule of rules) {
      if (late <= rule.daysLate) continue;
      const key = rule.repeat === 'once' ? `${rule.id}|${inv.id}` : `${rule.id}|${inv.id}|${month}`;
      if (made.has(key)) continue;
      const amount = (rule.amount ?? 0) + (rule.annualPercent ? Math.round(owed * rule.annualPercent / 100 / 12) : 0);
      if (amount > 0) out.push({ ruleId: rule.id, appliesTo: inv.id, appliesToNumber: inv.number, amount, key, daysLate: late });
    }
  }
  return out;
}

/** A billing party's key: its people's usernames, sorted, joined with commas. */
export function partyKey(usernames: string[]): string {
  return [...usernames].sort().join(',');
}

/** An amount split between parties by their percent, in cents; the rounding remainder goes to the first parties. */
export function splitByShare(amount: number, parties: { share: number }[]): number[] {
  const raw = parties.map(p => Math.floor(amount * p.share / 100));
  let rest = amount - raw.reduce((t, x) => t + x, 0);
  for (let i = 0; rest > 0 && i < raw.length; i++, rest--) raw[i] = (raw[i] as number) + 1;
  return raw;
}

/** What is stored on a payment line: the account it pays, the party whose balance it settles, and the invoice it names, if any. */
export interface DuesDetails { account: string; party: string | null; invoiceId: string | null }

/** The `dues` kind of receipt-line details: checks what a caller sends and returns what is stored. */
export function duesValidator(settings: {
  categories: () => string[];
  accountExists: (id: string) => boolean;
  invoiceOf: (invoiceId: string) => { accountId: string; party: string; status: string } | null;
  /** The parties an account's issued invoices were billed to. */
  partiesOf: (account: string) => string[];
}) {
  return {
    validate(data: unknown, line: { category: string }): Record<string, unknown> {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('details.dues must be an object');
      const d = data as { account?: unknown; party?: unknown; invoiceId?: unknown };
      const allowed = settings.categories();
      if (!allowed.includes(line.category)) throw new Error(`category: ${line.category} is not a dues category (${allowed.join(', ') || 'none set'})`);
      if (typeof d.account !== 'string' || d.account === '' || !settings.accountExists(d.account)) throw new Error('details.dues.account names no account');
      const invoiceId = typeof d.invoiceId === 'string' && d.invoiceId !== '' ? d.invoiceId : null;
      let party = typeof d.party === 'string' && d.party !== '' ? d.party : null;
      // A payment settles one party's balance (D-038): the invoice's, the one named, or the account's only one.
      if (invoiceId) {
        const invoice = settings.invoiceOf(invoiceId);
        if (!invoice || invoice.status !== 'issued') throw new Error('details.dues.invoiceId names no issued invoice');
        if (invoice.accountId !== d.account) throw new Error('details.dues.invoiceId is an invoice of another account');
        if (party && party !== invoice.party) throw new Error('details.dues.party is not the party of that invoice');
        party = invoice.party;
      } else {
        const parties = settings.partiesOf(d.account);
        if (party && !parties.includes(party)) throw new Error('details.dues.party is not a party billed on this account');
        if (!party && parties.length > 1) throw new Error('details.dues.party: this account bills more than one party; name the party or the invoice');
        party = party ?? parties[0] ?? null;
      }
      const details: DuesDetails = { account: d.account, party, invoiceId };
      return details as unknown as Record<string, unknown>;
    }
  };
}
