# Accounting donations

Donations for the [accounting](../accounting/README.md) add-on of
[ngdpbase](https://github.com/jwilleke/ngdpbase): gifts recorded as receipt lines with gift details,
the receipt slip's quid pro quo disclosure, in-kind gifts and pledges. Giving statements are coming.

- __Slug:__ `accounting-donations`, equal to the `name` exported from `index.ts`.
- __Type:__ `additive`. __Depends on__ `accounting`; the forms add-on carries the gift screen.
- __Requires:__ ngdpbase 5.22.0 or later.
- __Data:__ gifts of money are receipts in the accounting add-on, reached only through its managers
  (`LedgerManager.registerLineDetails`, `registerSlipNotes`, `ReceiptManager.recordReceipt`), never its
  database (operator, 2026-10-20). In-kind gifts and pledges are in this add-on's own database,
  declared as `ngdpbase.addons.accounting-donations.database`.
- __Permissions:__ its own `donation-record` (in-kind gifts, pledges) and `statement-issue` (issue,
  reissue and email giving statements); and core's `contact-read` (the donor list) and
  `contact-manage` (Add a Donor). The add-on's policy grants all four to the treasurer role. Donors are ngdpbase contacts (persons and organizations, ngdpbase #1930); a gift
  keeps the donor's `@id` and name.

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
