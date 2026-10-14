# Deploying and smoke-testing the accounting add-on

The add-on runs on ngdpbase v5.2.3 or later, on bare metal, in Docker and in Kubernetes
([D-006](../docs/plans/decisions.md)). `scripts/smoke.sh <base-url> <admin-password>` checks a
running site the same way everywhere: the help page is seeded, an anonymous caller is refused,
the admin signs in, a fund and an entry are written, the balance follows, and the CSV export works.

The smoke test needs `deploy/smoke/app-custom-config.json`, which is for tests only. It lets the
admin keep the ledger, and turns the secure session cookie off because the test talks plain HTTP to
localhost.

## Bare metal (a drop-in add-on)

Add this repository's `addons/` folder to `ngdpbase.managers.addons-manager.addons-path`, enable
`ngdpbase.addons.accounting.enabled` (and `ngdpbase.addons.forms.enabled` for the treasurer's
screens), build the add-on (`cd addons/accounting && npm ci && npm run build`) and restart.

The add-on imports ngdpbase as `../../dist/...`: this repository's `dist` link must point at the
`dist/` of the ngdpbase that runs it. A link to a different checkout loads a second copy of
ngdpbase's modules, and every audit event is then refused as "not declared".

## Docker

```sh
docker build --platform linux/amd64 -f deploy/Dockerfile -t ngdp-accounting:smoke .
```

`deploy/Dockerfile` follows the wrapper-image pattern of ngdpbase's add-on guide (section 12). The
runtime image has no npm, so the add-on is compiled in a build stage against the same ngdpbase
`dist/` and copied to `/app/addons/accounting`. A fresh container needs `PUID`, `PGID`,
`HEADLESS_INSTALL=true`, `NGDPBASE_ADMIN_PASSWORD` (with `ngdpbase.user.security.defaultpassword`
set to `$NGDPBASE_ADMIN_PASSWORD`), `NGDPBASE_DATABASE_KEY` and `NGDPBASE_SESSION_SECRET`.

Until ngdpbase supports an optional load order (ngdpbase#1808), `accounting` loads before `forms`
in the image, and the treasurer's screens stay off there; the ledger API works.

## Kubernetes

`deploy/k8s/smoke.yaml`: one pod from the same image, config seeded onto the data volume. The file
lists the secret and configmap to create first.
