# PRD-A: The demo stays fresh

2026-11-21 · from `docs/audits/FIVE-LENS-2026-11-19.md` §2 (work items 1 and 5; findings U1, U2, U3, S1, S6, C2, C8, C12) · Shane's decisions 1 (c) and 2 (a).

## Problem

The live demo's database is shared and never reset. One visitor holding the shared password can end the Finance seat, rewrite the approval rules, replan a line or tie Dana to another agency, and every later visitor's walk breaks. Even without that, each full walk commits $12,000 on Q2 Paid Social, so after about 16 walks step 3 stops matching the README. Visitor free text and links (any scheme, any host) are shown to the next visitor. And one failing cron job stops every job after it.

## Decisions applied

- Decision 1 (c): `assertNotDemo` guards on the configuration actions **and** a nightly reseed from the cron.
- Decision 2 (a): the reseed wipes all Earmark rows of the demo orgs and replants them; the audit log stays append-only (D-64 already accepted that visitors' acts remain as history).

## Requirements

| # | Requirement | Test |
|---|---|---|
| A1 | A shared demo session (`isDemo`) is refused, before any write, by every configuration action: `editRules`; `createFiscalYear`, `createProgram`, `createCampaign`, `createLine`, `setPlanned`; `createSeat`, `assignSeat`, `endSeat`, `delegateSeat`, `clearDelegation`; `createAgency`, `assignGuestAgency`; `submitReallocation`. The refusal is the template's own words (*This is a shared demo account, so that is switched off here.*). Requests, approvals, invoices, matching, payment approval and variance notes stay open: they are the walk. | New `tests/earmark/invariants/demo-guard.test.ts`: each guarded action refuses a demo session and writes nothing; a request still submits. Failing first. |
| A2 | When `DEMO_MODE=1`, the daily `/api/cron` replants the demo orgs' Earmark rows (`scripts/seed-earmark.ts`'s `seedEarmark`): rules, seats, plan, requests, POs, invoices, agencies and Dana's agency tie go back to the seed. The audit log is not touched. Not run when `DEMO_MODE` is off. | New `tests/earmark/demo-reset.test.ts`: after a rules edit, an ended seat and a replan, the reset restores rules, seats and planned; with `DEMO_MODE` off it does nothing. |
| A3 | Each cron job runs isolated: one job's throw is logged (`cron.job_failed`, job name and error name only) and recorded in the result, and the jobs after it still run. Inside the alerts job, one org's failure does not stop the next org (C8). | `demo-reset.test.ts`: a failing job does not stop the rest. |
| A4 | Visitor free text is capped for demo sessions: request and reallocation descriptions, invoice numbers, variance notes and decision notes at 200 characters (forms and API keep their general caps for real accounts). | `demo-guard.test.ts`: a 201-character description from a demo session is refused. |
| A5 | An invoice's file reference is an `https://` URL or empty, on the guest form and on `POST /api/v1/invoices`; `javascript:`, `data:` and `http:` are refused. | `tests/earmark/invariants/api.test.ts`: the API refuses a non-https `fileRef` with 400. |
| A6 | `e2e/demo.spec.ts` step 5 (the rules edit) runs as a real owner (`e2e/real-owner.ts`), never weakened: the demo admin is now refused. | `e2e/demo.spec.ts` "steps 3–5 …". |
| A7 | README and `docs/DEMO.md` say the demo resets every night at 06:00 UTC and which settings are switched off for the shared accounts. | Read. |

## Out of scope

- The AI spending allowance is **not** reset nightly (see the D-row): with a real key that would raise the effective cap thirtyfold.
- Write throttling and the password gate's rate limit (S3, S4): later.

## Patch or release

None: `src/app/cron-jobs.ts` is clone-owned. One new entry in the template's `src/core/db/cross-org.ts` allowlist (the reset crosses orgs), excused by a refreshed hash on its existing `FOUNDATION_PATCHES.md` line.
