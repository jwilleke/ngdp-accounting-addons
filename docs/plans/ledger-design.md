---
title: Ledger design (MVP)
description: How the accounting add-on stores funds and transactions, who may do what, and how every money action is recorded.
last_updated: "2026-10-08"
---

# Ledger design (MVP)

The design for the shared ledger in the base `accounting` add-on: the first working piece of the
MVP. It implements requirements.md section 4 (the ledger model) within the decisions in
[decisions.md](decisions.md). Status: __draft for the operator's review__; nothing here is built.

## What the MVP ledger does

- Keep a list of __funds__ (general, building, youth, an event). A fund can be closed, never deleted.
- Record __money in and money out__, each entry tagged to exactly one fund: cash, checks and other
  payments the treasurer enters by hand.
- __Correct mistakes without erasing them__: a posted entry is never edited or deleted. A
  correction voids it, with a reason, and posts a replacement linked to it.
- __Move money between funds__ as a linked out-and-in pair that leaves the total unchanged.
- Show __fund balances__ and the list of entries.
- Record __every money action__ in ngdpbase's audit log, and refuse the action if the record cannot
  be written.

Not in the MVP: online payments, dues, donations, events, scheduled jobs, QuickBooks and Wave
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
| `provider`, `confirmation_number` | TEXT | for payments a provider recorded; unique together when set |
| `source_type`, `source_id` | TEXT | what created it: `manual`, `adjustment`, `transfer` (later: `dues-invoice`, `donation`, …) |
| `status` | TEXT | `posted` or `voided` (`pending` arrives with online payments) |
| `voids_id` / `voided_by_id` | TEXT | links between a voided entry and its replacement |
| `void_reason` | TEXT | required when voided |
| `transfer_id` | TEXT | pairs the two halves of a fund transfer |
| `memo` | TEXT | free text |
| `created_by`, `created_at` | TEXT | actor and time |

`accounting_history`: append-only, one row per change (create, void, memo edit, fund change), with
actor, time, and before and after values, so the record survives with the add-on's data even apart
from ngdpbase's audit log.

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
writes safe. Every write is one short transaction. Re-posting the same provider payment is refused by
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
