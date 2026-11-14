# NEXT — Earmark

## Phase 4 (enterprise wiring, PRD §8): done, PR #5

Five commits (D-31 in `prd-earmark.md`).

**(1) done:** SSO. `seed:demo` turns Require SSO on for both demo orgs. Guests are exempt from it (D-32), which needed a template patch to `src/modules/sso/hooks.ts`, listed in `FOUNDATION_PATCHES.md`. The cross-org line for D-30's `alerts.ts` was never excused, so drift had been red since `14ff5d5`; it is excused now. Tests: `tests/earmark/invariants/sso.test.ts`; `e2e/enterprise.spec.ts` covers step 1 for real (the mock IdP stands in for Google), step 7's link half, and step 12. Full sweep: 22/22.

**(2) done:** API (D-33). The `invoices` scope; `GET /api/v1/commitments/[id]` (guest projection, one 404 body for foreign or missing); `POST /api/v1/invoices` through `fileInvoice` in `src/earmark/core.ts`, shared with the guest form. Tests: `tests/earmark/invariants/api.test.ts`; `e2e/enterprise.spec.ts` step 8's API half (the key is planted: demo accounts cannot mint keys). The `notFound()` test mock now carries Next's real digest, so the API's 404 mapping is exercised in vitest. Step 7's link test now deletes Dana's tokens first: `link.ts`'s 60s per-address cooldown swallowed the request on back-to-back sweeps. Gate: unit 519 + 1 skipped = 520, e2e 23/23 twice back to back.

**(3) done:** webhooks (D-34). Demo receiver `POST /api/demo/webhook` (DEMO_MODE only; its secret is derived from `AUTH_SECRET`, so no DB). `seed:demo` points a Northwind endpoint at it. Earmark's `emit` wrapper in `src/earmark/actions.ts` sweeps in `after()`, so delivery happens at approval, not at the daily cron. `e2e/demo.spec.ts` step 6 polls for the delivery `succeeded` with 200 and `"verified":true`. Test: `tests/earmark/invariants/demo-receiver.test.ts`. A local `npm run dev` demo needs `WEBHOOK_ALLOW_PRIVATE=1` in `.env.local` (http://localhost receiver), or the endpoint pauses after 10 failures; note it in DEMO.md.

**(4) done:** the explainer (D-35). `Draft with AI` on the line page; Haiku over `fetch` with a key, a fixed-usage stub without. The seed plants this month's spend so the fourth draft is refused, and resets it each seed. `e2e/demo.spec.ts` step 10 drafts, publishes, drafts twice more, and sees the fourth refused with 3 usage rows. `ANTHROPIC_API_KEY` joins `env.ts` (patch excused in `FOUNDATION_PATCHES.md`, propose upstream). Tests: `tests/earmark/explainer-drafter.test.ts`. Gate: unit 522 + 1 skipped, e2e 24/24 twice back to back, drift clean.

**(5) done:** demo steps 11, 13, 14 (D-36). Step 14 exports Northwind and checks the manifest's row counts and per-file sha256 with the system `unzip`; step 11 filters the audit log to today's actor and checks the CSV; step 13 (last in `e2e/demo.spec.ts`, since it removes Dana from Contoso) offboards Meridian and sees Contoso 404 and Northwind intact. The `/demo` accounts cannot export or remove members, so 13 and 14 act as `ops@<org>.demo.test` with a planted session (`e2e/real-owner.ts`). Fixed: `offboardAgency` left guests in place, unretryable, when a removal was refused (new E-INV-07 test); `seed:demo` now resets org names after a vitest run. Gate: lint, typecheck, drift clean; unit 523 + 1 skipped; e2e 27/27 twice back to back.

**PR #5 open** (`phase-4` → `main`, https://github.com/shanelabountyai/earmark/pull/5). Its §7 gate is automated-green; the only box left is Shane's: one manual Google and one Okta sign-in, recorded in the *Hand checks* table at the end of `docs/DEMO.md`.

## ▶ Now: Phase 5 (close-out) on branch `phase-5`, cut from `phase-4` (D-37). Model: Sonnet. Retarget to `main` once #5 merges.

**(1) done:** `docs/DEMO.md`. Live demo's real owner = the presenter's SSO user promoted by one `psql` line (D-37), who mints step 8's key in the UI. Run once, 2026-11-10: `seed:demo`, build and start, health, `/demo` 200, the promote SQL (in a rolled-back transaction), the step 6 delivery query, and step 8's two curls against the live server with a planted Contoso key (identical 404 bodies). Not runnable by Claude: the Google and Okta sign-ins (Shane), so steps 1, 11, 13 and 14 live are covered only by the e2e.

**Shane, before a live demo:** paste the seven `SSO_TEST_*` values into `.env.local` (lines 14–20, empty now; same values as `saas foundation/.env.local`), add `http://localhost:7600/login/sso/callback` as a redirect URI in both test apps, then `npm run seed:demo`.

**(2) done:** `WRITEUP.md` (Commons format). Its *Found while building* list is the LinkedIn mine.

**(3) done:** exec brief, *Earmark in Brief*: https://claude.ai/artifact/Xwpdyi152Ct3HWeyD99yGs (private until Shane shares it). No screenshots: the repo has no capture spec; add two (guest PO page, the identical 404) if wanted. Numbers re-run 2026-11-12: unit 523 + 1 skipped (one webhook test fails only while `WEBHOOK_ALLOW_PRIVATE=1` is in `.env.local`; passes unset), 27 e2e listed, not re-run.

**(4) done:** `CLONES.md` earmark row enriched in saas-foundation (pushed).

**(5) cost review done:** D-38 in `prd-earmark.md` (nothing deployed, nothing scheduled, $0 baseline; restore note recorded).

**(5) LinkedIn done (2026-11-13):** posts #168 (Impact, D-23) and #169 (Scale, D-32) added to the Lab Intelligence Ledger https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i, unposted. Note: project id `earmark` may need an entry in the Ledger page's PROJECTS list.

**▶ Next: Phase 5 closed.** Only open item: PR #5 waits on Shane's manual Google and Okta sign-ins (*Hand checks* in docs/DEMO.md).


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
