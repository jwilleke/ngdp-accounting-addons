# Accounting

Accounting addon for [ngdpbase](https://github.com/jwilleke/ngdpbase).

- __Slug:__ `accounting` — the canonical identity. It is the registry key and the
  config key, and it must equal the `name` exported from `index.ts`.
- __Type:__ `additive` — augments an existing instance.

## Enable

```json
{
  "ngdpbase.addons.accounting.enabled": true
}
```

## Contents

| Path | What it is |
|---|---|
| `managers/AccountingManager.ts` | Data layer, registered as `AccountingManager` |
| `plugins/AccountingPlugin.ts` | Renders `[{Accounting}]` on a page |
| `routes/api.ts` | Status and refresh, gated by `accounting-manage` |
| `views/accounting-status.ejs` | Admin view; its POST carries the CSRF token |
| `pages/` | Seed pages copied into the platform on first enable |
| `config/default-config.json` | Config keys, the permission and its policy |

## Rules an addon lives under

Addon code runs in the ngdpbase process. Every check that enforces a runtime
property of `src/` applies to this directory identically — a check that scans
only `src/` is a bug in the check, not a licence. This addon already follows the
four that bite:

- __Outbound HTTP goes through the host's `guardedFetch`.__ `index.ts` builds
  one under the instance's egress policy and injects it; a manager never calls
  `fetch` or an HTTP client library itself. Loopback and link-local are never
  reachable; a LAN source needs its prefix in
  `ngdpbase.security.egress.allowed-ranges`.
- __A permission decision is `ctx.requirePermission('accounting-manage')`__ on
  the request's own subject, forwarded — never a role name, never
  `isAuthenticated`, never a subject rebuilt from fields. The permission and its
  policy are declared in `config/default-config.json`.
- __A mutating browser request carries the CSRF token__ — the view uses
  `(window.csrfFetch || fetch)`; a bare `fetch` is refused by the host.
- __An acting call takes a context__, never a bare username.

The host is imported through `dist/`, never `src/`: a value import of host
source compiles it into this addon and emits a `.js` beside it, which exists on
a developer's machine and does not exist in the container.

The host's guards run over this directory: `lint:code`, `lint:csrf`,
`lint:http`, `lint:permission-subject`, `lint:gates`, `lint:addons`,
`lint:audit-deps` and the addon's own `tsc`. The rules in full are the
standing rules of ngdpbase's [addons developer guide](https://github.com/jwilleke/ngdpbase/blob/master/docs/guides/addons-developer-guide.md#standing-rules).

## Develop

Drop this directory into an ngdpbase instance's `addons/` (or point
`ngdpbase.managers.addons-manager.addons-path` at its parent), enable it, and
restart. For production, see the platform's `packaged` distribution model.
