---
title: Decisions
description: Log of design and project decisions for ngdp-accounting-addons, newest last.
last_updated: "2026-10-04"
---

# Decisions

One entry per decision. This file is the record; other documents link here rather than restate the
reasoning. A decision is never edited away: when it changes, add a new entry and mark the old one
`Superseded by D-NNN`.

Status values: `Proposed` (awaiting the owner), `Accepted`, `Superseded`, `Rejected`.

| ID | Date | Decision | Status |
| --- | --- | --- | --- |
| [D-001](#d-001-adopt-the-mjs-project-template-agent-kit) | 2026-10-04 | Adopt the mjs-project-template agent kit; defer Node/TypeScript scaffolding | Accepted |
| [D-002](#d-002-recurring-jobs-come-from-ngdpbase-core) | 2026-10-04 | Recurring jobs come from ngdpbase core, not a private scheduler | Accepted |
| [D-003](#d-003-learn-payment-outcomes-by-asking-not-by-webhook) | 2026-10-04 | Learn payment outcomes by asking the service, not by inbound webhook | Accepted |
| [D-004](#d-004-paymentmanager-with-configurable-providers) | 2026-10-04 | `PaymentManager` with configurable, capability-declaring providers | Accepted |
| [D-005](#d-005-where-paymentmanager-lives) | 2026-10-04 | Where `PaymentManager` lives | Proposed |
| [D-006](#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes) | 2026-10-04 | Every add-on runs on bare metal, Docker and Kubernetes | Accepted |
| [D-007](#d-007-configuration-lives-in-config-files) | 2026-10-04 | Configuration lives in config files | Accepted |
| [D-008](#d-008-where-secret-values-live) | 2026-10-04 | Where secret values (payment provider keys) live | Proposed |

## D-001: Adopt the mjs-project-template agent kit

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ PR [#10](https://github.com/jwilleke/ngdp-accounting-addons/pull/10)

__Context:__ The repository held only planning documents and had no shared agent conventions, issue
templates or markdown linting.

__Decision:__ Install the [mjs-project-template](https://github.com/jwilleke/mjs-project-template)
agent kit with its `install-kit.sh`. Do not adopt the template's Node/TypeScript scaffolding
(`package.json`, `tsconfig`, ESLint, Vitest, `src/`) while the repository is planning only.

__Consequences:__

- Kit-managed files are updated by `kit-sync` pull requests; fix kit files upstream, never here.
- When the first add-on is built, take the code scaffolding from ngdpbase's own tooling, not this kit:
  [`jwilleke/ngdpbase-addon-template`](https://github.com/jwilleke/ngdpbase-addon-template) (repository
  with Dockerfile and Renovate wiring) or `npm run create:addon` (one add-on directory). Both emit a
  matching slug and real seed-page UUIDs. ngdpbase requires Node 24+.

## D-002: Recurring jobs come from ngdpbase core

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [#11](https://github.com/jwilleke/ngdp-accounting-addons/issues/11),
  [ngdpbase#1611](https://github.com/jwilleke/ngdpbase/issues/1611),
  [ngdpbase#1238](https://github.com/jwilleke/ngdpbase/issues/1238)

__Context:__ Dues reminders, lapsing, payment sync and year-end statements need recurring jobs.
ngdpbase's `BackgroundJobManager` runs jobs only on demand. Add-ons and core work around this with
their own `setTimeout`/`setInterval`, which has no catch-up after downtime, no single runner across
instances, and has crashed a host before (ngdpbase#1238).

__Decision:__ Do not build a private scheduler. Wait for ngdpbase#1611 and register jobs with its
recurring schedule.

__Consequences:__

- Every scheduled job is idempotent per slot (job id plus slot time), so a retry or takeover cannot
  post twice.
- Job ids are namespaced by add-on slug (`<slug>.<job>`).
- Any interim timer must enqueue with a schedule `JobContext` and is documented as having no
  catch-up and no lock.

## D-003: Learn payment outcomes by asking, not by webhook

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3); depends on
  [D-002](#d-002-recurring-jobs-come-from-ngdpbase-core)

__Context:__ The first draft of the requirements had Stripe push results to an inbound webhook.
ngdpbase cannot receive one today: `express.json()` in `src/app.ts` consumes the raw body before
add-ons load, so signatures cannot be verified, and `src/middleware/csrf.ts` rejects the POST with
no way for an add-on to add an exemption. Add-ons may already make outbound calls through core's
`guardedFetch`.

__Decision:__ Add-ons never receive messages from outside. A payment provider learns outcomes by
asking the service on a schedule (for Stripe, its Events API), plus one immediate check when a payer
returns from a hosted payment page. All calls go out through `guardedFetch`.

__Consequences:__

- No ngdpbase core change for inbound requests; no public endpoint and no webhook secret to manage.
  Works on sites not reachable from the internet (for example behind Cloudflare Access).
- Ledger updates can lag by the sync interval (minutes). Acceptable for a volunteer treasurer.
- Stripe keeps events for 30 days; a provider also needs a slower reconciliation of recent payments
  as a backstop after long downtime.
- Payments depend on D-002 for the recurring sync.
- Revisit only if a provider is ever needed that can push but cannot be asked.

## D-004: PaymentManager with configurable providers

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3); ngdpbase
  `docs/guides/managers-developer-guide.md`, `docs/guides/addons-developer-guide.md`

__Context:__ Stripe will not always be the service. Organizations may use Toast, Zelle, others, or
only cash and checks, and switching must be a configuration change.

__Decision:__ All money movement goes through one `PaymentManager`, following ngdpbase's manager and
provider pattern. Providers extend a `BasePaymentProvider`: for example `StripePaymentProvider`,
`ToastPaymentProvider`, `ZellePaymentProvider`, `ManualPaymentProvider` (cash and check). Dues,
donations and events call `PaymentManager`, never a service directly.

__Consequences:__

- Several providers can be active at once (for example Stripe online plus cash at the door), unlike
  ngdpbase's usual single `ngdpbase.<capability>.provider`. Add-on configuration lives under
  `ngdpbase.addons.<slug>.*`, and in the add-on merge layer maps merge per entry while plain arrays
  replace wholesale, so providers are a map keyed by provider name, not a list:
  `ngdpbase.addons.<slug>.providers.<name>.enabled` and `.<name>.*` settings. Keys use the `$VAR`
  form.
- Correction, 2026-10-04: this entry first named the key `ngdpbase.payment.providers` (a list). That
  is not where add-on configuration lives (ngdpbase `docs/guides/addons-developer-guide.md`, sections
  3 and Standing rules).
- Providers declare capabilities (for example `checkout`, `sync`, `refund`, `import`,
  `manualEntry`), and the interface offers only what the configured providers support. Zelle, for
  instance, has no API for small organizations, so it is record-or-import only.
- The manual provider is always available, so payments work with nothing configured.
- Every ledger transaction carries `provider` and the service's `externalId`, unique together, so a
  repeated sync or import posts once. The ledger knows nothing about any one service.
- Toast's API access and refund support are unverified.

## D-005: Where PaymentManager lives

- __Status:__ Proposed
- __Date:__ 2026-10-04
- __Links:__ [D-004](#d-004-paymentmanager-with-configurable-providers)

__Options:__

- __In this repository (recommended):__ the payments add-on registers it with
  `engine.registerManager`, built in the shape of a core manager so it can move into ngdpbase later
  if add-ons outside accounting need payments.
- __In ngdpbase core now:__ available to every add-on, but adds a third core dependency to this
  project.

__Evidence:__ ngdpbase's add-on guide shows add-ons registering their own managers with
`engine.registerManager` (section 6) and says core changes must be self-contained, with no
add-on-specific code in the core repo (section 10). A payments manager written for these add-ons fits
the first; moving it to core would need it to be general first.

__Decision:__ Pending.

## D-006: Every add-on runs on bare metal, Docker and Kubernetes

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ ngdpbase `docs/platform/deployment/` (`direct-install.md`, `docker-compose.md`,
  `kubernetes.md`, `addon-packaged.md`), `docs/platform/addon-architecture.md` (Distribution Models),
  `docker/HEADLESS-DEPLOYMENT-NOTES.md`, `docker/k8s/`

__Context:__ ngdpbase is deployed three ways: direct install on a host (`./server.sh`, optionally
under pm2), Docker Compose, and Kubernetes. Organizations using these add-ons will use all three.

__Decision:__ Every add-on must install and run unchanged on all three. The same code and the same
configuration keys; no deployment-specific code paths.

__Consequences:__

- __Distribution:__ the add-on must be shippable in a form each target can load. ngdpbase loads the
  same add-on directory from a drop-in path (`addons-path`), an npm package
  (`node_modules:@jwilleke/*-addon` in `addons-path`), or a wrapper image built
  `FROM ghcr.io/jwilleke/ngdpbase:<version>`. Bare metal uses the directory or the package; Docker and
  Kubernetes use the wrapper image (ngdpbase's recommended production path for containers). Which
  artifacts we publish is still requirements.md open question 15, now narrowed to formats that cover
  all three.
- __State:__ everything the add-ons keep lives under their `dataPath` inside ngdpbase's data
  directory (`FAST_STORAGE` on a host, the data volume in Compose, the data PVC in Kubernetes).
  Nothing is written beside the code, into the image, or to temporary directories that do not
  survive a restart. ngdpbase's backup guidance is "back up the data directory"; the add-ons must
  not need anything more.
- __Configuration and secrets:__ see [D-007](#d-007-configuration-lives-in-config-files).
- __More than one process:__ ngdpbase's Kubernetes starter runs `replicas: 1` but rolls updates with
  `maxSurge: 1, maxUnavailable: 0`, so two pods share the data directory during every rollout. Any
  timer or scheduled job can therefore run twice. This makes the per-slot idempotency in D-002 and
  the `provider` plus `externalId` uniqueness in D-004 required, not optional.
- __Network:__ D-003 needs outbound HTTPS only and no inbound route, so no target needs extra
  ingress. In Kubernetes, outbound calls from Alpine-based images can hit the `ndots:5` DNS problem
  (`HEADLESS-DEPLOYMENT-NOTES.md` section 5); the add-ons' install notes must point to the fix.
- __Containers run as a non-root user__ (UID 1000); the add-ons must not need root or write outside
  the data directory.
- __Runtime:__ Node 24 or later on bare metal, matching ngdpbase.
- __Release check:__ before a release, each add-on is installed and smoke-tested on all three
  targets.
- ngdpbase's own documents disagree on the npm-package model: `addon-architecture.md` says it is
  implemented (#673), `kubernetes.md` still says it is not shipped. Confirm before relying on it.

## D-007: Configuration lives in config files

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [D-004](#d-004-paymentmanager-with-configurable-providers),
  [D-006](#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes); ngdpbase
  `docs/guides/configuration-developer-guide.md`, `docs/platform/deployment/kubernetes.md`

__Context:__ With three deployment targets (D-006) it is tempting to configure each through its own
mechanism: `.env` on a host, `environment:` in Compose, ConfigMaps in Kubernetes. That splits one
site's settings across places that differ by target.

__Decision:__ Add-on configuration is handled in configuration files. Each add-on ships its
defaults, permissions and policies in its own `config/default-config.json` (the add-on merge layer).
An operator overrides them in the instance's `app-custom-config.json`, which lives in the data
directory and can be edited through `/admin/configuration`. All keys are under
`ngdpbase.addons.<slug>.*`.

__Consequences:__

- The same files configure a bare-metal, Docker or Kubernetes site. Deployment manifests carry
  infrastructure only (image, replicas, volume, ingress, secrets), as ngdpbase's Kubernetes guide
  already advises.
- Add-on code reads settings only through the `config` passed to `register()` or
  `ConfigurationManager`, never from `process.env` directly.
- Where secret values (payment provider keys) live is not settled by this entry; see
  [D-008](#d-008-where-secret-values-live).
- Correction, 2026-10-04: this entry first said a `$VAR` reference makes `ConfigurationManager` mask
  a value. It does not. `$VAR` only resolves the value from the environment; masking comes solely
  from naming the key in `ngdpbase.config.secret-keys`.

## D-008: Where secret values live

- __Status:__ Proposed
- __Date:__ 2026-10-04
- __Links:__ [D-007](#d-007-configuration-lives-in-config-files); ngdpbase
  `src/managers/ConfigurationManager.ts` (`resolveEnvRef`, `getMaskedProperty`),
  `src/utils/auditConfigChange.ts` (`isSecretKey`), `src/utils/configEnvKeys.ts`,
  `docs/guides/configuration-developer-guide.md`

__Context:__ Payment providers need secret values (for example a Stripe secret key). How ngdpbase
treats a secret, checked on `master` at `9b0da38`:

- __Masking:__ a key named in `ngdpbase.config.secret-keys` is masked on the Admin Configuration
  screen until an admin with `admin-system` reveals it, and is stripped server-side for a read-only
  admin. Matching is by exact key. This works whether the value is in the file or comes from the
  environment.
- __`$VAR` values:__ a config value of the bare form `$STRIPE_SECRET_KEY` is read from the
  environment; if the variable is unset, reading the key throws. `$VAR` does not mask anything by
  itself.
- __`ngdpbase.config.env-keys`__ declares keys owned by the environment, so the admin screen does
  not save edits that cannot take effect. It is a map, so an add-on can add entries without
  disturbing core's.
- __Gap:__ `ngdpbase.config.secret-keys` is a plain array, and the add-on merge layer replaces plain
  arrays wholesale. An add-on that lists its own secret keys in its `config/default-config.json`
  replaces core's list and unmasks core secrets (session secret, SMTP password, OIDC client secret).
  An operator can add keys in `app-custom-config.json` only by restating the whole list. Core
  currently lists one add-on key itself (`ngdpbase.addons.demo.admin-account.password`).

__Options:__

- __A. Value in the config file:__ the secret is stored in `app-custom-config.json` in the data
  directory and masked through `secret-keys`. One place for everything, the same on every target;
  the secret is then in the data directory and its backups.
- __B. Value from the environment:__ the config file holds `$VAR`, the value comes from `.env`, the
  Compose environment or a Kubernetes Secret, and the key is declared in `env-keys` and
  `secret-keys`. Keeps secrets out of the data directory and its backups; needs one more place set
  per target.
- Either way, the add-on's secret keys must reach `secret-keys` without replacing core's list. That
  needs ngdpbase to make `secret-keys` additive for add-ons (for example a map, as `env-keys`
  already is), or the add-on's keys added to core's list.

__Facts from the owner:__ `.env` is not in backups.

__Recommendation: B.__

- Backups of the data directory travel further (off-site copies, Velero, S3) and are kept longer
  than the running site; a payment key should not travel with them. `.env` is not backed up, so B
  keeps keys out of every backup.
- It matches how ngdpbase already treats its own secrets (session secret, OIDC client secret), and
  `ConfigurationManager`'s own error for an unset `$VAR` tells the operator to set it in `.env` or a
  Kubernetes Secret.
- One mechanism covers D-006: `.env` on bare metal, `env_file` or `environment:` in Compose, a
  Kubernetes Secret (SOPS-encrypted in GitOps) in a cluster. D-007 still holds: the key is declared
  in the add-on's config file; only its value is outside.
- Each secret key is declared in `env-keys`, so the admin screen never saves a key that cannot take
  effect. Rotating a key is: change the environment, restart.
- A provider whose `$VAR` is unset must not take the add-on down: catch the error at `register()`,
  leave that provider disabled, and report it in `status()`.
- Keep the secret count small: a Stripe restricted key with only the permissions the provider uses,
  separate test and live keys, and no webhook secret (D-003).
- Masking is still needed (the resolved value must not render on the admin screen), so the
  `secret-keys` gap ([ngdpbase#1612](https://github.com/jwilleke/ngdpbase/issues/1612), P0) is a
  blocker for shipping any provider with a secret. Fixed in
  [ngdpbase#1613](https://github.com/jwilleke/ngdpbase/pull/1613) (open, not merged): `secret-keys`
  becomes a set that every layer extends. The add-on then declares its keys in its
  `config/default-config.json` as `"ngdpbase.config.secret-keys": { "<key>": true }` (a plain list
  of names also adds). Readers use `enabledEntries()` from ngdpbase `src/utils/configFiles.ts`.
- Requirements change: changing a provider key moves from an in-app action (`payment-settings`) to an
  operator action in the environment. `payment-settings` still covers which providers are enabled
  and their non-secret settings.

__Decision:__ Pending.
