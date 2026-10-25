# Accounting dues

Dues and assessments for the [accounting](../accounting/README.md) add-on of
[ngdpbase](https://github.com/jwilleke/ngdpbase): one invoice per billing party each month, payments
as receipts, money paid ahead kept as credit, and late charges proposed for the treasurer to confirm.
The Fairways (a condominium) is the reference site.

- __Slug:__ `accounting-dues`, equal to the `name` exported from `index.ts`.
- __Type:__ `additive`. __Depends on__ `accounting`; the forms add-on carries the screens.
- __Requires:__ ngdpbase 5.31.0 or later.
- __Accounts:__ read from managers named in configuration, and never copied. A condominium uses the
  accommodation add-on ([ngdpbase-addons](https://github.com/jwilleke/ngdpbase-addons)):
  `AccommodationManager` (`accounts-manager`) for `list()`, `get(id)`, `assessment(id)` (amount,
  monthly or annual, due day, from the accommodation's category) and `lateCharges()`; and
  `ResidencyManager` (`billing-manager`) for `billing(ctx, id, { on })`, the unit's billing parties
  on the charge's due date: who is billed together, at which address, for what percent.
- __Data:__ invoices are in this add-on's own database, declared as
  `ngdpbase.addons.accounting-dues.database`, outside the ledger, which holds only money that moved.
  A payment is a receipt made through the accounting add-on's `ReceiptManager`, whose line carries
  `dues` details (`{ account, party, invoiceId }`) registered with `LedgerManager.registerLineDetails`. The
  accounting database is never touched.
- __Permissions:__ its own `invoice-issue` (issue, void and email invoices), which the add-on's
  policy grants the treasurer role; recording a payment is accounting's `ledger-record`.

Why: [D-035](../../docs/plans/decisions.md#d-035-dues-and-assessments-flexible-accounts-and-charges).

## Turn it on

A condominium, with the accommodation add-on enabled and 4100 renamed in the chart:

```json
{
  "ngdpbase.addons.accounting.enabled": true,
  "ngdpbase.addons.accounting.categories": {
    "4100": { "name": "Assessments", "type": "income", "detailType": "Service/Fee Income" }
  },
  "ngdpbase.addons.accounting-dues.enabled": true,
  "ngdpbase.addons.accounting-dues.label": { "singular": "Assessment", "plural": "Assessments" },
  "ngdpbase.addons.accounting-dues.organization": {
    "name": "The Fairways Condominium Association",
    "address": "…",
    "pay-to": "Fairways Condominium Association, c/o …"
  }
}
```

## How billing works

- __One invoice per billing party__
  ([D-038](../../docs/plans/decisions.md#d-038-one-invoice-per-billing-party-each-with-its-own-balance)).
  Dues bills exactly what the unit's billing array says
  ([D-040](../../docs/plans/decisions.md#d-040-dues-bills-exactly-as-the-billing-array-says)): each
  party's percent of the charge, to its names and address. Joint owners at one address are one party
  and get one invoice for the total. A unit whose billing array is refused (someone named who is not
  an owner, shares not adding up to 100, no owner or no address) shows as not billable, with the
  reason, and nothing is issued for it.
- __Each month is evaluated on its own.__ Prepare This Month's Invoices shows each party's charge,
  the late charges due on its earlier invoices, its balance brought forward and the amount owed. The
  treasurer then issues: one invoice per party a month, I-0001 onwards, stored exactly as issued
  with its SHA-256. A mistake is voided, with a reason, and the month issued again.
- __Each party has its own balance.__ A payment settles only its party's invoices: the oldest first,
  or the one it names first. What is left is that party's credit. A payment names its invoice or its
  party; on an account with one party it may name neither. An account's balance is the sum of its
  parties'. Refunds lower a payment; a bounced check does not count.
- __Late charges__ come from the account source's rules. A rule applies once an invoice is more than
  its days past due and still unpaid: once per invoice, or each month. Interest is simple, on what is
  still owed, at the annual rate ÷ 12. They are added only when the treasurer ticks the box.
- __Email:__ with email ticked, an invoice with money owed goes to each person on its party with an
  email; one paid in full by credit is kept and not sent.
- __Sending to owners__ is off until a site sets `ngdpbase.addons.accounting-dues.send-to-owners` to
  `true`. While it is off nothing is sent to owners, even with the email box ticked: a development or
  copied site never mails real owners.
- __Your own bills:__ everyone who was billed sees, on their own profile, each billing party they
  were on: its invoices, what is paid and left to pay, and its balance. Everyone on a party sees the
  same, whoever paid; nobody sees another party's. A seller keeps seeing what they were billed;
  someone never billed sees no card
  ([D-044](../../docs/plans/decisions.md#d-044-an-owners-bills-are-on-their-profile-in-accountings-card),
  [D-045](../../docs/plans/decisions.md#d-045-the-dues-card-shows-whoever-was-billed)). It needs
  `ledger-self`, which every account holds.

- __PDF:__ an emailed invoice carries a PDF of itself, made by ngdpbase's export, when the site has a
  PDF provider (`ngdpbase.export.pdf.provider`), and the PDF's SHA-256 is kept with the invoice.
  Without one, the email carries the page alone.

- __Scheduled run:__ the job `accounting-dues.issue-invoices` issues each month's invoices on the
  1st at 06:00 in the site's time zone, with the late charges due, and emails them
  ([D-035](../../docs/plans/decisions.md#d-035-dues-and-assessments-flexible-accounts-and-charges)).
  It ships __paused__: turning it on (Admin → Scheduled Jobs → Resume) is the site's standing
  confirmation of the late charges and the email. Move the day with BackgroundJobManager's own keys.
  Run again for the same month, it issues nothing twice. A scheduled run acts as the job, which this
  add-on's policy grants only `invoice-issue`, `ledger-read` and the accommodation add-on's
  `accommodation-billing-read`; Run now acts as the admin who clicked. While `send-to-owners` is off,
  nothing goes to owners and the holders of `invoice-issue` get a notice of what was issued.

Not yet: sending by each user's communication preference (ngdpbase #1969).

## Develop

```bash
npm install
npm test        # builds, then runs vitest
```
