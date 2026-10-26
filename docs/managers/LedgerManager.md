---
name: LedgerManager
description: "The accounting add-on's one door to the ledger: funds, receipts, entries, refunds, voids, transfers, balances, period summaries and the CSV export, each asked of ngdpbase's decision point and audited"
dateModified: '2026-10-18'
category: managers
code: addons/accounting/managers/LedgerManager.ts
---

# LedgerManager

__Module:__ `addons/accounting/managers/LedgerManager.ts` (accounting add-on) __Registered as:__ `engine.getManager('LedgerManager')`

The ledger behind every accounting add-on. It holds the organization's funds and a single-entry, fund-tagged list of money in and out, in integer cents. Other add-ons (dues, donations, events) post through it; nothing else writes the accounting tables ([D-016](../plans/decisions.md)).

Money coming in is a __receipt__ ([D-028](../plans/decisions.md), [D-029](../plans/decisions.md)), recorded through [ReceiptManager](ReceiptManager.md); money going out is an __entry__. Every receipt, entry, refund and transfer carries a reason (`memo`, required).

A posted entry is never edited or deleted. A mistake is voided, with a reason, and replaced. The database enforces this as well as the code: triggers refuse deleting a fund or an entry, changing an entry's money, voiding twice, and changing the history (`managers/migrations.ts`).

## Calling it

Every method that reads or writes takes the caller first, as a `LedgerActor`. ngdpbase's `ApiContext` is one: pass the request's own context (`host.ApiContext.from(req, engine)`), never one rebuilt from a username.

```ts
const ledger = engine.getManager<LedgerManager>('LedgerManager');
const ctx = host.ApiContext.from(req, engine);
await ledger.postTransaction(ctx, {
  direction: 'out', amount: 3550, date: '2026-10-18',
  fundId, category: '5200', partyName: 'Office Supply Co', paymentMethod: '20', memo: 'printer paper'
});
```

For a page render, where there is a viewer but no request, use `ledger.viewerActor(userContext)`. It never satisfies a step-up, so use it for reading only.

## Access

The ledger is the enforcement point for its records ([D-025](../plans/decisions.md)). Each method asks ngdpbase's `PolicyDecisionPoint.decide(subject, { action })`, and on a deny calls `actor.enforceDeny(action, decision)`. That is ngdpbase's own refusal: 401, 403, or a step-up asking the person to sign in again, recorded in the audit log. No role name appears in code; policy decides.

