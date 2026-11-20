# NEXT — Earmark

## ▶ Closure status: live closeout and five-lens review (scheduled run, 2026-11-20 UTC; branch `closeout/2026-11-19-live`, draft PR "Earmark: live closeout pack and five-lens review (docs only)")

Documentation only. Nothing deployed, no environment variable touched, no application code, test, seed or template file changed. Decisions D-65 to D-67 in `prd-earmark.md`.

**Done**
- 2026-11-20: live closeout pack. `docs/RELEASE_NOTES.md` (new): what shipped from 17 to 20 November, live verification, local gate, cost review. `docs/DEMO.md` *Live demo*: nine stops (the gate plus the README's eight), each marked by its e2e test; none clicked through live yet. `docs/LINKEDIN_DRAFTS.md`: two drafts (D-47, D-63), unposted.
- 2026-11-20: exec brief **Earmark Live in Brief**, a Claude Docs document, private: https://claude.ai/artifact/7h7spt45ccKWWUXZQ2diNS (the first brief, unchanged: https://claude.ai/artifact/Xwpdyi152Ct3HWeyD99yGs).
- 2026-11-20: cost review (D-65): Earmark's measured Vercel usage $0.294 to $0.556 for 2026-11-17 08:00 to 2026-11-20 08:00 UTC, almost all builds. Neon, the domain, the Anthropic API and GitHub Actions not read.
- 2026-11-20: five-lens review, `docs/audits/FIVE-LENS-2026-11-19.md`: no Blockers; 49 findings (19 Major, 30 Minor), 23 work items; top five all about the first ten minutes of a visit (shared demo spoiled by one visitor, "SaaS Foundation" at `/`, an unbranded `/demo`, phone tables, visitor free text). One money bug off the walk: a partly matched invoice is counted twice against Available (C1).

**Verified, and how**
- Production deployment `dpl_CTPB6uks1m7KSybA9wqVi5ztgvSN` READY on `7968689` (PR #15), aliased to `earmark.labintelligence.co`: Vercel, read-only, 14:15 UTC.
- Runtime errors: one group, a `pg` SSL-mode warning, 12 occurrences in 7 days: Vercel, read-only.
- Gate on this branch (Postgres 16, RLS enforce): lint 0 errors (1 warning), typecheck clean, unit 652 passed + 1 skipped, build clean, e2e 41 passed. `npm ci` itself fails here (Prisma engine download blocked); CI is the gate.
- Every UI lens worked on a local production build with the demo seed, at 1280 and 390 px, light and dark.

**Not verified:** any page on the live site (WebFetch `client_error` at 02:06 and 14:14 UTC); Postgres 17; `prisma migrate deploy`; `foundation:drift`; production env vars (whether `ANTHROPIC_API_KEY` is set).

**Open:** the review's six decisions (report §3); the four proposed PRDs (report §2), not written; D-57's stated reason is wrong (report §1, C3), not edited; stale "not deployed" wording in `WRITEUP.md`, `docs/DEMO.md` (*Concede before you're asked*) and `prd-earmark.md` (opening paragraph, §6), listed in D-66, not edited.

**Your hand steps, in order**
1. You: read the draft PR and check CI is green on its head commit. It is docs only; merging it triggers a production build only if Vercel's ignore step sees a non-docs change (it should not).
2. You: open https://earmark.labintelligence.co/ in a private window; expect the password prompt; then `/demo` (six walk accounts among 17) and `/api/health` (`{"ok":true}`); then https://earmark-tau.vercel.app/ (expect the same prompt).
3. You: walk the nine stops in `docs/DEMO.md` *Live demo* on a laptop and once on a phone; fill in its table. Note: the live data has had visitors since the last seed.
4. You: make the review's decisions 1 to 6 (`docs/audits/FIVE-LENS-2026-11-19.md` §3), starting with decision 1 (keep the shared demo from being spoiled).
5. You: if you choose decision 5 (a), change `sslmode` to `verify-full` in the three Vercel database URLs and watch one redeploy.
6. You: read the two LinkedIn drafts aloud; add the ones you keep to the Lab Intelligence Ledger (https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i) as the next free numbers.
7. You: share **Earmark Live in Brief** when you are ready; it is private until you do.
8. You: read Neon's and the domain's billing yourself if you want a full cost figure; this run could not.

## ▶ D-61's two calls, decided by Shane on 2026-11-19 (branch `feat/request-open-link`, D-64)

- **(d) Open a submitted request:** built as option 1. The *Request submitted* notice now carries an *Open it* link to the new request; the action still returns a notice and does not redirect (D-24).
- **(f) Old `rules.edited` rows after a re-seed:** left as is (option 1). Nothing to build.
- **Demo password:** Shane sends the shared password along with the link wherever he shares it; the README is unchanged.

Not run locally (no database or Prisma engines in that session): the gate is the PR's CI (`ci (off)`, `ci (enforce)`, `modules-removed`). **Merging to `main` is a production deploy.** No migration, no schema change.

## ▶ Live gate (scheduled run, 2026-11-19): branch `live-gate`, draft PR "Earmark live gate: demo-path fixes and README demo script"

**Nothing was deployed. Merging the PR to `main` is a production deploy** (Vercel builds `main` and runs `prisma migrate deploy`; this PR has no migration and no schema change).

**Did (D-57 to D-63 in `prd-earmark.md`):** of §11's six open items, four fixed: a settings page the role may not open is the 404, not a 500 (guard layouts; D-57); a one-org `/demo` account lands in its org (D-58); the members page is usable at 390 px and the template settings pages carry the Earmark look, CSS only (D-59); a due date before the invoice date is refused (D-60). README has *Try the live demo*: eight steps with the shared accounts.

**Left for Shane (D-61):** open a submitted request directly (recommend: an *Open it* link in the notice); the seed keeps old `rules.edited` rows (recommend: leave; the log is append-only).

**For a foundation release:** `requireOrg(org, perm)` in a page or GET route should answer 404, not throw (then the five guard layouts and their four `FOUNDATION_PATCHES.md` lines go); until then `settings/audit/csv` and `settings/danger/export/<id>/download` still answer a member 500. A clone hook for where a demo sign-in lands. A class on destructive buttons in template pages.

**Not verified:** anything on https://earmark.labintelligence.co (the sandbox got a client error, consistent with the password gate; no page was read). `npm run foundation:drift` against the real `v1.7.0` tag (the tag is not in this repo; run with `--base 4938406`). Postgres 17 locally (16 here; CI runs 17).

**Shane's hand steps, in order:**
1. Read the PR; check CI is green on its head commit.
2. Locally: `git fetch https://github.com/shanelabountyai/saas-foundation.git tag v1.7.0 --no-tags && npm run foundation:drift`. Expect the two entries that were already red on main (`src/modules/sso/hooks.ts` stale hash, `src/proxy.ts` unlisted) and none from this branch; update those two lines in `FOUNDATION_PATCHES.md` if you agree with them.
3. Look at Members, Audit log, Security and API keys on a phone and in dark mode.
4. ~~Decide D-61's two calls.~~ Decided 2026-11-19 (D-64, above).
5. Merge (this deploys). Then open https://earmark.labintelligence.co/demo, pick `owner@northwind.demo.test` (it should land on the dashboard, not *Your orgs*), and walk the README's eight steps once.
6. Decide how a hiring manager gets the shared password: the README says only that the owner gives it out.

## ▶ Now: design pass on branch `design/impl` (scheduled run, 2026-11-18; instructions `docs/design/RUN.md`)

**Built:** the Claude Design look (HANDOFF.md owner calls) on every Earmark page: `src/app/globals.css` (tokens, light + dark), `src/earmark/ui/` (page kit, sidebar shell with phone menu, guest client switcher, `Form`, invoice form), and the 14 org pages rewritten on it. Eight gap artboards added in `docs/design/` (Plan, Variance, Approvals, Requests, Commitments, Invoices, Seats, Agencies) before building them. Decisions D-44 to D-55 and requirements DX-01 to DX-09 (§11) in `prd-earmark.md`.

**Reviewed:** three independent reviewers (design fidelity, UX, accessibility) on the running app; must-fix and most should-fix findings fixed in `9bc00f0` and after; the table is in the PR body. `e2e/design.spec.ts` runs axe on every Earmark page (light/dark × 1280/390): 0 violations.

**Left open (§11, end):** invoice due-before-issued accepted; no redirect to a new request; template pages (members, audit, API keys, export) not restyled and 500 for members; `/demo` lands on Your orgs; seed keeps old `rules.edited` rows.

**Shane's hand steps:** open the Design canvas (https://claude.ai/artifact/Mg1iqfuNLVesgVUYxk8d9E) and add the eight gap artboards if wanted; look at the PR's screens on a phone and in dark mode; decide on the open items; merge or not. `foundation:drift` was already red on main before this branch (stale hashes for `src/modules/sso/hooks.ts` and `src/proxy.ts` against `v1.7.0`); this branch updates only the `cross-org.ts` line it touched.

**Local notes from the cloud run:** Prisma engines could not be downloaded (`binaries.prisma.sh` blocked), so migrations were applied with `psql` and a stub schema engine; Postgres here was 16, CI uses 17.


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

**▶ Next: Phase 5 closed.** PR #5 merged; Shane's Google and Okta hand checks passed 2026-11-17 (*Hand checks* in docs/DEMO.md). PR #6 merged 2026-11-17. Nothing left; the three open items below are optional.


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
