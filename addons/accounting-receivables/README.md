# Accounting receivables

Receivables for the [accounting](../accounting/README.md) add-on of [ngdpbase](https://github.com/jwilleke/ngdpbase): one invoice per billing address each month, payments as receipts, money paid ahead kept as credit, and late charges proposed for the treasurer to confirm. The Fairways (a condominium) is the reference site.

- __Slug:__ `accounting-receivables`, equal to the `name` exported from `index.ts`.
- __Type:__ `additive`. __Depends on__ `accounting`; the forms add-on carries the screens.
- __Requires:__ ngdpbase 5.31.0 or later.
- __Accounts:__ read from managers named in configuration, and never copied. A condominium uses the accommodation add-on ([ngdpbase-addons](https://github.com/jwilleke/ngdpbase-addons)): `AccommodationManager` (`accounts-manager`) for `list()`, `get(id)`, `assessment(id)` (amount, monthly or annual, due day, from the accommodation's category) and `lateCharges()`; and `ResidencyManager` (`billing-manager`) for `billing(ctx, id, { on })`, where the unit's invoices go and its owners on the charge's due date, and `ownUnits(ctx)`, the units the viewer owns today.
- __Data:__ invoices are in this add-on's own database, declared as `ngdpbase.addons.accounting-receivables.database`, outside the ledger, which holds only money that moved. A payment is a receipt made through the accounting add-on's `ReceiptManager`, whose line carries `receivable` details (`{ account, invoiceId }`) registered with `LedgerManager.registerLineDetails`. The accounting database is never touched.
- __Permissions:__ its own `invoice-issue` (issue, void and email invoices), which the add-on's policy grants the treasurer role; recording a payment is accounting's `ledger-record`.

Why: [D-035](../../docs/plans/decisions.md#d-035-dues-and-assessments-flexible-accounts-and-charges).

## Turn it on

A condominium, with the accommodation add-on enabled and 4100 renamed in the chart:

```json
{
  "ngdpbase.addons.accounting.enabled": true,
  "ngdpbase.addons.accounting.categories": {
    "4100": { "name": "Assessments", "type": "income", "detailType": "Service/Fee Income" }
  },
  "ngdpbase.addons.accounting-receivables.enabled": true,
  "ngdpbase.addons.accounting-receivables.label": { "singular": "Assessment", "plural": "Assessments" },
  "ngdpbase.addons.accounting-receivables.organization": {
    "name": "The Fairways Condominium Association",
    "address": "…",
    "pay-to": "Fairways Condominium Association, c/o …"
  }
}
```

## How billing works

- __Folios__ ([D-048](../../docs/plans/decisions.md#d-048-a-unit-is-billed-through-folios-each-folio-keeps-its-own-balance)). A folio is one stretch of the same owners, with the same shares, on a unit: the accommodation add-on's ownership period, numbered per unit (`<unit>/F01`, `/F02`, …). A unit always has one current folio, and new invoices go on it. When the owners or their shares change, the next invoice starts a new folio at $0; the earlier owners' folio keeps its own balance, gets no new assessments, but keeps its late charges each month until it is paid or written off. The new owners never carry that debt. The unit's balance is its folios added together.
- __Payments__ settle their folio's invoices oldest first, or the one they name first. A payment naming only the unit goes on the unit's current folio; a payment on an earlier owners' folio names it on the payment form. Refunds lower a payment; a bounced check does not count.
- __On a folio__ the treasurer can also enter a balance brought forward (once per folio, owed or credit), a write-off, and a lien filed with the county (its amount and recording number; it does not change the balance). None is money that moved, so they stay outside the ledger; each is audited and voided to correct, on the Folios page.
- __One invoice per billing address.__ The unit's billing entries say only where invoices go: an address typed by the treasurer or an owner, and a share; usually one entry at 100%. Each entry's invoice carries its share of the month's charge and of its folio's balance brought forward; late charges go on the first. An invoice keeps the address as typed and the owners' `@id`s and shares, never names.
- __A unit with no billing address is never billed to a guessed one.__ It shows as not billable on Prepare This Month's Invoices, with the reason, and the scheduled run names it in its result and in the notice to the people who issue invoices.
- __Each month is evaluated on its own.__ Prepare This Month's Invoices shows each entry's charge, the late charges due on the unit's earlier invoices, the balance brought forward and the amount owed. The treasurer then issues: I-0001 onwards, each stored exactly as issued with its SHA-256. A mistake is voided, with a reason, and the month issued again.
- __Late charges__ come from the account source's rules. A rule applies once an invoice is more than its days past due and still unpaid: once per invoice, or each month. Interest is simple, on what is still owed, at the annual rate ÷ 12. They are added only when the treasurer ticks the box.
- __Email:__ with email ticked, an invoice with money owed goes to each of the unit's owners with an email, looked up as the sender through ngdpbase's identity records (`identity-read`); one paid in full by credit is kept and not sent.
- __Sending to owners__ is off until a site sets `ngdpbase.addons.accounting-receivables.send-to-owners` to `true`. While it is off nothing is sent to owners, even with the email box ticked: a development or copied site never mails real owners.
- __Your own bills:__ a unit's current owners, decided when they look, see its current folio on their profile: every billing entry's invoices, what is paid and left to pay, and the balance. A past owner keeps seeing their own folio with its balance, since they still owe it; someone never billed sees no card ([D-047](../../docs/plans/decisions.md#d-047-one-balance-per-unit-billing-entries-are-only-where-invoices-go), [D-045](../../docs/plans/decisions.md#d-045-the-dues-card-shows-whoever-was-billed)). It needs `ledger-self`, which every account holds.
- __The board__ sees every unit's account and folio under `account-read`, which no role holds by default: a site grants it to its board in its own policy.

- __PDF:__ an emailed invoice carries a PDF of itself, made by ngdpbase's export, when the site has a PDF provider (`ngdpbase.export.pdf.provider`), and the PDF's SHA-256 is kept with the invoice. Without one, the email carries the page alone.

- __Scheduled run:__ the job `accounting-receivables.issue-invoices` issues each month's invoices on the 1st at 06:00 in the site's time zone, with the late charges due, and emails them ([D-035](../../docs/plans/decisions.md#d-035-dues-and-assessments-flexible-accounts-and-charges)). It ships __paused__: turning it on (Admin → Scheduled Jobs → Resume) is the site's standing confirmation of the late charges and the email. Move the day with BackgroundJobManager's own keys. Run again for the same month, it issues nothing twice. A scheduled run acts as the job, which this add-on's policy grants only `invoice-issue`, `ledger-read` and the accommodation add-on's `accommodation-billing-read`; Run now acts as the admin who clicked. While `send-to-owners` is off, nothing goes to owners and the holders of `invoice-issue` get a notice of what was issued.

Not yet: sending by each user's communication preference (ngdpbase #1969).

## Develop

```bash
npm install
npm test        # builds, then runs vitest
```
