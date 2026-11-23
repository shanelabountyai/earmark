# PRD-B: The first minute

2026-11-21 · from `docs/audits/FIVE-LENS-2026-11-19.md` §2 (work items 2, 3, 6, 7, 8; findings U4, U5, U6, U8, U9, G1, G6) · Shane's decisions 3 (c) and 4 (b).

## Problem

The bare domain's first screen says "SaaS Foundation". The second, `/demo`, is 17 identical buttons in alphabetical order that tell no story and never say which six accounts the README walks. As the shared lists grow, "your request" is row 26 on a phone. The PO page says "nothing billed" after an invoice arrives. The request audit prints raw JSON on the walk's own page.

## Decisions applied

- Decision 3 (c): override the template-owned `/` and `/demo` pages in the clone now, each with a `FOUNDATION_PATCHES.md` line, and write an upstream hook proposal for saas-foundation (`docs/upstream/saas-foundation-clone-hooks.md`). The foundation repository is not edited.
- Decision 4 (b): `/demo` shows the six walk accounts as cards, the other accounts under a fold.

## Requirements

| # | Requirement | Test |
|---|---|---|
| B1 | `/` is an Earmark landing: logo, *Earmark*, one sentence on what it is, *Try the demo* (when `DEMO_MODE=1`) and *Sign in*. No "SaaS Foundation" text. | `e2e/demo.spec.ts` "the bare domain is Earmark's"; `/` in the axe sweep. |
| B2 | `/demo` has the Earmark logo and a one-sentence lede; *Start here* marks `owner@northwind.demo.test`; the six README accounts are cards in the README's order, each with who it is and the steps it is used in; every other seeded account is under a `<details>` fold. Every account still signs in through the same form and route. | `e2e/demo.spec.ts` "/demo shows the six walk accounts first …"; `/demo` in the axe and 390 px sweep. |
| B3 | Your own rows are easy to find: rows created today carry a *Today* marker in Requests, Approvals and both Invoices queues, and the *To approve for payment* queue lists newest first. | `e2e/demo.spec.ts` step 9 reads the marker. |
| B4 | The README's step wording matches the UI labels (*What it is for*, *Marketing Ops seat*). | Read. |
| B5 | The PO page's billing line is truthful: next to *Left to bill* it shows invoices received but not yet matched (*billed, awaiting match*), for invoices of the PO's agency naming it. | `e2e/demo.spec.ts` steps 7–8: after Dana's invoice the PO page shows *awaiting match*. |
| B6 | The request audit's *Details* column is readable: known keys (steps, amount, over budget, step, seat) as words and dollars; unknown keys fall back to `key: value`. | New `tests/earmark/audit-details.test.ts`. |

## Out of scope

- The TOTP issuer still says "SaaS Foundation" (`src/core/auth/totp.ts`, template core): in the upstream proposal, not patched here.
- `/onboarding` styling (template): upstream.

## Patch or release

Two `FOUNDATION_PATCHES.md` lines (`src/app/(public)/demo/page.tsx` with its drift hash; `src/app/page.tsx` as a note, since drift does not list that path) and the upstream proposal for clone hooks (landing page, demo account list, TOTP issuer).
