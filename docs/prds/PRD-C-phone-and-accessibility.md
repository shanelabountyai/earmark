# PRD-C: Phone and accessibility on the walk

2026-11-21 · from `docs/audits/FIVE-LENS-2026-11-19.md` §2 (work items 4 and 11 to 15; findings U7, U10, U11, G2, G3, G5, G7, G8, G9, G10, A1 to A5, A7) · no owner decision needed.

## Problem

On a phone, step 7 cannot be finished by sight: the *Match to PO-…* button sits off-screen in a 590 px table inside a 324 px box, and the wide tables hide the key figure. A 404 inside an org keeps the missing page's tab title, which Next's route announcer reads aloud. After any submit focus falls to the page body, a repeated refusal is not announced, and an invalid field is not marked. The budget table's hierarchy is shown only by indent and bold. The variance page leads with the oldest, emptiest period and never shows a published note. Small design defects (money baseline, 404 logo, no current sidebar item on a line page, rules rows wrapping, a column headed *Invoice*).

## Requirements

| # | Requirement | Test |
|---|---|---|
| C1 | Below 40 rem, the invoice page's *Suggested POs* rows stack (PO, reason, figures, button), so *Match to PO-…* is inside the viewport at 390 px; the wide list tables (invoices, dashboard unmatched) stack with each cell labelled. | `e2e/design.spec.ts` "the Match button is on screen at 390 px". |
| C2 | A page inside an org that ends in the 404 has the tab title *Page not found*. | `e2e/design.spec.ts` "a 404 inside an org is titled Page not found". |
| C3 | After an Earmark `Form` submit settles, focus moves to its alert or status (`tabIndex=-1`); the message is cleared when a submit starts, so a second identical refusal is a new alert and is announced again (D-81: always-present empty regions would have matched every e2e `getByRole('status')` on pages with several forms). | `e2e/design.spec.ts` "focus moves to the refusal …". |
| C4 | After a refusal that names a field, that field carries `aria-invalid="true"` and `aria-describedby` pointing at the alert. | Same test. |
| C5 | The dashboard's budget table states its hierarchy: program and campaign rows are `th scope="row"` headers with an `aria-level`-equivalent visually hidden prefix (*Program*, *Campaign*). | Same file, a DOM check. |
| C6 | The variance page lists the newest period first; the seed plants one published note (Q2 Paid Social). | `e2e/demo.spec.ts` step 9 reads the note. |
| C7 | Design polish: money on the text baseline; the 404 logo uses the paper fold; a line page marks *Dashboard* current in the sidebar (the budget tree it is reached from; *Plan* is not shown to every role); approval-rule rows do not wrap at 1280 px; the line page's status column is headed *Status*. | Visual; axe sweep stays at 0. |

## Out of scope

- The template's `ActionForm` has the same focus pattern: upstream proposal.
- A6 (focus after client navigation): the review marked it *Do not do*.

## Patch or release

None expected: the 404 title is set from clone-owned code. If a guard layout under a template directory has to change, its `FOUNDATION_PATCHES.md` hash is refreshed.
