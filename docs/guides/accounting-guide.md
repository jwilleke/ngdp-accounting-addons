---
name: Accounting site guide
description: Turning on the accounting add-on, giving the treasurer and the board access, and what it does not do yet
dateModified: 2026-10-18
category: guides
relatedModules: [LedgerManager, DatabaseManager, PolicyDecisionPoint, FormsAddon]
---

# Accounting site guide

For the administrator of an ngdpbase site who wants the treasurer to keep the organization's books
in it. The treasurer's own how-to is the __Using Accounting__ page the add-on ships.

Accounting keeps funds and a ledger of money in and out. It is not a full accounting package: the
books of record stay in QuickBooks or Wave, and accounting hands them a CSV.

## Before you start

- ngdpbase __5.18.0 or later__. The add-on declares this as its `minVersion`; an older core refuses
  to load it.
- The site's database on: `ngdpbase.database.provider` set to `sqlite`.
- The __forms__ add-on enabled. The treasurer's screens are forms; without it the ledger still works
  through the API and the `[{Ledger}]` plugin, but there is nothing to type into.
- `NGDPBASE_DATABASE_KEY` set in the site's environment or `.env`, so the ledger is encrypted. Without
  it the ledger is plain SQLite and the site warns at startup.

## Install it

From npm, once a release is published: ngdpbase installs the add-on itself, checks its sha512 and its
provenance (it must have been built by this repository's publish workflow), and pins it. Installing does not enable it; the enable key below still decides. The site
needs Node 24.15.0 or later. In `app-custom-config.json`:

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

Or from a checkout: point the site's add-ons path at this repository's `addons/` folder after
`npm install` and `npm run build` in `addons/accounting/`.

## Turn it on

In the site's `app-custom-config.json`:

```json
{
  "ngdpbase.database.provider": "sqlite",
  "ngdpbase.addons.forms.enabled": true,
  "ngdpbase.addons.accounting.enabled": true,
  "ngdpbase.addons.accounting.categories": {
    "4100": "Dues",
    "4200": "Donations",
    "5200": "Supplies"
  }
}
```

Restart the site. On first start the add-on creates its database (`accounting.db` in the data
folder), seeds its pages, and logs `Ledger ready`. The categories are UCOA account codes and labels;
the entry form offers exactly these.

If the database is off, the add-on starts nothing and says why on __Admin → Add-ons__.

## Give the treasurer access

The add-on ships a __treasurer__ role holding every accounting permission. Give it to the people who
keep the books (__Admin → Users__).

- The role needs a strong sign-in: a passkey (`required-aal: 2`, capped at what the account can reach).
- Voiding, transfers and the CSV export ask for a fresh sign-in when the last one is more than a few
  minutes old.
- Every write is recorded in the audit log with who did it and when; if the record cannot be
  written, the money does not move.

The treasurer's pages (Accounting, Ledger, Record an Entry, Move Money Between Funds, Void an Entry,
Manage Funds, Monthly Summary) are visible to the treasurer role only, and only an administrator can
change them.

## Show the board the summary

The board usually needs balances and the monthly summary, not who paid. Grant a role
`ledger-summary-read` in the site's own policy:

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

Then put `[{Ledger view='summary' month='previous'}]` or `[{Ledger view='balances'}]` on a page whose
audience includes the board. The summary carries no names. Leave out `export='true'`: downloads
need `ledger-export`, which only the treasurer has.

## Back up

The ledger is `accounting.db` in the site's data folder. ngdpbase's backup does __not__ include add-on
databases yet (ngdpbase #1723). Until it does, back the file up yourself, from a stopped site or with
SQLite's own backup, never a plain copy of a file being written. Keep the database key with it: an
encrypted backup is useless without the key.

## Upgrade

Raising ngdpbase is safe as long as it stays at or above the add-on's `minVersion`. The add-on's own
database migrations run on start; a database from a newer add-on version refuses to open with an
older one.

## How you know you are done

- __Admin → Add-ons__ shows accounting healthy: "Ledger ready".
- The treasurer, signed in with a passkey, sees the __Accounting__ page and can create a fund and
  record an entry; the fund's balance follows.
- Someone without the role who opens the Ledger page sees "You may not see the ledger." (or no page).
- The board page shows the summary without names, and without download links.
- `scripts/smoke.sh <site-url> <admin-password>` passes against a copy of the site (it needs the
  test-only policy in `deploy/smoke/app-custom-config.json`; never use that on a real site).

## Known gaps

- __Backups__ do not cover the ledger's database yet (ngdpbase #1723).
- No month lock: a closed month can still receive entries dated in it (#19).
- No QuickBooks or Wave formats yet (#20); use the CSV.
- No dues, payments, donations or events modules yet; entries are recorded by hand.
- Changing the database key, or encrypting a ledger that was started without one, is not built (#14).
