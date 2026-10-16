# ngdp-accounting-addons

Add-ons for [ngdpbase](https://github.com/jwilleke/ngdpbase) that give small organizations dues, payments, donations, fund tracking, event fees and treasurer reports, all in the same wiki where they keep the rest of their records.

__Status:__ the base `accounting` add-on (the MVP) is built and in testing: funds, a ledger with
voids and transfers, the treasurer's screens, a monthly summary and CSV export. The module add-ons
(dues, donations, events) are not built yet.

__Requires:__ ngdpbase v5.12.0 or later.

## Who it is for

Clubs first, then churches and associations: groups run by volunteers whose officers change every year or two.

## Why

- __Replace WildApricot.__ Its price increases and billing by contact count push small groups away. These add-ons run on the organization's own ngdpbase site, with no per-contact pricing.
- __Keep board memory.__ Dues history, giving records, fund balances and the treasurer's notes stay with the organization when officers change, not in one person's spreadsheet or inbox.
- __Stay small on purpose.__ This is not a full accounting package. The books of record live in QuickBooks or Wave, and these add-ons export to them.

## Modules

| Phase | Module | What it does |
| --- | --- | --- |
| 1 | Dues and invoicing | Membership tiers, renewal dates, automatic reminders, paid or lapsed status |
| 1 | Payments | Stripe for cards and ACH, plus manual recording of cash and checks |
| 1 | Donations and giving statements | Year-end tax receipts for each donor |
| 1 | Fund tracking | Every transaction is tagged to a fund (general, building, youth, an event) |
| 1 | Event fees and registrations | Paid sign-ups that post to the same ledger |
| 1 | Treasurer reports and export | Monthly income and expense summary for board meetings; CSV and QuickBooks export |
| 2 | Expense reimbursements | Requests with treasurer approval |
| 2 | Treasurer handover | A handover record tied to board memory |

All modules share one small, single-entry, fund-tagged transaction ledger with an audit trail.

## Non-goals

- Payroll
- Accounts payable
- A full double-entry general ledger (use QuickBooks or Wave for that)
- Storing card or bank account numbers (Stripe holds them)

## Requirements

See [docs/requirements.md](docs/requirements.md) for goals, personas, per-module requirements, the ledger model, roles and permissions, step-up authentication, and open questions.

## Relationship to ngdpbase

These are ngdpbase add-ons: each one exports an `AddonModule` with a `register(engine, config)` function and declares its own permissions and policies, as described in the ngdpbase add-on guide (`docs/guides/addons-developer-guide.md` in ngdpbase). Some requirements depend on ngdpbase core work that is not built yet; requirements.md lists it.

## License

[Apache License 2.0](LICENSE), the same as ngdpbase ([D-019](docs/plans/decisions.md#d-019-apache-license-20-the-same-as-ngdpbase)).
