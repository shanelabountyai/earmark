# NEXT — Earmark

## ▶ Now: Phase 4 (enterprise wiring, PRD §8) on branch `phase-4`. Model: Opus.

Five commits (D-31 in `prd-earmark.md`).

**(1) done:** SSO. `seed:demo` turns Require SSO on for both demo orgs. Guests are exempt from it (D-32), which needed a template patch to `src/modules/sso/hooks.ts`, listed in `FOUNDATION_PATCHES.md`. The cross-org line for D-30's `alerts.ts` was never excused, so drift had been red since `14ff5d5`; it is excused now. Tests: `tests/earmark/invariants/sso.test.ts`; `e2e/enterprise.spec.ts` covers step 1 for real (the mock IdP stands in for Google), step 7's link half, and step 12. Full sweep: 22/22.

**▶ Next: (2) API.** Add the `invoices` scope to `src/app/api-scopes.ts`. Add `GET /api/v1/commitments/[id]` (scope `read`, guest-safe projection, an identical 404 body for a foreign or missing id) and `POST /api/v1/invoices` (scope `invoices`, `idempotent`, the same rules as the guest submit action). Template pattern: `src/app/api/v1/projects/route.ts`. Then step 8's API half in `e2e/enterprise.spec.ts`: Contoso's key on a Northwind PO id returns the same 404 body as a nonexistent id.

**Then:** (3) a demo webhook receiver plus step 6 for real; (4) the explainer action (plain `fetch` to the Messages API on `claude-haiku-5-5`, a fixed-usage stub when `ANTHROPIC_API_KEY` is unset; the seed plants AI usage so the fourth draft is refused) plus step 10; (5) e2e steps 11, 13 and 14. Steps 9 and 12 are already done. Gate (§7): the manual Google and Okta sign-ins, recorded in `docs/DEMO.md`, are Shane's.

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
