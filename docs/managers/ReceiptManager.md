---
name: ReceiptManager
description: "The accounting add-on's door for money coming in: which receipt provider a receipt goes through and what it can do; the ledger numbers, audits and posts it"
dateModified: '2026-10-18'
category: managers
code: addons/accounting/managers/ReceiptManager.ts
---

# ReceiptManager

__Module:__ `addons/accounting/managers/ReceiptManager.ts` (accounting add-on)
__Registered as:__ `engine.getManager('ReceiptManager')`

Money coming in is a __receipt__: cash, a check, a bank transfer, and later card and ACH
([D-028](../plans/decisions.md)). Every receipt goes through `ReceiptManager`, which picks the
__receipt provider__ and checks what it can do. The ledger does the rest: it asks the decision point,
numbers the receipt, writes the audit record and posts it ([LedgerManager](LedgerManager.md)
`postReceipt` and `refundReceipt`). Add-ons that take money (dues, donations, events) record receipts
here, never in the ledger directly.

## Providers

Each provider declares what it can do (D-004): `manualEntry`, `checkout`, `sync`, `refund`,
`import`.

| Provider | Can | Status |
| --- | --- | --- |
| `manual` | `manualEntry`, `refund` | Always enabled: money the treasurer records by hand |
| `stripe` | — | Not built yet ([#49](https://github.com/jwilleke/ngdp-accounting-addons/issues/49), deferred) |

Configuration, a list merged by `id` (D-017):

```json
"ngdpbase.addons.accounting.receiptproviders": [{ "id": "manual", "enabled": true }]
```

The manual provider is included even if the list omits or disables it, so receipts always work. An
entry naming a provider this version does not ship is skipped, with a warning at startup.

## Methods

- `recordReceipt(actor, receipt, provider = 'manual')` → `Transaction`. Refused if the provider is
  not enabled or cannot record by hand. The receipt fields are `LedgerManager.postReceipt`'s:
  `amount`, `date`, `fundId`, `category`, `partyName` (who paid), `paymentMethod` (UN/CEFACT payment
  means), `paymentMethodId` (a check's number), `memo` (the reason), and optionally `accountId`
  (where it lands; left out, the method picks it: cash and checks to Cash on Hand, bank methods to
  the default bank account, D-031) and `reference: { type, id }` (what it pays for). The result carries the receipt number in `confirmationNumber`.
- Both return the record: a `Receipt` (`number`, `total`, `lines`) or a `Refund` (`RF-` number, its
  `lines` tied to receipt lines); see [LedgerManager](LedgerManager.md) for lines (D-033).
- `refundReceipt(actor, receiptId, { lines? | amount?, date, memo, paymentMethod?, paymentMethodId?, accountId? })` →
  `Transaction`, the linked out entry. Needs `receipt-refund` (step-up off for now, D-030).
- `providers()` → the enabled providers and their capabilities.

## Rules ([D-029](../plans/decisions.md))

- Receipt numbers are `R-0001` onwards, one sequence per site, never reused.
- All money in is a receipt: the ledger refuses a plain `in` entry.
- A receipt entered wrongly is voided (`ledger-adjust`) and recorded again with a new
  number. A refund is money actually returned, linked to the receipt, which stays posted.
- Every receipt and refund carries a reason.

## API

`POST /api/accounting/receipts` records a receipt; `POST /api/accounting/receipts/:id/refund` refunds
one. Both answer with the posted transaction.

## See also

- [LedgerManager](LedgerManager.md): the ledger underneath.
- [Accounting site guide](../guides/accounting-guide.md).
