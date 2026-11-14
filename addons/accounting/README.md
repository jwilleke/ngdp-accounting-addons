# Accounting

The base accounting add-on for [ngdpbase](https://github.com/jwilleke/ngdpbase): funds, a single-entry ledger with voids and transfers, the treasurer's screens, the `[{Ledger}]` plugin, a monthly summary and a CSV export.

- __Slug:__ `accounting`. It is the registry key and the config key, and equals the `name` exported from `index.ts`.
- __Type:__ `additive`.
- __Requires:__ ngdpbase 5.45.0 or later (`ngdpbase.minVersion` in `package.json`); the forms add-on for the screens (`optionalDependencies: ['forms']`).

Turning it on for a site: [docs/guides/accounting-guide.md](../../docs/guides/accounting-guide.md). The ledger's API for other add-ons: [docs/managers/LedgerManager.md](../../docs/managers/LedgerManager.md). Why it is built this way: [docs/plans/ledger-design.md](../../docs/plans/ledger-design.md) and [docs/plans/decisions.md](../../docs/plans/decisions.md).

## Contents

| Path | What it is |
| --- | --- |
| `index.ts` | `register(engine, config, host)`: opens the declared database, builds the audit door, registers `LedgerManager`, mounts the API, the plugin and the forms |
| `managers/LedgerManager.ts` | The ledger: one door per action, each asked of ngdpbase's decision point and audited |
| `managers/ReceiptManager.ts` | Money coming in: picks the receipt provider (manual now, Stripe later) and hands the receipt or refund to the ledger |
| `managers/migrations.ts` | The accounting tables, and the triggers that refuse deletes and silent changes to money |
| `routes/api.ts` | JSON API under `/api/accounting`, including the older CSV download at `/export`, which runs the same `LedgerManager.exportRecords` as the export source |
| `exportSource.ts` | The ledger's CSV download through ngdpbase's export engine: the `accounting.ledger` export source, declared in `package.json` (`ngdpbase.exportSources`) and registered in `register()` |
| `executive.ts` | The card on ngdpbase's Executive Hub (ngdpbase#2094): funds, cash not yet deposited, what waits on the treasurer |
| `forms.ts` | The treasurer's forms (receipt, refund, money out, transfer, void, fund create/rename/close) for the forms add-on |
| `plugins/gatedForm.ts` | `[{Ledger view='form' id='…'}]`: a treasurer's form, drawn only for a viewer the decision point permits its write permission and `form-submit`; anyone else reads a short note |
| `pageAudience.ts` | Upgrade: at start, takes the old shipped `audience: [treasurer]` off the add-on's own pages through core's page door, as the system |
| `plugins/LedgerPlugin.ts` | `[{Ledger view='balances' / 'entries' / 'summary'}]`, drawn for the viewer |
| `config/default-config.json` | The database declaration, permissions with their audit rules (step-up is off for now, D-030), the `treasurer` role and its policy, and the `executive` role's read policy (D-050) |
| `pages/` | The treasurer's pages and the Using Accounting help page, seeded on first enable. No page carries an audience: each screen asks the permission its data or action needs |
| `__tests__/` | Ledger, report, form and plugin tests against a real SQLite database |

## How it reaches ngdpbase

One path for each thing, never a local copy:

- __Core values__ (`ApiContext`, `ApiError`, `sendApiError`, `recordAuditEvent`, `addonAuditEventName`, `actorOf`, `logger`) come from the `host` passed to `register()` (ngdpbase #1813) and are handed down to the manager, routes and forms.
- __Shared capabilities belong to their manager__: the CSV writer is `ExportManager.toCsv`, the money formatter `PluginManager.formatters.formatMoney`; the plugin gets the formatters as `context.formatters`.
- __Routes__ use `engine.createRouter()`, core's own Express; the add-on never imports express at runtime.
- __The database__ is opened with `DatabaseManager.openAddonDatabase` and declared as `ngdpbase.addons.accounting.database`.
- __Access__: `LedgerManager` asks `PolicyDecisionPoint.decide(subject, { action })` and turns a deny into ngdpbase's refusal with `ctx.enforceDeny` (D-025). No role names in code.
- __Caching__: after each write the manager bumps the `LedgerManager` topic in `CacheManager`.

Types come from `@jwilleke/ngdpbase-types` (a dev dependency, published with each ngdpbase release); the tests use its `/testing` kit (the host builder, an in-memory add-on database checked against our declaration, the CSV writer, the plugin formatters). Nothing imports ngdpbase's files.

## Develop

No ngdpbase checkout is needed to build or test:

```bash
cd addons/accounting
npm install
npm test                        # builds (tsc) first, then runs vitest
```

To run it, point an ngdpbase instance's add-ons path at this repository's `addons/` folder, enable `accounting` (and `forms`), and restart. `scripts/smoke.sh` checks a running site end to end.

## CSV export (ngdpbase export engine)

The `[{Ledger view='summary' export='true'}]` download links open ngdpbase's Export screen for the export source `accounting.ledger` (`/export/source/accounting.ledger?ref=<ref>`); core's `core.csv-file` writes the file. The links show only to a holder of `ledger-export`.

- __`ref`__ is `<kind>:<from>..<to>`: kind `transactions` (every ledger field, entries dated in the period, voided ones with their status) or `funds` (the period summary per fund), and both dates as `YYYY-MM-DD`, for example `transactions:2026-10-01..2026-10-31`. Anything else is refused.
- __The ledger is the only door.__ `mayExport` and `read` go through `LedgerManager`, which asks `ledger-export` of ngdpbase's decision point, and writes the audit record (who, the period, the row count and a SHA-256) before any row is handed over. If it cannot be written, there is no file.
- __The hash is of the rows handed over__, as the ledger's own CSV writer (`ExportManager.toCsv`) would write them. The file core makes has the same columns in the same order, but core's writer decides the bytes (a number column is a number, a text cell starting with `=`, `+`, `-` or `@` gets a leading `'`), so the hash may not equal a hash of the downloaded file. It vouches for the rows.
- __Step-up.__ A holder whose sign-in is not fresh still sees the link, but `read` hands over nothing, and the Export screen says there is nothing to export. The engine hands the add-on a context, not a request, so the add-on cannot send the user to sign in again. Step-up is off for `ledger-export` by default ([D-030](../../docs/plans/decisions.md#d-030-step-up-off-for-accountings-money-actions-for-now)).
- A period with no rows exports nothing (the screen says so) and the audit record says 0 rows. The older `GET /api/accounting/export` still returns the file at once, header-only for an empty period, and asks for a fresh sign-in as before.
