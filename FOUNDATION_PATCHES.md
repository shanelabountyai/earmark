# Foundation patches

Template-owned files this clone has changed, each excused by its diff hash (`foundation:drift` prints it). Each moves
upstream at the next template release and its line is then deleted.

- `prisma/schema/core.prisma` `2fe88c595b0e` — Earmark D-02/D-12: `guest` added to `enum Role` (agency staff). The `// app` back-relations beside it need no excuse.
- `src/core/authz/permissions.ts` `c43866caf6d5` — Earmark D-02/D-12: `guest: []` in `grants`; `Record<Role, …>` must cover the new enum value. A guest holds no core permission and is not MFA-gated (the guard's MFA line is owner/admin only).
- `tests/invariants/inv-27-demo.test.ts` `7aead86b8a77` — Earmark Phase 3 (D-20): the re-run check counted the template seed's six demo users; Earmark's seed adds its seat holders and Dana. Now: at least six, and a second run adds none. Seed-agnostic, as the test's sibling `review-2026-10-12-demo.test.ts` already is; propose upstream with v1.7.0.
- `src/core/db/cross-org.ts` `72dec0fcd25c` — Earmark D-30: `src/earmark/alerts.ts` under `// clone entries below` (the alerts cron reads every org); D-45 (design pass, 2026-11-18): `src/earmark/ui/orgs.ts`, the guest sidebar's client switcher, which lists the user's own orgs as /onboarding does; D-73 (review fixes, 2026-11-21): `src/earmark/demo-reset.ts`, the nightly demo reset, which replants both demo orgs as `seed:demo` does. Drift counts lines under that marker as drift, so the template should exempt them (v1.7.0); until then this line excuses it. Missed in Phase 3 (7), caught in Phase 4 (1).
- `src/modules/sso/hooks.ts` `7c081ebdf87e` — Earmark D-32: `refusesLink` ignores `guest` memberships, so Require SSO never refuses an agency guest her magic link (PRD §5, §6). Moves upstream with the `guest` role.
- `src/core/env.ts` `7b02fc89058c` — Earmark D-35: `ANTHROPIC_API_KEY` (optional; unset or empty = the explainer's stub). env.ts has no clone section, and the template already prices Anthropic models in `src/core/ai/prices.ts`, so the key belongs upstream (v1.7.0).
- `src/app/(public)/demo/signin/route.ts` `e9df68ddb1ab` — Earmark D-58 (live gate, 2026-11-19): the redirect target is `demoLanding(userId)` from `src/earmark/demo-landing.ts` instead of the fixed `/onboarding`, so a demo account with exactly one listed org lands in it. One import and one changed line. Propose upstream: a clone hook for where a demo sign-in lands.
- `src/app/o/[org]/settings/audit/layout.tsx` `1fc12ca6caea` — Earmark D-57 (live gate, 2026-11-19): an added file, no template line changed. A guard layout that answers `notFound()` to a role without `audit.read`, because the page's `requireOrg(org, perm)` throws `AuthzError`, which a page renders as a 500. Goes away when the template's pages answer 404 themselves (see "For a foundation release" in PR "Earmark live gate").
- `src/app/o/[org]/settings/security/layout.tsx` `c032fd5a761b` — Earmark D-57: the same guard, `audit.read`.
- `src/app/o/[org]/settings/danger/layout.tsx` `46f7282695b9` — Earmark D-57: the same guard, `org.delete` (covers the export page under it).
- `src/app/o/[org]/settings/sso/layout.tsx` `4aa7f9337dff` — Earmark D-57: the same guard, `org.update`. (`settings/apikeys/layout.tsx` is the fifth; that directory is not on drift's owned list, so it needs no line.)

**Upstream proposal (template v1.7.0, the D-21 `scorekeeper` precedent):** a `guest` role holding no core permission, with a
test that a guest is refused every core permission and every template settings page. `agencyId` stays clone-side
(`GuestMembership` in `earmark.prisma`), so only the enum value and the empty grant move upstream.
