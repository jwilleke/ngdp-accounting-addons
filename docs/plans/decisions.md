---
title: Decisions
description: Log of design and project decisions for ngdp-accounting-addons, newest last.
last_updated: "2026-10-04"
---

# Decisions

One entry per decision. This file is the record; other documents link here rather than restate the reasoning. A decision is never edited away: when it changes, add a new entry and mark the old one `Superseded by D-NNN`.

Status values: `Proposed` (awaiting the owner), `Accepted`, `Superseded`, `Rejected`.

| ID | Date | Decision | Status |
| --- | --- | --- | --- |
| [D-001](#d-001-adopt-the-mjs-project-template-agent-kit) | 2026-10-04 | Adopt the mjs-project-template agent kit; defer Node/TypeScript scaffolding | Accepted |
| [D-002](#d-002-recurring-jobs-come-from-ngdpbase-core) | 2026-10-04 | Recurring jobs come from ngdpbase core, not a private scheduler | Accepted |
| [D-003](#d-003-learn-payment-outcomes-by-asking-not-by-webhook) | 2026-10-04 | Learn payment outcomes by asking the service, not by inbound webhook | Accepted |
| [D-004](#d-004-paymentmanager-with-configurable-providers) | 2026-10-04 | `PaymentManager` with configurable, capability-declaring providers | Accepted |
| [D-005](#d-005-paymentmanager-lives-in-ngdpbase-core) | 2026-10-04 | `PaymentManager` lives in ngdpbase core, off by default | Superseded by D-017 |
| [D-006](#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes) | 2026-10-04 | Every add-on runs on bare metal, Docker and Kubernetes | Accepted |
| [D-007](#d-007-configuration-lives-in-config-files) | 2026-10-04 | Configuration lives in config files | Accepted |
| [D-008](#d-008-where-secret-values-live) | 2026-10-04 | Secret values come from the environment, never a JSON file (option B) | Accepted 2026-10-05 |
| [D-009](#d-009-treasurer-requires-aal2-like-admin-roles) | 2026-10-04 | Treasurer role requires AAL2, like admin roles | Accepted |
| [D-010](#d-010-ledger-data-lives-in-ngdpbases-database) | 2026-10-05 | Ledger data lives in ngdpbase's database, through `DatabaseManager` | Partly superseded by D-012 |
| [D-011](#d-011-one-path-to-the-database) | 2026-10-05 | One path to the database: `DatabaseManager` → `SqliteDatabaseProvider` | Accepted |
| [D-012](#d-012-mvp-accounting-has-its-own-database-file) | 2026-10-05 | MVP: accounting has its own database file, opened through the same path | Accepted |
| [D-013](#d-013-docs-live-here-until-v100-in-their-target-formats) | 2026-10-05 | Docs live here until v1.0.0, in their target formats | Accepted |
| [D-014](#d-014-every-action-is-a-permission-with-one-audited-door-no-money-moves-without-a-record) | 2026-10-05 | Every action is a permission with one audited door; no money moves without a record | Accepted |
| [D-015](#d-015-sign-in-strength-belongs-to-permissions-and-is-the-operators-choice) | 2026-10-05 | Sign-in strength belongs to permissions and is the operator's choice; money actions ship at AAL2 | Partly superseded by D-022 |
| [D-016](#d-016-one-repository-a-base-accounting-add-on-and-optional-module-add-ons) | 2026-10-05 | One repository: base `accounting` add-on plus optional module add-ons; the MVP is `accounting` | Accepted |
| [D-017](#d-017-paymentmanager-lives-in-the-accounting-add-on) | 2026-10-05 | `PaymentManager` lives in the `accounting` add-on; providers configured like `ngdpbase.auth.factors` | Accepted |
| [D-018](#d-018-use-published-standards-schemaorg-and-uncefact-payment-means) | 2026-10-05 | Use published standards: schema.org names and UN/CEFACT payment means codes | Accepted |
| [D-019](#d-019-apache-license-20-the-same-as-ngdpbase) | 2026-10-05 | Apache License 2.0, the same as ngdpbase | Accepted |
| [D-020](#d-020-follow-ngdpbases-guides-where-we-can) | 2026-10-05 | Follow ngdpbase's guides where we can | Accepted |
| [D-021](#d-021-mvp-roles-and-report-pages-treasurer-only-reports-use-page-audience) | 2026-10-06 | MVP roles and report pages: `treasurer` only; reports use page `audience`; no vault yet | Accepted |
| [D-022](#d-022-sign-in-strength-stays-on-roles-money-permissions-use-step-up) | 2026-10-08 | Sign-in strength stays on roles; money permissions use step-up; no per-permission AAL | Accepted |
| [D-023](#d-023-categories-follow-the-unified-chart-of-accounts-ucoa) | 2026-10-08 | Categories follow the Unified Chart of Accounts (UCOA) model | Accepted |
| [D-024](#d-024-treasurer-screens-are-forms-of-an-improved-ngdpbase-forms-add-on) | 2026-10-10 | Treasurer screens are forms of an improved ngdpbase forms add-on, on locked pages | Accepted |
| [D-025](#d-025-accounting-records-follow-ngdpbases-access-control-model) | 2026-10-15 | Accounting records follow ngdpbase's access-control model: the ledger guards, the PDP decides | Accepted |
| [D-026](#d-026-ledger-tables-stay-the-ledger-plugins-own-for-now) | 2026-10-16 | Ledger tables stay the `[{Ledger}]` plugin's own for now; DataFeed and wiki-table markup are not adopted yet | Accepted |
| [D-027](#d-027-ledger-5-and-reports-7-are-done-their-leftovers-move-to-the-issues-that-need-them) | 2026-10-17 | Ledger (#5) and reports (#7) are done; their leftovers move to the issues that need them | Accepted |
| [D-028](#d-028-receipts-for-money-in-statements-for-what-donors-get-payments-only-for-money-out) | 2026-10-18 | Receipts for money in, statements for what donors get, payments only for money out | Accepted |
| [D-029](#d-029-how-receipts-are-recorded-numbered-corrected-and-refunded-every-money-movement-has-a-reason) | 2026-10-18 | How receipts are recorded, numbered, corrected and refunded; every money movement has a reason | Accepted |
| [D-030](#d-030-step-up-off-for-accountings-money-actions-for-now) | 2026-10-18 | Step-up off for accounting's money actions, for now | Accepted |
| [D-031](#d-031-bank-accounts-cash-on-hand-and-deposits) | 2026-10-18 | Bank accounts, Cash on Hand and deposits: every entry has a fund and an account | Accepted |
| [D-032](#d-032-cleared-deposits-and-bounced-checks) | 2026-10-19 | Checks count when recorded; deposits are marked cleared; a bounced check is a returned-check entry | Accepted |
| [D-033](#d-033-receipts-and-refunds-are-made-of-lines) | 2026-10-19 | Receipts and refunds are made of lines, shown once; refunds are numbered RF-0001 | Accepted |
| [D-034](#d-034-a-generic-starter-chart-with-account-types) | 2026-10-19 | A generic starter chart that follows QuickBooks' types, detail types and names | Accepted |
| [D-035](#d-035-dues-and-assessments-flexible-accounts-and-charges) | 2026-10-20 | Dues and assessments: site-named, accounts in ngdpbase, charges as configuration, kept flexible | Accepted |
| [D-036](#d-036-donations-follow-the-donations-guide) | 2026-10-20 | Donations are receipt lines against an ngdpbase person; year-end web-page statements; the donations guide is the source of truth | Accepted |

## D-001: Adopt the mjs-project-template agent kit

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ PR [#10](https://github.com/jwilleke/ngdp-accounting-addons/pull/10)

__Context:__ The repository held only planning documents and had no shared agent conventions, issue templates or markdown linting.

__Decision:__ Install the [mjs-project-template](https://github.com/jwilleke/mjs-project-template) agent kit with its `install-kit.sh`. Do not adopt the template's Node/TypeScript scaffolding (`package.json`, `tsconfig`, ESLint, Vitest, `src/`) while the repository is planning only.

__Consequences:__

- Kit-managed files are updated by `kit-sync` pull requests; fix kit files upstream, never here.
- When the first add-on is built, take the code scaffolding from ngdpbase's own tooling, not this kit: `npm run create:addon -- --id accounting --repo` for the repository pieces (wrapper `Dockerfile`, Renovate, CI) and `npm run create:addon -- --id accounting-<module>` for each module add-on. Both emit a matching slug and real seed-page UUIDs. ngdpbase requires Node `>=24.0.0` and npm `>=11.0.0`.
- Updated 2026-10-05: `ngdpbase-addon-template` is retired; `create:addon --repo` replaces it (ngdpbase `docs/guides/addons-developer-guide.md`, "A whole repository"). Its generated `LICENSE` is Apache-2.0, which matches this repository's licence ([D-019](#d-019-apache-license-20-the-same-as-ngdpbase)).

## D-002: Recurring jobs come from ngdpbase core

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [#11](https://github.com/jwilleke/ngdp-accounting-addons/issues/11), [ngdpbase#1611](https://github.com/jwilleke/ngdpbase/issues/1611), [ngdpbase#1238](https://github.com/jwilleke/ngdpbase/issues/1238)

__Context:__ Dues reminders, lapsing, payment sync and year-end statements need recurring jobs. ngdpbase's `BackgroundJobManager` runs jobs only on demand. Add-ons and core work around this with their own `setTimeout`/`setInterval`, which has no catch-up after downtime, no single runner across instances, and has crashed a host before (ngdpbase#1238).

__Decision:__ Do not build a private scheduler. Wait for ngdpbase#1611 and register jobs with its recurring schedule.

__Consequences:__

- Every scheduled job is idempotent per slot (job id plus slot time), so a retry or takeover cannot post twice.
- Job ids are namespaced by add-on slug (`<slug>.<job>`).
- Any interim timer must enqueue with a schedule `JobContext` and is documented as having no catch-up and no lock.

## D-003: Learn payment outcomes by asking, not by webhook

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3); depends on [D-002](#d-002-recurring-jobs-come-from-ngdpbase-core)

__Context:__ The first draft of the requirements had Stripe push results to an inbound webhook. ngdpbase cannot receive one today: `express.json()` in `src/app.ts` consumes the raw body before add-ons load, so signatures cannot be verified, and `src/middleware/csrf.ts` rejects the POST with no way for an add-on to add an exemption. Add-ons may already make outbound calls through core's `guardedFetch`.

__Decision:__ Add-ons never receive messages from outside. A payment provider learns outcomes by asking the service on a schedule (for Stripe, its Events API), plus one immediate check when a payer returns from a hosted payment page. All calls go out through `guardedFetch`.

__Consequences:__

- No ngdpbase core change for inbound requests; no public endpoint and no webhook secret to manage. Works on sites not reachable from the internet (for example behind Cloudflare Access).
- Ledger updates can lag by the sync interval (minutes). Acceptable for a volunteer treasurer.
- Stripe keeps events for 30 days; a provider also needs a slower reconciliation of recent payments as a backstop after long downtime.
- Payments depend on D-002 for the recurring sync.
- Revisit only if a provider is ever needed that can push but cannot be asked.

## D-004: PaymentManager with configurable providers

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3); ngdpbase `docs/guides/managers-developer-guide.md`, `docs/guides/addons-developer-guide.md`

__Context:__ Stripe will not always be the service. Organizations may use Toast, Zelle, others, or only cash and checks, and switching must be a configuration change.

__Decision:__ All money movement goes through one `PaymentManager`, following ngdpbase's manager and provider pattern. Providers extend a `BasePaymentProvider`: for example `StripePaymentProvider`, `ToastPaymentProvider`, `ZellePaymentProvider`, `ManualPaymentProvider` (cash and check). Dues, donations and events call `PaymentManager`, never a service directly.

__Consequences:__

- Several providers can be active at once (for example Stripe online plus cash at the door), unlike ngdpbase's usual single `ngdpbase.<capability>.provider`, so providers are a map keyed by provider name, not a list (plain arrays are replaced wholesale on merge). Since D-017 the configuration is `ngdpbase.addons.accounting.paymentproviders`, shaped like `ngdpbase.auth.factors`.
- Correction, 2026-10-04: this entry first named the key `ngdpbase.payment.providers` (a list), then `ngdpbase.addons.<slug>.providers` while the manager was planned for this repository. D-005 moved it to core.
- Providers declare capabilities (for example `checkout`, `sync`, `refund`, `import`, `manualEntry`), and the interface offers only what the configured providers support. Zelle, for instance, has no API for small organizations, so it is record-or-import only.
- The manual provider is always available, so payments work with nothing configured.
- Every payment carries `provider` and the service's `confirmationNumber` (renamed from `externalId` by D-018), unique together, so a repeated sync or import is recorded once; ledger transactions keep both. The ledger knows nothing about any one service.
- Toast's API access and refund support are unverified.

## D-005: PaymentManager lives in ngdpbase core

- __Status:__ Superseded by [D-017](#d-017-paymentmanager-lives-in-the-accounting-add-on) on 2026-10-05
- __Date:__ 2026-10-04
- __Links:__ [D-004](#d-004-paymentmanager-with-configurable-providers), [ngdpbase#1614](https://github.com/jwilleke/ngdpbase/issues/1614), [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3)

__Context:__ `PaymentManager` (D-004) could live in this repository's payments add-on, registered with `engine.registerManager`, or in ngdpbase core. Other add-ons (calendar reservations, paid forms, events outside accounting) also need to take money. A core manager can ship disabled and not load until enabled, as OIDC does (`oidc-auth-server.enabled: false`).

__Decision:__ `PaymentManager`, `BasePaymentProvider` and the providers live in ngdpbase core, off by default and not loaded until enabled. Requested as [ngdpbase#1614](https://github.com/jwilleke/ngdpbase/issues/1614).

__Consequences:__

- Core stays general (ngdpbase's add-on guide, section 10: no add-on-specific code in core). Core starts payments, syncs outcomes, refunds, keeps sync cursors and `provider` plus `confirmationNumber`, and hands each outcome to the add-on that registered for it, with an opaque `reference` the add-on supplied (as forms hands off submissions with `registerHandler`). Core knows nothing about funds, invoices or the ledger.
- This repository keeps the ledger, funds, dues, donations, events, receipts and reports, and registers a handler that turns payment outcomes into ledger transactions.
- Configuration keys are core keys from the start, so operators never face a rename.
- One more core dependency: payments wait on an ngdpbase release, and the minimum ngdpbase version rises with it. Suggested order in [ngdpbase#1614](https://github.com/jwilleke/ngdpbase/issues/1614): manager, manual provider and hand-off first; Stripe next; others later. Sync depends on D-002 (ngdpbase#1611).
- The payment screens and the hand-off handler live in the base `accounting` add-on ([D-016](#d-016-one-repository-a-base-accounting-add-on-and-optional-module-add-ons)).

## D-006: Every add-on runs on bare metal, Docker and Kubernetes

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ ngdpbase `docs/platform/deployment/` (`direct-install.md`, `docker-compose.md`, `kubernetes.md`, `addon-packaged.md`), `docs/platform/addon-architecture.md` (Distribution Models), `docker/HEADLESS-DEPLOYMENT-NOTES.md`, `docker/k8s/`

__Context:__ ngdpbase is deployed three ways: direct install on a host (`./server.sh`, optionally under pm2), Docker Compose, and Kubernetes. Organizations using these add-ons will use all three.

__Decision:__ Every add-on must install and run unchanged on all three. The same code and the same configuration keys; no deployment-specific code paths.

__Consequences:__

- __Distribution:__ the add-on must be shippable in a form each target can load. ngdpbase loads the same add-on directory from a drop-in path (`addons-path`), an npm package (`node_modules:@jwilleke/*-addon` in `addons-path`), or a wrapper image built `FROM ghcr.io/jwilleke/ngdpbase:<version>`. Bare metal uses the directory or the package; Docker and Kubernetes use the wrapper image (ngdpbase's recommended production path for containers). Which artifacts we publish is still requirements.md open question 15, now narrowed to formats that cover all three.
- __State:__ everything the add-ons keep lives under their `dataPath` inside ngdpbase's data directory (`FAST_STORAGE` on a host, the data volume in Compose, the data PVC in Kubernetes). Nothing is written beside the code, into the image, or to temporary directories that do not survive a restart. ngdpbase's backup guidance is "back up the data directory"; the add-ons must not need anything more.
- __Configuration and secrets:__ see [D-007](#d-007-configuration-lives-in-config-files).
- __More than one process:__ ngdpbase's Kubernetes starter runs `replicas: 1` but rolls updates with `maxSurge: 1, maxUnavailable: 0`, so two pods share the data directory during every rollout. Any timer or scheduled job can therefore run twice. This makes the per-slot idempotency in D-002 and the `provider` plus `confirmationNumber` uniqueness in D-004 required, not optional.
- __Network:__ D-003 needs outbound HTTPS only and no inbound route, so no target needs extra ingress. In Kubernetes, outbound calls from Alpine-based images can hit the `ndots:5` DNS problem (`HEADLESS-DEPLOYMENT-NOTES.md` section 5); the add-ons' install notes must point to the fix.
- __Containers run as a non-root user__ (UID 1000); the add-ons must not need root or write outside the data directory.
- __Runtime:__ Node 24 or later on bare metal, matching ngdpbase.
- __Release check:__ before a release, each add-on is installed and smoke-tested on all three targets.
- ngdpbase's own documents disagree on the npm-package model: `addon-architecture.md` says it is implemented (#673), `kubernetes.md` still says it is not shipped. Confirm before relying on it.

__Update 2026-10-14 (operator):__ the add-ons are independent of the deployment method, and this repository holds nothing deployment-specific: no Dockerfile, no Kubernetes manifests. Packaging and running a site is ngdpbase's (its add-on guide and `docs/platform/deployment/`) and each operator's. An add-on is tested as ngdpbase tests itself: `scripts/smoke.sh` against one running ngdpbase, however it is deployed. It passed on Docker (the wrapper image on v5.8.0) and on bare metal (v5.8.0), and the wrapper image and Kubernetes manifest used for that are removed (4521720). What it found went to ngdpbase: an optional load order (ngdpbase#1808), no npm in the runtime image for the guide's Dockerfile (#1808), and the second-copy-of-core trap (#1675).

## D-007: Configuration lives in config files

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ [D-004](#d-004-paymentmanager-with-configurable-providers), [D-006](#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes); ngdpbase `docs/guides/configuration-developer-guide.md`, `docs/platform/deployment/kubernetes.md`

__Context:__ With three deployment targets (D-006) it is tempting to configure each through its own mechanism: `.env` on a host, `environment:` in Compose, ConfigMaps in Kubernetes. That splits one site's settings across places that differ by target.

__Decision:__ Add-on configuration is handled in configuration files. Each add-on ships its defaults, permissions and policies in its own `config/default-config.json` (the add-on merge layer). An operator overrides them in the instance's `app-custom-config.json`, which lives in the data directory and can be edited through `/admin/configuration`. All keys are under `ngdpbase.addons.<slug>.*`.

__Consequences:__

- The same files configure a bare-metal, Docker or Kubernetes site. Deployment manifests carry infrastructure only (image, replicas, volume, ingress, secrets), as ngdpbase's Kubernetes guide already advises.
- Add-on code reads settings only through the `config` passed to `register()` or `ConfigurationManager`, never from `process.env` directly.
- Where secret values (payment provider keys) live is not settled by this entry; see [D-008](#d-008-where-secret-values-live).
- Correction, 2026-10-04: this entry first said a `$VAR` reference makes `ConfigurationManager` mask a value. It does not. `$VAR` only resolves the value from the environment; masking comes solely from naming the key in `ngdpbase.config.secret-keys`.

## D-008: Where secret values live

- __Status:__ Accepted 2026-10-05 (option B)
- __Date:__ 2026-10-04
- __Links:__ [D-007](#d-007-configuration-lives-in-config-files); ngdpbase `src/managers/ConfigurationManager.ts` (`resolveEnvRef`, `getMaskedProperty`), `src/utils/auditConfigChange.ts` (`isSecretKey`), `src/utils/configEnvKeys.ts`, `docs/guides/configuration-developer-guide.md`

__Context:__ Payment providers need secret values (for example a Stripe secret key). How ngdpbase treats a secret, checked on `master` at `9b0da38`:

- __Masking:__ a key named in `ngdpbase.config.secret-keys` is masked on the Admin Configuration screen until an admin with `admin-system` reveals it, and is stripped server-side for a read-only admin. Matching is by exact key. This works whether the value is in the file or comes from the environment.
- __`$VAR` values:__ a config value of the bare form `$STRIPE_SECRET_KEY` is read from the environment; if the variable is unset, reading the key throws. `$VAR` does not mask anything by itself.
- __`ngdpbase.config.env-keys`__ declares keys owned by the environment, so the admin screen does not save edits that cannot take effect. It is a map, so an add-on can add entries without disturbing core's.
- __Gap:__ `ngdpbase.config.secret-keys` is a plain array, and the add-on merge layer replaces plain arrays wholesale. An add-on that lists its own secret keys in its `config/default-config.json` replaces core's list and unmasks core secrets (session secret, SMTP password, OIDC client secret). An operator can add keys in `app-custom-config.json` only by restating the whole list. Core currently lists one add-on key itself (`ngdpbase.addons.demo.admin-account.password`).

__Options:__

- __A. Value in the config file:__ the secret is stored in `app-custom-config.json` in the data directory and masked through `secret-keys`. One place for everything, the same on every target; the secret is then in the data directory and its backups.
- __B. Value from the environment:__ the config file holds `$VAR`, the value comes from `.env`, the Compose environment or a Kubernetes Secret, and the key is declared in `env-keys` and `secret-keys`. Keeps secrets out of the data directory and its backups; needs one more place set per target.
- Either way, the add-on's secret keys must reach `secret-keys` without replacing core's list. That needs ngdpbase to make `secret-keys` additive for add-ons (for example a map, as `env-keys` already is), or the add-on's keys added to core's list.

__Facts from the owner:__ `.env` is not in backups.

__ngdpbase guidance (2026-10-05):__ the add-on developer guide, section "Secrets", now says "A secret is an environment variable, not a literal in either JSON file." The config key holds a bare `$VAR` reference; if the variable is unset, that one key is omitted with a warning and the add-on still loads, so the add-on treats the missing key as "not configured". This is option B.

__Recommendation: B.__

- Backups of the data directory travel further (off-site copies, Velero, S3) and are kept longer than the running site; a payment key should not travel with them. `.env` is not backed up, so B keeps keys out of every backup.
- It matches how ngdpbase already treats its own secrets (session secret, OIDC client secret), and `ConfigurationManager`'s own error for an unset `$VAR` tells the operator to set it in `.env` or a Kubernetes Secret.
- One mechanism covers D-006: `.env` on bare metal, `env_file` or `environment:` in Compose, a Kubernetes Secret (SOPS-encrypted in GitOps) in a cluster. D-007 still holds: the key is declared in the add-on's config file; only its value is outside.
- Each secret key is declared in `env-keys`, so the admin screen never saves a key that cannot take effect. Rotating a key is: change the environment, restart.
- A provider whose `$VAR` is unset must not take the add-on down: catch the error at `register()`, leave that provider disabled, and report it in `status()`.
- Keep the secret count small: a Stripe restricted key with only the permissions the provider uses, separate test and live keys, and no webhook secret (D-003).
- Masking is still needed (the resolved value must not render on the admin screen), so the `secret-keys` gap ([ngdpbase#1612](https://github.com/jwilleke/ngdpbase/issues/1612), P0) is a blocker for shipping any provider with a secret. Fixed in [ngdpbase#1613](https://github.com/jwilleke/ngdpbase/pull/1613) (merged 2026-10-04, `7d119b6c`): `secret-keys` becomes a set that every layer extends. The add-on then declares its keys in its `config/default-config.json` as `"ngdpbase.config.secret-keys": { "<key>": true }` (a plain list of names also adds). Readers use `enabledEntries()` from ngdpbase `src/utils/configFiles.ts`.
- Requirements change: changing a provider key moves from an in-app action (`payment-settings`) to an operator action in the environment. `payment-settings` still covers which providers are enabled and their non-secret settings.

__Decision:__ Option B, following ngdpbase's add-on guide. A secret value (a payment provider key, for example) is an environment variable, never a literal in a JSON config file. The config file holds a bare `$VAR` reference (`"secret-key": "$STRIPE_SECRET_KEY"`); the value comes from `.env` (bare metal, Docker) or a Kubernetes Secret. If the variable is unset, ngdpbase omits that key with a warning and the add-on still loads: the provider treats it as not configured, stays off, and says so in `status()`. Secret keys are named in `ngdpbase.config.secret-keys` (an add-to set since ngdpbase#1613) so the admin screen masks them.

## D-009: Treasurer requires AAL2, like admin roles

- __Status:__ Accepted
- __Date:__ 2026-10-04
- __Links:__ requirements.md section 7 and open question 4; [#1](https://github.com/jwilleke/ngdp-accounting-addons/issues/1); ngdpbase `config/app-default-config.json` (`ngdpbase.roles.definitions`), `AuthManager.rolesAtSignIn`

__Context:__ Treasurer actions move money and expose donor data. ngdpbase lets each role set `required-aal`; `admin` and `user-admin` ship at 2. The alternative considered was letting the treasurer role work at AAL1 and asking for a fresh factor only on high-risk actions (step-up).

__Decision:__ The `treasurer` role has `required-aal: 2`, the same as ngdpbase's admin roles. The requirement is the assurance level, not a particular factor.

__Consequences:__

- A treasurer signed in below AAL2 (magic link, Google) steps down to their other roles and is offered a stronger sign-in, exactly as an admin is today.
- Any factor combination that ngdpbase rates AAL2 qualifies: a passkey today; password plus TOTP or another second factor once ngdpbase supports it (ngdpbase#421, ngdpbase#1523).
- The option of letting the treasurer work at AAL1 and stepping up only for high-risk actions is not taken.
- Confirmed by the operator 2026-10-05: D-009 decides only the role's sign-in strength.
- Not decided here: whether high-risk permissions (refund, adjust, export, receipt issue) are also put on ngdpbase's step-up list, which would ask for a recent factor (within `max-age-minutes`) even in an AAL2 session. Who ships the `treasurer` role definition is requirements.md open question 5.

__Update 2026-10-11 (operator, decided in ngdpbase):__ AAL2 is enforced only once the account can reach it. An account with no passkey enrolled keeps the `treasurer` role at AAL1, shown with the red banner until it enrolls (ngdpbase #1690; recorded in ngdpbase `docs/planning/authentication.md`, AuthManager layout). ngdpbase has no "require, never cap" option, by decision: many installs are a family or one person with no IT support, and a missing passkey must lock nobody out. So a new treasurer without a passkey acts at AAL1 until they enroll, and the banner is the pressure. `ledger-adjust` and `ledger-export` still ask for a fresh sign-in (D-022) at whatever level the account has. The add-on builds no workaround for this.

## D-010: Ledger data lives in ngdpbase's database

- __Status:__ Accepted; the "one file, never a second SQLite file" part is superseded for the MVP by [D-012](#d-012-mvp-accounting-has-its-own-database-file)
- __Date:__ 2026-10-05
- __Links:__ [#5](https://github.com/jwilleke/ngdp-accounting-addons/issues/5); requirements.md open question 7; ngdpbase `docs/managers/DatabaseManager.md`, [ngdpbase#1536](https://github.com/jwilleke/ngdpbase/issues/1536), [ngdpbase#1537](https://github.com/jwilleke/ngdpbase/issues/1537)

__Context:__ The ledger needs durable, consistent storage that survives two processes during a rolling update (D-006). ngdpbase has a `DatabaseManager`: `ngdpbase.database.provider` is `none` by default or `sqlite`; the file is `ngdpbase.database.file` (default `${FAST_STORAGE}/ngdpbase.db`); with `NGDPBASE_DATABASE_KEY` set in the environment or instance `.env` (never config) it is encrypted with SQLCipher, without it it is plain SQLite and boot warns. Callers take the connection with `engine.getManager('DatabaseManager').getHandle()`; `isEnabled()` says whether one is open. Migrations are a dated ledger in `src/providers/databaseMigrations.ts`, each run once in its own transaction. Boot refuses a schema from a newer build, a failed migration, a failed integrity check, or a database on NFS or SMB.

__Decision:__ The ledger's data lives in ngdpbase's database through `DatabaseManager`, using its handle and its migration ledger. The add-ons never open a second SQLite file and never keep ledger data in JSON files.

__Consequences:__

- A site using the accounting add-ons sets `ngdpbase.database.provider` to `sqlite` and puts `NGDPBASE_DATABASE_KEY` in `.env` (or a Kubernetes Secret). The add-on checks `isEnabled()` in `register()`; without a database it does not register its routes and says why in `status()`.
- __Migrations:__ how the ledger's tables are created is worked out in [#13](https://github.com/jwilleke/ngdp-accounting-addons/issues/13), within [D-011](#d-011-one-path-to-the-database). Core's own list (`src/providers/databaseMigrations.ts`) is not used for add-on tables. `runMigrations(db, registry, ledgerTable)` already takes its own record table, so the provider can run a second list in the same database.
- Correction, 2026-10-05: this entry first said ngdpbase needs a new mechanism. It then said the add-on could call `runMigrations` on the handle itself. That would be a second code path, ruled out by D-011.
- __Backups:__ SQLite must not be copied as a plain file while it is being written. The encrypted file-level backup and staged restore from yourPHR are not ported yet (ngdpbase#1536). Until they are, a backup of the data directory may not hold a consistent copy of the ledger. Financial data needs this before release. Tracked as [ngdpbase#1723](https://github.com/jwilleke/ngdpbase/issues/1723) (P1, 2026-10-08): `DatabaseManager` has no `backup()`, so today no database is in ngdpbase backups at all.
- __Deployment (D-006):__ a database on NFS or SMB refuses to boot, so a Kubernetes data volume on an NFS-backed storage class will not work. Install notes must say the data volume needs a local or block storage class. Two pods during a rolling update share one file through SQLite's locking, which JSON files could not do safely.
- __Encryption at rest__ comes from SQLCipher when the key is set. Like the payment keys in D-008, the database key lives only in the environment, never in config.
- __Shutdown order:__ ngdpbase may close the database before managers registered later finish; the ledger must close its statements in its own `shutdown()` (DatabaseManager.md, "Not yet").
- Nothing in core stores rows yet; the first planned user is the database audit provider (ngdpbase#1537). The ledger may be the first add-on user. __Update (operator, 2026-10-17):__ the accounting database is declared to ngdpbase (#1860) with `"encrypt": "optional"`, keeping this decision: SQLCipher when `NGDPBASE_DATABASE_KEY` is set, plain SQLite with a boot warning otherwise. `"required"` (which stops the add-on loading without the key) was offered and not chosen. PR #23.

## D-011: One path to the database

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Links:__ [D-010](#d-010-ledger-data-lives-in-ngdpbases-database), [#13](https://github.com/jwilleke/ngdp-accounting-addons/issues/13), [#14](https://github.com/jwilleke/ngdp-accounting-addons/issues/14)

__Decision:__ Database access goes through one manager-to-provider path: `DatabaseManager` → `SqliteDatabaseProvider` → a database instance. Try hard to use that same code path for everything, including migrations; never write a second implementation of what it already does (the DRY principle).

__Consequences:__

- Add-ons may have migrations. They reuse ngdpbase's migration code (`runMigrations` with its own record table) through `DatabaseManager` and `SqliteDatabaseProvider`, rather than opening files or running schema changes on their own (#13).
- Amended 2026-10-05: the first wording ("never two code paths", add-ons never call `runMigrations`) was stricter than intended. The rule is to try for the same code path and never duplicate it.
- Anything the database needs that is missing, such as add-on migrations (#13) or key changes (#14), is built on that one path in ngdpbase. It is worked out here first, then sent back as a PR.

## D-012: MVP accounting has its own database file

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Links:__ [D-010](#d-010-ledger-data-lives-in-ngdpbases-database), [D-011](#d-011-one-path-to-the-database), [#13](https://github.com/jwilleke/ngdp-accounting-addons/issues/13)

__Decision:__ For the MVP, accounting data lives in its own SQLite database file, a separate database instance opened through the same path as ngdpbase's: `DatabaseManager` → `SqliteDatabaseProvider` → the accounting database instance. It uses the same provider code, the same migration code with its own record table, and the same startup checks.

__Consequences:__

- This supersedes D-010's "never open a second SQLite file" for the MVP. Whether accounting moves into the shared `ngdpbase.db` later is open.
- `DatabaseManager` must be able to open a second, named instance for an add-on. How that works is
  #13, built here first and sent back to ngdpbase as a PR.
- Key: shared `NGDPBASE_DATABASE_KEY` for now (operator, 2026-10-05). A separate key can come later with #14.
- Open: the file's name and location (proposed: in `FAST_STORAGE`, beside `ngdpbase.db`).
- Everything else in D-010 still applies: SQLCipher encryption from an environment key, no NFS or SMB, consistent backups needed before release (ngdpbase#1536), and closing statements on shutdown.
- A separate file keeps the accounting schema and backups apart from core's, and lets the add-on be removed without touching `ngdpbase.db`.

## D-013: Docs live here until v1.0.0, in their target formats

- __Status:__ Accepted
- __Date:__ 2026-10-05

__Decision:__ Until this project's v1.0.0 semver release, all documentation stays in this repository, including documentation for anything that will move into ngdpbase. Each document is written in the format it will have at its destination.

__Consequences:__

- Documents bound for ngdpbase follow ngdpbase's conventions. A manager page goes under `docs/managers/<Name>.md` with frontmatter `name`, `description`, `dateModified`, `category`, `code`, as `DatabaseManager.md` has. A guide goes under `docs/guides/` with `name`, `description`, `dateModified`, `category`, `relatedModules`. Each guide ends with "How you know you are done" and "Known gaps" sections.
- Moving them to ngdpbase at v1.0.0 is then a copy, not a rewrite.
- Documents that belong to this repository (requirements, decisions, the add-on's own README) keep this repository's format.
- Clarified 2026-10-05 by the operator. Nothing describing an incomplete feature goes onto ngdpbase's `master`: no developer docs, and above all no end-user wiki pages (required pages). Docs for work in progress live on this repository's `main`. A PR to ngdpbase documents only what that PR itself completes; for #13 that is the `DatabaseManager` change, never the accounting add-on.

## D-014: Every action is a permission with one audited door; no money moves without a record

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Links:__ [#5](https://github.com/jwilleke/ngdp-accounting-addons/issues/5); ngdpbase `docs/security-posture.md` (P1, P2), `docs/audit-posture.md`, `docs/guides/security-developer-guide.md`, `docs/guides/audit-developer-guide.md`

__Decision:__ The add-ons follow ngdpbase's security and audit posture. Every action is a permission, performed through exactly one door (the manager method for it), and that door records an audit event. No money moves without a record: every financial write (post, void, refund, transfer, period lock, export) uses `on-failure: refuse`, so the record is written first and the action does not happen if it cannot be. Details are worked out during implementation.

__Consequences:__

- A role is only a collection of permissions (actions). Only permissions decide access and which audit event is recorded; a role name never does (operator, 2026-10-05; ngdpbase P2).
- Routes ask `requirePermission` for the permission the action is; no role names in code. The context is forwarded, never rebuilt (P1, P2).
- Event names are `{target}-{action}`, declared in `ngdpbase.audit.events` and emitted through `recordAuditEvent` at the manager door.
- __Core gap, found 2026-10-05:__ an add-on cannot have audit events today. `AuditManager` (`src/managers/AuditManager.ts`, around line 277) puts the site into maintenance mode when an enabled event is not in core's built-in list (`src/utils/auditEventNames.ts`). An add-on that declares its own event in its config would therefore stop the site. ngdpbase needs a way for an add-on to register its event names; this blocks the MVP. Tracked in [#16](https://github.com/jwilleke/ngdp-accounting-addons/issues/16); proposed fix: accept an event named after a declared permission.
- Update 2026-10-05: superseded by [ngdpbase#1638](https://github.com/jwilleke/ngdpbase/issues/1638) (P0): every audit event becomes a permission, and the permission's entry in `ngdpbase.permissions.definitions` carries `audit` (`enabled`, `on-failure`) and `step-up`. The add-ons get their audit events by declaring permissions in their `config/default-config.json`. #16 is on hold until #1638 lands; ngdpbase builds it.
- Update 2026-10-06: slice 1 is [ngdpbase#1653](https://github.com/jwilleke/ngdpbase/pull/1653) (open). An add-on declares its event under `ngdpbase.audit.events` in its `config/default-config.json` and emits it with `addonAuditEventName('<name>')` and a string literal.
- Confirmed 2026-10-06 (answer on ngdpbase#1638, test `7838a068` on #1653): an add-on event declared `on-failure: refuse` gets core's guarantee: refused if the sink cannot flush, flushed before the action continues, and `recordAuditEvent` throws when the write fails. "No money moves without a record" holds.
- Update 2026-10-07 (ngdpbase [#1681](https://github.com/jwilleke/ngdpbase/pull/1681) and [#1672](https://github.com/jwilleke/ngdpbase/pull/1672), both merged): every audit event is now a permission entry in `ngdpbase.permissions.definitions` with an `audit` block, and `ngdpbase.audit.events` ships empty. An event that is a pure record, not an action anyone is granted, is a permission entry with `"grantable": false`. The add-ons follow that house pattern (D-020). An external add-on's declarations are checked against its emitters with `node dist/scripts/audit-coverage.js --check --addon <dir>` (`lint:audit --addon`), so this repository can run the same check as ngdpbase.

## D-015: Sign-in strength belongs to permissions and is the operator's choice

- __Status:__ Partly superseded by [D-022](#d-022-sign-in-strength-stays-on-roles-money-permissions-use-step-up) on 2026-10-08: the per-permission `required-aal` is not built
- __Date:__ 2026-10-05
- __Links:__ [#17](https://github.com/jwilleke/ngdp-accounting-addons/issues/17), [D-009](#d-009-treasurer-requires-aal2-like-admin-roles), [D-014](#d-014-every-action-is-a-permission-with-one-audited-door-no-money-moves-without-a-record), [#1](https://github.com/jwilleke/ngdp-accounting-addons/issues/1) (item 3)

__Context:__ ngdpbase sets `required-aal` only on roles. Access comes from permissions, and a role is only a collection of permissions (D-014), so any other role granted the same permissions bypasses the treasurer role's AAL2 (D-009). Sites also differ: a family on a closed network, a two-person condo association or a partnership may want no extra sign-in strength, while a club with a rotating treasurer may want it on every money action.

__Decision:__ Sign-in strength can be set per permission (`required-aal` on the permission's entry in `ngdpbase.permissions.definitions`), checked at the permission's one door whichever role granted it. Every level is the operator's choice in configuration. The add-on ships secure defaults: `required-aal: 2` on money-moving permissions (`ledger-adjust`, `payment-refund`, `ledger-export`, `receipt-issue`).

__Consequences:__

- Needs an ngdpbase change (#17). Update 2026-10-05: it becomes a `required-aal` field on the permission entry that [ngdpbase#1638](https://github.com/jwilleke/ngdpbase/issues/1638) introduces; the shape was requested as a comment on #1638, not a PR. #17 is on hold.
- Shipped levels follow ngdpbase's existing rule for roles: a shipped or add-on level that no enabled sign-in method can reach is lowered, so the smallest sites keep working; a level the operator set that cannot be reached refuses to boot with the reason.
- Changes are `config-change` audit events and belong in the security posture view.
- D-009 stays: roles keep `required-aal`, and a permission's level is a floor.
- Future, not decided: instance profiles for regulated settings (for example HIPAA, SOX, personal health records) that ship different default levels. To be reconciled with ngdpbase security-posture.md D7, which removed `ngdpbase.security.profile`.

## D-016: One repository, a base accounting add-on, and optional module add-ons

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Links:__ [#15](https://github.com/jwilleke/ngdp-accounting-addons/issues/15), [#13](https://github.com/jwilleke/ngdp-accounting-addons/issues/13), [#18](https://github.com/jwilleke/ngdp-accounting-addons/issues/18); requirements.md section 3

__Context:__ Organizations differ: a restaurant needs no dues or donations; a club needs both. ngdpbase switches features on and off per add-on: an add-on's `config/default-config.json` (permissions, policies, audit events) is merged only while that add-on is enabled, and its seed pages come with it. Module flags inside one add-on would leave every module's permissions and audit events present on every site.

__Decision:__ This repository holds all accounting for ngdpbase, as several add-ons. `accounting` is the required base: funds, the ledger, audit, the monthly summary and CSV export, the hand-off from `PaymentManager` and its providers (D-017), and the accounting database (D-012). Each optional feature is its own add-on that depends on `accounting`: `accounting-dues`, `accounting-donations`, `accounting-events`, `accounting-loyalty` (#18), and later others such as `accounting-reimbursements` and `accounting-handover`. The MVP is the `accounting` add-on alone.

__Consequences:__

- A site enables only what it needs: a restaurant enables `accounting` (and perhaps `accounting-loyalty`); a club adds dues, donations and events.
- __Revised (operator, 2026-10-20):__ a module add-on does __not__ use the accounting database. It calls the `accounting` add-on's managers instead (for example `LedgerManager.registerLineDetails` for a gift's details). The next point is superseded.
- `accounting` owns the one accounting database file. A module add-on runs its own migration list in that same file, with its own record table, which `runMigrations` already supports. #13 must let an add-on that depends on `accounting` use its database.
- Add-on ids are hard to rename (ngdpbase `docs/platform/addon-identity-contract.md`). Taking `accounting` means this repository is ngdpbase's accounting; what happens to [ngdpbase#486](https://github.com/jwilleke/ngdpbase/issues/486) (a double-entry accounting add-on) is requirements.md open question 1.
- Payments live in `accounting` itself (D-017), so every site that enables accounting can take money.

## D-017: PaymentManager lives in the accounting add-on

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Supersedes:__ [D-005](#d-005-paymentmanager-lives-in-ngdpbase-core)
- __Links:__ [D-004](#d-004-paymentmanager-with-configurable-providers), [D-016](#d-016-one-repository-a-base-accounting-add-on-and-optional-module-add-ons), [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3)

__Decision:__ `PaymentManager`, `BasePaymentProvider` and the payment providers live in the base `accounting` add-on, registered with `engine.registerManager`, not in ngdpbase core. Providers are configured like `ngdpbase.auth.factors`: a list of provider entries under `ngdpbase.addons.accounting.paymentproviders`, each with its identifier, `enabled`, and its own settings.

```json
"ngdpbase.addons.accounting.paymentproviders": [
  { "id": "manual", "enabled": true },
  { "id": "stripe", "enabled": false, "secret-key": "$STRIPE_SECRET_KEY" }
]
```

__Consequences:__

- A site takes payments by enabling `accounting`; other ngdpbase add-ons that want to take money depend on `accounting`.
- No ngdpbase core change for payments; [ngdpbase#1614](https://github.com/jwilleke/ngdpbase/issues/1614) is no longer needed.
- Merging: ngdpbase merges a list of objects entry by entry only when the entries share `id` or `authproviderid` (`IDENTITY_FIELDS`, `src/utils/configFiles.ts`). The sketch uses `id`, which works today. A `paymentproviderid` field, matching `authproviderid`, would need that one-line core change; to be decided when building.
- D-003 (fetch outcomes, no webhooks), D-004 (providers declare capabilities; `provider` plus `confirmationNumber` unique) and D-008 (where secret values live) still apply.
- The manager's registered name (`PaymentManager` or an accounting-specific name) is decided when building, to avoid a clash if ngdpbase ever adds one.

## D-018: Use published standards: schema.org and UN/CEFACT payment means

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Links:__ [#5](https://github.com/jwilleke/ngdp-accounting-addons/issues/5); requirements.md sections 1a and 4; [schema.org Invoice](https://schema.org/Invoice), [schema.org PaymentMethod](https://schema.org/PaymentMethod), [UNCL 4461](https://edifactory.de/edifact/directory/D00A/data-element/4461)

__Decision:__ Where a published standard names a thing, use its name and codes instead of inventing our own. For payments: field names from schema.org (`paymentMethod`, `confirmationNumber`, `paymentMethodId`, `provider`, `paymentStatus`) and `paymentMethod` values from the UN/CEFACT payment means code list (UNCL 4461), which schema.org recommends.

__Consequences:__

- The ledger transaction's `method`, `externalId` and `reference` fields are renamed `paymentMethod`, `confirmationNumber` and `paymentMethodId`. `provider` plus `confirmationNumber` is unique.
- `paymentMethod` stores the code (for example `10` in cash, `20` cheque, `48` bank card) with a readable label. Codes confirmed in the EDIFACT D00A version: 1, 10, 20, 30, 31, 42, 48, 49, 97, ZZZ. Newer codes used in e-invoicing (54 credit card, 55 debit card, and others) are checked against the current list before use.
- Exports to QuickBooks and Wave map the codes to their own payment-method names.
- The standards in use are listed in requirements.md section 1a; add to that list rather than restating it.

## D-019: Apache License 2.0, the same as ngdpbase

- __Status:__ Accepted
- __Date:__ 2026-10-05

__Decision:__ This repository and every add-on in it use the Apache License 2.0, the same licence as ngdpbase's `LICENSE` file and the one `npm run create:addon --repo` generates.

__Consequences:__

- `LICENSE` at the repository root is the Apache 2.0 text, copied from ngdpbase.
- Each add-on's `package.json`, when written, says `"license": "Apache-2.0"`.
- ngdpbase's `package.json` said `"license": "ISC"`, contradicting its `LICENSE`; fixed to `Apache-2.0` in ngdpbase `b795ead2` (2026-10-05).

## D-020: Follow ngdpbase's guides where we can

- __Status:__ Accepted
- __Date:__ 2026-10-05
- __Links:__ ngdpbase `docs/guides/` (add-ons, security, audit, configuration, managers), `docs/security-posture.md`, `docs/audit-posture.md`

__Decision:__ Where ngdpbase's developer guides give a direction, these add-ons follow it, unless there is a stated reason not to. A departure is recorded here as its own decision, with the reason.

__Consequences:__

- Before designing something, read the relevant ngdpbase guide on `master` (D-008 is the first decision settled this way).
- Where a guide is silent or cannot serve an accounting need (for example add-on audit events, #16, or per-permission sign-in strength, #17), the gap is worked out here and offered back to ngdpbase as a PR, not worked around.

## D-021: MVP roles and report pages: treasurer only, reports use page audience

- __Status:__ Accepted
- __Date:__ 2026-10-06
- __Links:__ [D-009](#d-009-treasurer-requires-aal2-like-admin-roles), [D-014](#d-014-every-action-is-a-permission-with-one-audited-door-no-money-moves-without-a-record), [D-020](#d-020-follow-ngdpbases-guides-where-we-can), requirements.md open question 5; ngdpbase `docs/architecture/Access-Control.md` (page-level `audience`), [ngdpbase#1507](https://github.com/jwilleke/ngdpbase/issues/1507)

__Decision:__

- The `accounting` add-on ships one role, `treasurer`, with `required-aal: 2`, in its `config/default-config.json` (`ngdpbase.roles.definitions` merges per entry). No `board` role yet. This settles requirements.md open question 5: the add-on ships the role, and the operator can change or remove it.
- Reports the add-on writes are pages whose front matter `audience: [...]` names who may read them (roles or usernames). ngdpbase checks a page's `audience` as its own allow-list, so the board reads the monthly report without a role of its own.
- No vault for report pages yet.

__Consequences:__

- A shipped role level is lowered to what the site can reach if no sign-in method reaches AAL2, and ngdpbase marks sign-in degraded with the fix named; an operator-set level that cannot be reached refuses to start (D-015).
- Departure from ngdpbase's add-on guide (D-020): the guide says pages an add-on generates go in its own category and vault. Not for the MVP, because the operator does not want vaults yet and an add-on cannot yet declare its own system category (ngdpbase#1507). Revisit when #1507 lands.
- A `member` role, if needed, comes with `accounting-dues`.

## D-022: Sign-in strength stays on roles; money permissions use step-up

- __Status:__ Accepted
- __Date:__ 2026-10-08
- __Supersedes:__ the per-permission `required-aal` in [D-015](#d-015-sign-in-strength-belongs-to-permissions-and-is-the-operators-choice)
- __Links:__ [#17](https://github.com/jwilleke/ngdp-accounting-addons/issues/17) (closed, not planned); ngdpbase [#1638](https://github.com/jwilleke/ngdpbase/issues/1638) and [#1657](https://github.com/jwilleke/ngdpbase/pull/1657)

__Context:__ D-015 wanted a minimum sign-in strength on each permission, so that granting a money permission to some other role could not bypass the treasurer role's AAL2. ngdpbase's permission entries now carry `audit` and `step-up`, but not `required-aal`.

__Decision:__ Do not build per-permission sign-in strength. Sign-in strength stays where ngdpbase puts it, on roles: the `treasurer` role ships at `required-aal: 2` (D-021). The add-on's money permissions carry `"step-up": true`, so each money action asks for a fresh sign-in within `ngdpbase.auth.step-up.max-age-minutes` at the strength the person's roles require.

__Reason (operator):__ granting a money permission to another role is an operator's configuration change, and every change saved through the admin screens is recorded as a `config-change` audit event. The gap is visible and accountable, so it does not need a new mechanism.

__Consequences:__

- D-015's intent, money actions protected by default and the operator's choice, is kept through the role's AAL2 and step-up on the money permissions.
- #17 is closed as not planned.

__Update (2026-10-18):__ step-up is off for accounting's money permissions for now; see [D-030](#d-030-step-up-off-for-accountings-money-actions-for-now).

## D-023: Categories follow the Unified Chart of Accounts (UCOA)

- __Status:__ Accepted
- __Date:__ 2026-10-08
- __Links:__ [ledger design](ledger-design.md), open question 2; [D-018](#d-018-use-published-standards-schemaorg-and-uncefact-payment-means)

__Decision:__ Income and expense categories follow the Unified Chart of Accounts (UCOA) as the overall model: each category is a UCOA account code with a readable label. Code sets for particular kinds of organization, such as nonprofit account codes, fit into that model and are added later.

__Consequences:__

- A ledger entry's `category` holds a UCOA account code, kept in the site's configuration with its label, not in code.
- The specific default code set the add-on ships is decided separately: [D-034](#d-034-a-generic-starter-chart-with-account-types).
- UCOA is added to the standards list in requirements.md section 1a.

## D-024: Treasurer screens are forms of an improved ngdpbase forms add-on

- __Status:__ Accepted
- __Date:__ 2026-10-10
- __Links:__ [#15](https://github.com/jwilleke/ngdp-accounting-addons/issues/15); ngdpbase [#1749](https://github.com/jwilleke/ngdpbase/pull/1749); [D-021](#d-021-mvp-roles-and-report-pages-treasurer-only-reports-use-page-audience)

__Context:__ The ledger had only a JSON API. The treasurer's input screens could be hand-written server pages in this add-on, or forms of ngdpbase's forms add-on. The forms add-on as shipped could not carry them: no choices from a manager, no money field, anyone could submit, a refused submission stayed on disk, and its admin pages could not post.

__Decision (operator):__ Use the forms add-on and improve it in ngdpbase, for every add-on rather than for accounting alone. The treasurer's input screens are forms on locked pages this add-on ships.

- Dropdowns get their choices from `LedgerManager.toFormOptions(list=...)`, which ngdpbase calls with the viewer's context, the same safe convention as the Marquee plugin's `fetch=`.
- Who may submit is decided by the page the form is on: `audience` (who sees it), `access: { form-submit: [...] }` (who may submit) and `author-lock: true` (who may change those). __Update 2026-10-11:__ ngdpbase dropped page-decided submit before release (5abcb14e, one code path). Submitting is the site-wide `form-submit` permission, asked through `ApiContext` like every add-on route. The treasurer pages keep `audience` and `author-lock`. The `access: form-submit` front matter is removed, and the add-on's treasurer policy grants `form-submit`. The ledger still asks its own permission on every write, so a page rule was never the guard on money.
- The handler posts through `LedgerManager`, which still asks its own permission and writes the audit record. The page decides who may use the form; the ledger decides what they may change.
- The entry form keeps no submission file (`"store": false`): the ledger entry is the record.

__Not chosen:__ hand-written pages (quicker for the MVP, but no reuse); a treasurer vault (a private area belongs to one person and cannot be shared yet, which does not fit a role that changes hands). A vault may suit the treasurer's own notes and a handover later (#9).

__Consequences:__

- The MVP's input screens depend on ngdpbase #1749 merging and shipping in a release.
- Overview screens (balances, the entry list) are display, not forms, and are built separately.
- Until ngdpbase lets an add-on ship form definitions, this add-on writes its own through `FormsDataManager.saveDefinition` on first start.
- The default category list is still open (D-023); a site sets `ngdpbase.addons.accounting.categories` meanwhile.

## D-025: Accounting records follow ngdpbase's access-control model

- __Status:__ Accepted
- __Date:__ 2026-10-15
- __Links:__ ngdpbase [#1431](https://github.com/jwilleke/ngdpbase/issues/1431) (decision log [comment](https://github.com/jwilleke/ngdpbase/issues/1431#issuecomment-6193262203)); [D-014](#d-014-every-action-is-a-permission-with-one-audited-door-no-money-moves-without-a-record)

__Context:__ ngdpbase is giving add-on records the same access control as pages (an XACML-style model: the enforcement point asks, the decision point decides, the information point supplies the facts). The operator asked for accounting's view, then decided (2026-10-15).

__Decision (operator, in ngdpbase):__

- __Custodian, not owner.__ `LedgerManager` stores and guards the ledger: it is the enforcement point for its record types and asks the decision point one question per action. It never decides. Funds and entries belong to the organization, so they have no personal owner; policy alone decides.
- __Actions are permissions.__ Our target-action names stay (`ledger-record`, `ledger-adjust`, `ledger-export`, `fund-manage`, ...). The add-on declares everything with existing keys in its `config/default-config.json`: its record types and their attributes under `ngdpbase.access.resource-types` (for example `createdBy`, `amount`, `party`; `owner` is a reserved, optional attribute), its permissions, and its policies. No new keys.
- __Answers are allow or deny, never empty.__ An allow can carry a structured filter (data, never SQL; rows only) that the ledger adds to its queries. A deny carries a reason. A request the decision point cannot decide throws and fails closed. A refused list is a refusal, not zero rows.
- __Rules that compare the person with the record__ (segregation of duties, amount thresholds) live in policy or configuration, never in add-on code; thresholds are configuration values.
- __Obligations__ (for example, notify the treasurers) are defined in policy. Everything is audited, allow and deny.
- __The period lock stays ledger validation__ (#19): nobody writes into a closed period. Policy only says who may close or reopen one.

__How the decision point is reached (operator, 2026-10-15):__ `LedgerManager` calls ngdpbase's `PolicyDecisionPoint` directly (`engine.getManager('PolicyDecisionPoint').decide(subject, { action, resource: { type, id }, attributes })`) and gets the answer; routes stay out of it. The refusal it then sends (401 or 403, and for a step-up the way to sign in again, with its audit record) must come from core with the answer, not be rebuilt in the ledger: one code path. Operator, same day: the manager uses the PDP, not `requirePermission`; the refusal comes from a shared core helper (requested from ngdpbase), and the ledger switches from `requirePermission` to `decide()` once that helper ships.

__Not decided yet (ngdpbase):__ the order of the core work.

__Consequences:__

- No accounting code changes until ngdpbase ships the record-level API. Then `LedgerManager` asks it per action (today it asks `requirePermission` per action, which stays the same shape), declares `ledger-entry` and `fund` under `ngdpbase.access.resource-types`, and applies the returned filter in its list and aggregate queries (balances, summary and CSV share one query).
- Segregation of duties for reimbursements (#8) and a second approver above an amount become policy, not code.

## D-026: Ledger tables stay the Ledger plugin's own for now

- __Status:__ Accepted
- __Date:__ 2026-10-16
- __Links:__ ngdpbase [#1813](https://github.com/jwilleke/ngdpbase/issues/1813); [D-025](#d-025-accounting-records-follow-ngdpbases-access-control-model)

__Context:__ The operator's direction in ngdpbase is that add-ons supply records and a shared renderer draws tables. Two ways were looked at for the ledger:

- the shared `[{DataFeed}]` plugin (feeds add-on). Today it only shows records the feeds add-on stored from outside URLs. It has no live source from another add-on, no per-viewer rows, no money format and no totals row;
- `[{Ledger}]` writing wiki-table markup (`|| head ||`, `| cell |`) from LedgerManager's rows, with a money plugin in each amount cell. ngdpbase has no money plugin yet.

__Decision (operator, 2026-10-16):__ leave it for now. `[{Ledger}]` keeps drawing its tables as it does (HTML through PluginManager's formatters). Whatever renderer comes later, `LedgerManager` owns the data and filters it to what each viewer may see (D-025); a renderer only displays.

__Facts checked on the way:__ ngdpbase's page cache keys a rendered page by the viewer's username and roles (plus preferences and a 5-minute time slot), and the ledger's bump re-renders it. So each person gets their own cached copy; nobody sees another viewer's table.

## D-027: Ledger (#5) and reports (#7) are done; their leftovers move to the issues that need them

- __Status:__ Accepted
- __Date:__ 2026-10-17
- __Links:__ [#5](https://github.com/jwilleke/ngdp-accounting-addons/issues/5), [#7](https://github.com/jwilleke/ngdp-accounting-addons/issues/7), [#20](https://github.com/jwilleke/ngdp-accounting-addons/issues/20), [#21](https://github.com/jwilleke/ngdp-accounting-addons/issues/21); ngdpbase [#1723](https://github.com/jwilleke/ngdpbase/issues/1723)

__Context:__ The shared ledger (#5) and the treasurer reports (#7) meet their acceptance criteria, but each issue's original scope also named pieces that only make sense with modules not built yet.

__Decision (operator):__ both go to In review. Their leftovers move:

- __From #5:__ pending entries and a deductible amount to donations (#4) and payments (#3); attachments to reimbursements (#8); the `accounting-settings` permission when a setting first needs protecting; the month lock is #19. Backup of the ledger's database depends on ngdpbase#1723 (core backups do not cover add-on databases yet).
- __From #7:__ QuickBooks and Wave formats to their own issue (#20); dues and donations reports to #2 and #4; large or unusual items and printable / PDF / wiki-page output __later__, after the MVP (#21, deferred).

## D-028: Receipts for money in, statements for what donors get, payments only for money out

- __Status:__ Accepted
- __Date:__ 2026-10-18
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3), [#4](https://github.com/jwilleke/ngdp-accounting-addons/issues/4), [D-004](#d-004-paymentmanager-with-configurable-providers), [D-017](#d-017-paymentmanager-lives-in-the-accounting-add-on), [D-018](#d-018-use-published-standards-schemaorg-and-uncefact-payment-means)

__Context:__ The plan called money coming in "payments" (the payer's view), and also used "receipt" for a donor's tax letter. The treasurer's books call money coming in receipts.

__Decision (operator):__ one word per thing.

- __Receipts:__ money coming in, of any kind (cash, check, card, ACH), and refunds of it. "Payment" is never used for incoming money. The manager is `ReceiptManager` (was `PaymentManager` in D-004 and D-017); its providers are receipt providers (manual, Stripe); the screen is "Record a Receipt"; the permissions are `receipt-refund` and `receipt-settings` (were `payment-refund` and `payment-settings`). The provider configuration key is `ngdpbase.addons.accounting.receiptproviders`.
- __Income:__ what money is for, the 4xxx categories and their totals in reports (unchanged). Each receipt is classified into an income category.
- __Statements:__ what a donor or member receives (giving statements, invoices). The permission is `statement-issue` (was `receipt-issue`).
- __Payments:__ only money going out, if that is ever built (accounts payable stays a non-goal).

Unchanged: "payment means" (UN/CEFACT UNCL 4461, D-018) names how money moves, in either direction; it stays in code (`paymentMethod`). Screens say "Method".

## D-029: How receipts are recorded, numbered, corrected and refunded; every money movement has a reason

- __Status:__ Accepted
- __Date:__ 2026-10-18
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3), [D-004](#d-004-paymentmanager-with-configurable-providers), [D-028](#d-028-receipts-for-money-in-statements-for-what-donors-get-payments-only-for-money-out)

__Decision (operator, 2026-10-18):__

1. __Receipt numbers.__ Every receipt recorded by hand gets a number from the system, `R-0001`, `R-0002`, one sequence per site. It is the manual provider's `confirmationNumber`, so the same receipt cannot post twice, and the treasurer can write it on a paper slip. A check's own number is still recorded, as the method reference (`paymentMethodId`). Numbers are never reused.
2. __All money in is a receipt.__ "Record a Receipt" is the only way to record incoming money by hand, so every amount in has a receipt number, a method and a payer (bank interest is a receipt from the bank). The ledger refuses a plain "in" entry that does not come through receipts. "Record an Entry" keeps money out and corrections.
3. __Mistakes and refunds are different.__ A receipt entered wrongly is voided with a reason (`ledger-adjust`, step-up) and recorded again; the new one gets a new number, and the voided one stays visible. A refund is money actually returned: `receipt-refund` (step-up) posts an out entry linked to the original, which stays posted; partial refunds are allowed.
4. __Every money movement has a reason.__ A receipt, a money-out entry, a refund and a transfer each need a reason (free text for now); voids already do. The reason is the plain-words why ("March dues, Ann Lee"); the category stays the bookkeeping class. Entries recorded before this keep their history as they are.

__Defaults (operator, 2026-10-18):__ the payer is a name for now (a member link comes with dues); the "what it pays for" link is optional until dues, donations and events exist; existing "in" entries get no receipt numbers after the fact. Deposit batches come later.

## D-030: Step-up off for accounting's money actions, for now

- __Status:__ Accepted
- __Date:__ 2026-10-18
- __Links:__ [D-022](#d-022-sign-in-strength-stays-on-roles-money-permissions-use-step-up), [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3)

__Context:__ Testing a refund on the dev site, the treasurer filled in the form, was sent to sign in again (step-up), came back, and found the form empty: everything had to be typed again. The forms add-on does not keep a submission across the fresh sign-in, and that fix is not being built now.

__Decision (operator, 2026-10-18, relayed by the ngdpbase session):__ add-ons turn step-up off for now. Accounting removes `"step-up": true` from `ledger-adjust` (voids, transfers), `receipt-refund` and `ledger-export`. Their audit rules stay as they are (`on-failure: refuse`). ngdpbase core's own step-up window goes from 15 to 60 minutes; its own step-up permissions are unchanged.

__What still protects money actions:__ the treasurer role needs a passkey sign-in (`required-aal: 2`, D-009); every action asks the decision point; every write is audited, and refused if its record cannot be written.

__Turning it back on:__ when the form keeps its fields across a fresh sign-in, add `"step-up": true` back to those three entries in `addons/accounting/config/default-config.json` and restore the sentences in the docs and pages.

## D-031: Bank accounts, Cash on Hand and deposits

- __Status:__ Accepted
- __Date:__ 2026-10-18
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3), [D-008](#d-008-where-secret-values-live), [D-025](#d-025-accounting-records-follow-ngdpbases-access-control-model), [D-029](#d-029-how-receipts-are-recorded-numbered-corrected-and-refunded-every-money-movement-has-a-reason)

__Context:__ Cash and checks are taken to the bank in batches, and the bank statement shows one line per deposit. To match that line, the books need to know where money sits, not only what it is for.

__Decision (operator, 2026-10-18):__

- __Two labels on every entry.__ A __fund__ says what the money is for; an __account__ says where it sits. One bank account holds money for several funds. All funds added up always equals all accounts added up. A fund does not care where its money is.
- __Accounts are configuration__, under `ngdpbase.addons.accounting.accounts`, keyed by id: name, kind (`bank` or `cash`), default bank account, active, routing number, account number. The defaults ship one bank account, `checking` ("Checking"), with no numbers. __Cash on Hand__ is built in and needs no configuration.
- __Bank accounts carry their account and routing numbers.__ They are the organization's own accounts, not a payer's. The account number is a secret: a `$VAR` reference in the config, named in `ngdpbase.config.secret-keys` (D-008). Holders of `fund-manage` (treasurer; admin) see the full number; everyone else sees the last four digits. It never goes into logs, audit events, exports or wiki pages. Payers' card and bank numbers are still never stored.
- __Opening balance and date__ of each account are set by the treasurer in the UI (`fund-manage`), audited, the same as a fund's.
- __Where a receipt lands:__ the method picks the starting account, and the treasurer can change it. Cash, check and card (event reader) go to Cash on Hand; ACH, Zelle and bank transfer go to the default bank account. Money-out entries pick an account, defaulting to the default bank account. Moving money between funds leaves the account unchanged.
- __A deposit is a record plus ledger entries.__ It lists its receipts and posts paired entries per fund: out of Cash on Hand, into the bank account. Each fund nets to zero, so fund balances never change; account balances are right on any date. Undoing a deposit voids its entries (`ledger-adjust`, with a reason) and its receipts return to Cash on Hand. Nothing posted changes.
- __What goes into a deposit:__ receipts in Cash on Hand, not voided, not already deposited; a receipt is in at most one deposit. A partly refunded receipt goes in at its full amount. Whole receipts only for now. The treasurer enters the deposit slip total; the deposit is refused unless it matches.
- __Deposit numbers__ are a counter shown as `D-` plus at least four digits, with no upper limit (`D-0001`, `D-10000`, `D-30000000`): one past the highest ever used, voided included. Receipt numbers work the same way and share the helper.
- __Permissions:__ none new. Making a deposit is `ledger-record`; undoing one is `ledger-adjust`; accounts and their opening balances are `fund-manage`.
- __Existing entries__ get `checking` when the database is upgraded; earlier receipts count as already in the bank. An account removed from config while entries still point at it is shown as with "(no longer configured)" after its name, and the add-on warns at startup.
- __Screens:__ "Make a Deposit"; a Deposits page that opens each deposit to its receipts; undo on the deposit; a balance per account beside the balance per fund on Balances and the board report; the receipt list shows each receipt's deposit number.

__Build order:__ two PRs. Accounts first, then deposits.

## D-032: Cleared deposits and bounced checks

- __Status:__ Accepted
- __Date:__ 2026-10-19
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3), [D-031](#d-031-bank-accounts-cash-on-hand-and-deposits), [D-033](#d-033-receipts-and-refunds-are-made-of-lines), [D-034](#d-034-a-generic-starter-chart-with-account-types)

__Context:__ A check is received, deposited, and days later cleared by the bank, or returned unpaid. The books keep cash-basis records per fund and per account.

__Decision (operator, 2026-10-19):__

- __A check counts in the balances as soon as it is recorded.__ There is no "pending" status that changes balances; one may come with Stripe's online ACH, which can fail days later.
- __Clear by deposit.__ The bank statement shows one credit per deposit, so the treasurer marks a deposit cleared with the date the bank shows, and its receipts count as cleared. ACH, Zelle and bank transfers land straight in the bank and count as cleared when recorded. Clearing moves no money (`ledger-record`). A wrong mark can be taken off with a reason; a deposit with a bounced check stays cleared. The Deposits page shows each deposit's cleared date and a "Not yet cleared" list (deposits in transit).
- __Bounce by check.__ The original receipt never changes. Marking a deposited check bounced (`ledger-adjust`) posts:
  1. a __returned check__ entry: the full amount, out of the bank account it was deposited into, in the receipt's own fund and category;
  2. the bank's fee, if entered, as an expense in the site's bank-charges category, from the same account and fund.
- __What the payer owes__ (check + fee + an optional penalty) is recorded on the bounce. A Bounced Checks page shows owed, repaid and still owed. Once invoices exist (#2), a bounce creates the invoice for that total. Until then, "Repay a Bounced Check" records one receipt whose lines fill in order: the check amount in the original category, the fee against bank charges, the penalty as other income; anything short stays owed.
- Only a deposited check can bounce; its deposit cannot then be undone. A new check from the payer is a new receipt. "Chargeback" is kept for card disputes, when Stripe comes.
- __Configuration:__ `ngdpbase.addons.accounting.bounced-check-penalty` (minor units, shipped as 0), `.bank-charges-category` and `.other-income-category` (category codes, defaulting to the starter chart's). The bounce form is off, and says why, until both categories exist.

## D-033: Receipts and refunds are made of lines

- __Status:__ Accepted
- __Date:__ 2026-10-19
- __Links:__ [#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3), [D-029](#d-029-how-receipts-are-recorded-numbered-corrected-and-refunded-every-money-movement-has-a-reason)

__Decision (operator, 2026-10-19):__ __invoices and receipts are always made of lines__: one document, one number, one or more lines, each with its own amount, fund and category, even when there is only one. __Statements show one line per transaction.__ This is the standard header-and-lines shape (QuickBooks' sales receipt with split lines).

- __A receipt is one record, shown once__ at its total everywhere a receipt is listed: the payer's slip, the receipt list, its deposit, the payer's statement, and the Ledger page (with its lines under it). Each line counts separately only in fund and category totals.
- One payment lands in one account. A deposit takes the whole receipt; a void voids every line; a bounce returns every line.
- Existing receipts become receipts with one line, keeping their numbers.
- __Refunds have lines too:__ each refund line names a line of the receipt and an amount, never more than is left on that line, and is money out in that line's fund and category.
- __Refunds are numbered RF-0001 onwards__, by the same rule as R- and D- (only the digits count, at least four, no upper limit), given when saved and never reused: "Refund RF-0001 of R-0012".
- The Ledger page's list shows each money movement once with its own number: R-, RF-, D- (no In or Out amount there, since a deposit changes no fund), and money paid out (unnumbered for now).

## D-034: A generic starter chart with account types

- __Status:__ Accepted
- __Date:__ 2026-10-19
- __Links:__ [D-023](#d-023-categories-follow-the-unified-chart-of-accounts-ucoa), [#20](https://github.com/jwilleke/ngdp-accounting-addons/issues/20)

__Context:__ No law fixes a U.S. chart of accounts. UCOA has no official, maintained list; the FASB GAAP Financial Reporting Taxonomy is a reporting vocabulary without account numbers. Accountants use the usual numbering and the starter chart of their software; QuickBooks fixes account types, not numbers. Accounting here is not only for nonprofits.

__Decision (operator, 2026-10-19):__ the add-on ships a generic starter chart that __follows QuickBooks' chart, as most accountants know it__. Every category has QuickBooks' __type__ (`income`, `other-income`, `cost-of-goods`, `expense`, `other-expense`) and its __detail type__, and uses the detail type's name wherever one fits, so an accountant recognises it and the export (#20) maps one to one. Numbering: 4000s income, 5000s cost of goods, 6000s–7000s expenses, 8000s other income, 9000s other expense.

| Code | Name | QuickBooks type | QuickBooks detail type |
| --- | --- | --- | --- |
| 4100 | Dues and memberships | Income | Service/Fee Income |
| 4200 | Donations and gifts | Income | Non-Profit Income |
| 4300 | Grants | Income | Non-Profit Income |
| 4400 | Sales | Income | Sales of Product Income |
| 4500 | Event and program fees | Income | Service/Fee Income |
| 5100 | Supplies & Materials – COGS | Cost of Goods Sold | Supplies & Materials – COGS |
| 6100 | Bank Charges | Expenses | Bank Charges |
| 6200 | Office Supplies & Software | Expenses | Office Supplies & Software |
| 6300 | Shipping, Freight & Delivery | Expenses | Shipping, Freight & Delivery |
| 6400 | Advertising/Promotional | Expenses | Advertising/Promotional |
| 6500 | Rent & Lease | Expenses | Rent & Lease |
| 6600 | Utilities | Expenses | Utilities |
| 6700 | Insurance | Expenses | Insurance |
| 6800 | Legal & Professional Fees | Expenses | Legal & Professional Fees |
| 6900 | Dues & Subscriptions | Expenses | Dues & Subscriptions |
| 7000 | Contractors | Expenses | Contractors |
| 7100 | Payroll Expenses | Expenses | Payroll Expenses |
| 7200 | Repair & Maintenance | Expenses | Repair & Maintenance |
| 7300 | Travel | Expenses | Travel |
| 7400 | Taxes & Licenses | Expenses | Taxes & Licenses |
| 7900 | Other Business Expenses | Expenses | Other Business Expenses |
| 8100 | Interest Earned | Other Income | Interest Earned |
| 8900 | Other Miscellaneous Income | Other Income | Other Miscellaneous Income |

Source for QuickBooks' types and detail types: the QuickBooks Online chart of accounts reference (Dancing Numbers, a QuickBooks consultancy, 2026), checked against Intuit's help pages where possible.

- A site changes or replaces it in configuration. Bank charges defaults to 6100; other income (bounced-check penalties) to 8900.
- __[docs/guides/chart-of-accounts-guide.md](../guides/chart-of-accounts-guide.md) is the source of truth__ for the chart (operator, 2026-10-19): every change is made there first, and a test holds the shipped configuration to its table. The table above is the decision as made.
- __Reporting maps__ for a kind of organization (a nonprofit's Form 990 lines, a business's tax-form lines, GAAP taxonomy elements) are optional and added later as code sets, never built into the categories.
- Our accounts map to QuickBooks' Bank type; Cash on Hand is its Undeposited Funds. Receivables, payables and equity are not in this ledger; owing and owed come with invoices (#2).

## D-035: Dues and assessments: flexible accounts and charges

- __Status:__ Accepted
- __Date:__ 2026-10-20
- __Links:__ [#2](https://github.com/jwilleke/ngdp-accounting-addons/issues/2), [D-033](#d-033-receipts-and-refunds-are-made-of-lines), [D-034](#d-034-a-generic-starter-chart-with-account-types)

__Context:__ The dues module (#2) has to fit a club, a church and a condominium. Condominiums bill units, not people, call the charge an assessment, and are told not to say "dues". The Fairways bills assessments annually but lets owners pay monthly; some pay months ahead.

__Decision (operator, 2026-10-20):__ keep the design flexible; do not go deeper yet.

- __The site names the module.__ Money lines (invoices, receipts, statements, reports) show the chart's category name: a condo renames 4100 to "Assessments" in its chart ([chart guide](../guides/chart-of-accounts-guide.md)). The module's screens and emails use a site label, `{ "singular": "Assessment", "plural": "Assessments" }`, defaulting to "Dues".
- __Accounts are in ngdpbase.__ The site chooses what holds accounts (people, households, units). Every account has one or more people responsible for it (every unit has at least one owner), and they are ngdpbase users. No core change (operator, 2026-10-20): ngdpbase has no groups; `unit-01` is a role. Units belong to the generic `condo` add-on ([ngdpbase-addons](https://github.com/jwilleke/ngdpbase-addons/tree/main/addons/condo), The Fairways its reference site): `CondoUnitManager`, keyed by the county parcel. Every owner and occupant is an ngdpbase user; the unit keeps only each owner's share, keyed by username, and `await owners(ctx, id)` returns `{ username, name, email, share }` (ngdpbase-addons#11). Occupants are never billed. Each unit has a __unit type__ carrying its assessment (cents, monthly or annual, due day), from `ngdpbase.addons.condo.unit-types` (operator, 2026-10-21). Accounting reads `owners(ctx, id)` (the acting person's context, or a job's), `assessment(id)` and `lateCharges()` through `getManager('CondoUnitManager')` and keeps no copy, only the money side. Accounting's profile panel (balance, statements) uses ngdpbase's existing add-on profile hook (`profileSection` / `saveProfileSection`, ngdpbase #534).
- __Its own add-on, `accounting-dues`__ (operator, 2026-10-21), like `accounting-donations`: its own database, accounting's managers for the money. It reads accounts from a manager named in configuration (`CondoUnitManager` for a condo), so a club can bring its own. __One invoice per unit__, showing each owner's share, sent to every owner. Invoices are numbered `I-0001` onwards, one sequence per site, at least four digits with no upper limit; an invoice is never edited, a mistake is voided and issued again.
- __The ledger holds only money that actually moved__ (operator's rule, 2026-10-21). Invoices live in `accounting-dues`' own database, outside the ledger. A payment is an ordinary receipt whose line names the invoice it pays (line details, as gifts do). A unit's balance is what was invoiced less what was paid.
- __The treasurer starts each month's billing__ (operator, 2026-10-21, for now): a Prepare This Month's Invoices page shows each unit's amount owed, credit and proposed late charges; the treasurer checks and issues. Later, an optional automation sends on a configured schedule (the 10th of the month, a day of the year), through ngdpbase's `BackgroundJobManager`. The scheduled run includes the late charges due (operator, 2026-10-22, [#11](https://github.com/jwilleke/ngdp-accounting-addons/issues/11)): turning the schedule on is the site's standing confirmation. The schedule is core's: the job `accounting-dues.issue-invoices` is registered at the 1st of the month, 06:00, and paused by default (`ngdpbase.jobs.accounting-dues.issue-invoices.enabled: false`); a site turns it on and changes the day with BackgroundJobManager's own keys (operator, 2026-10-22, revising an add-on key). On a live site the run sends each invoice to its owners by their communication preference; in development it sends nothing to owners and notifies the treasurer (operator, 2026-10-22). The switch is `ngdpbase.addons.accounting-dues.send-to-owners`, false by default, so a copied or test site never mails real owners; it governs every send to owners, the issue form's email box included.
- __Invoices reach each owner by their communication preference__, a core user preference (ngdpbase #1969). Each invoice is stored as issued with a fingerprint, and sent as a __PDF__ attachment once ngdpbase has a core PDF export (requested, P1, operator 2026-10-21); statements follow. Until then, print-styled HTML.
- __Charges are configuration:__ charge schedules with a category, a billing period and an amount rule. The billing period and the payment plan are separate (billed annually, paid monthly). Amounts can be fixed, each account's own, or a share of a total; one account's charge can be split by percentage between its people.
- __Each month is evaluated on its own.__ An installment is its own invoice, one per month; nothing is created up front. A payment gets a receipt; an invoice goes out only if something is owed. Money paid ahead sits on the account as a credit for later months.
- __Statements show one line per transaction__ (D-033). Bounced checks and their corrections go on the payer's account once accounts exist.
- __Out of scope for now:__ unit sales and closings.

## D-036: Donations follow the donations guide

- __Status:__ Accepted
- __Date:__ 2026-10-20
- __Links:__ [#4](https://github.com/jwilleke/ngdp-accounting-addons/issues/4), [donations guide](../guides/donations-guide.md), [D-033](#d-033-receipts-and-refunds-are-made-of-lines)

__Decision (operator, 2026-10-20):__

1. __A donation is a receipt line__ in a donation category, in the donor's chosen fund, carrying the deductible amount, the value of goods or services received, and whether it is anonymous.
2. __A gift that should appear on a statement is recorded against an ngdpbase person__, picked from the list or created as a new donor; anonymous cash needs no person.
3. __A year-end giving statement__ per donor serves as the acknowledgment for gifts of $250 or more; the __receipt slip carries the quid pro quo disclosure__ at the time of the gift. Wording is a site setting; United States only for now.
4. __Statements are web pages for now__, stored exactly as sent; PDF files wait for a PDF export in ngdpbase core.
5. __In-kind gifts are described, not valued__: a separate record against the donor (a person) with a date and a description, not a ledger entry; it appears on the year-end statement without an amount.
6. __Pledges are their own record, outside the ledger__ (donor, amount, fund, period, optional schedule), with the gifts that pay toward them linked; the ledger holds real money only, so no "pending" entry status is added.

__[docs/guides/donations-guide.md](../guides/donations-guide.md) is the source of truth for donations__ (operator): every change is made there first, and the code follows it.

## D-037: People see their own money through one ledger door

- __Status:__ Accepted
- __Date:__ 2026-10-22
- __Links:__ [#50](https://github.com/jwilleke/ngdp-accounting-addons/issues/50), [D-035](#d-035-dues-and-assessments-flexible-accounts-and-charges), [D-036](#d-036-donations-follow-the-donations-guide)

__Context:__ A donor who signs in should see their own gifts and statements, and a unit owner their invoices and balance, on their own profile (ngdpbase's add-on profile hook, #534). The receipts are in the ledger, which only `ledger-read` (the treasurer) may read.

__Decision (operator, 2026-10-22):__ `LedgerManager` gets one self-service door: the caller's own receipts and refunds, those whose payer is the caller's own ngdpbase person record, under one permission, `ledger-self`, granted to every signed-in person. The modules read through it: donations shows the gift lines, dues the payment lines for the units the person owns. It replaces the donations guide's separate `giving-self`.

## D-038: One invoice per billing party, each with its own balance

- __Status:__ Accepted; its balance rule superseded by [D-039](#d-039-a-balance-belongs-to-the-person-billed)
- __Date:__ 2026-10-23
- __Links:__ [#56](https://github.com/jwilleke/ngdp-accounting-addons/issues/56), [#50](https://github.com/jwilleke/ngdp-accounting-addons/issues/50), [D-035](#d-035-dues-and-assessments-flexible-accounts-and-charges), [D-037](#d-037-people-see-their-own-money-through-one-ledger-door), [ngdpbase-addons#14](https://github.com/jwilleke/ngdpbase-addons/issues/14)

__Context:__ The accommodation add-on keeps a unit's billing parties: who is billed together, at which address, for what share (`ResidencyManager.billing(ctx, id, { on })`). Joint owners at one address get one invoice; owners at different addresses one each. With one balance per unit, settled oldest invoice first, one party's payment would pay off another party's invoice, and the late charge would land on whoever had paid.

__Decision (operator, 2026-10-23):__ dues issues one invoice per billing party, and each party has its own balance:

- A party's invoice shows that party's share of the month's charge, and only that party's balance or credit brought forward.
- A payment settles only its party's invoices; the payment line names the party.
- Late charges follow each party's own unpaid invoices.
- The unit's balance is the sum of its parties' balances.
- Each person on a party can see that party's invoices and balance on their own profile (#50).

A unit with one party at 100% works exactly as before.

## D-039: A balance belongs to the person billed

- __Status:__ Accepted
- __Date:__ 2026-10-23
- __Links:__ [#56](https://github.com/jwilleke/ngdp-accounting-addons/issues/56), [D-038](#d-038-one-invoice-per-billing-party-each-with-its-own-balance)

__Context:__ D-038 gave each billing party its own balance. A party changes when a unit is sold or an owner is added, and the operator's rule is that debts follow people, not parties.

__Decision (operator, 2026-10-23):__ supersedes D-038's balance rule; one invoice per billing party stands.

- Each invoice is billed to the owners on its billing date. For The Fairways that is the 1st of the month: whoever owns the unit on the 1st owes that month's charge.
- A balance belongs to the person. An owner keeps owing their past balance, and their part of every later invoice, whatever party they are on. A new owner starts at $0 and never takes on a seller's balance.
- A party's invoice shows each member's own balance brought forward (Jim $100, Molly $0).
- A payment names the person who paid, and settles that person's balance.
- The unit's balance is the sum of the balances its owners were billed for it.

## D-040: Dues bills exactly as the billing array says

- __Status:__ Accepted
- __Date:__ 2026-10-23
- __Links:__ [#56](https://github.com/jwilleke/ngdp-accounting-addons/issues/56), [D-039](#d-039-a-balance-belongs-to-the-person-billed), [ngdpbase-addons#14](https://github.com/jwilleke/ngdpbase-addons/issues/14)

__Context:__ Who sets a unit's billing parties and their percentages came up while working out how a joint party's charge is split between its members.

__Decision (operator, 2026-10-23):__ from accounting's side, the billing array is how things are billed. Dues reads it through `ResidencyManager.billing(ctx, id, { on })` and bills exactly what it says: it never works out, adjusts or second-guesses a party or a percentage. Setting the array is not accounting's concern; for The Fairways, the Board of Directors approves it.

## D-041: Accommodation owns the owner and occupant roles

- __Status:__ Accepted; what the dues card rests on corrected by [D-045](#d-045-the-dues-card-shows-whoever-was-billed)
- __Date:__ 2026-10-23
- __Links:__ [#50](https://github.com/jwilleke/ngdp-accounting-addons/issues/50), [D-037](#d-037-people-see-their-own-money-through-one-ledger-door), [ngdpbase-addons#23](https://github.com/jwilleke/ngdpbase-addons/issues/23)

__Context:__ The owner's dues card was going to rest on core's `vault-owner` role, which every account holds because of its private vault and which has nothing to do with owning a unit. The accommodation add-on now declares `owner` and `occupant` roles and keeps them in step with the dated ownership and occupancy entries.

__Decision (operator, 2026-10-23):__ the accommodation add-on is the owner of the roles for owners and occupants. Accounting never decides who is an owner: what dues shows an owner rests on accommodation's `owner` role, not on `vault-owner`. The donations card is unchanged: any signed-in donor sees their own giving under `ledger-self` (D-037).

## D-042: One term: donation

- __Status:__ Accepted
- __Date:__ 2026-10-23
- __Links:__ [D-036](#d-036-donations-follow-the-donations-guide)

__Context:__ The donations add-on calls one donation a "gift" in its code, screens and docs: the `gift` line details, gift forms, "Your giving". Two words for one thing.

__Decision (operator, 2026-10-23):__ use one term, __donation__, everywhere: screens, guides, code and stored names. "Gift" goes. Renaming what is already stored (the `gift` line details on posted receipts) needs a migration, not a rewrite of history.

## D-043: Every signed-in user holds ledger-self

- __Status:__ Accepted; how it is granted superseded by [ngdpbase#1539](https://github.com/jwilleke/ngdpbase/issues/1539#issuecomment-6382833733) (2026-10-24, below)
- __Date:__ 2026-10-24
- __Links:__ [#50](https://github.com/jwilleke/ngdp-accounting-addons/issues/50), [D-037](#d-037-people-see-their-own-money-through-one-ledger-door), [D-041](#d-041-accommodation-owns-the-owner-and-occupant-roles)

__Context:__ `ledger-self` (D-037) lets a person see their own money: their own receipts, their donations and statements, their party's invoices. Accounting's policy grants it to core's roles, `vault-owner` among them, and `vault-owner` is the only role an owner or donor with no site role has. `vault-owner` exists for a person's private vault and has nothing to do with accounting; the operator's rule is that accounting does not use it.

__Decision (operator, 2026-10-24):__ `ledger-self` is granted to every signed-in user (the policy subject `authenticated`), not to a list of roles, and never through `vault-owner`. It opens only a person's own records, so someone with none sees nothing: each card hides itself when empty. The build checks that ngdpbase's decision point honours the `authenticated` subject.

__Superseded in part (operator, 2026-10-24, [ngdpbase#1539](https://github.com/jwilleke/ngdpbase/issues/1539#issuecomment-6382833733)):__ the decision point honours only role subjects, so `authenticated` grants nothing. `vault-owner` stays the role core gives every account, and it is the one way to give every user a permission: an add-on names it in its own policy. `accounting-self-service` grants `ledger-self` to `vault-owner` alone. Every signed-in user still holds `ledger-self`; only how it reaches them changed.

## D-044: An owner's bills are on their profile, in accounting's card

- __Status:__ Accepted
- __Date:__ 2026-10-24
- __Links:__ [#50](https://github.com/jwilleke/ngdp-accounting-addons/issues/50), [D-043](#d-043-every-signed-in-user-holds-ledger-self), [ngdpbase-addons#16](https://github.com/jwilleke/ngdpbase-addons/issues/16)

__Decision (operator, 2026-10-24):__ an owner sees their bills in one place: the dues card accounting adds to their profile, with each billing party they are on, its invoices, what is paid and left, and the balance. The accommodation add-on's resident page links to that card rather than showing a balance of its own, so the money appears in one place only.

## D-045: The dues card shows whoever was billed

- __Status:__ Accepted
- __Date:__ 2026-10-24
- __Links:__ [#50](https://github.com/jwilleke/ngdp-accounting-addons/issues/50), [D-041](#d-041-accommodation-owns-the-owner-and-occupant-roles), [D-043](#d-043-every-signed-in-user-holds-ledger-self), [D-044](#d-044-an-owners-bills-are-on-their-profile-in-accountings-card)

__Context:__ When someone sells, the accommodation add-on takes away their `owner` role, but they may still owe money on bills they were sent.

__Decision (operator, 2026-10-24):__ a person who was billed keeps seeing those bills, owner or not. The dues card shows the invoices of every billing party the person was on, under `ledger-self` (D-043); it does not depend on accommodation's `owner` role. This corrects D-041's line that what dues shows an owner rests on that role; accommodation still owns the roles.

## D-046: Add-on data is shown through core's one display plugin

- __Status:__ Accepted
- __Date:__ 2026-10-25
- __Links:__ [ngdpbase#2074](https://github.com/jwilleke/ngdpbase/issues/2074), [D-044](#d-044-an-owners-bills-are-on-their-profile-in-accountings-card), [#70](https://github.com/jwilleke/ngdp-accounting-addons/issues/70)

__Context:__ The self-service cards (a donor's donations, an owner's bills) are built by each add-on as HTML for the profile page, and could have been repeated as wiki plugins of our own.

__Decision (operator, 2026-10-25, relayed by ngdpbase core):__ core provides one display plugin for add-on data. Add-ons register named data sources (`host.registerDataSource('<slug>.<source>', (ctx, params) => ({ columns, rows }))`, deciding with the viewer's context), and core renders them as a table, list, count or card, on any page and on `/profile`. Until it ships, accounting builds no new HTML views; the profile cards use core's formatters (`formatAsTable`, `formatMoney`, `escapeHtml`) rather than hand-built tables. When it ships, the cards become data sources.

## D-047: One balance per unit; billing entries are only where invoices go

- __Status:__ Accepted
- __Date:__ 2026-10-25
- __Links:__ [ngdpbase#2042](https://github.com/jwilleke/ngdpbase/issues/2042), [D-038](#d-038-one-invoice-per-billing-party-each-with-its-own-balance), [D-040](#d-040-dues-bills-exactly-as-the-billing-array-says), [D-045](#d-045-the-dues-card-shows-whoever-was-billed)

__Context:__ The accommodation add-on's billing changed (operator, 2026-10-25, ngdpbase#2042): who owes is always the unit's owners at invoice time, each with a share, every owner an account and referred to by identity `@id`. The billing array is only where invoices go: free-text addresses typed by the treasurer or the owners, with shares totalling 100%. Every unit must have one; there is no fallback to the unit's own address. Any current owner may see the unit's whole account, and the board every unit's.

__Decision (operator via ngdpbase core, and accounting's own choices, 2026-10-25):__ supersedes D-038's per-party balance.

- __One balance per unit.__ The owners owe it jointly; a payment settles the unit's oldest invoice.
- __One invoice per billing entry__, for its share of the month's charge and of the balance brought forward, sent to its address and emailed to every owner. The invoice records the address text and the owners' `@id`s and shares at that date, no names.
- __Who sees it:__ a current owner, decided when they look, sees the unit's whole account. A past owner keeps seeing the invoices issued while they owned it (D-045), not the unit's later account. The board sees every unit's under a new permission, `account-read`, which a site grants to its board.
- __A unit with no billing address is never invoiced to a guessed address:__ the run reports and skips it, naming it in the run's result and in the treasurer's notice.
- Invoices issued in the old shape are read as they are and never rewritten.