Step-up (a fresh sign-in) is __off for now__ on every accounting permission ([D-030](../plans/decisions.md#d-030-step-up-off-for-accountings-money-actions-for-now)): after the sign-in the form came back empty. The money actions were designed with it; turning it back on is adding `"step-up": true` to their entries.

| Method | Permission | Step-up | Audit event (action) |
| --- | --- | --- | --- |
| `listFunds`, `fundBalances`, `periodSummary`, `listAccounts`, `accountBalances` | `ledger-summary-read` | no | — |
| `listTransactions`, `getTransaction`, `listDocuments`, `getDocument`, `listDeposits`, `getDeposit`, `receiptsToDeposit` | `ledger-read` | no | — |
| `postTransaction` (money out) | `ledger-record` | no | `ledger-record` (`ledger-post`) |
| `postReceipt` (money in) | `ledger-record` | no | `ledger-record` (`receipt-record`) |
| `makeDeposit` | `ledger-record` | no | `ledger-record` (`deposit-make`) |
| `clearDeposit`, `unclearDeposit` | `ledger-record` | no | `ledger-record` (`deposit-clear`, `deposit-unclear`) |
| `recordBounce` | `ledger-adjust` | off for now | `ledger-adjust` (`check-bounce`) |
| `repayBounce` | `ledger-record` | no | `ledger-record` (`receipt-record`) |
| `listBounces` | `ledger-read` | no | — |
| `undoDeposit` | `ledger-adjust` | off for now | `ledger-adjust` (`deposit-undo`) |
| `refundReceipt` | `receipt-refund` | off for now | `receipt-refund` (`receipt-refund`) |
| `voidTransaction` | `ledger-adjust` | off for now | `ledger-adjust` (`ledger-void`) |
| `transferBetweenFunds` | `ledger-adjust` | off for now | `ledger-adjust` (`ledger-transfer`) |
| `createFund`, `updateFund`, `closeFund` | `fund-manage` | no | `fund-manage` (`fund-create`, `fund-update`, `fund-close`) |
| `setAccountOpening` | `fund-manage` | no | `fund-manage` (`account-opening`) |
| `setLockSettings`, `lockPeriod`, `unlockPeriod` | `fund-manage` | no | `fund-manage` (`lock-settings`, `period-lock`, `period-unlock`) |
| `accountNumbers` | `fund-manage` | no | `fund-manage` (`account-number-view`) |
| `exportCsv` | `ledger-export` | off for now | `ledger-export` (`ledger-export`) |
| `toFormOptions` | each list its own: `funds`, `accounts` `ledger-summary-read`; `entries`, `receipts`, `refundable-lines`, `deposit-receipts`, `deposits`, `uncleared-deposits`, `cleared-deposits`, `bounceable-receipts`, `unsettled-bounces` `ledger-read`; `bank-accounts` `ledger-summary-read`; `categories`, `payment-methods` `ledger-record` | no | — |

The permissions, their audit rules and the `treasurer` role's policy are declared in `config/default-config.json`. Writes whose audit rule says `on-failure: refuse` stop if their audit record cannot be written: no money moves without a record. The record's "who" comes from ngdpbase's `actorOf`, so under proxy access it names both the person represented and the person who acted.

## Methods

Amounts are integer minor units (cents) in the site currency, `currencyCode()`. Dates are `YYYY-MM-DD`.

- `createFund(actor, { name, description?, restricted?, openingBalance?, openingDate? })` → `Fund`. A fund's opening balance and date never change afterwards.
- `updateFund(actor, fundId, { name?, description?, restricted? })` → `Fund`.
- `closeFund(actor, fundId, reason?)` → `Fund`. Funds are closed, never deleted; a closed fund takes no new entries.
- `listFunds(actor)` → `Fund[]`.
- `listAccounts(actor)` → `Account[]`: where money sits ([D-031](../plans/decisions.md#d-031-bank-accounts-cash-on-hand-and-deposits)). Cash on Hand (`cash-on-hand`, built in) first, then the bank accounts in `ngdpbase.addons.accounting.accounts`, then any account entries still name that the configuration has dropped (`configured: false`). One active bank account is the default.
- Each `Account` carries its `routingNumber` and `accountNumberLast4`, never the full number. `accountNumbers(actor, accountId)` → `{ accountId, name, routingNumber, accountNumber }`: the full numbers, for `fund-manage` holders only. Each read is audited, without the number. In configuration `account-number` is a `$VAR` reference that ngdpbase resolves and hides as a secret (v5.21.0).
- `setAccountOpening(actor, accountId, { openingBalance, openingDate? })` → `AccountBalance`. What the account held on the day the books started. Set once; it never changes.
- `accountBalances(actor)` → per account: opening balance, money in, money out, balance. Added up, they equal the funds' balances when the openings agree.
- __Every entry has an account__ as well as a fund: `accountId` on `postTransaction`, `postReceipt` and `refundReceipt`. Left out, the method picks it: cash, checks and card go to Cash on Hand, every other method (and no method) to the default bank account (`docs/receipt-methods.md`, "Starting account"). A transfer between funds puts both halves in the same account, so no account changes.
- `postTransaction(actor, { direction: 'out', amount, date, fundId, category, partyPersonId?, partyName?, paymentMethod?, paymentMethodId?, memo })` → `Transaction`. Money out only: `in` is refused ("money in is recorded as a receipt"). `category` is a UCOA account code; `paymentMethod` a UN/CEFACT payment means; `memo` is the reason, required.
- `postReceipt(actor, { lines | amount + fundId + category, date, partyName, partyPersonId?, paymentMethod, paymentMethodId?, accountId?, memo, reference? }, { provider, confirmationNumber? })` → `Receipt`. Money in ([D-033](../plans/decisions.md#d-033-receipts-and-refunds-are-made-of-lines)): one record, one number, with one or more `lines` (`{ amount, fundId, category, memo? }`, at most 50), each a ledger entry counted in its own fund and category. Without `lines`, the amount, fund and category make the one line. All lines land in one account. A refusal about a line names it: `lines[1].amount …`. For the manual provider the ledger numbers it, `R-0001` onwards, in the same database transaction: one sequence per site, never reused (a voided receipt keeps its number). Another provider passes its own `confirmationNumber`; `provider` plus number is unique, so the same receipt never posts twice. `reference: { type, id }` records what it pays for (e.g. an invoice). Called by `ReceiptManager`, not by other add-ons directly.
- `refundReceipt(actor, receiptId, { lines? | amount?, date, memo, paymentMethod?, paymentMethodId?, accountId? })` → `Refund`, numbered `RF-0001` onwards. Its `lines` (`{ receiptLineId, amount }`) each give back part of a receipt line, as money out in that line's fund and category (`sourceType: 'receipt-refund'`, `lineOf` the receipt line); a line never gives back more than is left on it. A one-line receipt may give just `amount`, which defaults to what is left. The receipt stays posted.
- `voidTransaction(actor, transactionId, reason, replacement?)` → `{ voided, replacement }`. Voiding one side of a transfer voids both, and takes no replacement: post a new transfer instead. Given a receipt's or refund's id, it voids the whole record and every line; a single line is never voided alone. A receipt takes no replacement: void it and record a new receipt. A receipt with posted refunds is not voided until its refunds are, nor one in a standing deposit until it is undone. The original stays visible, marked voided.
- __What modules add__ (D-036): `registerLineDetails(kind, { validate(data, line) })` lets a module (accounting-donations: `donation`; accounting-receivables: `receivable`) put its own details on receipt lines, sent as `lines[].details` and stored by the ledger in the same transaction; a line's `details` reads them back. A validator throws an Error naming the field; the ledger refuses it as a 400. `registerSlipNotes(receipt => string[])` adds notes to the printable slip; `receiptSlip(actor, id)` (`ledger-read`) returns the receipt and its notes, and `GET /api/accounting/receipts/:id/slip` renders it as a page to print. Modules call these managers, never the accounting database.
- __A module's own lines:__ `registerLineDetails` returns that module's reader, handed to it alone: `lines()` gives every posted receipt line carrying its kind, net of refunds, bounced checks left out. accounting-receivables works out which invoices are paid from it, so no person is granted more of the ledger.
- __A person's own receipts__ ([D-037](../plans/decisions.md#d-037-people-see-their-own-money-through-one-ledger-door), [D-043](../plans/decisions.md#d-043-every-signed-in-user-holds-ledger-self)): `ownDocuments(actor, 'receipt' | 'refund')` under `ledger-self`, which every account holds through `vault-owner`: the receipts whose payer is the caller's own identity record, and refunds of them. The caller's record is read as the caller (`IdentityManager.getByUserIdentifier(ctx, username)`, their own under `profile-manage`).
- __Period locks__ ([#19](https://github.com/jwilleke/ngdp-accounting-addons/issues/19)): `setLockSettings(actor, { period, fiscalStartMonth })` (the treasurer's choice: `month`, `quarter`, `half-year` or `year`), `lockPeriod(actor, throughDate)` (a period end that has passed, after the current lock), `unlockPeriod(actor, reason)` (takes the latest lock off), `lockStatus(actor)`. Anything dated on or before the lock is refused: posting, receipts, refunds, transfers, deposits, bounces, voids, undoing a deposit, and fund and account openings. `periodEnds(settings, after, until)` lists period ends.
- A `Receipt` says `bounced: true` once its check has bounced (it stays posted).
- `listDocuments(actor, 'receipt' | 'refund', { includeVoided? })`, `getDocument(actor, id)` → receipts and refunds with their lines, newest first (`ledger-read`).
- `transferBetweenFunds(actor, { fromFundId, toFundId, amount, date, memo? })` → the linked out and in entries. The total across funds is unchanged.
- `makeDeposit(actor, { accountId, date, receiptIds, total, slipReference?, memo? })` → `Deposit`. Receipts taken from Cash on Hand to a bank account together ([D-031](../plans/decisions.md#d-031-bank-accounts-cash-on-hand-and-deposits)): numbered `D-0001` onwards, with an out entry from Cash on Hand and an in entry to the bank account for each fund (`sourceType: 'deposit'`, `sourceId` the deposit). Fund balances do not change. Each receipt must be posted, in Cash on Hand, in no standing deposit and dated on or before the deposit; `total` (the slip's) must equal theirs. Whole receipts only.
- `undoDeposit(actor, depositId, reason)` → `Deposit`. Voids its entries; its receipts are back in Cash on Hand. Its number is not reused. A deposit's entries are never voided one by one, and a receipt in a standing deposit is not voided until the deposit is undone.
- `clearDeposit(actor, depositId, date)` → `Deposit` with `clearedDate`: the bank statement shows it, on `date` (not before the deposit). No money moves; one standing mark per deposit ([D-032](../plans/decisions.md#d-032-cleared-deposits-and-bounced-checks)). `unclearDeposit(actor, depositId, reason)` takes a wrong mark off; the mark stays in the history. A cleared deposit is not undone until its mark is taken off.
- `recordBounce(actor, receiptId, { date, fee?, penalty?, memo? })` → `Bounce`: the bank returned a deposited check ([D-032](../plans/decisions.md#d-032-cleared-deposits-and-bounced-checks)). The receipt never changes. A returned-check entry for each of its lines takes the full amount back out of the bank account it was deposited into, in the line's fund and category, and the fee posts as an expense in the bank-charges category. The payer owes check + fee + penalty (`penalty` defaults to `bounced-check-penalty`). Only a check (`20`) in a standing deposit, once, not dated before its deposit. Afterwards the receipt is not refunded or voided, and its deposit is not undone. Refused, saying why, until `bank-charges-category` names an expense and `other-income-category` an other-income category in the chart.
- `repayBounce(actor, bounceId, { amount, date, paymentMethod, paymentMethodId?, accountId?, memo? })` → `Receipt`: one receipt (reference `bounced-check`) whose lines fill in order: the check in the receipt's own categories, the fee against bank charges, the penalty as other income. Never more than is still owed.
- `listBounces(actor, { settled? })` → `Bounce[]` with `owed`, `repaid` and `stillOwed`.
- `listDeposits(actor, { includeVoided? })`, `getDeposit(actor, id)`, `receiptsToDeposit(actor)` (receipts a deposit can take, oldest first).
- `categories()` → the site's chart, parsed from `ngdpbase.addons.accounting.categories` ([D-034](../plans/decisions.md#d-034-a-generic-starter-chart-with-account-types)): each `{ code, name, type, detailType }`, sorted by code. The period summary carries each category's type.
- Receipt and deposit numbers share one rule: the letter, a dash, and one past the highest number used, at least four digits with no upper limit (`R-9999`, `R-10000`).
- `listTransactions(actor, { fundId?, from?, to?, includeVoided? })`, `getTransaction(actor, id)`.
- `fundBalances(actor)` → per fund: opening balance, money in, money out, balance (opening + in − out, posted entries only).
- `period({ month?, from?, to? })` → `{ from, to }`. `month` is `current`, `previous` or `YYYY-MM`; the default is the current month.
- `periodSummary(actor, period)` → per fund and per account start, opened, in, out and end, and per category income and expense, with totals. Transfers and deposits are left out of the categories; they net to zero. It carries no names, so a summary reader never sees who paid.
- `exportCsv(actor, 'transactions' | 'funds', period)` → `{ filename, body, sha256 }`. Built with ngdpbase's one CSV writer (`ExportManager.toCsv`); the audit record carries the file's SHA-256.
- `toFormOptions({ list })` → choices for a forms add-on dropdown: `funds`, `accounts`, `bank-accounts`, `entries`, `receipts`, `deposit-receipts`, `deposits` (posted receipts with money left to refund), `categories` (with `kind=in` only income types, `kind=out` the rest) or `payment-methods`. Reached from a form definition as `optionsSource: "fetch:LedgerManager.toFormOptions(list=funds)"`; each list asks its own permission of the viewer, so a dropdown never offers what its reader may not see.

A bad input throws `LedgerError` with a status (400, 404 or 409) and a message naming the field. A refusal throws ngdpbase's `ApiError`.

## Caching

After every committed write the ledger bumps the `LedgerManager` topic in ngdpbase's `CacheManager`. Pages that read the ledger (the `[{Ledger}]` plugin, a form's fund choices) are drawn again on their next view. The page cache keeps one copy per viewer (username and roles), so nobody is served another person's table.

## Storage

The add-on's own SQLite database, `accounting.db`, opened through `DatabaseManager.openAddonDatabase('accounting', { migrations, ledgerTable })` and declared in `config/default-config.json` as `ngdpbase.addons.accounting.database` (ngdpbase #1860). Encrypted with SQLCipher when `NGDPBASE_DATABASE_KEY` is set; plain SQLite with a boot warning otherwise ([D-010](../plans/decisions.md)).

## See also

- [ledger-design.md](../plans/ledger-design.md): the data model and why.
- [Accounting site guide](../guides/accounting-guide.md): turning it on and giving people access.
