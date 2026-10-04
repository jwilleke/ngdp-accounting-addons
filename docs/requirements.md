# Requirements: ngdp-accounting-addons

__Status:__ draft for review, 2026-10-03. Nothing here is built.

This document describes a suite of ngdpbase add-ons for small organizations: clubs first, then churches and associations. Where it refers to ngdpbase, it cites files on `main` of [jwilleke/ngdpbase](https://github.com/jwilleke/ngdpbase) as of commit `817ca75` (2026-10-03). Where ngdpbase does not yet provide something, it says so.

## 1. Goals and non-goals

### Goals

- Replace WildApricot for small organizations put off by its price increases and per-contact billing.
- Keep __board memory__: financial records, giving history and the treasurer's working notes belong to the organization and survive officer changes.
- Cover the money tasks a volunteer treasurer does every month: collect dues, take payments and donations, track money by fund, run event sign-ups, report to the board, and hand the numbers to the real books.
- Keep accounting deliberately small. The books of record stay in QuickBooks or Wave; these add-ons export to them.
- Protect higher-risk actions (refunds, voids, exports, payment settings, role changes, tax receipts) with stronger sign-in than everyday member actions.

### Non-goals (Phase 1)

- Payroll.
- Accounts payable (bills, vendors, scheduled payments).
- A double-entry general ledger, chart of accounts, balance sheet or trial balance.
- Bank feeds or automatic bank reconciliation.
- Storing card numbers or bank account numbers.
- Multi-currency, and more than one organization per ngdpbase instance.
- Tax filing (for example US Form 990). Reports support the person who files; they do not file.

### Relationship to earlier ngdpbase plans

ngdpbase already has an open, deferred issue for a generic accounting add-on, [#486](https://github.com/jwilleke/ngdpbase/issues/486), planned in `docs/planning/plan-addon-accounting.md` as a __double-entry__ ledger with chart of accounts, AR and AP. `addons/README.md` also points to a double-entry `financial-ledger` add-on in `fairways-gen2-website`. This suite deliberately takes the opposite approach (single-entry, fund-tagged, no AP). Whether #486 is superseded, narrowed, or kept for a later, fuller product is an open question (section 13).

## 2. Personas

| Persona | Who they are | What they need |
| --- | --- | --- |
| __Treasurer__ | Volunteer officer, often not an accountant, serving one or two years | Record money quickly, chase lapsed dues, produce a board report and year-end receipts, hand off cleanly |
| __Board member__ | President, secretary, other officers | See fund balances and the monthly summary; approve things; trust the numbers without seeing every donor |
| __Member__ | Pays dues, registers for events | Pay online, see their own status and history, get reminders and receipts |
| __Donor__ | May or may not be a member; may never sign in | Give online or by check, receive a correct year-end giving statement |
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

### Proposed add-on layout (to confirm)

One repository with several add-ons, each with its own slug, permissions and routes, all depending on a shared ledger add-on:

| Slug (proposed) | Phase | Contents | Depends on |
| --- | --- | --- | --- |
| `org-ledger` | 1 | Transaction ledger, funds, audit trail, shared settings, base permissions | none |
| `org-dues` | 1 | Tiers, memberships, invoices, reminders | `org-ledger` |
| `org-payments` | 1 | Stripe integration, manual cash and check entry, refunds | `org-ledger` |
| `org-donations` | 1 | Donations, giving statements, tax receipts | `org-ledger`, `org-payments` |
| `org-events` | 1 | Paid registrations | `org-ledger`, `org-payments` |
| `org-reports` | 1 | Treasurer reports, CSV and QuickBooks/Wave export | `org-ledger` |
| `org-reimbursements` | 2 | Expense reimbursement requests and approvals | `org-ledger` |
| `org-handover` | 2 | Treasurer handover record | `org-ledger` |

The slugs are placeholders. Slugs are hard to rename later (`docs/platform/addon-identity-contract.md`, "Renaming"), so choosing them is an open question.

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
| `party` | Who paid or was paid: a reference to an ngdpbase Person (`PersonManager`, `src/managers/PersonManager.ts`), or a free-text name |
| `method` | `stripe-card`, `stripe-ach`, `cash`, `check`, `other` |
| `reference` | Check number, Stripe object id, or other external reference |
| `source` | Link to what created it: `{ type: dues-invoice, donation, event-registration, reimbursement, manual, adjustment; id }` |
| `status` | `pending` (for example ACH not yet settled), `posted`, `voided` |
| `deductible` | For donations: the tax-deductible amount, and the value of goods or services received, if any |
| `memo` | Free text |
| `attachments` | Optional receipt or check images |
| `createdBy`, `createdAt` | Actor and time, from the request's context |
| `voids` / `voidedBy` | Links between a voided transaction and its correction |

### Fund

`id`, `name`, `description`, `restricted` (true when donors gave it for a specific purpose), `active`, `openingBalance` and `openingDate`. A fund's balance is its opening balance plus posted money in, minus posted money out. Funds can be closed but never deleted while transactions reference them.

### Rules

- __Posted transactions are not edited in place.__ A correction voids the original (with a required reason) and posts a replacement, linked both ways. Small non-financial fixes (memo, attachment) are allowed and audited.
- __Nothing financial is hard-deleted.__ Voided transactions stay visible in history and exports.
- __Audit trail.__ Every create, post, void, edit, refund, export and settings change is recorded with actor, time, before and after values, and reason. Use ngdpbase's audit path (`recordAuditEvent` in `src/utils/auditEvents.ts`, `docs/guides/audit-developer-guide.md`) and also keep the ledger's own append-only change history, so the record survives with the add-on's data.
- __Processing fees.__ Stripe fees are recorded so deposits reconcile (proposed: gross amount as income, fee as a separate `out` transaction in the same fund; see open questions).
- __Period lock (optional).__ The treasurer can lock a month after the board report; posting into a locked month needs the high-assurance void and adjust permission.
- __No double entry.__ There are no accounts, debits or credits. The export carries enough detail for the real books to do that.

## 5. Module requirements

### 5.1 Dues and invoicing (Phase 1)

__Requirements:__

- Define membership tiers: name, price, term (annual, semiannual, monthly, lifetime), optional proration and grace period.
- Each membership links a Person to a tier, with a start date, renewal date and status: `active`, `due`, `grace`, `lapsed`, `cancelled`.
- Generate an invoice at renewal (or on demand) and post it as payable; a paid invoice creates a ledger transaction tagged to the configured fund.
- Send reminders by email before the renewal date, on the due date, and after (schedule configurable), through `EmailManager` (`src/managers/EmailManager.ts`). Members can stop non-essential reminders.
- Show members their own status, invoices and payment history; let them pay online.
- Show the treasurer a roster filtered by status, with bulk reminder sending.

__Acceptance criteria:__

- [ ] A treasurer can create tiers and assign members to them.
- [ ] Status moves from active to due, grace and lapsed on the configured dates without manual work.
- [ ] Reminders go out on schedule, once each, and each send is logged.
- [ ] Paying an invoice (online or recorded manually) marks it paid, renews the membership, and posts one ledger transaction.
- [ ] A member sees only their own invoices.

### 5.2 Payments (Phase 1)

__Requirements:__

- Take card and ACH payments through Stripe, using a Stripe-hosted payment page or Stripe-hosted fields so card and bank details never reach the ngdpbase server.
- Receive payment results by Stripe webhook, verify the signature, and process each event once.
- Record cash and check payments manually: amount, date, payer, check number, fund, and a link to the invoice, donation or registration it pays.
- Record deposits of cash and checks as a batch (optional in Phase 1).
- Refund a Stripe payment fully or partly; record a manual refund for cash or check. A refund posts an `out` transaction linked to the original.
- Treat ACH as pending until Stripe reports it settled; handle a failed ACH by reverting the paid status and notifying the treasurer.

__Acceptance criteria:__

- [ ] A test-mode card payment and a test-mode ACH payment each produce exactly one posted transaction, even when Stripe delivers the webhook more than once.
- [ ] A webhook with a missing or invalid signature is rejected and logged, and changes nothing.
- [ ] No card number, CVC or bank account number is stored or logged anywhere.
- [ ] A refund requires the high-assurance refund permission and appears in the audit trail.
- [ ] A treasurer can record a check in under a minute.

### 5.3 Donations and giving statements (Phase 1)

__Requirements:__

- Take one-time and recurring donations online (via Payments) and record offline gifts (cash, check, in-kind).
- Each gift has a donor, date, amount, fund, deductible amount, and the value of any goods or services received.
- Support anonymous gifts (no name shown to the board) and donors who never sign in.
- Generate a year-end giving statement per donor: organization name and tax id, donor name, each gift with date and amount, totals, and the required wording for gifts with goods or services received. Wording is configurable; the organization is responsible for checking it with its accountant.
- Email statements in bulk, or download them, and keep a copy of each issued statement.
- Reissue a corrected statement, keeping the original and marking it superseded.

__Acceptance criteria:__

- [ ] Statement totals equal the sum of that donor's posted, non-voided gifts for the year.
- [ ] Issuing, reissuing or bulk-sending statements requires the high-assurance receipt permission.
- [ ] Each issued statement is stored, immutable, and linked to the gifts it covers.
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
- Registration form collects attendee details and payment; free events work without payment.
- Registrations post to the shared ledger through Payments.
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

- A member or officer submits a request: amount, date, purpose, fund, receipt images.
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
| `dues-self` | View and pay own dues and invoices | yes | | yes | yes | yes | no |
| `giving-self` | View own gifts and statements | yes | yes | yes | yes | yes | no |
| `event-register` | Register and pay for events | yes | yes | yes | yes | yes | no |
| `reimbursement-request` (Phase 2) | Submit and track own requests | yes | | yes | yes | yes | no |
| `ledger-summary-read` | Fund balances and monthly report, no donor names | | | yes | yes | yes | no |
| `handover-read` (Phase 2) | Read handover records | | | yes | yes | yes | no |
| `ledger-read` | Transaction detail, including names | | | | yes | optional | no |
| `ledger-record` | Record manual payments and gifts, create invoices, manage registrations | | | | yes | | no |
| `accounting-settings` | Tiers, funds, categories, reminder schedule, statement wording | | | | yes | yes | no (funds: open question) |
| `ledger-adjust` | Edit or void posted transactions, post into a locked period, fund transfers | | | | yes | | __yes__ |
| `payment-refund` | Refund payments | | | | yes | | __yes__ |
| `ledger-export` | CSV, QuickBooks and Wave export, donor lists | | | | yes | | __yes__ |
| `receipt-issue` | Issue, reissue or bulk-send tax statements | | | | yes | | __yes__ |
| `payment-settings` | Stripe keys, webhook secret, payment methods | | | | | yes | __yes__ |
| `reimbursement-approve` (Phase 2) | Approve, reject, mark paid | | | | yes | | __yes__ |
| `handover-manage` (Phase 2) | Create and finalize a handover | | | | yes | yes | __yes__ (finalize) |
| Role changes (core) | Grant or remove roles, including treasurer | | | | | yes (`admin`, `user-admin`) | __yes__ (core) |

Notes:

- A "donor" who never signs in has no role; their statement is emailed. `giving-self` applies only to donors with an account.
- Whether an admin who is not an officer should see donor-level detail is an open question. The table defaults to no.
- The add-ons' policies may name roles on day one (as the calendar and journal add-ons do), but add-on code never tests a role name.

## 7. Step-up authentication (acr)

### What ngdpbase has today

Checked against the code on 2026-10-03; `docs/planning/authentication.md` has the same status table.

- __Providers__ (`src/providers/`): password, magic link (`MagicLinkAuthProvider`), Google OIDC (`GoogleOIDCProvider`), passkey / WebAuthn (`PasskeyAuthProvider`), Cloudflare Access, Authentik bearer, agent tokens.
- __Assurance is computed per sign-in.__ Each provider declares `amr`, `aal` and `acr` (`src/providers/*`), configurable via `ngdpbase.auth.factors`, and `AuthManager.assess()` (`src/managers/AuthManager.ts`) combines them by NIST SP 800-63B. The session keeps a sign-in record (`req.session.signIn`, typed in `src/types/express.d.ts`) with `acr` as one of `phrh`, `phr`, `aal1`, `aal2`, `aal3`.
- __Levels by provider:__ magic link `amr: ["email"]`, AAL1, and email never lifts a sign-in above AAL1. Google OIDC is AAL1 with no `amr` unless configured to trust Google's reported values. Passkey `amr: ["swk","user"]`, AAL2, `acr: "phr"` (phishing-resistant).
- __Per-role required level is built.__ Each role in `ngdpbase.roles.definitions` can set `required-aal` (1 to 3); `admin` and `user-admin` ship at 2. In a session signed in below a role's level, that role __steps down__: the person acts without it, and a banner offers passkey sign-in or enrolment (`AuthManager.rolesAtSignIn`, applied in `src/app.ts`). A level set in `app-custom-config.json` that no enabled factor can reach refuses to boot; a shipped or add-on default degrades instead (`RoleManager.operatorRequiredAal`, `src/managers/RoleManager.ts`).
- __Not built:__ TOTP ([#421](https://github.com/jwilleke/ngdpbase/issues/421); the credentials store has a `totp` kind in `src/providers/BaseCredentialsProvider.ts`, but there is no `TotpAuthProvider`), the second-factor sign-in flow (part of [#1523](https://github.com/jwilleke/ngdpbase/issues/1523)), and __step-up re-authentication__ ([#1525](https://github.com/jwilleke/ngdpbase/issues/1525), open). The planned design is a fresh-factor check for listed permissions (`ngdpbase.auth.step-up`, default 5 minutes, in `docs/planning/authentication.md`); the issue body describes a `requireFreshAuth(maxAge)` guard. Neither exists yet.
- ngdpbase is not yet an OpenID Connect provider; that is the planned `OidcManager` epic ([#1578](https://github.com/jwilleke/ngdpbase/issues/1578)).

### Requirements

- __Low assurance (AAL1):__ magic link and Google sign-in stay sufficient for members, donors and board members: paying, giving, registering, viewing own history, viewing board summaries.
- __High assurance:__ the actions marked "High assurance" in section 6 require a sign-in at AAL2 or above (`acr` of `aal2`, `aal3`, `phr` or `phrh`): refunds; editing or voiding posted transactions and posting into a locked period; exports; changing Stripe keys and payment settings; role changes; issuing or reissuing tax receipts; approving and paying reimbursements; finalizing a handover.
- __Stage 1 (works with today's ngdpbase):__ define `treasurer` with `required-aal: 2` in `app-custom-config.json`. A treasurer signed in by magic link or Google steps down to their other roles and cannot reach treasurer actions until they sign in with a passkey. This is coarse (all treasurer work needs a passkey, not only high-risk actions), but needs no core change.
- __Stage 2 (needs #1525):__ the treasurer role can drop to AAL1 for routine work, and only the high-assurance permissions require a fresh AAL2 factor within a short window. The add-ons must be able to add their own permissions to the step-up list from their `config/default-config.json`.
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
- __Donor data:__ individual gifts are sensitive. Support anonymous gifts. Donor-level views and exports need `ledger-read` or `ledger-export`.
- __No card or bank data stored.__ Payments go through Stripe-hosted pages or fields; store only Stripe object ids and, at most, display details Stripe returns (such as card brand and last four), if needed.
- __Stripe webhooks:__ verify every event's signature with the endpoint's signing secret before acting, reject on failure, process each event id once, and fetch the authoritative object from Stripe where it matters. Follow Stripe's current webhook documentation.
- __Secrets:__ Stripe secret key and webhook secret come from environment variables, referenced in configuration in `$VAR` form so `ConfigurationManager` masks them (`getMaskedProperty`, `ngdpbase.config.secret-keys` in `src/managers/ConfigurationManager.ts`). Never log them. Changing them is a high-assurance action.
- __Outbound HTTP__ to Stripe goes through `guardedFetch` (`addons/README.md`); the egress policy must allow it.
- __CSRF:__ every browser POST carries the CSRF token. The webhook route is the only exception and is protected by the signature instead; this needs core support (section 11).
- __Encryption at rest:__ if the ledger uses `DatabaseManager` with SQLCipher, data is encrypted when `NGDPBASE_DATABASE_KEY` is set. JSON files under `dataPath` are not encrypted by ngdpbase. Choice is an open question.
- __Audit:__ all high-assurance actions, exports, settings changes and failed webhook verifications are audited.
- __Least privilege:__ the admin role does not get donor-level detail by default.

## 10. Integration notes

These notes describe intent only. Specific API calls, fields and file formats must be checked against current vendor documentation before implementation; nothing below was verified for this draft.

### Stripe

- Use a Stripe-hosted payment flow (for example Stripe Checkout) for cards and US bank accounts (ACH), so the server never handles card or bank details.
- Webhooks are the source of truth for payment success, failure, ACH settlement, refunds and disputes.
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
| Assurance-gated permissions (step-up) | Not built: [#1525](https://github.com/jwilleke/ngdpbase/issues/1525), open | Stage 2 of section 7 |
| Add-ons can add permissions to the step-up list | Not designed. Note that in the add-on merge layer plain arrays replace wholesale (`addons/README.md`), so a plain-array step-up list would let one add-on overwrite core's list | Stage 2 |
| Alternative: an assurance condition on policies (`Policy.ts`, `PolicyEvaluator`) | Not built; only `role` subjects are matched | Only if step-up is not the chosen mechanism |
| TOTP | Not built: [#421](https://github.com/jwilleke/ngdpbase/issues/421) | A second high-assurance option (password plus TOTP only) |
| Passkeys | Built ([#448](https://github.com/jwilleke/ngdpbase/issues/448)); needs an explicit HTTPS base URL | Stage 1 |
| Webhook ingress for add-ons: raw request body, CSRF-exempt, unauthenticated route verified by signature | Not available. `express.json()` is applied globally in `src/app.ts` before add-ons load, and `src/middleware/csrf.ts` exempts only bearer requests and one search path | Payments (Stripe webhooks) |
| Scheduled jobs | `BackgroundJobManager` registers and runs jobs but has no recurring schedule; the journal add-on uses its own `setTimeout` (`addons/journal/index.ts`) | Dues reminders, ACH follow-up |
| Add-on-owned system-category and vault | Planned, [#1507](https://github.com/jwilleke/ngdpbase/issues/1507) | Board memory pages (Phase 2) |
| Add-on use of `DatabaseManager` tables and migrations | Not documented | Ledger storage, if SQLite is chosen |
| Add-on audit event names | To confirm in `docs/guides/audit-developer-guide.md` | Audit trail |

## 12. Phasing

- __Phase 1:__ `org-ledger` with funds and audit first, then Payments (manual entry before Stripe), Dues, Donations, Events, Reports. Step-up Stage 1 (treasurer at `required-aal: 2`).
- __Phase 2:__ Reimbursements, Treasurer handover, Step-up Stage 2 once #1525 lands.

## 13. Open questions

1. __Prior plans:__ supersede, narrow or keep ngdpbase [#486](https://github.com/jwilleke/ngdpbase/issues/486) (double-entry accounting add-on) and the `financial-ledger` add-on mentioned in `addons/README.md`?
2. __License__ for this repository (README TODO). Also, should ngdpbase fix its own `LICENSE` (Apache 2.0) versus `package.json` (`ISC`) mismatch?
3. __Slugs and layout:__ one add-on or several? Final slug names?
4. __Step-up approach:__ start with treasurer at `required-aal: 2` (works today, passkey for all treasurer work), or wait for #1525 for per-action step-up? Should core gain an assurance condition on policies instead?
5. __Should the add-on ship the `treasurer` role definition__ in its `config/default-config.json`, or leave it to each deployment? A role level shipped by an add-on degrades silently when no factor can reach it; one set by the operator refuses to boot.
6. __TOTP:__ is passkey-only acceptable for high assurance until TOTP lands, given that TOTP with magic link stays at AAL1?
7. __Storage:__ JSON files under `dataPath` (like calendar) or SQLite through `DatabaseManager` (encrypted with SQLCipher if keyed)?
8. __Membership tiers and access roles:__ should paying dues grant an ngdpbase role (for example `member`) automatically, and remove it when lapsed?
9. __Admin access to donor detail:__ default no? Separation of duties between admin and treasurer?
10. __Stripe fees:__ record gross plus a fee expense, or net?
11. __Stripe account model:__ one Stripe account per organization with keys entered by the admin, or Stripe Connect? (Affects onboarding and any platform fee.)
12. __Events:__ build on the ngdpbase `calendar` and `forms` add-ons, or stand alone?
13. __Tax receipts:__ which countries first (US only?), and who supplies the receipt wording?
14. __Who files the core issues__ in ngdpbase (step-up list contribution, webhook ingress, scheduled jobs)?
15. __Distribution:__ private npm package on GitHub Packages (recommended in `docs/platform/deployment/addon-packaged.md`), or a drop-in directory?
