# Changelog

Entries prefixed `security:` are mandatory for anything touching an invariant. Clones must take a `security:` release within 7 days.

## 1.6.1 (2026-11-07)

Fix: `src/core/db/cross-org.ts` listed `src/modules/billing/webhook.ts` and `src/modules/notifications/outbox.ts` without
their `// billing` / `// notifications` markers, so removing either module left a stale entry and INV-32 ("every listed file
exists") failed in the clone. Found by Earmark Phase 1.5 (`ci (off)` red on earmark PR #2). The template never saw it because
`foundation:check-modules` removes modules and runs typecheck, build and drift, not the invariants. Both lines now carry their
marker, and a new unit test fails if any line in a `MARKED_FILES` file names a module path without that module's marker
(mutation-checked red). Not `security:`: INV-32 was over-strict in clones, never permissive.

Also: `foundation:status` counted any line containing `security:` as a security entry (it flagged 1.5.0's "Not `security:`").
It now matches only lines that start with `security:`.

Upgrade: merge, `npm ci`. A clone that removed `billing` or `notifications` deletes the matching marked line(s) in
`src/core/db/cross-org.ts`, as the "Removing a module" recipe says; `foundation:drift` allows it. No migration, no env change.

## 1.6.0 (2026-11-06)

**M9: row-level security, opt-in (addendum §2).** `withOrg(ctx, fn)` and `asSystem(fn)` in `src/core/db/rls.ts`; a second
client on `DATABASE_URL_SYSTEM` (owner); `RLS_MODE` (unset | `enforce`). `npm run rls:policies` generates the policy migration from
the schema; `20261105000000_rls_policies` covers the 7 core and module tables with `orgId`. Every org-scoped query runs in `withOrg`;
the cross-org paths are a closed list in `src/core/db/cross-org.ts` (INV-32). INV-29 to INV-33 added. A clone that merges this and
sets nothing behaves as on 1.5.0: its role is the owner, which bypasses the policies.

Measured round-trip cost (spike S4c; 200 reads of one Project row after 20 warm-up; integer microseconds):

| Where | plain p50 / p95 | `withOrg` p50 / p95 |
|---|---|---|
| local Postgres 17 | 285 / 1082 | 617 / 1265 |
| Neon pooler, from a laptop (aws-us-east-2) | 43809 / 129913 | 179714 / 262536 |

`withOrg` is BEGIN + `set_config` + the query + COMMIT: four round trips where a plain read is one. From a laptop that is about 4x per
read on Neon; from a Vercel function in the same region the round trip is a few milliseconds, but the ratio holds. With RLS off (the default) it
costs nothing: no `set_config`, and reads marked `{ atomic: false }` skip the transaction (D-31). Under enforce, a page should do
its reads in one `withOrg`, not one each.

**M10: `sso` module, OIDC per org (addendum §3).** Removable like billing (`foundation:check-modules`). Tables `SsoConnection`,
`SsoDomain`, `SsoState` and `SsoSubject` (`prisma/schema/sso.prisma`), plus one core column, `Session.mfaOrgId`. Migrations `20261106000000_sso`
and `20261106000001_rls_policies_sso` (the regenerated policies, now 10 tables). `SSO_ENABLED=1` turns it on; unset, `/login`
never routes to a provider. Owners manage the connection, DNS-verified domains, Test sign-in and *Require SSO* at
`/o/[org]/settings/sso`. Built on `openid-client` 6.8.8 (pinned), with ID-token signature checks turned on. The approved §10 rules hold:
provider MFA counts only with `amr: mfa`, and only in that org; JIT only on `allowedDomains` plus `hd` for Google. INV-35 to
INV-38 added, run against a local mock provider (`tests/helpers/oidc-mock.ts`), and INV-22 gains the SSO cases. A clone that merges this and
leaves `SSO_ENABLED` unset behaves as before. **Hand check before the tag:** one sign-in each through Okta and Google Workspace
(results to be recorded here).

**M11: audit-log viewer, security pages, per-org data export (addendum §4, §5).** `/o/[org]/settings/audit` (F-01: filter by
actor, action and day, 50 a page, CSV download) and `/o/[org]/settings/security` (F-02: two-factor status and last sign-in per member,
SSO status and the *Require SSO* switch) for owners and admins; `/account/security` lists sessions with last seen, country and
method, and signs out any one but the current. Owners export the org from `/o/[org]/settings/danger`: a zip of JSON Lines plus
`manifest.json` (row counts and sha256 per file), fresh sign-in, one an hour, kept 24 hours, emailed as a link to a signed-in page.
A clone lists its own tables in the new clone-owned `src/app/export-hooks.ts`. INV-34 added. Migrations `20261106000002_m11_export_sessions`
(`OrgExport`, sign-in columns) and `20261106000003_rls_policies_export` (11 tables). Deviations: addendum §5, "As built in M11".

**M12: AI spend guards (addendum §6).** `withBudget(ctx, feature, maxCostMicros, fn)` in `src/core/ai/budget.ts` is a **hard cap**: under a
lock on the org's `AiBudget` row it refuses (`BudgetExceeded`, a `Refused`) when this month's spend, plus every call in flight, plus
this call's worst-case estimate would pass the cap; otherwise it holds the estimate (`AiHold`) while `fn` runs and swaps the hold for
an `AiUsage` row priced from the billed tokens. Prices are data in `src/core/ai/prices.ts` (integer micro-dollars per MTok, as of
2026-10-19); an unpriced model throws. Default cap $25.00 per org per month, hard stop on; demo orgs seed at $1.00. One email to the owners
per month at 80% and one at the cap, both audited. `AI_ENABLED=0` refuses every call. The *AI spending* card (this month, the limit,
pause) is on `/o/[org]/settings/security`; changing it needs `billing.manage`. INV-39 added. Migrations `20261107000000_ai_spend`
(`AiUsage`, `AiBudget`, `AiHold`) and `20261107000001_rls_policies_ai` (14 tables). Inert until a clone calls `withBudget`.
Deviations: addendum §6, "As built in M12".

**M13: `apikeys` module, API keys and outbound webhooks (addendum §7, ported from Bookable's W- track).** Removable like
billing (`foundation:check-modules`). Owners and admins (new permission `apikeys.manage`) issue keys at `/o/[org]/settings/apikeys`:
shown once, stored as sha256 with a short visible prefix, scoped, revoked on the next request, rate-limited per key and scope
(`read` 120 and `write` 20 a minute). `/api/v1/projects` (list, get, create) and `/api/v1/events?since=` (catch-up) show the shape:
problem+json errors, keyset cursors capped at 100, and `Idempotency-Key` required on every POST (replayed for 24 hours, a reused key
with another body is 422). Removing a member, a member leaving, or deleting an account revokes the keys that person created (owner decision; clone-owned `onMembershipEnded` in `org-hooks.ts`, now a required argument of `removeMember` and `deleteAccount`). Core gains `emit(ctx, type, payload, tx)` (`src/core/events.ts`), which writes the org's event log
(`OrgEvent`, seq per org handed out at commit by a trigger) in the change's transaction, beside its audit line. The module fans
the log out to signed webhook endpoints (`Webhook-Signature: t=…,v1=HMAC-SHA256`, 24-hour secret rotation overlap), retries six
times with backoff, dead-letters, pauses after ten failures in a row, disables on a 410, and replays from the settings page with
`replayed: true`. Clone-owned: `src/app/api-scopes.ts` and `src/app/event-types.ts`. INV-40 and INV-41 added; the outbound half of
INV-12 lives with INV-41. Migrations `20261108000000_org_events` (core), `20261108000001_apikeys_init` and
`20261108000002_rls_policies_apikeys`. `WEBHOOK_ALLOW_PRIVATE=1` (test only, refused in production) lets an endpoint be
`http://localhost`. A clone that merges this and calls no `emit` behaves as before. Delivery timing: an API write sends its
webhooks right after the response; everything else (retries, events from page actions) waits for `/api/cron`, which the
template schedules **daily** (see addendum §7 "As built in M13", item 3).

**CI enforce leg is opt-in for clones** (owner, 2026-11-05; addendum §7 item 14). The template always runs `ci (off)` and
`ci (enforce)`; a clone runs `enforce` only once the repo variable `RLS_ENFORCE=1` is set
(`gh variable set RLS_ENFORCE --body 1 --repo <clone repo>`). INV-29 seeds clone tables through a fixture hook.

**Real-provider hand checks (owner, 2026-11-06; addendum §3, M10 gate).** Okta (Integrator Free org): a new user on a verified
domain JIT-joins Globex as member; promoted to admin with no TOTP, the Okta `amr` carries `mfa` and the session gets `mfaOrgId`
(no TOTP prompt). Google Workspace: a `labintelligence.co` user lands in Acme. Not done by hand, covered by INV-35 to 38 through
the mock: an unverified email (every Okta refusal on the night was the bug below, never a real `false`), a personal Gmail on the
Google connection (Google honours the login hint and skips the account picker), and an Okta sign-in without `mfa` in `amr`.
**What Okta's `email_verified` is worth:** Okta reported `true` for an admin-created `okta-tester@example.com`, an address no one
can receive mail at. With Okta, `email_verified` means "the org's Okta admin vouches for it", not proof of inbox control: whoever
administers the org's Okta can create a user with any email on an allowed domain and JIT-join. That is the expected trust model for
an org's own IdP; the DNS-verified domain is the real control. **Found by the Okta check and fixed:** Okta's ID
token carries `email` but never `email_verified`, so every Okta user was refused. The callback now reads both from userinfo
when the ID token lacks either, bound to the same `sub`; the mock gains an Okta mode and INV-35 a case (mutation-checked red).

Upgrade (every feature is opt-in; a clone that merges and sets nothing behaves as on 1.5.0 at runtime):

1. Merge the tag, `npm ci`, `npx prisma migrate deploy`. Ten migrations, all additive. If the clone has its own `orgId` tables,
   run `npm run rls:policies` and commit the migration it writes, or INV-29 fails on them.
2. Clone-owned files arrive with safe defaults; fill them in when the feature is used: `src/app/export-hooks.ts` (list your
   org-scoped tables, or INV-34 fails on them), `src/app/api-scopes.ts`, `src/app/event-types.ts`, `src/app/modules.ts`,
   `src/app/cron-jobs.ts`.
3. **The one compile break:** `removeMember` and `deleteAccount` take `onMembershipEnded` (from `src/app/org-hooks.ts`) as a
   required argument. Any clone call site outside `src/core` must pass it.
4. `.env.example` adds `DATABASE_URL_SYSTEM`, `RLS_MODE`, `AI_ENABLED`, `SSO_ENABLED`, `WEBHOOK_ALLOW_PRIVATE` and the
   `SSO_TEST_*` set. All may stay unset. Turning on enforce needs an `app_rw` role without `BYPASSRLS` (`npm run db:setup` locally;
   the README has the Neon SQL), `RLS_MODE=enforce`, both URLs, and the repo variable above.
5. Remove `sso` or `apikeys` you don't use, the same way as billing; `npm run foundation:check-modules` confirms it.

## 1.5.0 (2026-11-04)

`vitest` 2.1 -> 5.1 (dev dependency only; F-05). It clears the dev-tree advisories found during v1.4.1: tinypool prototype-pollution RCE
(critical), `@vitest/mocker` (critical) and vite path traversal (high). `vite` moves 5 -> 8 under vitest. `vitest.config.ts` needed no
change; 207 tests pass unchanged. Not `security:`: nothing that ships changes, and `npm audit --omit=dev` was already 0. Full
`npm audit` goes from 14 (2 critical, 1 high, 11 moderate) to 8 moderate, all one `minimatch` DoS reached through `typescript-eslint`
(lint only). Its only "fix" is `npm audit fix --force`, which would downgrade `eslint-config-next` to 15, so it waits for upstream.

Upgrade: merge, then `npm uninstall vitest && npm install -D vitest@^5.1.0` if the lockfile conflicts (vitest 2's `vite` 5 blocks a
plain install with ERESOLVE), then `npm ci` and the usual gate. A clone with its own vitest config options or custom pools checks them
against the vitest 3, 4 and 5 migration notes.

## 1.4.1 (2026-11-04)

security: `next` and `eslint-config-next` 16.3.8 -> 16.4.5. `next` 16.0.0 through 16.4.0 is affected by a **critical** unauthenticated
remote code execution in Image Optimization when SVG files are used (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr), and by a denial of
service in App Router Server Actions (GHSA-p3m5-59mp-jv5r). v1.3.1's 16.3.8 is inside that range, so every clone on v1.3.1 or v1.4.0
is still exposed. Also: `zod` 4.6.5 -> 4.6.7 (memory exhaustion validating oversized constrained collections, GHSA-mrhx-c7xc-m3w5);
`prisma`, `@prisma/client`, `@prisma/adapter-pg` 7.10.0 -> 7.10.1 (drops the vulnerable `deepmerge-ts` and `mysql2`); and
lockfile-only bumps for `sharp` (>= 0.35.5), `source-map-js` (>= 1.2.2) and `fast-uri` (>= 3.1.9). `npm audit --omit=dev` reports 0
vulnerabilities. No runtime code, migration or env var changes. Clones must take this within 7 days (by 2026-11-11). Given the
severity, take it now, and redeploy deployed clones as soon as it merges.

Upgrade: merge, `npm ci`, then generate, typecheck, lint, test and a production build. A clone already on a newer `next` keeps the
newer version, provided it is 16.4.1 or later. After `npm audit fix`, run `npm ci`: `audit fix --omit=dev` prunes devDependencies from
`node_modules` (not from the lockfile), and typecheck then fails with "Cannot find module 'vitest'".

## 1.4.0 (2026-10-26)

A clone hook for the template's org lists (D-22), asked for by quorum, ledgerleave and coursework, whose archived orgs still
showed on `/onboarding`. No schema change, no migration, no new env var. Not a `security:` release: no invariant changes,
and the hook cannot widen what a user sees.

- `src/app/org-hooks.ts` (clone-owned) gains `filterListedOrgs(userId, orgs) => orgs`, beside `beforeOrgDelete`. The
  default returns every org, so a clone that does nothing lists exactly what it did before.
- `/onboarding` and `/demo` (each account's org line) now pass the user's orgs through it via the new
  `keepListedOrgs` (`src/core/tenancy/listed.ts`), which keeps only the page's own rows whose id the hook returned, in
  their order. An id the user is not in, a duplicate, or a renamed org from the hook never reaches the page; the hook gets
  frozen copies. Display only: a hidden org's `/o/<slug>` still opens for its members.
- `listDemoUsers` (`src/core/auth/demo.ts`) also selects each org's `id` and `slug`.
- `tests/integration/org-list-hook.test.ts` (12): default unchanged on both pages; a hook hiding one org hides it on both;
  a hook returning an extra org id, a renamed org, or mutating its input changes nothing. Mutation-checked: returning the
  hook's output instead of intersecting turns 7 red; unwiring the two pages turns 4 red.

Upgrade: merge. `src/app/org-hooks.ts` is clone-owned, so a clone that edited it gets a merge conflict there: keep the
clone's `beforeOrgDelete` and add the template's `filterListedOrgs` (typecheck fails if it is missing, since the template
pages import it). Then implement it if the clone hides orgs (an archive table, say) and add one test that a hidden org is
not on `/onboarding`. No deadline (not `security:`).

## 1.3.1 (2026-10-20)

security: `next` and `eslint-config-next` 16.3.6 -> 16.3.8 (`npm audit --omit=dev` no longer lists `next`; 16.3.7 and earlier are
affected). Fixes: server-side request forgery in Image Optimization (GHSA-cjq9-62q9-8jv4); cache poisoning of SSG and ISR pages
in self-hosted apps (GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p); information disclosure in App Router metadata image routes
(GHSA-f87g-xv8r-7p7x) and in the dev server's MCP endpoint (GHSA-39w2-rjm5-chcv); `use cache` fill leaking Draft Mode content
(GHSA-3w37-wq28-93x7). Only `package.json`, `package-lock.json` and next's own packages (`@next/*`) change; no runtime code,
migration or env var. Clones must take this within 7 days (by 2026-10-27).

Upgrade: merge, `npm ci`, then typecheck, lint, test and a production build. Also carries the tests-only changes below.

Tests only, no runtime change:

- `tests/invariants/inv-12-webhooks.test.ts`: the "a demo session cannot use billing" case (v1.3.0) looked up
  `owner@acme.demo.test` and org `acme`, which only the template's sample seed creates, so a clone with its own
  `seed-demo.ts` failed it with P2025 (tradepost, 2026-10-19). It now takes the first demo org's owner by membership, as
  INV-27 does. Assertions unchanged. The text is identical to tradepost's excused patch (`52c17ca7d099`), so that clone
  can drop the row from `FOUNDATION_PATCHES.md` once it takes this release.
- `tests/integration/review-2026-10-12-demo.test.ts` (v1.2.1): the same lookup by membership instead of `acme` addresses,
  and the fixed counts (6 demo users, 4 with TOTP, 3 memberships) are now "unchanged from before the demo session
  acted", which is what they were checking. The "add and share a project" half moved to
  `tests/integration/review-2026-10-12-demo-projects.test.ts`, because it tests the example resource a clone replaces
  (D-16): a clone that removes `/o/[org]/projects` deletes that file instead of editing this one.

## 1.3.0 (2026-10-14)

A `scorekeeper` role that holds only a new `results.write` permission (D-21), asked for by bracketry so a volunteer can enter
and correct scores without `org.update`. Owner and admin hold `results.write` too; member does not. Core checks it nowhere:
a clone gates its own result entry on it. One migration (`20261014000000_role_scorekeeper`, `ALTER TYPE "Role" ADD VALUE`),
additive. No new env var.

security: (INV-22) The guard's MFA line was `role !== 'member'`, so any role added later would have been MFA-gated by
accident and the rule's wording ("an owner or admin without MFA") was not what the code said. It is now an explicit
owner/admin list; behaviour for the three existing roles is unchanged. A scorekeeper is not MFA-gated, by decision.

security: (INV-28) `revokeInvitesBeyond` listed the roles by hand (`owner`, `admin`, `member`), so a demoted issuer's pending
invite for any newer role would have stayed live. It now reads `Object.values(Role)`. Tests in
`tests/integration/scorekeeper-role.test.ts` (4); both fixes were reverted one at a time and each turned its test red.

Upgrade: merge, then `npm run db:migrate` (the enum value arrives with the merge). The members page and `z.enum(Role)` offer
the new role with no clone change. A clone that does not want it simply never checks `results.write`; an admin can still
assign the role, and it grants nothing there. Clones owe this within 7 days (by 2026-10-21); it can be taken together with
v1.2.1.

## 1.2.1 (2026-10-13)

The four fixes from the 2026-10-12 review. No schema change, no migration, no new env var.

security: (review 2026-10-12 #1, INV-28) A pending invite outlived its issuer's authority: a removed owner could re-enter as
owner through an owner invite they had sent to a spare address, and a demoted admin's `admin` invites stayed good.
`acceptInvite` now reads the issuer's membership as it is at acceptance and refuses (same "not valid" answer) unless the
issuer could still send that invite — so removal, demotion, leaving and account deletion are all covered at the one place an
invite is honoured. `removeMember` and `changeRole` also revoke the invites the person can no longer back, in the same
transaction, so they drop out of the pending lists. An `Invite` row with no `invitedById` (none is written by core) is no
longer acceptable.

security: (review 2026-10-12 #4, D-10, INV-09) `requestEmailChange` answered "That address belongs to another account" for a
registered address, and returned before its rate limit counted the request — so any signed-in user could enumerate accounts
at request speed. The limit is now counted before the lookup, and a taken address resolves exactly like a free one: same
"check your new inbox" result, no link created, no mail sent. Cost: someone who types an address that already has an account
is told to check that inbox and nothing arrives. INV-06's "taken address is refused" case now asserts the silent form.

security: (review 2026-10-12 #2, INV-27, INV-26) A `/demo` session was born fresh and MFA-passed, so any visitor could delete
the demo org, delete a demo account, or move the demo owner to an email they control — and since the demo TOTP seed is a
public constant, that became a normal owner login that kept working after `DEMO_MODE` was turned off. Two rules now, both in
`core/auth/session.ts`: (1) `sessionFor` resolves no session for an `isDemo` user unless `DEMO_MODE=1`, whether the session
came from `/demo` or a sign-in link; (2) `assertNotDemo` refuses a demo session org deletion, account deletion, email change
and TOTP enrol/confirm/disable (via `assertFresh`, which every INV-26 action already calls), inviting, re-roling, removing
and leaving (`createInvite`, and `withMembers` in `core/tenancy/orgs.ts`), and sign-out-everywhere (the shared account would
sign every other visitor out). `SessionCtx` gains `isDemo`. A demo session can still browse, add projects, and create and
revoke share links — a clone that wants more locked calls `assertNotDemo(ctx.session)` itself.

security: (owner decision 2026-10-13, INV-27) A demo session is also refused creating an org and using billing. `createOrg`
(`core/tenancy/orgs.ts`) calls `assertNotDemo`: an org made by the shared account was owned by every visitor and never
cleaned up. `startCheckout` and `openPortal` call it too, in the billing module's own
`src/app/o/[org]/settings/billing/actions.ts`, so a visitor cannot subscribe the shared demo org or open its Stripe customer
portal; the guard is removed with the module and core imports nothing from it. Tests: the org half in
`tests/integration/review-2026-10-12-demo.test.ts`, the billing half in `tests/invariants/inv-12-webhooks.test.ts`.

Upgrade: no schema or config change. **Behaviour change for a deployed demo:** demo visitors can no longer invite or manage
members, create an org, subscribe or open the billing portal, or delete anything listed above, so a `DEMO.md` step that does
one of those needs a real account. And any environment
holding `isDemo` rows without `DEMO_MODE=1` (local dev without the flag included) can no longer sign those users in at all.
Existing damage is not repaired: a demo row whose email was already changed still has it — re-run `seed:demo` or check the
`isDemo` rows by hand.

## 1.2.0 (2026-09-28)

F-03: a clone can now declare a module required in the clone-owned `src/app/required-modules.ts`. `foundation:check-modules`
leaves a required module in place and still removes the rest, instead of always removing both — callboard imports
`notifications` outside the marked lines (`src/lib/messages.ts`, `src/lib/broadcast.ts`, `/api/sms/inbound`, the event
actions), so its `modules-removed` CI job has failed `tsc` since 2026-09-26. Verified for real: `check-modules` with
`notifications` required passes with only billing removed, and with no module required it still removes both, unchanged.

## 1.1.1 (2026-09-28)

security: (LOW K1) `signOutEverywhere` and `confirmEmailChange` left any unused `login`/`signup` link for that user valid — a
stolen link outlived the session boundary meant to close it. Both now also spend that user's unused `loginToken` rows,
atomically with the session/email change.

security: (LOW K1) The session cookie was named `session` with `Secure` derived from `APP_URL`, instead of the browser-enforced
`__Host-session` prefix. Renamed; `Secure` is now unconditional (`http://localhost` is treated as a secure context, so local
dev is unaffected).

security: (LOW K2) `confirmTotp` skipped `assertFresh`, and its enrolment write was not exclusive: two concurrent confirms
could both succeed and leave 20 recovery codes instead of 10, with only one meant to have won. Added `assertFresh`, and the
write is now a conditional `updateMany` claim on `totpEnrolledAt: null` so the loser gets `null` back.

security: (LOW K5) An IPv6 rate-limit key was scoped to the exact address, so a client rotating within its ISP-assigned /64
dodged the limit on every request. `clientIp` now keys on the first 64 bits.

security: (LOW K6) A share link survived its creator's removal from the org. `removeMember` now revokes that user's active
share links in the org, in the same transaction as the membership delete.

security: (LOW K13) `addProject`, `createShareLink`, `revokeShareLink` and `revokeInvite` wrote their row and their audit
event as two separate commits, so a crash between them left an unaudited write. All four now wrap the write and the `audit()`
call in one `db.$transaction`.

Upgrade: no schema or config change. Any code that read `SESSION_COOKIE` (`'session'`) directly instead of importing the
constant needs the new value, `'__Host-session'`.

## 1.1.0 (2026-09-28)

security: (FR-06, K3, rule 1) Nothing checked that pages, layouts and route handlers guard themselves; a clone's new page could
ship unguarded, and a client-side navigation does not re-run the layout's guard. `unguardedEntrypoints()` now requires every
exported handler in `src/app/**/{page,layout,template,default,route}` to make `requireUser`/`requireOrg` its first `await`, or
the file to carry a `// public: <reason>` line. The 14 public files are marked.

security: (FR-07, K3) The action harness globbed only `src/{app,modules}`, and could not see inline `'use server'` functions,
which Next also registers as endpoints. It now globs all of `src/`, and any `'use server'` that is not a file's first directive fails.

security: (FR-08, K4) An id typed `z.string()`/`z.cuid()` was filled with `'x'`, so INV-02/03/04 silently skipped that action.
`generate()` now throws on an untagged field whose name looks like an id (`id`, `…Id(s)`, `slug`, `token`) or whose format is an
id format; wrap a non-row-id in the new `notRef()` (the two emailed-token fields are).

Upgrade: add `// public: <reason>` to any clone page/route that is deliberately unguarded, move inline server actions into an
actions file, and tag id fields `ref('<model>')` (or `notRef()`). The failing test names each file or field.

Fix (FR-09, tooling): a path listed once in `FOUNDATION_PATCHES.md` was excused from drift forever, whatever later edits it
got. Each entry now carries a hash of the excused diff (`` `path` `hash` — reason ``); `foundation:drift` fails again once
that path's diff moves on, and its error message prints the `` `path` `hash` `` to paste in.

Fix (FR-10, tooling): module removal stripped the `// <module>` lines in `core.prisma` and `cron-jobs.ts` but not the Billing
nav link in `src/app/o/[org]/layout.tsx` (a JSX file, where a trailing `//` renders as literal text — it now carries
`{/* billing */}`). `layout.tsx` is in `MARKED_FILES`; `foundation:check-modules` confirms the route is gone after removal.

Fix (FR-11, tooling): `new-project` checked a port only against the template's own 4100, not the port table, and a second run
silently corrupted the README banner and left scripts on the first port. It now refuses a port already `in use` or `reserved`
in `~/.claude/CLAUDE.md`'s port table, and refuses to run once `package.json`'s name is no longer `saas-foundation`.

## 1.0.3 (2026-09-27)

security: (FR-02, K2) A session waiting on TOTP lived 30 days, and the only guess control was 8 tries per 5 minutes: over one session,
about a 19% chance to guess a code for someone holding the inbox. A pending-MFA session now dies 10 minutes after the link
(`PENDING_MFA_MS`). Wrong TOTP and recovery codes are audited (`auth.mfa_failed`) and capped at 20 per user per UTC day
(`LIMITS.mfaFailPerUserDay`); past the cap the pending session is ended and MFA is refused until the day turns. `/login/mfa` has a Sign out button.

security: (FR-03, K5) `createInvite` had no rate limit, so anyone could send unlimited invite mail from the app's domain. It is now
capped per sender (50/day), per org (100/day) and per recipient address (5/day, across orgs).

security: (FR-04, K9, billing) The org's billing row followed any subscription carrying its org id, so a second checkout made a second
subscription whose events overwrote the first. `BillingAccount.stripeSubscriptionId` now binds the org to one subscription; another's
events apply only after the bound one has ended (a re-subscribe), and otherwise log `billing.second_subscription`. Checkout is refused
while the org has a live subscription.

security: (FR-05, K9, billing) `deleteOrg` dropped the billing row but left the Stripe subscription charging. It now cancels a live
subscription first (`cancelOrgSubscription`, called from the new clone-owned `src/app/org-hooks.ts`, whose `// billing` lines go with the module), and refuses to delete if the
cancel fails. A live subscription for an unknown org logs `billing.unknown_org_live_subscription`.

Upgrade: `git merge v1.0.3`, then `npm run db:migrate` (adds `stripeSubscriptionId`). Existing live rows bind on their next
subscription event; until then, deleting such an org is refused. A clone with its own `PaymentProvider` must add `cancel()`.

## 1.0.2 (2026-09-27)

Fix (FR-01, notifications): `drainOutbox` sent inside the claim's interactive transaction (5s timeout). A send slower than that
was delivered but never recorded, then re-sent on every cron run and blocked the queue. The claim is now a short transaction that
counts the attempt and leases the row (`LEASE_MS`, 2 min); the send runs outside it and is marked after. The Resend and Twilio
fetches time out at 15s (this also covers the sign-in and invite mail). Take it promptly if your cron drains often.
Upgrade: `git merge v1.0.2`; no migration.

## 1.0.1 (2026-09-25)

Fix: the clone steps in README and plan §3.1 used `git checkout -b main`, which fails because a fresh clone already has `main`; now `-B`. Docs only.

## 1.0.0 (2026-09-25)

First release. Core (env, db with cloud guard, auth with magic link, sessions, TOTP and recovery codes, tenancy, authz, audit, share links, cron),
the `billing` and `notifications` modules, demo sign-in (`/demo`, `DEMO_MODE=1`), `seed:demo`, clone tooling
(`new-project`, `db:setup`, `foundation:drift`, `foundation:status`, `foundation:check-modules`), and invariants INV-01 to INV-28.
