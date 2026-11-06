# NEXT

## ▶ Next session: v1.6.0 M14, finish the release (Opus). Waiting only on the owner's review of Pulseboard PR #4.
State 2026-11-06: PR #12 green on `d06f41c` (off, enforce, modules-removed). Owner's Okta + Google hand checks DONE and
recorded in CHANGELOG; they found a real bug (Okta ID token has no `email_verified`), fixed via userinfo fallback + INV-35 case.
Pulseboard PR #4 has the latest template merged (`1d2a4c6`, worktree `~/Projects/pulseboard-pr4`), CI green; D-027 annotated.
CHANGELOG already has the 1.6.0 upgrade steps (no separate UPGRADING.md; 1.5.0 precedent).
**On the owner's "approved":** bump `FOUNDATION_VERSION` to v1.6.0, retitle `## Unreleased (1.6.0)` → `## 1.6.0 (<date>)`,
merge PR #12, tag `v1.6.0`, push the tag to every clone repo in CLONES.md, confirm `foundation:status` in quorum, then the
kickoff's "After M14" list (Earmark first with `RLS_ENFORCE=1`, then Pulseboard, then foundation-rollout).
Local: `.env.test` gained `DATABASE_URL_SYSTEM` (test DB); without it tests' system client hit the dev DB. `.env.local`
`SSO_TEST_OKTA_DOMAIN=example.com` (Okta user `okta-tester@example.com`, admin of Globex in the dev DB).

## ▶ Next session: v1.6.0 M14 (release). Model: Sonnet is enough for the mechanics, but merging RLS/SSO/auth release PR #12 is a phase gate: Opus. Prompt: `docs/v1.6.0-KICKOFF.md`, M14 row + header; read PR #12's M13 section first.
**Before the tag:** the owner's Okta and Google hand checks (M10, `.env.local` lines 6-8) are still owed, and the Pulseboard proof PR must be reviewed by the owner (addendum §9 M13 gate).

