---
title: Ledger design (MVP)
description: How the accounting add-on stores funds and transactions, who may do what, and how every money action is recorded.
last_updated: "2026-10-08"
---

# Ledger design (MVP)

The design for the shared ledger in the base `accounting` add-on: the first working piece of the
MVP. It implements requirements.md section 4 (the ledger model) within the decisions in
[decisions.md](decisions.md). Status: __reviewed; the ledger core is built__ (funds, entries, voids,
transfers, balances, audit, permissions and the treasurer role). The CSV export comes with the reports work.

## What the MVP ledger does

- Keep a list of __funds__ (general, building, youth, an event). A fund can be closed, never deleted.
- Record __money in and money out__, each entry tagged to exactly one fund: cash, checks and other
  money received that the treasurer enters by hand.
- __Correct mistakes without erasing them__: a posted entry is never edited or deleted. A
  correction voids it, with a reason, and posts a replacement linked to it.
- __Move money between funds__ as a linked out-and-in pair that leaves the total unchanged.
- Show __fund balances__ and the list of entries.
- Record __every money action__ in ngdpbase's audit log, and refuse the action if the record cannot
  be written.

Not in the MVP: online receipts, dues, donations, events, scheduled jobs, QuickBooks and Wave
formats, and the period lock (see [Open questions](#open-questions)). The monthly summary and CSV
export are designed with the reports work, on top of this ledger.

## Storage

- The add-on asks ngdpbase for its database in `register()`:
  `openAddonDatabase('accounting', { migrations: ACCOUNTING_MIGRATIONS, ledgerTable: 'accounting_schema_migrations' })`.
  That opens `accounting.db` beside ngdpbase's database, encrypted with the site's database key.
- If the site has not turned the database on, the add-on mounts no routes and says so in
  `status()`.
- Every table starts with `accounting_`, so one future backup can hold several databases and split
  them by table name.

### Tables (first migration)

`accounting_funds`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT primary key | UUID |
| `name` | TEXT, unique | "General", "Building" |
| `description` | TEXT | |
| `restricted` | INTEGER 0/1 | donors gave it for a specific purpose |
| `active` | INTEGER 0/1 | closing a fund sets 0 |
| `opening_balance` | INTEGER | minor units (cents) |
| `opening_date` | TEXT | ISO date |
| `created_by`, `created_at` | TEXT | actor and time |

`accounting_transactions`, with field names following schema.org and UN/CEFACT (D-018):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT primary key | UUID |
| `direction` | TEXT | `in` or `out` |
| `amount` | INTEGER | positive, minor units; never floating point |
| `currency` | TEXT | ISO 4217 code, from the site's `ngdpbase.default.currency` |
| `date` | TEXT | when the money moved |
| `fund_id` | TEXT | required; references `accounting_funds` (delete restricted) |
| `category` | TEXT | a UCOA account code from the site's category list (D-023) |
| `party_person_id` / `party_name` | TEXT | an ngdpbase Person, or free text |
| `payment_method` | TEXT | UN/CEFACT payment means code, e.g. `10` cash, `20` cheque |
| `payment_method_id` | TEXT | check number or similar |
| `provider`, `confirmation_number` | TEXT | for receipts a provider recorded; unique together when set |
| `source_type`, `source_id` | TEXT | what created it: `manual`, `adjustment`, `transfer` (later: `dues-invoice`, `donation`, …) |
| `status` | TEXT | `posted` or `voided` (`pending` arrives with online receipts) |
| `voids_id` / `voided_by_id` | TEXT | links between a voided entry and its replacement |
| `void_reason` | TEXT | required when voided |
| `transfer_id` | TEXT | pairs the two halves of a fund transfer |
| `memo` | TEXT | free text |
| `created_by`, `created_at` | TEXT | actor and time |

`accounting_history`: append-only, one row per change (create, void, memo edit, fund change), with
actor, time, and before and after values, so the record survives with the add-on's data even apart
from ngdpbase's audit log.

### Second migration: accounts

[D-031](decisions.md#d-031-bank-accounts-cash-on-hand-and-deposits) adds where the money sits:

- `accounting_transactions.account_id` (TEXT, required): `cash-on-hand` or a bank account id from
  `ngdpbase.addons.accounting.accounts`. Accounts are configuration, so it is an id, not a foreign
  key; the ledger checks it on every write. Entries posted before the migration are `checking`.
  The "money never changes" trigger now covers it too.
- `accounting_account_openings` (`account_id` primary key, `opening_balance`, `opening_date`,
  `created_by`, `created_at`): set once by the treasurer; never updated or deleted.

### Fourth migration: receipts and refunds as records

[D-033](decisions.md#d-033-receipts-and-refunds-are-made-of-lines) adds `accounting_documents`: one
row per receipt or refund (kind, number, payer, method, account, total, reason, status). Its lines
are ledger entries with `document_id`; a refund line also has `line_of`, the receipt line it gives
back. Existing receipts become one-line receipts with their ids and numbers; existing refunds become
one-line refunds numbered `RF-0001` onwards in the order they were made. Records are voided, never
changed or deleted.

### Fifth migration: cleared deposits

[D-032](decisions.md#d-032-cleared-deposits-and-bounced-checks) adds `accounting_deposit_clearings`:
a deposit marked cleared with the date the bank shows, one standing mark per deposit. A wrong mark is
taken off once, with a reason (`removed`), and is never changed or deleted.

### Sixth migration: bounced checks

[D-032](decisions.md#d-032-cleared-deposits-and-bounced-checks) adds `accounting_bounces`: one row per
returned check (receipt, deposit, date, account, check amount, fee, penalty), never changed or
deleted. Its entries carry `source_type` `returned-check` or `bounce-fee`; repayments are receipts
whose reference is `bounced-check` and the bounce's id.

### Seventh migration: line details

[D-036](decisions.md#d-036-donations-follow-the-donations-guide) adds `accounting_line_details`: what a
module adds to a receipt line, by kind (`gift` at the time, `donation` since D-042), as JSON the module validated. Written with the line,
never changed or deleted.

### Eighth migration: period locks

[#19](https://github.com/jwilleke/ngdp-accounting-addons/issues/19) adds `accounting_lock_settings`
(append-only: how periods are locked, as the treasurer last chose) and `accounting_period_locks`
(each lock's through date, taken off once with a reason, never changed or deleted).

### Enforced by the database itself

Triggers make the money rules hold even if code is wrong:

- No DELETE on `accounting_transactions` or `accounting_history`.
- No UPDATE on `accounting_history`.
- On `accounting_transactions`, an UPDATE may only: set `status` from `posted` to `voided` together
  with `voided_by_id` and `void_reason`; or change `memo`. Any change to an amount, direction, fund,
  date, party or payment field is refused.
- A fund referenced by a transaction cannot be deleted (foreign key, `ON DELETE RESTRICT`).

## One door per action

All writes go through one class, `LedgerManager`, registered with `engine.registerManager`. Each
method is one action and one permission. It takes the caller's context (never rebuilt), asks for the
permission, writes the audit record first, then makes the change in one database transaction:

1. `requirePermission(<action>)`: ngdpbase's policy check, including step-up where the permission
   asks for it.
2. `await recordAuditEvent(...)` for the action; with `on-failure: refuse` a record that cannot be
   written stops here, so no money moves without a record.
3. The rows change inside one synchronous `db.transaction`, together with the `accounting_history`
   row.

| Method | Permission (= audit event) |
| --- | --- |
| `createFund`, `updateFund`, `closeFund` | `fund-manage` |
| `postTransaction` | `ledger-record` |
| `voidTransaction` (posts the replacement) | `ledger-adjust` |
| `transferBetweenFunds` | `ledger-adjust` |
| `listTransactions`, `getTransaction` | `ledger-read` |
| `fundBalances` | `ledger-summary-read` |
| `exportCsv` | `ledger-export` |

Routes under `/api/accounting/` only parse input, call the manager, and return the result. They use
`ApiContext` and ngdpbase's CSRF protection.

## Permissions, audit and the treasurer role

Declared in `addons/accounting/config/default-config.json`, in the shape ngdpbase uses for its own
permissions. The scaffold's placeholder `accounting-manage` is removed.

| Permission | What it allows | Audit `on-failure` | Step-up |
| --- | --- | --- | --- |
| `ledger-summary-read` | Fund balances, no names | recorded off (a read) | no |
| `ledger-read` | Transactions, including names | recorded off (a read) | no |
| `ledger-record` | Post an entry | `refuse` | no |
| `ledger-adjust` | Void and replace, transfer between funds | `refuse` | yes |
| `ledger-export` | Download the CSV | `refuse` | yes |
| `fund-manage` | Create, change and close funds | `refuse` | no |

Example entry:

```json
"ledger-adjust": {
  "description": "Void a posted entry and post its replacement, or move money between funds",
  "icon": "pen-to-square",
  "color": "#fd7e14",
  "audit": { "on-failure": "refuse", "description": "Ledger entry voided, replaced or transferred" },
  "step-up": true
}
```

The `treasurer` role (D-021), shaped like ngdpbase's `admin` role:

```json
"ngdpbase.roles.definitions": {
  "treasurer": {
    "name": "treasurer",
    "required-aal": 2,
    "displayname": "Treasurer",
    "description": "Records and corrects the organization's money",
    "icon": "coins",
    "color": "#198754"
  }
}
```

One policy, `accounting-treasurer`, grants all six permissions to `treasurer`. A site grants
`ledger-summary-read` to anyone else through its own policy, and reports reach the board through the
`audience` of the report page (D-021).

## Concurrency

Two copies of the site share the database during a rolling update (D-006). SQLite's locking keeps
writes safe. Every write is one short transaction. Re-posting the same provider receipt is refused by
the unique `provider` plus `confirmation_number` index.

## Tests

- __LedgerManager__ against a real encrypted database in a temporary folder, opened through
  `DatabaseManager`: balances equal opening plus in minus out; a transfer leaves the total
  unchanged; a void keeps the original and links the replacement.
- __Triggers__: an UPDATE of an amount, or any DELETE, fails with the trigger's message.
- __Permissions__: each method refuses without its permission, and allows it when a policy grants it,
  whatever role name is used.
- __Audit__: a failing audit sink refuses `postTransaction` and leaves no row behind.
- `audit-coverage --check --addon addons/accounting`: every declared event has an emitter.
- Each guard sabotage-checked once (break it, watch its test go red).
- Test teardown removes only the temporary folders the tests created.

## Open questions

1. __Period lock:__ decided 2026-10-08: not in the MVP. Later, a __period__ lock whose length each site sets
   (monthly, quarterly, semi-annual, annual), because many condos and small entities do not report monthly
   ([#19](https://github.com/jwilleke/ngdp-accounting-addons/issues/19)).
2. __Categories:__ decided 2026-10-08: categories follow the Unified Chart of Accounts (UCOA) model, each a
   UCOA account code with a label, kept in the site's configuration
   ([D-023](decisions.md#d-023-categories-follow-the-unified-chart-of-accounts-ucoa)). Still open: the default code set the add-on ships.
3. __Waiting for a busy database:__ decided 2026-10-08: ngdpbase sets it in the provider, as a default
   configuration setting (`ngdpbase.database.busy-timeout-ms`,
   [ngdpbase#1710](https://github.com/jwilleke/ngdpbase/issues/1710)). The add-on sets nothing.
4. __Currency codes:__ decided 2026-10-08: ISO 4217 codes, taken from a site-wide default in ngdpbase
   (`ngdpbase.default.currency`, [ngdpbase#1711](https://github.com/jwilleke/ngdpbase/issues/1711)).
   The add-on ships no currency default of its own.
