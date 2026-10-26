# ngdp-accounting-addons

Add-ons for [ngdpbase](https://github.com/jwilleke/ngdpbase) that give small organizations receipts, fund tracking, invoices (assessments, rent or dues), donations and treasurer reports, all in the same wiki where they keep the rest of their records.

__Status:__ three add-ons are built and published to npm:

| Add-on | npm | What it does |
| --- | --- | --- |
| [`accounting`](addons/accounting/README.md) | `@jwilleke/accounting-addon` | Funds, one ledger of money in and out with voids, transfers and refunds, receipts (R-numbers) recorded by hand, bank accounts and deposits, bounced checks, period locks, the treasurer's screens, a monthly summary and CSV export |
| [`accounting-receivables`](addons/accounting-receivables/README.md) | `@jwilleke/accounting-receivables-addon` | Invoices for each unit's charge (a condominium's assessments, a landlord's rent, a club's dues): one per billing address, payments, credits, late charges, a monthly scheduled run, PDF invoices, and each owner's own account on their profile |
| [`accounting-donations`](addons/accounting-donations/README.md) | `@jwilleke/accounting-donations-addon` | Donations on receipts with the quid pro quo disclosure, in-kind donations, pledges, donors as ngdpbase contacts, year-end donation statements (PDF), and each donor's own donations on their profile |

Not built yet: online payments (Stripe), membership tiers and renewals, event fees, the board report, QuickBooks and Wave export, and the Phase 2 modules; see [TODO.md](TODO.md).

- Setting it up on a site: [docs/guides/accounting-guide.md](docs/guides/accounting-guide.md), the [donations guide](docs/guides/donations-guide.md) and the [chart of accounts guide](docs/guides/chart-of-accounts-guide.md)
- The ledger's API for other add-ons: [docs/managers/LedgerManager.md](docs/managers/LedgerManager.md)
- Every decision and why: [docs/plans/decisions.md](docs/plans/decisions.md)

__Requires:__ ngdpbase v5.31.0 or later. The invoices read units, owners and billing addresses from the `accommodation` add-on ([ngdpbase-addons](https://github.com/jwilleke/ngdpbase-addons)).

## Who it is for

Clubs first, then churches and associations: groups run by volunteers whose officers change every year or two.

## Why

- __Replace WildApricot.__ Its price increases and billing by contact count push small groups away. These add-ons run on the organization's own ngdpbase site, with no per-contact pricing.
- __Keep board memory.__ Dues and assessment history, donation records, fund balances and the treasurer's notes stay with the organization when officers change, not in one person's spreadsheet or inbox.
- __Stay small on purpose.__ This is not a full accounting package. The books of record live in QuickBooks or Wave, and these add-ons export to them.

## Modules

| Phase | Module | What it does | State |
| --- | --- | --- | --- |
| 1 | Fund tracking | Every transaction is tagged to a fund (general, building, youth, an event) | Built (`accounting`) |
| 1 | Receipts | Money coming in, recorded by hand (cash, check, bank transfer); Stripe for cards and ACH later | By hand: built. Stripe: deferred |
| 1 | Invoices | Each unit's assessments (or rent, or dues): invoices, payments, credits, late charges | Built (`accounting-receivables`) |
| 1 | Donations and donation statements | Year-end tax receipts for each donor | Built (`accounting-donations`) |
| 1 | Treasurer reports and export | Monthly income and expense summary for board meetings; CSV, QuickBooks and Wave export | Summary and CSV: built. QuickBooks and Wave: deferred |
| 1 | Memberships | Membership tiers, renewal dates, automatic reminders, paid or lapsed status | Deferred |
| 1 | Event fees and registrations | Paid sign-ups that post to the same ledger | Deferred |
| 2 | Expense reimbursements | Requests with treasurer approval | Deferred |
| 2 | Treasurer handover | A handover record tied to board memory | Deferred |

All modules share one small, single-entry, fund-tagged transaction ledger with an audit trail.

## Non-goals

- Payroll
- Accounts payable
- A full double-entry general ledger (use QuickBooks or Wave for that)
- Storing card or bank account numbers (Stripe holds them)

## Requirements

See [docs/requirements.md](docs/requirements.md) for goals, personas, per-module requirements, the ledger model, roles and permissions, step-up authentication, and open questions.

## Relationship to ngdpbase

These are ngdpbase add-ons: each one exports an `AddonModule` with a `register(engine, config, host)` function and declares its own permissions and policies, as described in the ngdpbase add-on guide (`docs/guides/addons-developer-guide.md` in ngdpbase). Some requirements depend on ngdpbase core work that is not built yet; requirements.md lists it.

## License

[Apache License 2.0](LICENSE), the same as ngdpbase ([D-019](docs/plans/decisions.md#d-019-apache-license-20-the-same-as-ngdpbase)).
