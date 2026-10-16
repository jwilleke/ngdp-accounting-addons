# Installing and smoke-testing the accounting add-on

The add-on is an ordinary ngdpbase add-on, independent of how a site is deployed
([D-006](../docs/plans/decisions.md#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes)):
the same code and configuration keys on a host, in Docker or in Kubernetes, and nothing
deployment-specific in this repository. How to install an add-on on each is ngdpbase's: its add-on
guide (`docs/guides/addons-developer-guide.md`, "Where it is loaded" and "Shipping Your Addon as a
Container Image") and `docs/platform/deployment/`.

Requirements: ngdpbase v5.11.0 or later (declared as `minVersion`; it is `ctx.enforceDeny`, ngdpbase v5.11.0, that the ledger needs), the site's database on
(`ngdpbase.database.provider: sqlite`), and the forms add-on for the treasurer's screens.

One rule worth knowing: the add-on imports ngdpbase as `../../dist/...`. Wherever it is installed,
that path must lead to the `dist/` of the ngdpbase that runs it. Pointing it at another copy loads a
second set of ngdpbase's modules, and every audit event is then refused as "not declared"
(ngdpbase#1675).

## Smoke test

`scripts/smoke.sh <base-url> <admin-password>` checks one running site, however it is deployed:
the help page is seeded, an anonymous caller is refused, the admin signs in, a fund and an entry are
written, the balance follows, and the CSV export works.

It needs `deploy/smoke/app-custom-config.json` on that site, which is for tests only: it lets the
admin keep the ledger, and turns the secure session cookie off because the test talks plain HTTP to
localhost.
