# Accounting donations

Donations for the [accounting](../accounting/README.md) add-on of [ngdpbase](https://github.com/jwilleke/ngdpbase): donations recorded as receipt lines with donation details, the receipt slip's quid pro quo disclosure, in-kind donations and pledges, and year-end donation statements.

- __Slug:__ `accounting-donations`, equal to the `name` exported from `index.ts`.
- __Type:__ `additive`. __Depends on__ `accounting`; the forms add-on carries the donation screen.
- __Requires:__ ngdpbase 5.31.0 or later.
- __Data:__ donations of money are receipts in the accounting add-on, reached only through its managers (`LedgerManager.registerLineDetails`, `registerSlipNotes`, `ReceiptManager.recordReceipt`), never its database (operator, 2026-10-20). In-kind donations and pledges are in this add-on's own database, declared as `ngdpbase.addons.accounting-donations.database`.
- __Permissions:__ its own `donation-record` (in-kind donations, pledges) and `statement-issue` (issue, reissue and email donation statements); and core's `identity-read` (the donor list) and `identity-manage` (Add a Donor). The add-on's policy grants all four to the treasurer role. Donors are ngdpbase contacts (persons and organizations, ngdpbase #1930); a donation keeps the donor's `@id` and name. A donor who gives for an organization carries that affiliation on their identity record, as a schema.org `OrganizationRole` (`memberOf`, `roleName`).
- __Statements:__ stored exactly as issued, with their fingerprint; emailed with a PDF attached when the site has a PDF provider (`ngdpbase.export.pdf.provider`), else the page alone.
- __A donor's own view:__ "Your donations" on their profile: each year's donations and statements, under `ledger-self`, which every account holds.

How donations work, and what the IRS asks for: [docs/guides/donations-guide.md](../../docs/guides/donations-guide.md), the source of truth. Why: [D-036](../../docs/plans/decisions.md#d-036-donations-follow-the-donations-guide).

## Turn it on

```json
{
  "ngdpbase.addons.accounting.enabled": true,
  "ngdpbase.addons.accounting-donations.enabled": true,
  "ngdpbase.addons.accounting-donations.categories": ["4200"]
}
```

`categories` lists the chart codes a donation may use. The disclosure's wording is `ngdpbase.addons.accounting-donations.wording["quid-pro-quo"]`; check it with your accountant.

## Upgrading to 0.3.0

One term, donation ([D-042](../../docs/plans/decisions.md#d-042-one-term-donation)): the `gift-record` form is replaced by `donation-record`. After the upgrade, the forms admin (`/addons/forms`) lists `gift-record` as "No longer provided by accounting-donations". An administrator deletes it there. It never stored submissions (each one became a receipt in the ledger), so nothing is lost. Stored line details and statement counts are renamed by migration; issued statements are unchanged.

## Develop

```bash
cd addons/accounting-donations
npm install
npm test        # builds first; the tests use the accounting add-on's ledger and test host
```
