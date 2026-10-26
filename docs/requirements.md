# Requirements: ngdp-accounting-addons

__Status:__ draft for review, 2026-10-03. Nothing here is built.

This document describes a suite of ngdpbase add-ons for small organizations: clubs first, then churches and associations. Where it refers to ngdpbase, it cites files on `main` of [jwilleke/ngdpbase](https://github.com/jwilleke/ngdpbase) as of commit `817ca75` (2026-10-03). Where ngdpbase does not yet provide something, it says so.

Decisions made since this draft are recorded in [docs/plans/decisions.md](plans/decisions.md) and take precedence over this document where they differ.

## 1. Goals and non-goals

### Goals

- Replace WildApricot for small organizations put off by its price increases and per-contact billing.
- Keep __board memory__: financial records, donation history and the treasurer's working notes belong to the organization and survive officer changes.
- Cover the money tasks a volunteer treasurer does every month: collect dues and donations, record money received, track money by fund, run event sign-ups, report to the board, and hand the numbers to the real books.
- Keep accounting deliberately small. The books of record stay in QuickBooks or Wave; these add-ons export to them.
- Protect higher-risk actions (refunds, voids, exports, receipt settings, role changes, donation statements) with stronger sign-in than everyday member actions.

### Non-goals (Phase 1)

- Payroll.
- Accounts payable (bills, vendors, scheduled payments) in Phase 1. Reversed for later by [D-049](plans/decisions.md#d-049-accounts-payable-outside-the-ledger): vendor bills in a payables module, outside the ledger.
- A double-entry general ledger, chart of accounts, balance sheet or trial balance.
- Bank feeds or automatic bank reconciliation.
- Storing card numbers or bank account numbers.
- Multi-currency, and more than one organization per ngdpbase instance.
- Tax filing (for example US Form 990). Reports support the person who files; they do not file.

### Relationship to earlier ngdpbase plans

ngdpbase already has an open, deferred issue for a generic accounting add-on, [#486](https://github.com/jwilleke/ngdpbase/issues/486), planned in `docs/planning/plan-addon-accounting.md` as a __double-entry__ ledger with chart of accounts, AR and AP. `addons/README.md` also points to a double-entry `financial-ledger` add-on in `fairways-gen2-website`. This suite deliberately takes the opposite approach (single-entry, fund-tagged, no AP). Whether #486 is superseded, narrowed, or kept for a later, fuller product is an open question (section 13).

## 1a. Standards we follow

Where a published standard names a thing, these add-ons use its name and codes rather than inventing their own ([D-018](plans/decisions.md#d-018-use-published-standards-schemaorg-and-uncefact-payment-means)).

| Standard | Used for |
| --- | --- |
| [schema.org](https://schema.org/) (`Invoice`, `Order`, `PaymentMethod`, `PaymentStatusType`) | Field names for payments: `paymentMethod`, `confirmationNumber`, `paymentMethodId`, `provider`, `paymentStatus`. ngdpbase already uses schema.org for people and organizations |
| UN/CEFACT payment means codes ([UNCL 4461](https://edifactory.de/edifact/directory/D00A/data-element/4461)) | Values of `paymentMethod` (schema.org recommends them). Codes are checked against the current list before use |
| [ISO 4217](https://www.iso.org/iso-4217-currency-codes.html) currency codes | `currency` on every amount, from the site-wide `ngdpbase.default.currency` ([ngdpbase#1711](https://github.com/jwilleke/ngdpbase/issues/1711)) |
| Unified Chart of Accounts (UCOA) | `category`: income and expense categories are UCOA account codes with labels ([D-023](plans/decisions.md#d-023-categories-follow-the-unified-chart-of-accounts-ucoa)) |

## 2. Personas

| Persona | Who they are | What they need |
| --- | --- | --- |
| __Treasurer__ | Volunteer officer, often not an accountant, serving one or two years | Record money quickly, chase lapsed dues, produce a board report and year-end receipts, hand off cleanly |
| __Board member__ | President, secretary, other officers | See fund balances and the monthly summary; approve things; trust the numbers without seeing every donor |
| __Member__ | Pays dues, registers for events | Pay online, see their own status and history, get reminders and statements |
| __Donor__ | May or may not be a member; may never sign in | Give online or by check, receive a correct year-end donation statement |
| __Admin__ | Runs the ngdpbase site (may be the same person as an officer in a small club) | Install and configure the add-ons, manage roles, set Stripe keys, keep the site secure |

## 3. Architecture in ngdpbase terms

### How ngdpbase add-ons work today

- An add-on is a directory with an `index.ts` (or `index.js`) that exports an `AddonModule`: `name`, `version`, optional `dependencies`, and `register(engine, config)`, plus optional `status()` and `shutdown()` (`addons/README.md`, `docs/platform/addon-architecture.md`). `addons/journal/index.ts` is a full example.
- In `register()`, an add-on mounts Express routers on `engine.app` (journal mounts `/api/journal`, `/journal` and `/addons/journal`), registers managers with `engine.registerManager()`, markup plugins with `PluginManager.registerPlugin()`, a stylesheet and a dashboard card through `AddonsManager`, and sets a capability flag with `engine.setCapability()` (`addons/journal/index.ts`).
- Pages it ships live in `pages/<uuid>.md` with `system-category: addon` and are seeded on first load (`addons/journal/pages/`, `docs/guides/addons-developer-guide.md`, section "Seed Wiki Pages").
- Its own data lives in files under a `dataPath` (calendar writes `dataPath/<calendarId>.json`, `addons/calendar/managers/CalendarDataManager.ts`). ngdpbase's rule is that data an add-on keeps in its own files belongs to the system, not to a user, and never goes in a user's vault (`docs/system-category.md`). That matches board memory.
- ngdpbase has an optional SQLite database through `DatabaseManager` (`src/managers/DatabaseManager.ts`): provider `none` by default, `sqlite` optionally encrypted with SQLCipher when `NGDPBASE_DATABASE_KEY` is set. Whether add-ons may own tables and migrations there is not documented (section 13).
- An add-on declares its permissions in `ngdpbase.permissions.definitions` and grants them with its own policy (with its own `id`) in `ngdpbase.access.policies`, inside its `config/default-config.json`. That file is a merge layer between shipped defaults and the instance's `app-custom-config.json` (`src/utils/addonConfigLayer.ts`). Routes call `ApiContext.from(req, engine)` and then `await ctx.requirePermission('<permission>')`. Add-on code must never test a role name (`docs/guides/addons-developer-guide.md`, section 7; `addons/calendar/config/default-config.json` is the worked example).
- Add-on code runs in the ngdpbase process under the same rules as core: outbound HTTP only through `src/http/guardedFetch` (imported from `dist/`), CSRF tokens on browser POSTs, an `ActorContext` on every acting call, no imports from host `src/`. Lint checks enforce these over `addons/` (`addons/README.md`, "Security Notes").
- A separate repository is supported. During development, add its `addons/` directory to `ngdpbase.managers.addons-manager.addons-path`. For production, the recommended model is an npm package (`@jwilleke/<slug>-addon`, with `ngdpbase.slug` in `package.json`), published to GitHub Packages for a private add-on (`docs/platform/deployment/addon-packaged.md`). Slug rules are in `docs/platform/addon-identity-contract.md`.

- Every add-on must run unchanged on bare metal, Docker and Kubernetes ([D-006](plans/decisions.md#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes)).

### Add-on layout ([D-016](plans/decisions.md#d-016-one-repository-a-base-accounting-add-on-and-optional-module-add-ons))

One repository with a required base add-on and optional module add-ons. Each module depends on `accounting`; a site enables only what it needs.

| Add-on | Phase | Contents | Depends on |
| --- | --- | --- | --- |
| `accounting` | 1 (MVP) | Funds, ledger, audit trail, monthly summary and CSV export, `ReceiptManager` and receipt providers ([D-017](plans/decisions.md#d-017-paymentmanager-lives-in-the-accounting-add-on)), the accounting database, base permissions | none |
| `accounting-receivables` | 1 | Invoices for assessments, rent or dues; payments, balances, late charges (memberships later) | `accounting` |
| `accounting-donations` | 1 | Donations and donation statements | `accounting` |
| `accounting-events` | 1 | Paid registrations | `accounting` |
| `accounting-loyalty` | to be decided | Loyalty members and gift cards ([#18](https://github.com/jwilleke/ngdp-accounting-addons/issues/18)) | `accounting` |
| `accounting-reimbursements` | 2 | Expense reimbursement requests and approvals | `accounting` |
| `accounting-handover` | 2 | Treasurer handover record | `accounting` |

QuickBooks and Wave export may live in `accounting` or a module; to be decided.

## 4. Shared ledger model

A single-entry, fund-tagged list of money in and money out. Every module posts to it; nothing posts around it.

### Transaction

| Field | Meaning |
| --- | --- |
| `id` | Stable unique id |
| `direction` | `in` or `out` |
| `amount` | Positive integer in minor units (cents); never floating point |
| `currency` | One currency per install, default `USD` |
| `date` | The date the money moved (or the check was received) |
| `fund` | Required fund id; defaults to `general` |
| `category` | Income or expense category: dues, donation, event fee, processing fee, refund, supplies, and so on (configurable list) |
| `party` | Who paid or was paid: a reference to an ngdpbase identity record (`IdentityManager`, `src/managers/IdentityManager.ts`), or a free-text name |
| `paymentMethod` | How the money moved, as a UN/CEFACT payment means code (UNCL 4461) with a readable label: `10` in cash, `20` cheque, `30` credit transfer, `42` payment to bank account, `48` bank card, `49` direct debit, ... ([D-018](plans/decisions.md#d-018-use-published-standards-schemaorg-and-uncefact-payment-means)) |
| `provider` | The receipt provider that recorded it (`manual`, `stripe`, ...), or empty for an entry made directly in the ledger ([D-004](plans/decisions.md#d-004-paymentmanager-with-configurable-providers), [D-017](plans/decisions.md#d-017-paymentmanager-lives-in-the-accounting-add-on)) |
| `confirmationNumber` | The provider's own id confirming the money received (schema.org `confirmationNumber`). `provider` plus `confirmationNumber` is unique, so a receipt delivered twice is posted once |
| `paymentMethodId` | Check number or other identifier of the payment instrument a person reads (schema.org `paymentMethodId`) |
| `source` | Link to what created it: `{ type: dues-invoice, donation, event-registration, reimbursement, manual, adjustment; id }` |
| `status` | `posted`, `voided`. A check counts when recorded; clearing is a mark on its deposit ([D-032](plans/decisions.md#d-032-cleared-deposits-and-bounced-checks)). A `pending` status may come with Stripe's online ACH |
| `deductible` | For donations: the tax-deductible amount, and the value of goods or services received, if any |
| `memo` | Free text |
| `attachments` | Optional images (a check, a proof of purchase) |
| `createdBy`, `createdAt` | Actor and time, from the request's context |
| `voids` / `voidedBy` | Links between a voided transaction and its correction |

### Fund

`id`, `name`, `description`, `restricted` (true when donors gave it for a specific purpose), `active`, `openingBalance` and `openingDate`. A fund's balance is its opening balance plus posted money in, minus posted money out. Funds can be closed but never deleted while transactions reference them.

### Rules

- __Posted transactions are not edited in place.__ A correction voids the original (with a required reason) and posts a replacement, linked both ways. Small non-financial fixes (memo, attachment) are allowed and audited.
- __Nothing financial is hard-deleted.__ Voided transactions stay visible in history and exports.
- __Audit trail.__ Every create, post, void, edit, refund, export and settings change is recorded with actor, time, before and after values, and reason. Use ngdpbase's audit path (`recordAuditEvent` in `src/utils/auditEvents.ts`, `docs/guides/audit-developer-guide.md`) and also keep the ledger's own append-only change history, so the record survives with the add-on's data.
- __Audit events ([D-014](plans/decisions.md#d-014-every-action-is-a-permission-with-one-audited-door-no-money-moves-without-a-record)).__ Every action is a permission with one door that records an audit event, named `{target}-{action}`. Every financial write (post, void, refund, transfer, period lock, export) uses `on-failure: refuse`: no money moves without a record. Each audited action is declared once, as a permission entry carrying its `audit` rule ([ngdpbase#1638](https://github.com/jwilleke/ngdpbase/issues/1638), section 11).
- __Processing fees.__ Stripe fees are recorded so deposits reconcile (proposed: gross amount as income, fee as a separate `out` transaction in the same fund; see open questions).
- __Period lock (after the MVP).__ The treasurer can lock a reporting period after the board report; the period length is set per site (monthly, quarterly, semi-annual, annual), since many condos and small entities do not report monthly. Posting into a locked period needs the high-assurance adjust permission and a reason ([#19](https://github.com/jwilleke/ngdp-accounting-addons/issues/19)).
- __No double entry.__ There are no accounts, debits or credits. The export carries enough detail for the real books to do that.

## 5. Module requirements

### 5.1 Dues and invoicing (Phase 1)

__Requirements:__

- Define membership tiers: name, price, term (annual, semiannual, monthly, lifetime), optional proration and grace period.
- Each membership links a Person to a tier, with a start date, renewal date and status: `active`, `due`, `grace`, `lapsed`, `cancelled`.
- Generate an invoice at renewal (or on demand) and post it as payable; a paid invoice creates a ledger transaction tagged to the configured fund.
- Send reminders by email before the renewal date, on the due date, and after (schedule configurable), through `EmailManager` (`src/managers/EmailManager.ts`). Members can stop non-essential reminders.
- Show members their own status, invoices and what they have paid; let them pay online.
- Show the treasurer a roster filtered by status, with bulk reminder sending.

__Acceptance criteria:__

- [ ] A treasurer can create tiers and assign members to them.
- [ ] Status moves from active to due, grace and lapsed on the configured dates without manual work.
- [ ] Reminders go out on schedule, once each, and each send is logged.
- [ ] Paying an invoice (online or recorded manually) marks it paid, renews the membership, and posts one ledger transaction.
- [ ] A member sees only their own invoices.

### 5.2 Receipts (Phase 1)

Receipts are money coming in, of any kind, and refunds of it ([D-028](plans/decisions.md#d-028-receipts-for-money-in-statements-for-what-donors-get-payments-only-for-money-out)).

__Requirements:__

- All money received goes through the `accounting` add-on's `ReceiptManager` ([D-017](plans/decisions.md#d-017-paymentmanager-lives-in-the-accounting-add-on)), whose providers are chosen by configuration ([D-004](plans/decisions.md#d-004-paymentmanager-with-configurable-providers)). Stripe is the first online provider; manual cash and check is always available.
- Take card and ACH receipts through Stripe, using a Stripe-hosted checkout page or Stripe-hosted fields so card and bank details never reach the ngdpbase server.
- Learn the outcome of an online receipt by asking the provider on a schedule and when a payer returns from the hosted page; no inbound webhook ([D-003](plans/decisions.md#d-003-learn-payment-outcomes-by-asking-not-by-webhook)). Process each event once.
- Record cash and check receipts by hand: amount, date, payer, check number, fund, and a link to the invoice, donation or registration it pays.
- Record deposits of cash and checks as a batch (optional in Phase 1).
- Refund a Stripe receipt fully or partly; record a manual refund for cash or check. A refund posts an `out` transaction linked to the original.
- Treat ACH as pending until Stripe reports it settled; handle a failed ACH by reverting the paid status and notifying the treasurer.

__Acceptance criteria:__

- [ ] A test-mode card receipt and a test-mode ACH receipt each produce exactly one posted transaction, even when the same event is synced more than once.
- [ ] Switching or adding a receipt provider is a configuration change only.
- [ ] No card number, CVC or bank account number is stored or logged anywhere.
- [ ] A refund requires the high-assurance refund permission and appears in the audit trail.
- [ ] A treasurer can record a check in under a minute.

### 5.3 Donations and donation statements (Phase 1)

__Requirements:__

- Take one-time and recurring donations online (via Receipts) and record offline donations (cash, check, in-kind).
- Each donation has a donor, date, amount, fund, deductible amount, and the value of any goods or services received.
- Support anonymous donations (no name shown to the board) and donors who never sign in.
- Generate a year-end donation statement per donor: organization name and tax id, donor name, each donation with date and amount, totals, and the required wording for donations with goods or services received. Wording is configurable; the organization is responsible for checking it with its accountant.
- Email statements in bulk, or download them, and keep a copy of each issued statement.
- Reissue a corrected statement, keeping the original and marking it superseded.

__Acceptance criteria:__

- [ ] Statement totals equal the sum of that donor's posted, non-voided donations for the year.
- [ ] Issuing, reissuing or bulk-sending statements requires the high-assurance statement permission.
- [ ] Each issued statement is stored, immutable, and linked to the donations it covers.
- [ ] Board members see donation totals by fund without seeing individual donors unless granted.

### 5.4 Fund tracking (Phase 1)

__Requirements:__

- Funds are defined by the treasurer (general, building, youth, a specific event) and flagged restricted or unrestricted.
- Every transaction carries exactly one fund; each module has a default fund per item (tier, event, donation form).
- Move money between funds with a linked pair of transfer entries (out of one, into the other), with a reason.
- Show each fund's balance, with income and expense for a chosen period.

__Acceptance criteria:__

- [ ] A transaction without a fund cannot be posted.
- [ ] Fund balances match the sum of their posted transactions plus the opening balance.
- [ ] A transfer changes two fund balances and leaves the total unchanged.
- [ ] A fund with transactions cannot be deleted, only closed.

### 5.5 Event fees and registrations (Phase 1)

__Requirements:__

- Define a paid event: name, date, price options (member and non-member prices, early-bird dates), capacity, and fund.
- Registration form collects attendee details and the fee; free events need no fee.
- Registrations post to the shared ledger through Receipts.
- Waitlist when full (optional), cancellation and refund rules.
- Roster and check-in list for organizers.
- Integrate with the ngdpbase `calendar` add-on (`addons/calendar/`) and `forms` add-on (`addons/forms/`, which offers `registerHandler` for other add-ons) where it helps, but do not require them. Whether to build on them is an open question.

__Acceptance criteria:__

- [ ] A paid registration produces one registration record and one posted transaction tagged to the event's fund.
- [ ] Capacity is enforced, including when two people register at once.
- [ ] A cancelled registration with a refund posts the refund and frees the seat.

### 5.6 Treasurer reports and export (Phase 1)

__Requirements:__

- Monthly summary for board meetings: income and expense by category and by fund, fund balances at start and end, and a list of large or unusual items. Printable and exportable as PDF or as a wiki page.
- Year-to-date and custom period versions of the same report.
- Dues report (active, lapsed, revenue) and donations report (totals by fund, donor count).
- Export transactions as CSV with every ledger field.
- Export in formats QuickBooks and Wave can import (section 10).
- Each export is logged with who ran it, when, the period, and a hash of the file.

__Acceptance criteria:__

- [ ] The monthly report's totals reconcile with the ledger for the same period.
- [ ] Board members can view the report; only treasurer-level users can export transaction detail.
- [ ] Every export requires the high-assurance export permission and appears in the audit trail.
- [ ] A test import of the QuickBooks and Wave exports into a sandbox company succeeds.

### 5.7 Expense reimbursements (Phase 2)

__Requirements:__

- A member or officer submits a request: amount, date, purpose, fund, proof-of-purchase images.
- The treasurer (and optionally a second approver above a configurable amount) approves or rejects with a comment.
- Marking a request paid records the payment method and reference and posts an `out` transaction.
- The requester sees the status of their own requests.

__Acceptance criteria:__

- [ ] A requester cannot approve their own request.
- [ ] Approval and marking paid require the high-assurance permission.
- [ ] A paid request posts exactly one transaction linked to the request.

### 5.8 Treasurer handover (Phase 2)

__Requirements:__

- A handover record created when the treasurer changes: date, outgoing and incoming treasurer, fund balances and bank balances at handover, open items (unpaid invoices, pending reimbursements, upcoming renewals), accounts and services the treasurer controls (bank, Stripe, QuickBooks or Wave; names only, never passwords), recurring tasks and calendar, and free-form notes.
- Both treasurers acknowledge the record; it then becomes read-only and is kept as part of board memory.
- Role change checklist: grant the incoming treasurer the role, remove it from the outgoing one, and remind the admin to rotate shared credentials outside ngdpbase.
- The record is readable by board members and later treasurers.

__Acceptance criteria:__

- [ ] Fund balances in the record match the ledger on the handover date.
- [ ] After both acknowledgements, the record cannot be edited, only annotated.
- [ ] Finalizing the record requires the high-assurance handover permission.

## 6. Roles and permissions

### How ngdpbase matches policies today

- `src/types/Policy.ts` defines `PolicySubject { type, value }` and says: "`role` is the only type the evaluator matches today."
- `PolicyEvaluator.matchesSubject` (`src/managers/PolicyEvaluator.ts`) matches only `subject.type === 'role'` against the user's roles. `PolicyValidator` (`src/managers/PolicyValidator.ts`) accepts other subject types (`user`, `group`, `attribute`, and so on), but the evaluator ignores them. `docs/access-policies.md` is the source of truth and confirms this.
- Roles are declared in configuration, not code: `ngdpbase.roles.definitions` in `config/app-default-config.json`, overridable in `app-custom-config.json`. Shipped roles: `admin`, `user-admin`, `editor`, `contributor`, `demo-admin`, `vault-owner`, `reader`, `anonymous`. There is no `treasurer`, `board` or `member` role.
- Group membership records exist as schema.org `OrganizationRole` files (`src/types/Role.ts`) that list who holds a role in an organization; they carry no start or end dates today.

__Consequence:__ a `treasurer` role does __not__ need a change to `Policy.ts`. A deployment adds `treasurer` (and `board`, `member` if wanted) to `ngdpbase.roles.definitions` in its `app-custom-config.json`, and the add-ons' policies grant their permissions to those roles. What `Policy.ts` and the evaluator cannot express today is __assurance__: there is no way to say "this permission only when the sign-in reached AAL2". That is section 7.

### Proposed permissions

Each add-on declares these in its `config/default-config.json`. Names are proposals and would be prefixed per add-on slug.

| Permission | Allows | Member | Donor | Board | Treasurer | Admin | High assurance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dues-self` (memberships, deferred) | View and pay own membership dues | yes | | yes | yes | yes | no |
| `ledger-self` | View own money: receipts, donations and statements, and the accounts of units one owns (D-037, D-043, D-047) | yes | yes | yes | yes | yes | no |
| `event-register` | Register and pay for events | yes | yes | yes | yes | yes | no |
| `reimbursement-request` (Phase 2) | Submit and track own requests | yes | | yes | yes | yes | no |
| `ledger-summary-read` | Fund balances and monthly report, no donor names | | | yes | yes | yes | no |
| `handover-read` (Phase 2) | Read handover records | | | yes | yes | yes | no |
| `ledger-read` | Transaction detail, including names | | | | yes | optional | no |
| `ledger-record` | Record money received by hand and donations, create invoices, manage registrations | | | | yes | | no |
| `accounting-settings` | Tiers, funds, categories, reminder schedule, statement wording | | | | yes | yes | no (funds: open question) |
| `ledger-adjust` | Edit or void posted transactions, post into a locked period, fund transfers | | | | yes | | __yes__ |
| `receipt-refund` | Refund money received | | | | yes | | __yes__ |
| `ledger-export` | CSV, QuickBooks and Wave export, donor lists | | | | yes | | __yes__ |
| `statement-issue` | Issue, reissue or bulk-send donation statements | | | | yes | | __yes__ |
| `invoice-issue` | Issue, void and email invoices (assessments, rent or dues) | | | | yes | | no |
| `account-read` | See every unit's account: invoices, payments and balance, without the rest of the ledger | | | yes (site grants it) | | | no |
| `receipt-settings` | Receipt provider selection, provider keys, methods | | | | | yes | __yes__ |
| `reimbursement-approve` (Phase 2) | Approve, reject, mark paid | | | | yes | | __yes__ |
| `handover-manage` (Phase 2) | Create and finalize a handover | | | | yes | yes | __yes__ (finalize) |
| Role changes (core) | Grant or remove roles, including treasurer | | | | | yes (`admin`, `user-admin`) | __yes__ (core) |

Notes:

- A "donor" who never signs in has no role; their statement is emailed. `ledger-self` applies only to people with an account.
- Whether an admin who is not an officer should see donor-level detail is an open question. The table defaults to no.
- The add-ons' policies may name roles on day one (as the calendar and journal add-ons do), but add-on code never tests a role name.

## 7. Step-up authentication (acr)

### What ngdpbase has today

Checked against the code on 2026-10-03; `docs/planning/authentication.md` has the same status table.

- __Providers__ (`src/providers/`): password, magic link (`MagicLinkAuthProvider`), Google OIDC (`GoogleOIDCProvider`), passkey / WebAuthn (`PasskeyAuthProvider`), Cloudflare Access, Authentik bearer, agent tokens.
- __Assurance is computed per sign-in.__ Each provider declares `amr`, `aal` and `acr` (`src/providers/*`), configurable via `ngdpbase.auth.factors`, and `AuthManager.assess()` (`src/managers/AuthManager.ts`) combines them by NIST SP 800-63B. The session keeps a sign-in record (`req.session.signIn`, typed in `src/types/express.d.ts`) with `acr` as one of `phrh`, `phr`, `aal1`, `aal2`, `aal3`.
- __Levels by provider:__ magic link `amr: ["email"]`, AAL1, and email never lifts a sign-in above AAL1. Google OIDC is AAL1 with no `amr` unless configured to trust Google's reported values. Passkey `amr: ["swk","user"]`, AAL2, `acr: "phr"` (phishing-resistant).
- __Per-role required level is built.__ Each role in `ngdpbase.roles.definitions` can set `required-aal` (1 to 3); `admin` and `user-admin` ship at 2. In a session signed in below a role's level, that role __steps down__: the person acts without it, and a banner offers passkey sign-in or enrolment (`AuthManager.rolesAtSignIn`, applied in `src/app.ts`). A level set in `app-custom-config.json` that no enabled factor can reach refuses to boot; a shipped or add-on default degrades instead (`RoleManager.operatorRequiredAal`, `src/managers/RoleManager.ts`).
- __Not built:__ TOTP ([#421](https://github.com/jwilleke/ngdpbase/issues/421); the credentials store has a `totp` kind in `src/providers/BaseCredentialsProvider.ts`, but there is no `TotpAuthProvider`) and the second-factor sign-in flow (part of [#1523](https://github.com/jwilleke/ngdpbase/issues/1523)).
- __Built since this draft (2026-10-04):__ __step-up re-authentication__ ([#1525](https://github.com/jwilleke/ngdpbase/issues/1525), closed). `ngdpbase.auth.step-up` lists permissions that ask for a fresh factor within `max-age-minutes` (default 5) even inside a valid session; the prompt is `/auth/reauth`, and every prompt and outcome is audited. Core ships `account-security`, `config-manage`, `secret-reveal` and `token-mint`. Add-ons extending that list was added in [ngdpbase#1613](https://github.com/jwilleke/ngdpbase/pull/1613) (merged 2026-10-04, `7d119b6c`).
- ngdpbase is not yet an OpenID Connect provider; that is the planned `OidcManager` epic ([#1578](https://github.com/jwilleke/ngdpbase/issues/1578)).

### Requirements

- __Low assurance (AAL1):__ magic link and Google sign-in stay sufficient for members, donors and board members: paying, giving, registering, viewing own history, viewing board summaries.
- __High assurance:__ the actions marked "High assurance" in section 6 require a sign-in at AAL2 or above (`acr` of `aal2`, `aal3`, `phr` or `phrh`): refunds; editing or voiding posted transactions and posting into a locked period; exports; changing Stripe keys and receipt settings; role changes; issuing or reissuing donation statements; approving and paying reimbursements; finalizing a handover.
- __Decided ([D-009](plans/decisions.md#d-009-treasurer-requires-aal2-like-admin-roles)):__ the `treasurer` role has `required-aal: 2`, the same as ngdpbase's `admin` and `user-admin`. A treasurer signed in below AAL2 (magic link, Google) steps down to their other roles until they sign in at AAL2. Any factor combination ngdpbase rates AAL2 qualifies: a passkey today, password plus TOTP once available.
- __Step-up on money actions (decided, [D-022](plans/decisions.md#d-022-sign-in-strength-stays-on-roles-money-permissions-use-step-up); off for now, [D-030](plans/decisions.md#d-030-step-up-off-for-accountings-money-actions-for-now)):__ the money permissions (`ledger-adjust`, `receipt-refund`, `ledger-export`, `statement-issue`) carry `"step-up": true` on their permission entries, so each asks for a fresh sign-in within `ngdpbase.auth.step-up.max-age-minutes` at the strength the person's roles require. There is no per-permission sign-in strength; granting a money permission to another role is a recorded `config-change`.
- Delegated credentials (agent tokens, share links) never satisfy a high-assurance permission; #1525 already states this for step-up.
- Each step-up prompt, success and refusal is audited.

### TOTP caveat

Under ngdpbase's factor rules, TOTP (`amr: ["otp"]`, AAL1, not primary in the planned configuration) reaches AAL2 only when combined with a factor of another type, such as a password. Magic link plus TOTP stays at AAL1 (both are "have" factors, and email never lifts). For organizations that sign in by magic link or Google, __passkeys are the practical high-assurance factor__, and passkeys require an explicit HTTPS base URL.

## 8. Data retention and board memory

- All financial records, statements, handover records and the audit trail belong to the organization and are stored in the add-ons' own data, never in a user's private vault (consistent with `docs/system-category.md`).
- Removing a user or role never removes records they created; records keep the actor's name as it was.
- Retention: keep transactions, statements and audit records for a configurable period, default 7 years (to confirm with an accountant; requirements vary by country and organization type). No automatic deletion in Phase 1.
- Disabling an add-on must not lose data; re-enabling restores it.
- Data must be included in the ngdpbase backup (`BackupManager`, `src/managers/BackupManager.ts`) and exportable in an open format, so an organization can leave.
- Board memory pages (handover records, annual summaries, treasurer notes) could be wiki pages in an add-on-owned system-category. ngdpbase documents add-on-declared system-categories as the target design, but the add-on guide says that until [#1507](https://github.com/jwilleke/ngdpbase/issues/1507) lands an add-on cannot declare a vault of its own (`docs/guides/addons-developer-guide.md`, "Declare a Private Store").

## 9. Privacy and security

- __PII:__ names, emails, addresses, phone numbers, membership status. Shown only to people with the matching permission; board summaries are aggregate by default.
- __Donor data:__ individual donations are sensitive. Support anonymous donations. Donor-level views and exports need `ledger-read` or `ledger-export`.
- __No payer card or bank data stored.__ Card and bank receipts go through Stripe-hosted pages or fields; store only Stripe object ids and, at most, display details Stripe returns (such as card brand and last four), if needed.
- __The organization's own bank accounts__ carry their routing and account numbers. The account number is a secret, referenced from config as `$VAR`; only `fund-manage` holders see it in full, and it never goes into logs, audit events or exports ([D-031](plans/decisions.md#d-031-bank-accounts-cash-on-hand-and-deposits)).
- __Provider events:__ fetch events from the provider over an authenticated outbound call (`guardedFetch`), process each event id once, and fetch the authoritative object from the provider where it matters. There is no inbound webhook ([D-003](plans/decisions.md#d-003-learn-payment-outcomes-by-asking-not-by-webhook)).
- __Secrets:__ receipt provider keys are environment variables, referenced from config as `$VAR`, never literals in a JSON file ([D-008](plans/decisions.md#d-008-where-secret-values-live)). They are named in `ngdpbase.config.secret-keys` so the admin screen masks them; never log them. Changing one is an operator action: change the environment, then restart.
- __Outbound HTTP__ to Stripe goes through `guardedFetch` (`addons/README.md`); the egress policy must allow it.
- __CSRF:__ every browser POST carries the CSRF token. There are no exceptions; receipts need no inbound route ([D-003](plans/decisions.md#d-003-learn-payment-outcomes-by-asking-not-by-webhook)).
- __Encryption at rest:__ the ledger lives in ngdpbase's database ([D-010](plans/decisions.md#d-010-ledger-data-lives-in-ngdpbases-database)), encrypted with SQLCipher when `NGDPBASE_DATABASE_KEY` is set in the environment. Without the key it is plain SQLite and boot warns.
- __Audit:__ all high-assurance actions, exports, settings changes and failed provider syncs are audited.
- __Least privilege:__ the admin role does not get donor-level detail by default.

## 10. Integration notes

These notes describe intent only. Specific API calls, fields and file formats must be checked against current vendor documentation before implementation; nothing below was verified for this draft.

### Stripe

- Use a Stripe-hosted checkout (for example Stripe Checkout) for cards and US bank accounts (ACH), so the server never handles card or bank details.
- Stripe's Events API, polled on a schedule, is the source of truth for receipt success, failure, ACH settlement, refunds and disputes ([D-003](plans/decisions.md#d-003-learn-payment-outcomes-by-asking-not-by-webhook)).
- Use Stripe test mode in development and acceptance tests.
- Record Stripe's processing fees so payouts can be reconciled (how to obtain fee amounts is to be confirmed in Stripe's documentation).
- Open: whether to use the Stripe Node SDK or call Stripe's REST API through `guardedFetch`. The SDK makes its own HTTP requests, which may conflict with ngdpbase's `lint:http` boundary check (`addons/README.md`).

### QuickBooks

- Provide a CSV export shaped for import into QuickBooks Online; QuickBooks Desktop may need a different format. The exact import formats and column requirements must be verified.
- Map ledger funds to a QuickBooks dimension (for example classes or locations, depending on plan) and categories to QuickBooks accounts, through a mapping table the treasurer maintains.
- A direct API integration is out of scope for Phase 1.

### Wave

- Provide a CSV export shaped for Wave's transaction import. The exact format must be verified, as must how Wave can represent funds.
- A direct API integration is out of scope for Phase 1.

### Generic CSV

- Always available: one row per transaction with every ledger field, plus a fund summary CSV.

## 11. Dependencies on ngdpbase core

| Need | Status in ngdpbase | Needed for |
| --- | --- | --- |
| `treasurer`, `board`, `member` roles | Possible today through `ngdpbase.roles.definitions` in configuration; no code change | All modules |
| Assurance-gated permissions (step-up) | Built: [#1525](https://github.com/jwilleke/ngdpbase/issues/1525), closed 2026-10-04 | Optional recent-factor check (section 7) |
| Add-ons can add permissions to the step-up list | Fixed in [ngdpbase#1613](https://github.com/jwilleke/ngdpbase/pull/1613) (merged 2026-10-04, `7d119b6c`): `ngdpbase.auth.step-up.permissions` becomes a set that every layer extends | Optional recent-factor check (section 7) |
| Alternative: an assurance condition on policies (`Policy.ts`, `PolicyEvaluator`) | Not built; only `role` subjects are matched | Only if step-up is not the chosen mechanism |
| TOTP | Not built: [#421](https://github.com/jwilleke/ngdpbase/issues/421) | A second high-assurance option (password plus TOTP only) |
| Passkeys | Built ([#448](https://github.com/jwilleke/ngdpbase/issues/448)); needs an explicit HTTPS base URL | Treasurer AAL2 ([D-009](plans/decisions.md#d-009-treasurer-requires-aal2-like-admin-roles)) |
| Webhook ingress for add-ons | Not needed: receipts are polled, not pushed ([D-003](plans/decisions.md#d-003-learn-payment-outcomes-by-asking-not-by-webhook)) | n/a |
| Add-ons can add keys to `ngdpbase.config.secret-keys` | Bug [ngdpbase#1612](https://github.com/jwilleke/ngdpbase/issues/1612); fixed in [ngdpbase#1613](https://github.com/jwilleke/ngdpbase/pull/1613) (merged 2026-10-04, `7d119b6c`): becomes a set that every layer extends ([D-008](plans/decisions.md#d-008-where-secret-values-live)) | Payment provider keys |
| Scheduled jobs | Built: recurring schedules in the site's time zone, catch-up, a job shipped paused, and jobs that act under their own policy ([ngdpbase#1611](https://github.com/jwilleke/ngdpbase/issues/1611), [#1998](https://github.com/jwilleke/ngdpbase/issues/1998), [#1999](https://github.com/jwilleke/ngdpbase/issues/1999)) | The monthly invoice run ([#11](https://github.com/jwilleke/ngdp-accounting-addons/issues/11), [D-002](plans/decisions.md#d-002-recurring-jobs-come-from-ngdpbase-core)); receipt sync later |
| Add-on-owned system-category and vault | Planned, [#1507](https://github.com/jwilleke/ngdpbase/issues/1507) | Board memory pages (Phase 2) |
| Add-on tables and migrations in `DatabaseManager` | Not supported or documented. To be worked out on the one path, `DatabaseManager` → `SqliteDatabaseProvider` ([#13](https://github.com/jwilleke/ngdp-accounting-addons/issues/13), [D-011](plans/decisions.md#d-011-one-path-to-the-database)) | Ledger storage |
| Consistent database backup and restore | Not built: `DatabaseManager` has no `backup()`, so no database is in ngdpbase backups ([ngdpbase#1723](https://github.com/jwilleke/ngdpbase/issues/1723), P1; parent [#1536](https://github.com/jwilleke/ngdpbase/issues/1536)) | Ledger backups ([D-010](plans/decisions.md#d-010-ledger-data-lives-in-ngdpbases-database)) |
| Changing the database key; encrypting an existing plain database | Not supported ([#14](https://github.com/jwilleke/ngdp-accounting-addons/issues/14)) | Key rotation, for example at a handover |
| Add-on audit event names | Being fixed by [ngdpbase#1638](https://github.com/jwilleke/ngdpbase/issues/1638) (P0): every audit event becomes a permission, declared once in `ngdpbase.permissions.definitions` with its `audit` and `step-up` rules; add-ons declare theirs in their own config ([D-014](plans/decisions.md#d-014-every-action-is-a-permission-with-one-audited-door-no-money-moves-without-a-record)) | Audit trail; blocks the MVP |

## 12. Phasing

- __Phase 1:__ the `accounting` add-on (MVP: funds, ledger, audit, monthly summary and CSV) first, then Receipts (by hand before Stripe), Dues, Donations, Events, Reports. Treasurer at `required-aal: 2` ([D-009](plans/decisions.md#d-009-treasurer-requires-aal2-like-admin-roles)).
- __Phase 2:__ Reimbursements, Treasurer handover.

## 13. Open questions

1. __Prior plans:__ supersede, narrow or keep ngdpbase [#486](https://github.com/jwilleke/ngdpbase/issues/486) (double-entry accounting add-on) and the `financial-ledger` add-on mentioned in `addons/README.md`?
2. __License:__ decided: Apache License 2.0, the same as ngdpbase ([D-019](plans/decisions.md#d-019-apache-license-20-the-same-as-ngdpbase)).
3. __Slugs and layout:__ decided: base `accounting` plus `accounting-<module>` add-ons ([D-016](plans/decisions.md#d-016-one-repository-a-base-accounting-add-on-and-optional-module-add-ons)).
4. __Step-up approach:__ decided: treasurer role at `required-aal: 2`, step-up on the money permissions, no per-permission sign-in strength ([D-022](plans/decisions.md#d-022-sign-in-strength-stays-on-roles-money-permissions-use-step-up)). Still open: should core gain an assurance condition on policies?
5. __Treasurer role:__ decided: the `accounting` add-on ships `treasurer` at `required-aal: 2`; no `board` role; report pages use `audience` ([D-021](plans/decisions.md#d-021-mvp-roles-and-report-pages-treasurer-only-reports-use-page-audience)).
6. __TOTP:__ is passkey-only acceptable for high assurance until TOTP lands, given that TOTP with magic link stays at AAL1?
7. __Storage:__ decided: for the MVP, accounting has its own SQLite database file, opened through `DatabaseManager` → `SqliteDatabaseProvider` ([D-012](plans/decisions.md#d-012-mvp-accounting-has-its-own-database-file)). Key: shared `NGDPBASE_DATABASE_KEY` for now. Open: file location.
8. __Membership tiers and access roles:__ should paying dues grant an ngdpbase role (for example `member`) automatically, and remove it when lapsed?
9. __Admin access to donor detail:__ default no? Separation of duties between admin and treasurer?
10. __Stripe fees:__ record gross plus a fee expense, or net?
11. __Stripe account model:__ one Stripe account per organization with keys entered by the admin, or Stripe Connect? (Affects onboarding and any platform fee.)
12. __Events:__ build on the ngdpbase `calendar` and `forms` add-ons, or stand alone?
13. __Donation statements:__ which countries first (US only?), and who supplies the statement wording?
14. __Core issues:__ scheduled jobs is ngdpbase#1611; secret-keys and step-up extension are fixed in [ngdpbase#1613](https://github.com/jwilleke/ngdpbase/pull/1613).
15. __Distribution:__ private npm package on GitHub Packages (recommended in `docs/platform/deployment/addon-packaged.md`), or a drop-in directory? Whatever is chosen must cover bare metal, Docker and Kubernetes ([D-006](plans/decisions.md#d-006-every-add-on-runs-on-bare-metal-docker-and-kubernetes)).
