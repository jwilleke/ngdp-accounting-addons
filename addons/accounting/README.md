# Accounting

The base accounting add-on for [ngdpbase](https://github.com/jwilleke/ngdpbase): funds, a
single-entry ledger with voids and transfers, the treasurer's screens, the `[{Ledger}]` plugin, a
monthly summary and a CSV export.

- __Slug:__ `accounting`. It is the registry key and the config key, and equals the `name` exported
  from `index.ts`.
- __Type:__ `additive`.
- __Requires:__ ngdpbase 5.17.0 or later (`ngdpbase.minVersion` in `package.json`); the forms add-on
  for the screens (`optionalDependencies: ['forms']`).

Turning it on for a site: [docs/guides/accounting-guide.md](../../docs/guides/accounting-guide.md).
The ledger's API for other add-ons: [docs/managers/LedgerManager.md](../../docs/managers/LedgerManager.md).
Why it is built this way: [docs/plans/ledger-design.md](../../docs/plans/ledger-design.md) and
[docs/plans/decisions.md](../../docs/plans/decisions.md).

## Contents

| Path | What it is |
| --- | --- |
| `index.ts` | `register(engine, config, host)`: opens the declared database, builds the audit door, registers `LedgerManager`, mounts the API, the plugin and the forms |
| `managers/LedgerManager.ts` | The ledger: one door per action, each asked of ngdpbase's decision point and audited |
| `managers/migrations.ts` | The accounting tables, and the triggers that refuse deletes and silent changes to money |
| `routes/api.ts` | JSON API under `/api/accounting`, including the CSV download at `/export` |
| `forms.ts` | The treasurer's forms (entry, transfer, void, fund create/rename/close) for the forms add-on |
| `plugins/LedgerPlugin.ts` | `[{Ledger view='balances' / 'entries' / 'summary'}]`, drawn for the viewer |
| `config/default-config.json` | The database declaration, permissions with their audit and step-up rules, the `treasurer` role and its policy |
| `pages/` | The treasurer's pages and the Using Accounting help page, seeded on first enable |
| `__tests__/` | Ledger, report, form and plugin tests against a real SQLite database |

## How it reaches ngdpbase

One path for each thing, never a local copy:

- __Core values__ (`ApiContext`, `ApiError`, `sendApiError`, `recordAuditEvent`,
  `addonAuditEventName`, `actorOf`, `logger`) come from the `host` passed to `register()`
  (ngdpbase #1813) and are handed down to the manager, routes and forms.
- __Shared capabilities belong to their manager__: the CSV writer is `ExportManager.toCsv`, the money
  formatter `PluginManager.formatters.formatMoney`; the plugin gets the formatters as
  `context.formatters`.
- __Routes__ use `engine.createRouter()`, core's own Express; the add-on never imports express at
  runtime.
- __The database__ is opened with `DatabaseManager.openAddonDatabase` and declared as
  `ngdpbase.addons.accounting.database`.
- __Access__: `LedgerManager` asks `PolicyDecisionPoint.decide(subject, { action })` and turns a deny
  into ngdpbase's refusal with `ctx.enforceDeny` (D-025). No role names in code.
- __Caching__: after each write the manager bumps the `LedgerManager` topic in `CacheManager`.

Types come from `@jwilleke/ngdpbase-types` (a dev dependency, published with each ngdpbase
release); the tests use its `/testing` kit (the host builder, an in-memory add-on database checked
against our declaration, the CSV writer, the plugin formatters). Nothing imports ngdpbase's files.

## Develop

No ngdpbase checkout is needed to build or test:

```bash
cd addons/accounting
npm install
npm test                        # builds (tsc) first, then runs vitest
```

To run it, point an ngdpbase instance's add-ons path at this repository's `addons/` folder, enable
`accounting` (and `forms`), and restart. `scripts/smoke.sh` checks a running site end to end.
