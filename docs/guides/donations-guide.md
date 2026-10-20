---
name: Donations guide
description: How the accounting add-on records gifts and produces giving statements, and what the IRS asks for
dateModified: 2026-10-20
category: guides
relatedModules: [LedgerManager, ReceiptManager, PersonManager, ExportManager]
---

# Donations guide

For the site administrator, the treasurer, and the accountant who checks the organization's giving
records. It explains how gifts are recorded, who counts as a donor, and what donors receive.

__This page is the source of truth for donations__
([#4](https://github.com/jwilleke/ngdp-accounting-addons/issues/4),
[D-036](../plans/decisions.md#d-036-donations-follow-the-donations-guide)). Any change to how
donations work is made here first, and the code follows it.

__Status:__ decided, not built yet. What exists today: receipts with lines, funds, the chart's
donation category (4200 Donations and gifts) and refunds. The sections below say what is still to be
built.

## A donation is a receipt line

A gift is money received, so it is recorded as a __receipt__, with its R-number, payer, method and
account, like any other money in
([D-033](../plans/decisions.md#d-033-receipts-and-refunds-are-made-of-lines)). The gift is a __line__
of that receipt:

- in a __donation category__ from the chart (4200 Donations and gifts, or another the site adds),
- in the __fund__ the donor chose (General, the Roof Fund),
- with the __gift details__ on the line:
  - the __deductible amount__;
  - the __value of goods or services__ the donor received, if any (a dinner ticket inside a gift);
  - whether the gift is __anonymous__.

One check can mix dues and a gift: that is two lines on one receipt. Refunds and voids work as for
any receipt. Giving statements and the board's totals by fund come from the same ledger.

## In-kind gifts

A gift of goods or services rather than money (a donated laptop, food for an event, a printer's free
work) is recorded as an __in-kind gift__: the donor (a person), the date and a __description__
("Dell laptop, used"). It has __no value__: under IRS Publication 1771 the organization describes a
non-cash gift and does not value it; valuing it is the donor's job.

It is not a receipt, since no money came in, and it does not touch fund balances. It appears on the
donor's year-end statement as a described item without an amount. An optional value, for the
organization's own books, can be added later if its accountant wants it.

## Pledges

A pledge is a promise to give that is not money yet: "$1,200 to the building campaign this year,
$100 a month". It is __its own record, outside the ledger__: the donor (a person), the amount, the
fund, the period and an optional schedule. Gifts that pay toward it are ordinary receipt lines
__linked to the pledge__. A Pledges page shows pledged, given and remaining, by donor and by
campaign.

Nothing reaches the fund balances until money arrives: the ledger holds real money only, as it does
for checks, which count when recorded. Statements list gifts actually given, since only those are
deductible; a statement may add a line such as "Pledged $1,200; given $800".

## Who the donor is

A gift that should appear on a statement is recorded against an __ngdpbase person__: picked from the
site's list of people, or created on the spot as a __new donor__ from the receipt form. The person
record holds the donor's name, postal address and email, once; an address change is made in one
place. A person may never log in; everyone who logs in already has a person record.

__Anonymous cash__, such as the collection plate, needs no person. It counts in the fund totals and
is on no statement.

__Anonymous__ on a gift means hidden from the board and from public totals. The treasurer still knows
the donor, and the donor still gets a statement.

## What the donor receives

| What | When | Covers |
| --- | --- | --- |
| __Year-end giving statement__ | January, for the year before | Every gift that year, each with date and amount, the total, and the goods-or-services wording. It is the written acknowledgment for every gift of $250 or more. |
| __Quid pro quo disclosure__ on the receipt slip | When the gift is made | A gift over $75 where the donor received something: "Of your $100.00, $60.00 is deductible; the dinner is valued at $40.00." |

- A statement goes to every donor with a person record and gifts in the year.
- Statements are emailed in bulk or downloaded. Each issued statement is __kept exactly as sent and
  cannot be changed__; a correction is __reissued__, and the original is marked superseded. A gift
  voided after its statement was issued flags that statement for reissue.
- Statements are __web pages__ for now: HTML styled for printing, built through ngdpbase's export
  path, printable or saved as PDF from the browser, emailed as the message itself, and stored with a
  fingerprint. Real PDF files wait for a PDF export in ngdpbase core, if wanted later.
- The __wording__ of the statement and of the disclosure is a site setting, starting from the IRS's
  own language. The organization checks it with its accountant.
- Issuing, reissuing and bulk-sending statements need the `statement-issue` permission, and are
  audited.

## What the IRS asks for

United States only, for now. The reference is IRS Publication 1771, *Charitable Contributions:
Substantiation and Disclosure Requirements*. Your accountant has the final word.

| Rule | What it means here |
| --- | --- |
| A written acknowledgment for any single gift of __$250 or more__, which the donor has before filing | The year-end statement |
| A written disclosure for a __quid pro quo gift over $75__, made with the gift | The receipt slip's disclosure |
| __Form 990, Schedule B__: contributors of __$5,000 or more__ in the year, with name and address | The person record's name and address |
| No tax ID from a cash donor | None is collected |
| A non-cash gift is __described, not valued__, by the organization | In-kind gifts carry a description, no amount |

Large non-cash gifts (property over $5,000) involve extra IRS forms; they are not covered yet.

## Who sees what

- The __treasurer__ records gifts (`ledger-record`) and sees donors (`ledger-read`).
- The __board__ sees donation totals by fund without individual donors (`ledger-summary-read`),
  unless granted `ledger-read`.
- A __donor who logs in__ sees their own gifts and statements (`giving-self`).

## Still to decide

- __Recurring online gifts__: these wait for an online receipt provider (Stripe, on hold).

## See also

- [Accounting site guide](accounting-guide.md)
- [Chart of accounts guide](chart-of-accounts-guide.md): the donation categories
- Requirements, [section 5.3](../requirements.md)
