# NEXT — Earmark

## ▶ Now: Phase 3 on `phase-3` (off `main` after PR #3 merged 2026-11-09). Model: Opus.

Seven commits (D-21 in `prd-earmark.md`). **Done: (1) demo seed** (D-20); **(2) dashboard, budget tree, line page** (D-23); **(3) requests, chain view, approvals inbox, rules settings** (D-24); **(4) commitments, guest view, guest invoice submit**; **(5) match, approve-for-payment, variance view, published notes** (D-25): `/o/[org]/invoices` (to match / to approve queues), `/o/[org]/invoices/[id]` (ranked suggestions with reasons, match form, Finance-only *Approve for payment* emitting `invoice.approved_for_payment`), `/o/[org]/variance` (per period, replan marker, latest published note), publish form on the line page. Demo step 9 is e2e in `e2e/demo.spec.ts`; tests in `tests/earmark/invariants/payment.test.ts`.

**(6) done in four commits:** planning (`/plan`, planned edits on the line page, D-26), seats (`/settings/seats`, owner only, D-27), reallocation (line page form, `reallocation` chain, planned moves on approval, D-28), guest agency binding and agencies (`/settings/agencies`, D-29). Tests: `tests/earmark/invariants/{planning,seats,reallocation,agencies}.test.ts`.

**▶ Next item: (7) alerts cron and e2e demo steps 1, 2, 6** with D-22's stand-ins: step 1 via `/demo`, step 6 asserts the `commitment.issued` event row. Alerts are data in `rules/alerts.json` (PRD §4): committed reaches 80 % of planned; actual reaches 100 %; an invoice unmatched 14 days; an agency's invoices exceed its open commitments. Each emails the line's owner seat; register the job in `cron-jobs.ts`. Phase 4's gate re-runs 1, 6, 8 for real. After (7): Phase 3 gate (e2e demo steps 1–8 pass), PR `phase-3` → `main`.

**Not built in Phase 3, on purpose (D-26):** rename/delete of plan rows; fiscal-year close/lock with carry-forward (nothing sets `lockedAt` yet).

**UI pattern learned in (5):** a form whose success removes it from the page (fully matched → suggestions vanish; approved → approve button vanishes) loses its `notice`. Assert the page's new state in e2e, not the notice.

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
