---
title: Receipt methods
description: How money can arrive, as the receipt form offers it, with the UN/CEFACT code each is stored as
last_updated: "2026-10-18"
---

# Receipt methods

A receipt records how the money arrived: its __method__. The receipt form offers the methods below.
Each is stored as a code from the UN/CEFACT list of payment means, __UNCL 4461__
([D-018](plans/decisions.md#d-018-use-published-standards-schemaorg-and-uncefact-payment-means)), so
an export to QuickBooks or Wave, or to another system, names the same thing the same way. Screens
show the label, never the code.

The same list is used for money going out (an entry's method) and for refunds.

## The methods

| Label | Code | UNCL 4461 name | Use it for | Reference to record |
| --- | --- | --- | --- | --- |
| Cash | `10` | In cash | Notes and coins handed over | none |
| Check | `20` | Cheque | A paper check | the check number |
| ACH | `2` | Automated clearing house credit | Money the payer sends to the organization's bank: direct deposit, online bill pay | the bank's confirmation or trace number |
| Zelle | `68` | Online payment service | A Zelle transfer | Zelle's confirmation code |
| Bank transfer | `30` | Credit transfer | A wire, or another transfer that is not ACH or Zelle | the bank's reference |
| Card | `48` | Bank card | A card payment taken outside this system (a card reader at an event) | the last four digits are not stored; the reader's receipt number, if any |

The reference goes in the receipt's "Check number or confirmation code" field
(`paymentMethodId`). It is what the treasurer matches against the bank statement. Never record a
full card or bank account number ([requirements](requirements.md), section 9).

## Notes

- __Zelle__ has no code of its own in UNCL 4461; `68`, "online payment service", is the closest. If
  another service (PayPal, Venmo) is added, it shares `68` and its label tells them apart.
- __ACH__ here is always money the payer sends (an ACH *credit*, `2`). Pulling money from a payer's
  account (an ACH *debit*, `3`) needs a processor such as Stripe, settles over days and can fail, so
  it waits with the online receipt providers ([#3](https://github.com/jwilleke/ngdp-accounting-addons/issues/3)).
- __Card__ means a card taken elsewhere and recorded by hand. Online card payments will come through
  a receipt provider, which records the method itself.
- __Other codes:__ the ledger accepts any UNCL 4461 code, or `ZZZ` ("mutually defined"), from the API.
  The form offers only this list.

## Where it lives in code

`MANUAL_PAYMENT_MEANS` in `addons/accounting/managers/LedgerManager.ts` is this list, in this order;
the form reads it through `LedgerManager.toFormOptions({ list: 'payment-methods' })`. Change this page
and that list together.

| Label | In the code today |
| --- | --- |
| Cash, Check, Bank transfer, Card | yes |
| ACH, Zelle | not yet: to be added with the field label "Check number or confirmation code" |
