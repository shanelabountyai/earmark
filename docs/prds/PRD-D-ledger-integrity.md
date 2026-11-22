# PRD-D: Ledger integrity

2026-11-21 · from `docs/audits/FIVE-LENS-2026-11-19.md` §2 (work items 9 and 10; findings C1, C6, C7, C12, S2) · Shane's decision 6 (a). Built first: it is the money.

## Problem

1. **C1, a partly matched invoice is counted twice against Available.** An invoice stays `submitted` until all of it is matched. `ledgerOf` passes its whole amount to the rollup as unmatched provision, while the matched part already counts as committed. Reproduced in the review: a $5,000 invoice matched $3,000 to a $3,000 PO took $8,000 off Available. The engine and the Python oracle share the rule, so parity cannot catch it (the D-23 lesson).
2. **S2 / C7, an invoice's PO number is not checked against the agency.** `fileInvoice` stores any `poNumber` text. The ledger maps an invoice to a line by that raw text, with no agency check and no normalisation, so a guest can file an invoice naming another agency's PO and lower that PO's line's Available; the staff PO page lists it under the other agency's PO.
3. **C6, tier-2 suggestions offer a Match that always fails.** "PO number, other agency" rows carry a *Match* button; `matchInvoice` always refuses a cross-agency match.

## Decisions applied

- Decision 6 (a): fix C1 in the engine (`src/lib/earmark/rollup.ts`), the oracle (`tools/rollup_oracle.py`) and the fixtures together, with a new D-row beside D-23 and PRD §4's wording.

## Requirements

| # | Requirement | Test |
|---|---|---|
| D1 | The rollup counts a submitted invoice's provision as its amount minus what is already matched to it (pending or approved; not rejected). The engine owns the subtraction: it sums the ledger's matches naming the invoice, or takes the invoice's `matchedCents` when the caller supplies the total matched across every PO. A fully matched remainder (zero) is neither provision nor listed as unmatched. Matched above the invoice amount is a `LedgerError`. | New fixtures `fixtures/rollup/partial-match-provision.json` and an error fixture, through both engine and oracle (`tests/earmark/parity.test.ts`). |
| D2 | `ledgerOf` passes each submitted invoice's total matched, so a line's Available and the dashboard agree with the engine. | `tests/earmark/invariants/ledger.test.ts`: the review's reproduction ($5,000 invoice, $3,000 matched to a $3,000 PO) takes $5,000 off Available, not $8,000. Failing first. |
| D3 | `fileInvoice` (the guest form and `POST /api/v1/invoices`) resolves a non-empty PO number, normalised, to a commitment of the same org **and the invoice's agency**, and stores that PO's own number. Otherwise it refuses: *No PO <n> for <agency>.* (the API answers 422, as for D-60). An empty PO number stays allowed: an invoice with no PO is the control exception the dashboard shows. | `tests/earmark/invariants/api.test.ts` "D-70 …" (form and API): another agency's PO number is refused on both paths; a lower-case PO number is stored canonical. Failing first. |
| D4 | The ledger maps an invoice to a line through a PO of the same agency, comparing normalised PO numbers. The staff PO page lists only invoices of the PO's agency that name it. | `ledger.test.ts`: a pre-existing invoice row naming another agency's PO (written below the action, as an old row would be) does not lower that line's Available. |
| D5 | Tier-2 suggestions ("PO number, other agency") are shown as information, without a *Match* button. | Covered by reading the page; the action already refuses (E-INV). |

## Out of scope

- Rows already stored in production with a cross-agency PO number: D4 makes them harmless to the ledger; nothing rewrites them.
- Matching all-or-nothing (decision 6 (c), not chosen).

## Patch or release

None. No schema change, no migration.
