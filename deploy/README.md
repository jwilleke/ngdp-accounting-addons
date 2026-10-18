# Installing and smoke-testing the accounting add-on

The add-on is an ordinary ngdpbase add-on, independent of how a site is deployed
([D-006](../docs/plans/decisions.md#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes)):
the same code and configuration keys on a host, in Docker or in Kubernetes, and nothing
deployment-specific in this repository. How to install an add-on on each is ngdpbase's: its add-on
guide (`docs/guides/addons-developer-guide.md`, "Where it is loaded" and "Shipping Your Addon as a
Container Image") and `docs/platform/deployment/`.

Requirements: ngdpbase v5.18.0 or later (declared as `minVersion`; its types package starts at 5.18.0; the ledger needs `ctx.enforceDeny` from v5.11.0, the ExportManager CSV writer and PluginManager formatters from v5.12.0, `engine.createRouter()` from v5.15.0, and declared add-on databases from v5.17.0), the site's database on
(`ngdpbase.database.provider: sqlite`), and the forms add-on for the treasurer's screens.

At runtime the add-on imports nothing from ngdpbase's files: core values come from the `host` passed
to `register()`, routes from `engine.createRouter()`, and the rest from ngdpbase's managers. The build
and the tests take ngdpbase's types and test kit from `@jwilleke/ngdpbase-types`, so no ngdpbase
checkout is needed anywhere. Installing it needs its compiled `.js` files, which `npm run build` writes
beside the `.ts`.

Setting it up for a real site (access, the board's view, backups): the
[accounting site guide](../docs/guides/accounting-guide.md).

## Smoke test

`scripts/smoke.sh <base-url> <admin-password>` checks one running site, however it is deployed:
the help page is seeded, an anonymous caller is refused, the admin signs in, a fund and an entry are
written, the balance follows, and the CSV export works.

It needs `deploy/smoke/app-custom-config.json` on that site, which is for tests only: it lets the
admin keep the ledger, and turns the secure session cookie off because the test talks plain HTTP to
localhost.
