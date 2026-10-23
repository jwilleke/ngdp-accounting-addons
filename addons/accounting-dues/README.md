# Accounting dues

Dues and assessments for the [accounting](../accounting/README.md) add-on of
[ngdpbase](https://github.com/jwilleke/ngdpbase): one invoice per account each month, payments as
receipts, money paid ahead kept as credit, and late charges proposed for the treasurer to confirm.
The Fairways (a condominium) is the reference site.

- __Slug:__ `accounting-dues`, equal to the `name` exported from `index.ts`.
- __Type:__ `additive`. __Depends on__ `accounting`; the forms add-on carries the screens.
- __Requires:__ ngdpbase 5.22.0 or later.
- __Accounts:__ read from managers named in configuration, and never copied. A condominium uses the
  accommodation add-on ([ngdpbase-addons](https://github.com/jwilleke/ngdpbase-addons)):
  `AccommodationManager` (`accounts-manager`) for `list()`, `get(id)`, `assessment(id)` (amount,
  monthly or annual, due day, from the accommodation's category) and `lateCharges()`; and
  `ResidencyManager` (`owners-manager`) for `owners(ctx, id, { on })`, the ngdpbase users who own it
  on the invoice's due date.
- __Data:__ invoices are in this add-on's own database, declared as
  `ngdpbase.addons.accounting-dues.database`, outside the ledger, which holds only money that moved.
  A payment is a receipt made through the accounting add-on's `ReceiptManager`, whose line carries
  `dues` details (`{ account, invoiceId }`) registered with `LedgerManager.registerLineDetails`. The
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

- __Each month is evaluated on its own.__ Prepare This Month's Invoices shows each account's charge,
  the late charges due on earlier invoices, the balance brought forward and the amount owed. The
  treasurer then issues: one invoice per account a month, I-0001 onwards, stored exactly as issued
  with its SHA-256. A mistake is voided, with a reason, and the month issued again.
- __Payments__ settle the oldest invoice first, or the one the payment names first. What is left is
  the account's credit. Refunds lower a payment; a bounced check does not count.
- __Late charges__ come from the account source's rules. A rule applies once an invoice is more than
  its days past due and still unpaid: once per invoice, or each month. Interest is simple, on what is
  still owed, at the annual rate ÷ 12. They are added only when the treasurer ticks the box.
- __Owners:__ every owner on the invoice's due date is named on the invoice. With
  email ticked, an invoice with money owed goes to each owner with an email; one paid in full by
  credit is kept and not sent.
- __Sending to owners__ is off until a site sets `ngdpbase.addons.accounting-dues.send-to-owners` to
  `true`. While it is off nothing is sent to owners, even with the email box ticked: a development or
  copied site never mails real owners.

Not yet: sending by each user's communication preference (ngdpbase #1969), PDF attachments
(ngdpbase #1974), a scheduled send, and the owner's own profile panel.

## Develop

```bash
npm install
npm test        # builds, then runs vitest
```
