---
name: Chart of accounts guide
description: The starter chart of accounts the accounting add-on ships, how it follows QuickBooks, and how a site changes it
dateModified: 2026-10-19
category: guides
relatedModules: [LedgerManager]
---

# Chart of accounts guide

For the site administrator, the treasurer, and the accountant who keeps the books of record. It
explains the income and expense categories the accounting add-on ships, why they look the way they
do, and how to change them. Turning the add-on on is in the [Accounting site guide](accounting-guide.md).

__This page is the source of truth for the chart of accounts.__ Any change to the shipped chart, its
types, its numbering or the categories with a job is made here first, and the code follows it: a
test (`addons/accounting/__tests__/chart.test.ts`) reads the table under
[The starter chart](#the-starter-chart) and fails if `ngdpbase.addons.accounting.categories` in
`addons/accounting/config/default-config.json` differs from it, and checks the defaults in
[Categories with a job](#categories-with-a-job) the same way.

## What the chart is for

Every receipt and every payment out names a __category__: what kind of income or expense it is. The
categories are the add-on's chart of accounts, and the monthly summary adds up income and expense by
category.

A category is separate from the two other labels on every entry:

- the __fund__ says what the money is for (General, the Roof Fund);
- the __account__ says where the money sits (Checking, Cash on Hand);
- the __category__ says what kind of money it is (dues, bank charges).

## It follows QuickBooks

No law fixes a chart of accounts in the United States, and there is no maintained official list
for small organizations. Accountants use the usual numbering and the starter chart of their
software, most often QuickBooks. QuickBooks fixes each account's __type__ and __detail type__, not
its number, so the add-on's chart carries both and numbers them the usual way
([D-034](../plans/decisions.md#d-034-a-generic-starter-chart-with-account-types)):

| Numbers | Type | QuickBooks type |
| --- | --- | --- |
| 4000s | `income` | Income |
| 5000s | `cost-of-goods` | Cost of Goods Sold |
| 6000s–7000s | `expense` | Expenses |
| 8000s | `other-income` | Other Income |
| 9000s | `other-expense` | Other Expense |

Names follow QuickBooks' detail types wherever one fits, so an accountant recognises them and an
export to QuickBooks or Wave ([#20](https://github.com/jwilleke/ngdp-accounting-addons/issues/20))
maps one to one. The chart is generic: it suits a club, a nonprofit or a small business.

## The starter chart

| Code | Name | Type | QuickBooks detail type |
| --- | --- | --- | --- |
| 4100 | Dues and memberships | income | Service/Fee Income |
| 4200 | Donations and gifts | income | Non-Profit Income |
| 4300 | Grants | income | Non-Profit Income |
| 4400 | Sales | income | Sales of Product Income |
| 4500 | Event and program fees | income | Service/Fee Income |
| 5100 | Supplies & Materials – COGS | cost-of-goods | Supplies & Materials – COGS |
| 6100 | Bank Charges | expense | Bank Charges |
| 6200 | Office Supplies & Software | expense | Office Supplies & Software |
| 6300 | Shipping, Freight & Delivery | expense | Shipping, Freight & Delivery |
| 6400 | Advertising/Promotional | expense | Advertising/Promotional |
| 6500 | Rent & Lease | expense | Rent & Lease |
| 6600 | Utilities | expense | Utilities |
| 6700 | Insurance | expense | Insurance |
| 6800 | Legal & Professional Fees | expense | Legal & Professional Fees |
| 6900 | Dues & Subscriptions | expense | Dues & Subscriptions |
| 7000 | Contractors | expense | Contractors |
| 7100 | Payroll Expenses | expense | Payroll Expenses |
| 7200 | Repair & Maintenance | expense | Repair & Maintenance |
| 7300 | Travel | expense | Travel |
| 7400 | Taxes & Licenses | expense | Taxes & Licenses |
| 7900 | Other Business Expenses | expense | Other Business Expenses |
| 8100 | Interest Earned | other-income | Interest Earned |
| 8900 | Other Miscellaneous Income | other-income | Other Miscellaneous Income |

Some lines are easy to mix up:

- __4100 Dues and memberships__ is dues members pay you; __6900 Dues & Subscriptions__ is dues and
  subscriptions the organization pays.
- __Software__ goes in 6200 Office Supplies & Software, as in QuickBooks.
- __Postage__ is 6300 Shipping, Freight & Delivery; printing flyers is 6400 Advertising/Promotional.
- __Interest the bank pays you__ is 8100, other income, not ordinary income.

The source for QuickBooks' types and detail types is a QuickBooks Online chart of accounts reference
(Dancing Numbers, a QuickBooks consultancy, 2026), checked against Intuit's help pages where
possible.

## Which categories each form offers

- __Record a Receipt__ offers the income types: `income` and `other-income`.
- __Record an Entry__ (money out) and the replacement on __Void an Entry__ offer the rest:
  `cost-of-goods`, `expense` and `other-expense`.
- A __refund__ uses the category of the receipt it refunds, so it lowers that income.
- __Transfers__ between funds and __deposits__ use no category from the chart; they move money
  without being income or expense, and the summary leaves them out.

## Categories with a job

Two categories have a job when a check bounces
([D-032](../plans/decisions.md#d-032-cleared-deposits-and-bounced-checks)), and each is named in
configuration:

| Setting | Default | Used for |
| --- | --- | --- |
| `ngdpbase.addons.accounting.bank-charges-category` | `6100` | the bank's fee for a returned check, and a fee the payer repays |
| `ngdpbase.addons.accounting.other-income-category` | `8900` | a penalty charged to the payer |
| `ngdpbase.addons.accounting.bounced-check-penalty` | `0` | the penalty the form fills in, in cents; 0 charges none |

At startup the add-on warns if either category is missing from the chart or has the wrong type
(bank charges must be an `expense`, other income an `other-income`). The bounced-check screens stay
off until both are right.

## Changing the chart

The chart lives in `ngdpbase.addons.accounting.categories`, a map keyed by code. The site's
`app-custom-config.json` changes it one code at a time; codes it does not mention stay as shipped.

```json
{
  "ngdpbase.addons.accounting.categories": {
    "4150": { "name": "Fundraising dinner", "type": "income", "detailType": "Service/Fee Income" },
    "6100": { "name": "Bank fees" },
    "4300": false
  }
}
```

That adds 4150, renames 6100 and removes 4300; the other 20 shipped categories stay.

__A condominium__ says "assessments", never "dues" (condominiums are told not to
use the word). Rename 4100 and drop what does not apply:

```json
{
  "ngdpbase.addons.accounting.categories": {
    "4100": { "name": "Assessments", "type": "income", "detailType": "Service/Fee Income" },
    "4400": false,
    "5100": false
  }
}
```

Every invoice, receipt, statement and report then says "Assessments". The dues module's own screens
and emails use its label setting for the same word
([D-035](../plans/decisions.md#d-035-dues-and-assessments-flexible-accounts-and-charges)).

- `name` is required. `type` is one of `income`, `other-income`, `cost-of-goods`, `expense` or
  `other-expense`. `detailType` is the QuickBooks detail type, and is optional.
- `false` (or `null`) removes a shipped category.
- The short form `"4100": "Dues"` still works: the type comes from the number (4000s income, and so
  on). Use the full form for a code outside those ranges.
- A code is letters, digits, dots or dashes, at most 32 characters. An entry the add-on cannot use
  is skipped, with a warning at startup that says why.
- Restart the site after changing it.

__Before removing or renumbering a category__, think about the entries already posted under it.
Entries keep the code they were recorded with; the summary then shows that code without a name.
Renaming is safe: entries show the new name.

## Accounts and what is not here

The chart holds income and expense only. In QuickBooks terms:

- the __accounts__ (Checking, Savings) are its Bank type, and __Cash on Hand__ is its Undeposited
  Funds: money received but not yet deposited;
- __receivables, payables, credit cards, loans and equity__ are not part of this ledger. It is a
  single-entry, cash-basis ledger: money counts when it moves. What a payer owes, such as after a
  bounced check, is tracked on its own until invoices arrive with dues
  ([#2](https://github.com/jwilleke/ngdp-accounting-addons/issues/2)).

The books of record stay with your accountant, in QuickBooks or Wave. Accounting hands them a CSV
of entries, each with its category code.

## Reporting maps

A nonprofit files IRS Form 990, and a business files its own tax forms; each has its own lines.
Mapping categories to those lines is optional and will come later, as a separate code set for each
kind of organization. It is never built into the categories themselves, so the chart stays the same
whatever the organization is.

## See also

- [Accounting site guide](accounting-guide.md): turning the add-on on, access, accounts
- [LedgerManager](../managers/LedgerManager.md): `categories()` and the form choices
- Decisions [D-023](../plans/decisions.md#d-023-categories-follow-the-unified-chart-of-accounts-ucoa),
  [D-032](../plans/decisions.md#d-032-cleared-deposits-and-bounced-checks) and
  [D-034](../plans/decisions.md#d-034-a-generic-starter-chart-with-account-types)
