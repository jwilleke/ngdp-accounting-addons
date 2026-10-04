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