**M13 done 2026-11-05** (`84d8baa`, `2419b84` on `v1.6.0`, PR #12): `apikeys` module, core `emit` + `OrgEvent`, INV-40/41.
**Owner decisions:** (1) a member's API keys are revoked when their membership ends (removal, leaving, account deletion), via the
clone-owned `onMembershipEnded` hook, now a required argument of `removeMember`/`deleteAccount`; (2) retries and page-action events
ride the **daily** `/api/cron` (kept daily for cost; addendum §7 item 3); (3) Pulseboard reissues its `pk_` write keys as `api_` keys
(no row copy) with an `ingest` scope at 3,000/min. Deviations: addendum §7 "As built in M13" (13 items). Gate: off 282 + 21 skipped,
enforce 302 + 1 skipped, e2e enforce 14/14, check-modules passes with all four modules removed; scope, revocation, dedupe and the
membership hook each mutation-checked red. **Pulseboard proof PR #4** (https://github.com/shanelabountyai/pulseboard/pull/4, unmerged; clone decisions D-025 to D-027): `ci (off)` and
`modules-removed` green; `ci (enforce)` was red because the template made enforce mandatory for clones. **Fixed in the template**
(owner, 2026-11-05: enforce is opt-in via repo variable `RLS_ENFORCE=1`; addendum §7 item 14). **Next step:** merge the template's latest
`v1.6.0` commit into PR #4's branch (in a worktree; Pulseboard's folder is on `foundation-v1.4.0` with draft PR #2 open, leave it), take
the template `ci.yml` (drop the clone's D-027 if it only records the enforce failure), watch CI green, then the owner reviews the diff.
Local e2e trap: vitest leaves an org with slug `acme`, and the demo seed then shows no "Acme Studio"; truncate the test DB before e2e.

**M12 done 2026-11-05** (`ef2ce1f`, `55a3390` on `v1.6.0`, PR #12): AI spend guards, INV-39. **Owner decision: hard cap by reservation**
(`AiHold` under a row lock; the signature gains `maxCostMicros`), addendum §6 "As built in M12". Gate: off 266 + 16 skipped, enforce 281 + 1 skipped,
e2e enforce 14/14. Proof: footnote PR #2 (`v1.6.0-withbudget-proof`, unmerged), worked in the worktree `~/Projects/footnote-m12` against its own DB
`footnote_m12_test`, so Shane's uncommitted `CLAUDE.md` edit in `footnote/` is untouched. Remove both once the PR is closed:
`git -C ../footnote worktree remove ../footnote-m12 && dropdb footnote_m12_test`. INV-34 is red there on purpose (footnote's `CorpusChunk`, `StaffRole`,
`Answer`, `ApiKey` need export decisions in its real upgrade; `ApiKey` must never be exported whole).

**M11 done 2026-11-05** (`e3f2280` on `v1.6.0`, PR #12): audit viewer, org and account security pages, per-org data export, INV-34.
Gate: off 254 + 13 skipped, enforce 266 + 1 skipped, e2e enforce 14/14, demo-org exports verify against their manifests,
check-modules pass. Owner decision: export archives live in Postgres (`OrgExport`, 24 h), not Vercel Blob (addendum §5 "As built in M11", item 1).
**Still open from M10:** CI on `e3f2280`; owner's Okta and Google hand checks (`.env.local` lines 6-8), due before the M14 tag. Doc sync hazard
unchanged: never sync the Claude Doc copy of the addendum back to the file.

### (done) M10 handoff, 2026-11-05: Okta app set up (Integrator Free org `integrator-1711217`, redirect `http://localhost:4100/login/sso/callback`)

### (done) M9 handoff, 2026-11-04

**Owner decisions 2026-11-04:** (1) The RLS/SSO/enterprise release is **v1.6.0**, not v1.5.0: v1.5.0 is already tagged (`cdc146b`,
vitest 5) and pushed tags never move. `docs/v1.6.0-ADDENDUM.md` and `docs/v1.6.0-KICKOFF.md` are renamed and carry a note; the branch
is `v1.6.0`, the PR "v1.6.0: RLS, SSO, enterprise modules". (2) Claude created the local `app_rw` role (NOBYPASSRLS, no superuser),
granted DML on `saas_foundation_test` plus default privileges; its URL is `DATABASE_URL_APP_RW` in `.env.test` (gitignored, password
never printed). M9's `db:setup` takes it over and writes `DATABASE_URL` (app_rw) / `DATABASE_URL_SYSTEM` (owner).

**Kickoff pre-flight:** addendum APPROVED 2026-11-04 (§10: 2 and 3 tightened). Still the owner's: Okta and Google
`SSO_TEST_*` in `.env.local`, which does not exist yet (needed by M10, not M9). Done: every clone on v1.4.1; `app_rw`.

**Merge rule (owner, 2026-11-04): "merge without me if saas foundation based".** Template release PRs and clone upgrade PRs merge
once green (v1.6.0's at M14); kickoff, memory and `foundation-rollout` skill all say so. An owner "hold" overrides it.

**v1.5.0 (vitest) clone rollout is ON HOLD** (owner): only tradepost PR #4 open, unmerged. The rest wait for the owner's go;
`foundation-rollout` skill resumes it. A clone can also skip straight to v1.6.0 later (it carries v1.5.0).

## ▶ 2026-11-04 (later): v1.5.0 released (vitest 5, F-05, `cdc146b`); rolling out to clones under the standing rule

Owner, 2026-11-04: run updates end to end without asking (memory `foundation-updates-autonomous`; procedure in
`~/.claude/skills/foundation-rollout/SKILL.md`, per-clone agent `~/.claude/agents/clone-upgrader.md`, both user-level so clones
don't inherit them). v1.5.0: vitest 2.1 -> 5.1, dev only, not `security:`; full `npm audit` 14 -> 8 moderate (lint-only minimatch).
Clones roll out in batches; housefile goes last (its phase-branch merge is running).
**ON HOLD (owner, 2026-11-04).** Done: tradepost PR #4 (open, unmerged, CI was pending). Not started: every other clone. Resume only on the owner's go.

## ▶ 2026-11-04: v1.4.1 is live in every clone. Next item: housefile phase branches (in housefile's folder).

All 13 `security:` v1.4.1 PRs merged by owner request (checks re-verified green before each). Production redeployed: gavel and
ledgerleave built from `main` automatically; callboard via its manual deploy hook (HTTP 201). All three were Ready by 18:12 CST and
answer 401 behind their shared password. `CLONES.md`: 13 rows on v1.4.1. Left open, each in its own folder: housefile (merge `main`
into `phase-1` and the phase-2 branch; refresh `housefile_test`), footnote (`CLAUDE.md` line 33 says v1.3.0, beside Shane's
uncommitted edit), template F-05 (vitest 5).

## ▶ 2026-11-04: clone upgrades to v1.4.0 run FROM HERE, one at a time (owner decision)

Shane chose to drive every clone's v1.4.0 merge (carries `security:` v1.3.1) from this session instead of one session per
clone: one Opus subagent per clone, **sequential** (no overlapping builds or pools). Each one merges, runs typecheck, lint,
unit tests, drift and a build, then opens a PR and **does not merge it**. CI runs e2e. Order: ledgerleave, coursework,
tradepost, gavel, pulseboard, callboard (`onsitestaffing/`), loanbook, adjuster, bracketry, housefile (no `template` remote yet),
footnote. Skipped: boxloop (on hold), gridline (12 uncommitted files, not in `CLONES.md`). `CLONES.md` rows move only when a PR merges.

**Mid-queue 2026-11-04 (owner decision): v1.4.1 `security:` cut.** `npm audit` found a critical `next` RCE (Image Optimization +
SVG, `<=16.4.0`, so v1.3.1's 16.3.8 doesn't cover it) plus highs in zod/prisma/sharp/source-map-js/fast-uri. v1.4.1 bumps next to
16.4.5 (audit 0). Remaining clones take **v1.4.1**; already-open v1.4.0 PRs (tradepost #3, gavel #3, pulseboard #3, callboard #18,
loanbook) and the clones already on v1.4.0 (quorum, commons, coursework, ledgerleave) each get v1.4.1 merged in.

**Roll-out done 2026-11-04 (all merged later the same day, see top): every clone (except boxloop, gridline) had an open `security:` v1.4.1 PR; `npm audit --omit=dev` 0 in each.**
Owner merges each, by 2026-11-11 (sooner: critical RCE), and moves the `CLONES.md` row to v1.4.1 as each merges.

| Clone | PR | CI | Owner note |
|---|---|---|---|
| tradepost | #3 | green | hand port (no shared history) |
| gavel | #3 | green | D-99 spec scoped, D-100 previews off; **deployed: redeploy after merge** |
| pulseboard | #3 | green | |
| callboard | #18 | green | next 16.4.0 → 16.4.5; **deployed: fire deploy hook after merge** |
| loanbook | #4 | green | `modules-removed` flaked once (Google font fetch) |
| adjuster | #3 | green | `sharp` pin 0.35.4 → 0.35.5 (D91 c) |
| bracketry | #2 | green | |
| housefile | #9 | green | then merge `main` into `phase-1` and the phase-2 branch; local `housefile_test` has the phase schema (17 billing tests fail on `main`) |
| footnote | #1 | green | also fixes CI (pgvector image); `main` red until merged; your `CLAUDE.md` edit untouched, line 33 still says v1.3.0 |
| quorum | #5 | green | |
| commons | #13 | green | note is D-99; phase-7.1 numbers from D-100 |
| coursework | #4 | green | |
| ledgerleave | #5 | green | D-63 Preview builds off (owner, like gavel D-100); **deploying: redeploy after merge** |

**Release-process lesson:** a clone's CI resolves `FOUNDATION_VERSION` via the tag *in the clone's own repo*. quorum, commons,
coursework and ledgerleave failed `foundation:drift` (`bad revision 'v1.4.1'`) until the tag was pushed to each. Next release: push
the tag to clone repos as part of the roll-out (or keep the `Release vX:` commit-message line some clones fall back on).
Follow-up: F-05 vitest 5 (dev-only advisories) in `BACKLOG.md`.

## ▶ 2026-11-03: v1.3.1 and v1.4.0 both tagged and pushed. Nothing open in this repo.

v1.4.0 (PR #7) was already merged and tagged; v1.3.1 (`security:`) was tagged at `1bc3386` and pushed 2026-11-03, a week
past its 10-27 date. Still owed, **each in that clone's own session**: every clone still on v1.3.0 in `CLONES.md` owes
v1.3.1 (`security:`, overdue); quorum, ledgerleave, coursework also implement `filterListedOrgs` (v1.4.0, steps in PR #7).
Older queue: talk4me SEC-01, storage SEC-01/02, both in their own folders.

### (done) v1.4.0 prepared 2026-10-26 on branch `org-list-hook`

Owner decision 2026-10-26 (D-22): clone hook `filterListedOrgs(userId, orgs) => orgs` in clone-owned `src/app/org-hooks.ts`,
beside `beforeOrgDelete`. `/onboarding` and `/demo` call it through `keepListedOrgs` (`src/core/tenancy/listed.ts`), which
intersects with the input, so the hook can only hide. Local gate: lint clean (1 pre-existing warning), typecheck clean,
207 tests, e2e 10/10, `foundation:check-modules` passes.

**Version settled (owner, 2026-10-26):** PR #4 (`next` 16.3.8 `security:` bump) merged as **v1.3.1**; this hook is
renumbered **v1.4.0** (an additive change is a minor under §3.3). `main` merged into this branch; CHANGELOG lists 1.4.0
above 1.3.1.

**Owner to-do:**
1. Tag v1.3.1 from the Mac on `main` at the PR #4 merge commit `1bc3386`: `git tag v1.3.1 1bc3386 && git push origin v1.3.1`.
   Clones must take it by 2026-10-27 (`security:`).
2. Merge PR #7, then tag v1.4.0 at its merge commit and push (the cloud proxy refuses tag pushes).
3. Each of quorum, ledgerleave, coursework merges v1.4.0 (which carries v1.3.1) and implements the hook against its
   `OrgArchive` (steps in the PR body); its `CLONES.md` row moves to v1.4.0.

## ▶ v1.3.0 released 2026-10-14 (model: Opus — permissions)

✅ **Good to clear.** `scorekeeper` role + `results.write` (D-21), a `security:` release for two INV-22/INV-28 latent defects
the new role exposed. 172 tests pass (4 new), lint and typecheck clean; e2e and `check-modules` run in CI on the push and tag.
Bracketry merged it the same day for L-040. **Every other clone owes v1.3.0 by 2026-10-21** (with v1.2.1, due 10-20), each in
its own session.

## ▶ Next session here: talk4me is next in the older queue if picked up; storage SEC-01/02 runs in its own folder (Opus, money)

✅ **Good to clear.** **`v1.2.1` released and pushed 2026-10-13** (model: Opus — `security:` release). Four fixes from the
2026-10-12 review, each with a red-first test: stale invites (`e47af9a`), the email-change oracle (`71b5fd8`), demo sessions
(`2cc20a8`), and the owner's 2026-10-13 decision that a demo session also cannot create an org or use billing (`4cae624`).
168 tests pass, typecheck and lint clean. No schema change. **Every clone owes this within 7 days (due 2026-10-20)**, each in
its own session; `CLONES.md` rows stay as they are until each merges. Not run locally: `foundation:check-modules` and the
e2e sweep (both build) — CI runs them on the push and on the tag.

**Older checkpoint (superseded above):** **F-03 done and pushed 2026-09-28, tagged `v1.2.0`** (model: Sonnet — spec-following tooling, no new
logic). A clone declares a module required in the clone-owned `src/app/required-modules.ts`; `foundation:check-modules`
(`scripts/foundation-modules.ts`'s new `modulesToRemove()`) leaves that module in place and still removes the rest. 3 new
unit tests (157 total pass), the filter mutation-checked red (dropped it, confirmed the test failed, restored). Verified
for real, not just unit-tested: ran `foundation:check-modules` once with `notifications` required — passed with only
billing removed and `notifications` left in place — and once with the template's default (nothing required) to confirm
the existing CI job is unchanged. **Also fixed in passing:** `FOUNDATION_VERSION` was still `v1.1.0` — the `v1.1.1`
release (`a121708`) never bumped it, a step the release process (`IMPLEMENTATION_PLAN.md` §3.3) requires; a clone created
between those two commits would have stamped the wrong base version. Now `v1.2.0`, current.
**Not done, on purpose:** callboard hasn't merged the release yet — that's callboard's own session, per the established
pattern (it still owes `v1.1.0` and the `security:` `v1.1.1` too, due 2026-10-05). Its `CLONES.md` row stays `v1.0.1`
until then.

**CI fixed 2026-09-28** (`37cf7c4`, model: Opus — real regression, not a stale-test triage). Root cause: `e2e/billing.spec.ts`
still injected a cookie named `session` via `context.addCookies`; K1 (`a121708`) had renamed the real cookie to `__Host-session`.
Fixed to the new name — but Chromium's CDP rejects a `__Host-` cookie set with a plain `http://` `url` field ("Invalid cookie
fields"), so it's set via `domain: 'localhost', path: '/', secure: true` instead, which Chromium accepts and still sends over
`http://localhost` (treated as a secure context). Verified: 10/10 e2e, 154/154 unit+integration, lint/typecheck clean, `gh run
watch` on the push shows green. Clones (tradepost, pulseboard, callboard) can now safely take v1.1.1.

✅ **Good to clear.** 6 of 8 LOWs fixed and pushed 2026-09-28 (`a121708`, tagged **`v1.1.1`**, model: Sonnet — `security:` release,
**clones (tradepost, pulseboard, callboard) owe this within 7 days, by 2026-10-05**). 10 new tests (154 total pass, 1 file:
`tests/integration/low-2026-09-28.test.ts`), each of the 5 test-covered fixes (K1 x2, K2, K5, K6, K13) mutation-checked red by
reverting just that source file with the new test in place, confirming failure, then restoring — not just asserted done.
Typecheck and lint clean.
- **K1** (`session.ts`, `link.ts`): `signOutEverywhere`/`confirmEmailChange` now also spend the user's other unused sign-in
  links, atomically with the session/email change. Cookie renamed `session` → `__Host-session`, `Secure` unconditional.
- **K2** (`totp.ts`): `confirmTotp` now runs `assertFresh` and claims enrolment via a conditional `updateMany` on
  `totpEnrolledAt: null`, so a concurrent second confirm loses the race instead of also minting 10 more recovery codes.
- **K5** (`http.ts`): IPv6 rate-limit key now scoped to the address's first 64 bits, not the exact address.
- **K6** (`orgs.ts`): `removeMember` now revokes that user's active share links in the org, same transaction as the delete.
- **K13** (`invites.ts`, `links.ts`, `projects/actions.ts`): `addProject`, `createShareLink`, `revokeShareLink`,
  `revokeInvite` now wrap their write and `audit()` call in one `db.$transaction`. Only `invites.ts` has direct mutation-check
  coverage in the new test file; `links.ts`/`actions.ts` got the identical pattern, not separately mutation-checked.
- **Not fixed, deferred on purpose** (see `audit/FOUNDATION-REVIEW-2026-09-26.md` LOW section): K13's `audit_append_only`
  role separation (needs a second non-owner Postgres role — real infra change, add if the audit log ever needs to survive a
  compromised app role) and the `.env.example`/drift tooling item (already accepted, documented behavior, D-19d).
- **Not done, on purpose**: clone upgrade notes for v1.1.1 in tradepost/pulseboard/callboard's own `NEXT.md` — each clone
  upgrades in its own session, per the established pattern; they're still behind (all at v1.0.1 per `CLONES.md`) and now
  owe both v1.1.0 and this v1.1.1 `security:` release.

**Older checkpoint (superseded above):** FR-09..11 done and pushed 2026-09-28 (`d422d1a`, tagged **`v1.1.0`**, model: Sonnet). 5 new tests (144 total
pass), each confirmed red against the prior behavior before its fix (patched-to-old-code, ran, restored). Typecheck and lint clean.
- **FR-09**: `FOUNDATION_PATCHES.md` entries now carry a hash of the excused diff (`` `path` `hash` — reason ``); `foundation:drift`
  fails again once that path's diff moves on, instead of excusing it forever. Error message prints the hash to paste in.
- **FR-10**: Billing nav link in `layout.tsx` marked `{/* billing */}` (JSX — a trailing `//` renders as literal text) and added to
  `MARKED_FILES`. Verified end-to-end: ran `foundation:check-modules` for real, confirmed `/o/[org]/settings/billing` is gone from
  the build output and drift stays clean.
- **FR-11**: `new-project` now refuses a port already `in use`/`reserved` in `~/.claude/CLAUDE.md`'s port table (best-effort, skips
  if the file is unreadable), and refuses a second run once `package.json`'s name is no longer `saas-foundation`.
- **Not done, on purpose**: clone upgrade notes for v1.1.0 — FR-09..11 is tooling, not a `security:` release, so no 7-day clock;
  each clone (tradepost, pulseboard, callboard) picks up v1.1.0 whenever it next upgrades, in its own session.
- **Also not done**: the 8 LOWs from `audit/FOUNDATION-REVIEW-2026-09-26.md` — queued, not urgent, "as time allows."

**Decided 2026-09-26 (Shane): queue all of it for a fresh session; nothing was changed in code.** Findings, confirmed in source:
`audit/FOUNDATION-REVIEW-2026-09-26.md` (no HIGH, 11 MED, 8 LOW). Order:
1. ~~**FR-01 first**~~ **Done 2026-09-27, tagged `v1.0.2`** (lease claim, send outside tx, 15s fetch timeout; 3 new tests, 3 mutations red, 125 pass). Was: outbox sends inside a 5s interactive tx; a slow provider → delivered, not recorded, re-sent every cron run
   and blocks the queue. Callboard's cron is `*/5`, so this is the live risk. Worth its own patch tag (v1.0.2) if the rest runs long.
2. ~~FR-02..05~~ **Done 2026-09-27, tagged `v1.0.3`** (`8e4dd35`; 18 mutations red, 133 pass + 10/10 e2e, check-modules green). Clone notes added to each clone's NEXT.md (uncommitted there, beside the v1.0.2 note).
   Choices: pending-MFA TTL 10 min; wrong-code cap 20/user/UTC day; invite caps 50/sender, 100/org, 5/recipient per day; the cancel hook lives in clone-owned `src/app/org-hooks.ts` (core may not import modules); concurrent pending checkouts still make two subs (ponytail note, logged).
3. ~~FR-06/07/08~~ **Done 2026-09-28, untagged (CHANGELOG *Unreleased (1.1.0)*)**: `unguardedEntrypoints()` + `// public: <reason>` markers (14 files), glob all of `src/` + inline `'use server'` refused, id-like untagged fields throw (`notRef()` opt-out). 7 mutations red, 139 pass. Tag v1.1.0 after FR-09..11, then add each clone's upgrade note (their NEXT already says v1.1.0 follows).
4. ~~FR-09/10/11 tooling~~ **Done 2026-09-28, tagged `v1.1.0`** (`d422d1a`). See the checkpoint note above.
5. ~~LOWs (K1, K2, K5, K6, K13 writes)~~ **6 of 8 done 2026-09-28, tagged `v1.1.1`** (`a121708`). See the checkpoint note above.
   Remaining 2 are deliberately deferred/no-action, not open work (K13 audit-role separation needs new infra; drift/.env.example
   item is accepted behavior) — the LOW queue item is closed.
Clones: tradepost (4200), pulseboard (4500), callboard (4600) — each upgrades in its own session. All three still owe v1.1.0
*and* v1.1.1 (`security:`, due 2026-10-05) — neither has an upgrade note yet.

**Also done 2026-09-26:** clinic D-32 (group leader writes notes for own group only, `f35252c`) and rental SEC-16 / D-266
(unrouted inbox portfolio-wide only, `58a0b5b`); CI green in both. Both repos had another session active at the time.

**Decided 2026-09-23: urgent live-security fixes run before foundation M0.** Each one is its own session, run in
**that project's folder** (one session per project). The details for each are in that repo's *Security findings*
section and in `audit/<repo>.md` here.

**Session pick 2026-09-25: item 5 (storage SEC-01/02) runs on Opus, in the storage business folder, not here. Foundation has nothing open; safe to /clear.**

**2026-09-26: Opus K4 pass done** (`audit/K4-SWEEP-2026-09-26.md`, scorecard v7). Rental K4 ✗ (3 HIGH, confirmed in source), clinic K4 ✗ (1 HIGH),
alongside ✔, reservations N/A. Rental's Re-check processed: 10/14, not the 14/14 its own NEXT claims (K1, K6, K11 still ✗).
Storage's Re-check stays queued in the artifact db until its SEC-01/02 edits are committed (they were uncommitted in flight at the time).
Carried notes moved to `BACKLOG.md` (F-01, F-02). Items 9–10 were fixed the same day (scorecard v8: rental 11/14, clinic 10/14).

## Queue (in order)

1. ~~**clinic: SEC-01 HIGH.**~~ **Live** (verified 2026-09-23): env vars set, pushed (`5f24c71`, in sync with origin),
   `curl -I https://clinic.labintelligence.co/` returns 401 with a Basic challenge, and the cron route returns 401 with no challenge. gitleaks is clean (196 commits),
   so `clearpath` was **made public** on 2026-09-23. **Done.**
2. ~~**event toolkit: SEC-01 HIGH.**~~ Fixed (`2de11b8`); SEC-02 fixed too. **The repo is still blocked from going public:**
   gitleaks flags a literal Vercel bearer token in `.claude/settings.json` (plus the ` 3`/` 4` copies), commit `b8310aa` (2026-08-14).
   Shane: revoke that Vercel token. The files are no longer tracked, but they are not gitignored either, so add `.claude/settings*.json` to `.gitignore`. The token stays in history, so revoking it is the real fix.
   SEC-03/04 (MED) are in progress in that folder (uncommitted edits).
3. ~~**claude-dashboard: SEC-01 HIGH.**~~ Fixed (`a009fce`, pushed). The server binds to 127.0.0.1 and a LAN connection is refused. SEC-02 and OPS-01 are covered by the same fix. **Done.**
4. ~~talk4me~~: **deferred to the end of the queue** (Shane, 2026-09-23). See item 8.
5. **storage business: SEC-01, SEC-02** (webhook re-apply; cross-facility echo). Model: Opus (money). The repo was made private on 2026-09-23 because of these findings; make it public again once both are fixed.
6. ~~design bridge~~: dead project (the API it needed cost too much), 2026-09-23. The repo stays private. SEC items dropped.
7. ~~**Foundation M0**~~ **Done** 2026-09-23 (Shane chose to run it before storage). The repo `shanelabountyai/saas-foundation` is **private**.
   The scaffold is pushed, and spikes S1–S3 all passed (the results are in spec §0). CI is lint + typecheck. Port 4100 is claimed in `~/.claude/CLAUDE.md`.
   **M1 core platform: done** 2026-09-23 (env/clock/log/db + guard, headers, health, error pages, vitest, prod-build e2e, CI; INV-14, 15 (public + api), 18, 20 green).
   **M2 Auth: done** 2026-09-23 in one session (est. 2). INV-05/07/09 (scoped to M2), 13, 15 (signed-in), 17, 23, 24, 25, 26 (TOTP) are green,
   and each was mutation-checked red. The first migrations exist: core, billing and notifications, each separate (D-14d). Build choices are in spec **D-14**.
   **M3 Tenancy + authz: done** 2026-09-23 in one session (est. 2). INV-01/02/03/04/22 run through the glob harness
   (`tests/invariants/harness.ts`; six negative controls, and mutation-checked red on real code), plus INV-05 (membership removal),
   06, 07 (invite), 09 (invite accepts), 19, 21 (including concurrent demotion), 26 (deletion) and 28, all green. D-13 confirmed; build choices are in spec **D-15**.
   **M4 Share links: done** 2026-09-23. `Project` is the example resource, with `core/share/{links,project}.ts`, `/s/[token]` and `/o/[org]/projects`.
   INV-07 (share link), 08, 09 (share reads) and 15 (share route) are green, each mutation-checked red (7 mutations). The e2e sweep passed 8/8. Build choices are in spec **D-16**.
   **M5 Cron + secret hygiene: done** 2026-09-24. `core/cron.ts` (`isAuthorizedCron`: fails closed, `safeEqual`, header only), hourly `/api/cron`
   (also sweeps `RateLimit` rows older than a day), `CRON_SECRET` in env + `.env.example`, `vercel.json` cron. INV-10/11/16 green, 5 mutations red. 84 unit/integration tests pass.
   **M6 Billing: done** 2026-09-24. `modules/billing/{provider,webhook}.ts`, `/api/webhooks/stripe`, `/o/[org]/settings/billing` (+ nav link),
   mock provider when no key. INV-12 green (13 tests, 8 mutations red, including the SB "any row = duplicate" bug and a dropped row lock).
   98 unit/integration + 9/9 e2e. **Found and fixed a defect present since M1**: Prisma writes were stored 5–6h off in a non-UTC Postgres zone (D-17g).
   Build choices are in spec **D-17**.
   **M7 Notifications: done** 2026-09-24. `modules/notifications/{outbox,sms,templates}.ts`, drain + 7-day sweep in `/api/cron`, Twilio/SMS env keys.
   11 new tests (109 total pass), 4 drain mutations red (no row lock, no backoff, no attempt cap, no sentAt filter). Build choices are in spec **D-18**.
   **M8 Demo, clone tooling, release: done** 2026-09-25. `/demo` + `seed:demo` (INV-27, 3 mutations red), `new-project`, `db:setup`, `foundation:drift|status|check-modules`
   (CI job `modules-removed`), README, legal stubs, CHANGELOG, CLONES. 122 tests + 10/10 e2e. **Tagged `v1.0.0`, then `v1.0.1`** (the acceptance run found the README's
   `git checkout -b main` fails in a fresh clone; a pushed tag is not moved, so the fix is a patch release). Clone from **v1.0.1**. Acceptance run from a clean clone:
   install to a working `/demo` sign-in took about 10s warm-cache (limit 30 min; not measured cold). Build choices in spec **D-19**.
   **M9 scorecard: done** 2026-09-25, artifact https://claude.ai/artifact/TognMvisj8T9GNQGtE9MbJ. Foundation row all ✔ (122 tests). All rows re-scored 2026-09-25 by Sonnet agents (audit/rescore/*.json; design bridge stays baseline). K3/K4 spot-checks flagged; the Opus K3/K4 pass has not run. Per-project Re-check buttons queue requests in the artifact db (docs checks/<project-id>); process them by reading with ArtifactData, re-running that project's scorer, then writing doneAt + summary back.
   **Clinic K11/OPS-04 cleanup landed 2026-09-25** (`clinic` a2e07eb: zod env schema, OPS-04 was already satisfied). Clinic is now 10/14. `audit/scorecard.json` and `build-scorecard.py` are updated and committed, but the artifact was republished (v5) with clinic at 10/14. **Next: storage (item 5)**, then talk4me. Earlier: storage (item 5) and talk4me (item 8).
   - Not built, on purpose: `scripts/seed.ts`, `scripts/drain-outbox.ts` (nothing needs them).
   - Shane, optional: to try real Stripe test mode, set `STRIPE_SECRET_KEY` (sk_test_), `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` in `.env.local`
     and forward with `stripe listen --forward-to localhost:4100/api/webhooks/stripe`. Not needed for M7.
   - Carried notes: an audit-log viewer (`audit.read`) and `/o/[org]/settings/security` are not built. Neither is in any milestone yet, so add them to `BACKLOG.md` if wanted.
   - The harness takes ~2.5s on an idle machine and ~80s under a sibling project's sweep (load 45). That is CPU contention, not a hang.
8. **talk4me: SEC-01 HIGH** (deferred here from item 4 on 2026-09-23). Cap `api/tts.ts` at about 500 chars, allowlist voice ids,
   add a Vercel Firewall rule. Model: Sonnet. After it is fixed, make the `talk4me` repo public.
9. ~~**rental business: K4-R1/R2/R3 HIGH**~~ **Fixed 2026-09-26** (`6d75d45`, SEC-09–15, CI green). Open in that repo: SEC-16 (unrouted inbox, a design
   question for Shane), the K4 LOWs, and K1/K6/K11 (tenant sign-out not server-side, same-origin referrer + no no-store on token pages, env schema covers 6 vars).
10. ~~**clinic: K4-C1 HIGH**~~ **Fixed 2026-09-26** (`8c060a5`, SEC-07–11). Also fixed: clinic CI had been red at `npm ci` since SEC-06 (`b72b1f3`, 09-23) —
   `a4d11ba` — which hid a date-rotted e2e spec, fixed in `62d7f1c`; CI green. Open in that repo: whether a group leader may write notes for attendees
   they don't treat (Shane), and two LOWs (forms for any client; not-found vs forbidden oracle).

**Shane-only, no code (still to do):**
- Revoke the Vercel token leaked in event-toolkit history (`b8310aa`, `.claude/settings.json`). This blocks making the repo public.
- ElevenLabs spend cap (talk4me).
- Rotate or remove the live Anthropic key and Neon credentials in `use-case-support-ticket-deflection/.env.local`.

## Where things are
- Spec (APPROVED v2): `FOUNDATION_SPEC.md`. Plan (APPROVED, M0–M9): `IMPLEMENTATION_PLAN.md`. Both were revised on 2026-09-23 after a Codex review (D-10 to D-12, INV-28, tighter S1–S3), and the revision is approved.
- Portfolio audit baseline for the M9 scorecard: `audit/` (17 reports on the K1–K14 checklist).
- SEC items were appended (uncommitted, for each repo's own session to commit) to:
  - storage, Bookable and rental: `docs/prds/06-backlog.md`
  - Countertop and reservations: `docs/backlog.md`
  - clinic, groundwork and talk4me: `NEXT.md`
  - alongside: `BACKLOG.md`
  - showcall: `docs/backlog.md`
  - event toolkit, design bridge, claude-dashboard and the three use-case repos: `SECURITY_BACKLOG.md`
  - Use-Case Studio: its backlog file
