---
name: Accounting site guide
description: Turning on the accounting add-on, giving the treasurer and the board access, and what it does not do yet
dateModified: 2026-10-18
category: guides
relatedModules: [LedgerManager, DatabaseManager, PolicyDecisionPoint, FormsAddon]
---

# Accounting site guide

For the administrator of an ngdpbase site who wants the treasurer to keep the organization's books in it. The treasurer's own how-to is the __Using Accounting__ page the add-on ships.

Accounting keeps funds and a ledger of money in and out. It is not a full accounting package: the books of record stay in QuickBooks or Wave, and accounting hands them a CSV.

## Before you start

- ngdpbase __5.31.0 or later__. The add-on declares this as its `minVersion`; an older core refuses to load it.
- The site's database on: `ngdpbase.database.provider` set to `sqlite`.
- The __forms__ add-on enabled. The treasurer's screens are forms; without it the ledger still works through the API and the `[{Ledger}]` plugin, but there is nothing to type into.
- `NGDPBASE_DATABASE_KEY` set in the site's environment or `.env`, so the ledger is encrypted. Without it the ledger is plain SQLite and the site warns at startup.

## Install it

From npm, once a release is published: ngdpbase installs the add-on itself, checks its sha512 and its provenance (it must have been built by this repository's publish workflow), and pins it. Installing does not enable it; the enable key below still decides. The site needs Node 24.15.0 or later. In `app-custom-config.json`:

```json
{
  "ngdpbase.addons.install": {
    "accounting": {
      "package": "@jwilleke/accounting-addon",
      "version": "^0.1.0",
      "repository": "github.com/jwilleke/ngdp-accounting-addons"
    }
  }
}
```

Or from a checkout: point the site's add-ons path at this repository's `addons/` folder after `npm install` and `npm run build` in `addons/accounting/`.

## Turn it on

In the site's `app-custom-config.json`:

```json
{
  "ngdpbase.database.provider": "sqlite",
  "ngdpbase.addons.forms.enabled": true,
  "ngdpbase.addons.accounting.enabled": true,
  "ngdpbase.addons.accounting.categories": {
    "4150": { "name": "Fundraising dinner", "type": "income", "detailType": "Service/Fee Income" },
    "6100": { "name": "Bank fees" },
    "4300": false
  },
  "ngdpbase.addons.accounting.accounts": {
    "checking": {
      "name": "Checking at First Bank", "kind": "bank", "default": true,
      "routing-number": "021000021", "account-number": "$CHECKING_ACCOUNT_NUMBER"
    },
    "savings": { "name": "Savings", "kind": "bank" }
  }
}
```

Restart the site. On first start the add-on creates its database (`accounting.db` in the data folder), seeds its pages, and logs `Ledger ready`.

The __categories__ are a starter chart that follows QuickBooks ([D-034](../plans/decisions.md#d-034-a-generic-starter-chart-with-account-types)): 4000s income, 5000s cost of goods, 6000s–7000s expenses, 8000s other income, each with QuickBooks' type and detail type, so an accountant recognises them. The example above adds one code, renames 6100 and removes 4300 (`false`); the rest of the shipped chart stays. Each category is `{ "name", "type", "detailType" }`, where type is `income`, `other-income`, `cost-of-goods`, `expense` or `other-expense`; the older `"4100": "Dues"` still works, its type read from the number. Receipts offer income categories; money out offers the rest. `ngdpbase.addons.accounting.bank-charges-category` (6100) and `.other-income-category` (8900) name the categories a bounced check uses; the add-on warns at startup if either is missing from the chart. The [Chart of accounts guide](chart-of-accounts-guide.md) lists the shipped categories and how to change them.

The __accounts__ say where the money sits; funds say what it is for ([D-031](../plans/decisions.md#d-031-bank-accounts-cash-on-hand-and-deposits)). One bank account holds money for several funds. The add-on ships one bank account, `checking` ("Checking"); rename it and add the others, keyed by an id of lowercase letters, digits and dashes. `false` removes the shipped one. The account marked `default` is where ACH, Zelle and bank transfers land and where money out comes from. __Cash on Hand__ is built in: cash, checks and card-reader receipts wait there until they are deposited. The treasurer then sets each account's opening balance on __Set an Account's Opening Balance__, so the accounts add up to the funds.

A bank account's `account-number` is always a `$VAR` reference: put the number itself in the site's `.env` (or a Kubernetes Secret) as `CHECKING_ACCOUNT_NUMBER=…`, never in the JSON file. If the variable is not set, the site will not start, and says which entry names it. ngdpbase hides every `accounts.*.account-number` as a secret (the add-on declares it), so it never shows on the admin screen or in a log. Screens show "Checking …1234"; the treasurer (`fund-manage`) can read the full numbers at `/api/accounting/accounts/<id>/numbers`, and every read is recorded in the audit log. The routing number is public (it names the bank) and is written as it is.

Entries recorded before accounts existed are in Checking. An account removed from the configuration while entries still name it is kept in the reports, marked "no longer configured", and the add-on warns at startup.

Money coming in is recorded as a __receipt__ through the manual provider (cash, checks, bank transfers), which is always on. Online providers will be added to `ngdpbase.addons.accounting.receiptproviders`; see [ReceiptManager](../managers/ReceiptManager.md).

If the database is off, the add-on starts nothing and says why on __Admin → Add-ons__.

The add-ons' forms are shipped with them and are read-only on the site. When an update raises an add-on's version, its forms replace the site's copies at the next start; nothing needs syncing by hand. A site that runs an older add-on than the forms it holds keeps its copies, and administrators get a notice.

## Give the treasurer access

The add-on ships a __treasurer__ role holding every accounting permission. Give it to the people who keep the books (__Admin → Users__).

- The role needs a strong sign-in: a passkey (`required-aal: 2`, capped at what the account can reach).
- For now, voiding, transfers, refunds and the CSV export do __not__ ask for a fresh sign-in ([D-030](../plans/decisions.md#d-030-step-up-off-for-accountings-money-actions-for-now)): after the sign-in, the form came back empty and had to be filled in again. The treasurer's passkey sign-in and the audit record still apply. To turn it back on, add `"step-up": true` to `ledger-adjust`, `receipt-refund` and `ledger-export` in the add-on's `config/default-config.json`.
- Every write is recorded in the audit log with who did it and when; if the record cannot be written, the money does not move.

The treasurer's pages (Accounting, Ledger, Record a Receipt, Refund a Receipt, Record an Entry, Move Money Between Funds, Void an Entry, Deposits, Undo a Deposit, Create a Fund, Rename a Fund, Close a Fund, Set an Account's Opening Balance, Monthly Summary) are visible to the treasurer role only (those that show the books also to the executive role, below), and only an administrator can change them.

## The executive role

ngdpbase's __executive__ role (the board, ngdpbase [#2093](https://github.com/jwilleke/ngdpbase/issues/2093)) reads everything these add-ons keep, names included ([D-050](../plans/decisions.md#d-050-the-executive-role-reads-all-of-accounting-actions-stay-the-treasurers)). The add-ons' own policies grant it, so a site configures nothing:

| Add-on | Policy | Grants `executive` |
| --- | --- | --- |
| accounting | `accounting-executive` | `ledger-summary-read`, `ledger-read`, `ledger-export` (the CSV downloads) |
| accounting-receivables | `accounting-receivables-executive` | `account-read` |
| accounting-donations | none of its own | its reads ask accounting's `ledger-read` |

It records nothing: receipts, deposits, invoices, write-offs, liens, corrections and locks stay the treasurer's. The treasurer's pages that show the books (Accounting, Ledger, Deposits, Bounced Checks, Monthly Summary, Invoices, Folios, Account Balances, Donations, Pledges, In-kind Donations, Donation Statements) list `executive` in their audience; the pages that only record stay the treasurer's. Folios, Pledges and In-kind Donations also carry the treasurer's forms: the executive sees them, and a submission is refused.

The add-ons put three cards on the Executive Hub (`/executive`), each shown to a holder of its permission and read with the viewer's own context:

- __Accounting__ (`ledger-summary-read`): funds, open funds, cash not yet deposited, and the date the books are locked through; with `ledger-read`, the receipts waiting for a deposit, the deposits not cleared and the bounced checks still owed.
- __Invoices__ (`account-read`, titled with the site's `label`): what units owe, units owing, liens and write-offs standing, and the last month invoiced.
- __Donations__ (`ledger-read`): this year's donations in the site's time zone, gifts, donors, in-kind donations, anonymous gifts, and the largest donors by name: `ngdpbase.addons.accounting-donations.executive-top-donors` of them (3; 0 names none). A donation recorded as anonymous is counted, never named.

A site that already runs these add-ons gets the new page audiences only on a fresh seed: reseed and Required Pages Sync compare a page's body, not its frontmatter (ngdpbase, Known gaps). Add `executive` to those pages' audience by hand, or delete and resync them.

## Show the board the summary

On a site that keeps its board in a role of its own rather than `executive`: the board usually needs balances and the monthly summary, not who paid. Grant a role `ledger-summary-read` in the site's own policy:

```json
{
  "ngdpbase.access.policies": [
    {
      "id": "board-reads-accounting-summary",
      "name": "Board reads the accounting summary",
      "priority": 80,
      "effect": "allow",
      "subjects": [{ "type": "role", "value": "board" }],
      "resources": [{ "type": "page", "pattern": "*" }],
      "actions": ["ledger-summary-read"]
    }
  ]
}
```

Then put `[{Ledger view='summary' month='previous'}]` or `[{Ledger view='balances'}]` on a page whose audience includes the board. The summary carries no names. Leave out `export='true'`: downloads need `ledger-export`, which only the treasurer and the executive role have.

## Back up

The ledger is `accounting.db` in the site's data folder. ngdpbase's backup does __not__ include add-on databases yet (ngdpbase #1723). Until it does, back the file up yourself, from a stopped site or with SQLite's own backup, never a plain copy of a file being written. Keep the database key with it: an encrypted backup is useless without the key.

## Upgrade

Raising ngdpbase is safe as long as it stays at or above the add-on's `minVersion`. The add-on's own database migrations run on start; a database from a newer add-on version refuses to open with an older one.

## How you know you are done

- __Admin → Add-ons__ shows accounting healthy: "Ledger ready".
- The treasurer, signed in with a passkey, sees the __Accounting__ page and can create a fund and record an entry; the fund's balance follows.
- After the treasurer sets the accounts' opening balances, the Ledger page's accounts add up to its funds (otherwise it says by how much they differ).
- Someone without the role who opens the Ledger page sees "You may not see the ledger." (or no page).
- The board page shows the summary without names, and without download links.
- A user holding only the executive role sees the Accounting, Invoices and Donations cards on `/executive`, opens the Ledger, Folios and Donation Statements pages, downloads the Monthly Summary's CSV, and is refused when submitting any treasurer form.
- `scripts/smoke.sh <site-url> <admin-password>` passes against a copy of the site (it needs the test-only policy in `deploy/smoke/app-custom-config.json`; never use that on a real site).

## Known gaps

- No QuickBooks or Wave formats yet (#20); use the CSV.
- No online receipts yet (Stripe cards and ACH, #49, deferred); receipts are recorded by hand.
- No events module or membership tiers yet (#6, #2, deferred). Donations are the `accounting-donations` add-on ([Donations guide](donations-guide.md)); invoices for assessments, rent or dues are the `accounting-receivables` add-on ([its README](../../addons/accounting-receivables/README.md)), whose units, owners and billing addresses come from the accommodation add-on.
- Changing the database key, or encrypting a ledger that was started without one, is not built; it is ngdpbase core's ([ngdpbase#2078](https://github.com/jwilleke/ngdpbase/issues/2078)).

The add-ons' databases are in every site backup: ngdpbase's DatabaseManager backs up each declared add-on database with the site.
