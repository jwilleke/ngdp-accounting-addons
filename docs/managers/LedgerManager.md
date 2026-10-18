---
name: LedgerManager
description: "The accounting add-on's one door to the ledger: funds, entries, voids, transfers, balances, period summaries and the CSV export, each asked of ngdpbase's decision point and audited"
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
  direction: 'in', amount: 3550, date: '2026-10-18',
  fundId, category: '4100', partyName: 'Ann Lee', paymentMethod: 'check'
});
```

For a page render, where there is a viewer but no request, use `ledger.viewerActor(userContext)`.
It never satisfies a step-up, so use it for reading only.

## Access

The ledger is the enforcement point for its records ([D-025](../plans/decisions.md)). Each method
asks ngdpbase's `PolicyDecisionPoint.decide(subject, { action })`, and on a deny calls
`actor.enforceDeny(action, decision)`. That is ngdpbase's own refusal: 401, 403, or a step-up asking
the person to sign in again, recorded in the audit log. No role name appears in code; policy decides.

| Method | Permission | Step-up | Audit event (action) |
| --- | --- | --- | --- |
| `listFunds`, `fundBalances`, `periodSummary` | `ledger-summary-read` | no | — |
| `listTransactions`, `getTransaction` | `ledger-read` | no | — |
| `postTransaction` | `ledger-record` | no | `ledger-record` (`ledger-post`) |
| `voidTransaction` | `ledger-adjust` | yes | `ledger-adjust` (`ledger-void`) |
| `transferBetweenFunds` | `ledger-adjust` | yes | `ledger-adjust` (`ledger-transfer`) |
| `createFund`, `updateFund`, `closeFund` | `fund-manage` | no | `fund-manage` (`fund-create`, `fund-update`, `fund-close`) |
| `exportCsv` | `ledger-export` | yes | `ledger-export` (`ledger-export`) |
| `toFormOptions` | `ledger-record` | no | — |

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
- `postTransaction(actor, { direction, amount, date, fundId, category, partyPersonId?, partyName?,
  paymentMethod?, paymentMethodId?, memo? })` → `Transaction`. `category` is a UCOA account code;
  `paymentMethod` a UN/CEFACT payment means.
- `voidTransaction(actor, transactionId, reason, replacement?)` → `{ voided, replacement }`. Voiding
  one side of a transfer voids both, and takes no replacement: post a new transfer instead. The
  original stays visible, marked voided.
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
- `toFormOptions({ list })` → choices for a forms add-on dropdown: `funds`, `entries`, `categories`
  or `payment-methods`. Reached from a form definition as
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
