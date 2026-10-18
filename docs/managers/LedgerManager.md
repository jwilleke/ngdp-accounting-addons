---
name: LedgerManager
description: "The accounting add-on's one door to the ledger: funds, receipts, entries, refunds, voids, transfers, balances, period summaries and the CSV export, each asked of ngdpbase's decision point and audited"
dateModified: '2026-10-18'
category: managers
code: addons/accounting/managers/LedgerManager.ts
---

# LedgerManager

__Module:__ `addons/accounting/managers/LedgerManager.ts` (accounting add-on)
__Registered as:__ `engine.getManager('LedgerManager')`

The ledger behind every accounting add-on. It holds the organization's funds and a single-entry,
fund-tagged list of money in and out, in integer cents. Other add-ons (dues, donations, events)
post through it; nothing else writes the accounting tables ([D-016](../plans/decisions.md)).

Money coming in is a __receipt__ ([D-028](../plans/decisions.md), [D-029](../plans/decisions.md)), recorded
through [ReceiptManager](ReceiptManager.md); money going out is an __entry__. Every receipt, entry,
refund and transfer carries a reason (`memo`, required).

A posted entry is never edited or deleted. A mistake is voided, with a reason, and replaced. The
database enforces this as well as the code: triggers refuse deleting a fund or an entry, changing an
entry's money, voiding twice, and changing the history (`managers/migrations.ts`).

## Calling it

Every method that reads or writes takes the caller first, as a `LedgerActor`. ngdpbase's
`ApiContext` is one: pass the request's own context (`host.ApiContext.from(req, engine)`), never one
rebuilt from a username.

```ts
const ledger = engine.getManager<LedgerManager>('LedgerManager');
const ctx = host.ApiContext.from(req, engine);
await ledger.postTransaction(ctx, {
  direction: 'out', amount: 3550, date: '2026-10-18',
  fundId, category: '5200', partyName: 'Office Supply Co', paymentMethod: '20', memo: 'printer paper'
});
```

For a page render, where there is a viewer but no request, use `ledger.viewerActor(userContext)`.
It never satisfies a step-up, so use it for reading only.

## Access

The ledger is the enforcement point for its records ([D-025](../plans/decisions.md)). Each method
asks ngdpbase's `PolicyDecisionPoint.decide(subject, { action })`, and on a deny calls
`actor.enforceDeny(action, decision)`. That is ngdpbase's own refusal: 401, 403, or a step-up asking
the person to sign in again, recorded in the audit log. No role name appears in code; policy decides.

