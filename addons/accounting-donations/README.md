# Accounting donations

Donations for the [accounting](../accounting/README.md) add-on of
[ngdpbase](https://github.com/jwilleke/ngdpbase): gifts recorded as receipt lines with gift details,
and the receipt slip's quid pro quo disclosure. Giving statements, in-kind gifts and pledges are
coming.

- __Slug:__ `accounting-donations`, equal to the `name` exported from `index.ts`.
- __Type:__ `additive`. __Depends on__ `accounting`; the forms add-on carries the gift screen.
- __Requires:__ ngdpbase 5.21.0 or later.
- __Data:__ none of its own for gifts. It calls the accounting add-on's managers
  (`LedgerManager.registerLineDetails`, `registerSlipNotes`, `ReceiptManager.recordReceipt`) and never
  its database (operator, 2026-10-20).

How donations work, and what the IRS asks for: [docs/guides/donations-guide.md](../../docs/guides/donations-guide.md),
the source of truth. Why: [D-036](../../docs/plans/decisions.md#d-036-donations-follow-the-donations-guide).

## Turn it on

```json
{
  "ngdpbase.addons.accounting.enabled": true,
  "ngdpbase.addons.accounting-donations.enabled": true,
  "ngdpbase.addons.accounting-donations.categories": ["4200"]
}
```

`categories` lists the chart codes a gift may use. The disclosure's wording is
`ngdpbase.addons.accounting-donations.wording["quid-pro-quo"]`; check it with your accountant.

## Develop

```bash
cd addons/accounting-donations
npm install
npm test        # builds first; the tests use the accounting add-on's ledger and test host
```
