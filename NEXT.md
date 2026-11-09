# NEXT — Earmark

## ▶ Now: Phase 3 on `phase-3` (off `main` after PR #3 merged 2026-11-09). Model: Opus.

Seven commits (D-21 in `prd-earmark.md`). **Done: (1) demo seed** (`scripts/seed-earmark.ts`, D-20).

**▶ Next item: (2) dashboard, budget tree and line page.** `/o/[org]` home: planned, committed, actual, available, aged unmatched invoices (rollup engine over the whole org). Program → campaign → line tree. Line page: requests, POs, matches, history with the *replan* marker (`plannedEditedAt`, `isReplan` in `variance.ts`). Demo steps 1–2. Seeded: Northwind `Demand Gen → Paid Social → Q2 Paid Social` carries the replan marker.

Then: (3) request form, chain view, approvals inbox, rules settings → (4) commitments, guest view, guest invoice submit → (5) match with suggestions, approve-for-payment, variance view, published notes → (6) planning CRUD, seats, reallocation, guest agency at invite → (7) alerts cron, e2e demo steps 1–8 with D-22's stand-ins: step 1 via `/demo`, step 6 asserts the event row, step 8 URL half only. Phase 4's gate re-runs 1, 6, 8 for real.

**Seed facts for the e2e:** sign in at `/demo`. Requester `member@northwind.demo.test` also holds Demand Gen Owner (self-approval refusal); `demandgen@` approves Demand Gen lines; `admin@` holds Marketing Ops; `finance@` Finance; Dana is `dana@meridian.demo.test`, guest in both orgs.

**Phase 3 inherits (D-17):**
- Planning CRUD (fiscal year, programs, campaigns, lines, planned edits with the replan marker)
- Seat management
- The reallocation flow (`Reallocation` table exists; the `reallocation` chain is in the rules)
- Publishing a variance note
- Invoice approve-for-payment (emits `invoice.approved_for_payment`)
- Binding a guest's agency at invite time: core invite accept is template-owned, so either an `assignGuestAgency` step after accept, or a template hook proposed upstream
- `seed:demo` for Northwind, Contoso, Meridian and Dana (PRD §9)

**Open items, not blocking:**
- `FOUNDATION_PATCHES.md` holds two lines for the `guest` role (D-12). Propose upstream as template v1.7.0 (`guest` role, no core permission), then delete the patch lines when Earmark merges it.
- The template's migrations still create the `billing` and `notifications` tables (`BillingAccount`, `Outbox`, `StripeEvent`) though both modules are removed here. `prisma migrate diff` wants to drop them. Left alone: a template-side question, not Earmark's.
- The tag `v1.6.1` was never pushed to this repo (only `v1.6.0`), so `foundation:drift` fails on a fresh clone until it is fetched. Fix: `git fetch https://github.com/shanelabountyai/saas-foundation.git tag v1.6.1 --no-tags && git push origin v1.6.1`.
- **Template bug (fix in the next template patch):** the v1.6.0 `ci.yml` enforce step hardcodes `saas_foundation_test`, and `new-project` only renames it at clone time. Every clone that merged v1.6.x and later sets `RLS_ENFORCE=1` gets a red `ci (enforce)` at setup. Earmark fixed its own copy (`d1db748`). The template should use `$PGDATABASE` or the DB name from `DATABASE_URL`.
- GitHub's default branch is `prd` (holds only the PRD commit); work merges to `main`. Consider making `main` the default.

**Local setup notes:** `npm run db:setup`, then in `.env.local` and `.env.test` set `DATABASE_URL` to the `DATABASE_URL_APP_RW` value and `RLS_MODE=enforce` (D-08; README).