Step-up (a fresh sign-in) is __off for now__ on every accounting permission ([D-030](../plans/decisions.md#d-030-step-up-off-for-accountings-money-actions-for-now)): after the sign-in the form came back empty. The money actions were designed with it; turning it back on is adding `"step-up": true` to their entries.

| Method | Permission | Step-up | Audit event (action) |
| --- | --- | --- | --- |
| `listFunds`, `fundBalances`, `periodSummary` | `ledger-summary-read` | no | — |
| `listTransactions`, `getTransaction` | `ledger-read` | no | — |
| `postTransaction` (money out) | `ledger-record` | no | `ledger-record` (`ledger-post`) |
| `postReceipt` (money in) | `ledger-record` | no | `ledger-record` (`receipt-record`) |
| `refundReceipt` | `receipt-refund` | off for now | `receipt-refund` (`receipt-refund`) |
| `voidTransaction` | `ledger-adjust` | off for now | `ledger-adjust` (`ledger-void`) |
| `transferBetweenFunds` | `ledger-adjust` | off for now | `ledger-adjust` (`ledger-transfer`) |
| `createFund`, `updateFund`, `closeFund` | `fund-manage` | no | `fund-manage` (`fund-create`, `fund-update`, `fund-close`) |
| `exportCsv` | `ledger-export` | off for now | `ledger-export` (`ledger-export`) |
| `toFormOptions` | each list its own: `funds` `ledger-summary-read`; `entries`, `receipts` `ledger-read`; `categories`, `payment-methods` `ledger-record` | no | — |

The permissions, their audit rules and the `treasurer` role's policy are declared in
`config/default-config.json`. Writes whose audit rule says `on-failure: refuse` stop if their audit
record cannot be written: no money moves without a record. The record's "who" comes from ngdpbase's
`actorOf`, so under proxy access it names both the person represented and the person who acted.

## Methods

Amounts are integer minor units (cents) in the site currency, `currencyCode()`. Dates are
`YYYY-MM-DD`.

- `createFund(actor, { name, description?, restricted?, openingBalance?, openingDate? })` → `Fund`.
  A fund's opening balance and date never change afterwards.
- `updateFund(actor, fundId, { name?, description?, restricted? })` → `Fund`.
- `closeFund(actor, fundId, reason?)` → `Fund`. Funds are closed, never deleted; a closed fund
  takes no new entries.
- `listFunds(actor)` → `Fund[]`.
- `postTransaction(actor, { direction: 'out', amount, date, fundId, category, partyPersonId?,
  partyName?, paymentMethod?, paymentMethodId?, memo })` → `Transaction`. Money out only: `in` is
  refused ("money in is recorded as a receipt"). `category` is a UCOA account code; `paymentMethod` a
  UN/CEFACT payment means; `memo` is the reason, required.
- `postReceipt(actor, { amount, date, fundId, category, partyName, partyPersonId?, paymentMethod,
  paymentMethodId?, memo, reference? }, { provider, confirmationNumber? })` → `Transaction`. Money in.
  For the manual provider the ledger numbers it, `R-0001` onwards, in the same database transaction:
  one sequence per site, never reused (a voided receipt keeps its number). Another provider passes
  its own `confirmationNumber`; `provider` plus number is unique, so the same receipt never posts
  twice. `reference: { type, id }` records what it pays for (e.g. a dues invoice). Called by
  `ReceiptManager`, not by other add-ons directly.
- `refundReceipt(actor, receiptId, { amount?, date, memo, paymentMethod?, paymentMethodId? })` →
  `Transaction`. Money returned to the payer: an `out` entry in the receipt's fund and category,
  `sourceType: 'receipt-refund'`, linked by `sourceId`. The receipt stays posted. Partial refunds add
  up to at most the receipt's amount; a missing `amount` refunds what is left.
- `voidTransaction(actor, transactionId, reason, replacement?)` → `{ voided, replacement }`. Voiding
  one side of a transfer voids both, and takes no replacement: post a new transfer instead. A
  receipt takes no replacement either: void it and record a new receipt. A receipt with posted
  refunds is not voided until its refunds are. The original stays visible, marked voided.
- `transferBetweenFunds(actor, { fromFundId, toFundId, amount, date, memo? })` → the linked out and
  in entries. The total across funds is unchanged.
- `listTransactions(actor, { fundId?, from?, to?, includeVoided? })`, `getTransaction(actor, id)`.
- `fundBalances(actor)` → per fund: opening balance, money in, money out, balance (opening + in −
  out, posted entries only).
- `period({ month?, from?, to? })` → `{ from, to }`. `month` is `current`, `previous` or `YYYY-MM`;
  the default is the current month.
- `periodSummary(actor, period)` → per fund start, opened, in, out and end, and per category income
  and expense, with totals. Transfers are left out of the categories; they net to zero. It carries
  no names, so a summary reader never sees who paid.
- `exportCsv(actor, 'transactions' | 'funds', period)` → `{ filename, body, sha256 }`. Built with
  ngdpbase's one CSV writer (`ExportManager.toCsv`); the audit record carries the file's SHA-256.
- `toFormOptions({ list })` → choices for a forms add-on dropdown: `funds`, `entries`, `receipts`
  (posted receipts with money left to refund), `categories` or `payment-methods`. Reached from a form definition as
  `optionsSource: "fetch:LedgerManager.toFormOptions(list=funds)"`; each list asks its own
  permission of the viewer, so a dropdown never offers what its reader may not see.

A bad input throws `LedgerError` with a status (400, 404 or 409) and a message naming the field. A
refusal throws ngdpbase's `ApiError`.

## Caching

After every committed write the ledger bumps the `LedgerManager` topic in ngdpbase's
`CacheManager`. Pages that read the ledger (the `[{Ledger}]` plugin, a form's fund choices) are
drawn again on their next view. The page cache keeps one copy per viewer (username and roles), so
nobody is served another person's table.

## Storage

The add-on's own SQLite database, `accounting.db`, opened through
`DatabaseManager.openAddonDatabase('accounting', { migrations, ledgerTable })` and declared in
`config/default-config.json` as `ngdpbase.addons.accounting.database` (ngdpbase #1860). Encrypted
with SQLCipher when `NGDPBASE_DATABASE_KEY` is set; plain SQLite with a boot warning otherwise
([D-010](../plans/decisions.md)).

## See also

- [ledger-design.md](../plans/ledger-design.md): the data model and why.
- [Accounting site guide](../guides/accounting-guide.md): turning it on and giving people access.
