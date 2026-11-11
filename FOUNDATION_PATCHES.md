# Foundation patches

Template-owned files this clone has changed, each excused by its diff hash (`foundation:drift` prints it). Each moves
upstream at the next template release and its line is then deleted.

- `prisma/schema/core.prisma` `2fe88c595b0e` — Earmark D-02/D-12: `guest` added to `enum Role` (agency staff). The `// app` back-relations beside it need no excuse.
- `src/core/authz/permissions.ts` `c43866caf6d5` — Earmark D-02/D-12: `guest: []` in `grants`; `Record<Role, …>` must cover the new enum value. A guest holds no core permission and is not MFA-gated (the guard's MFA line is owner/admin only).
- `tests/invariants/inv-27-demo.test.ts` `7aead86b8a77` — Earmark Phase 3 (D-20): the re-run check counted the template seed's six demo users; Earmark's seed adds its seat holders and Dana. Now: at least six, and a second run adds none. Seed-agnostic, as the test's sibling `review-2026-10-12-demo.test.ts` already is; propose upstream with v1.7.0.
- `src/core/db/cross-org.ts` `e35320572eea` — Earmark D-30: `src/earmark/alerts.ts` under `// clone entries below` (the alerts cron reads every org). Drift counts lines under that marker as drift, so the template should exempt them (v1.7.0); until then this line excuses it. Missed in Phase 3 (7), caught in Phase 4 (1).
- `src/modules/sso/hooks.ts` `7c081ebdf87e` — Earmark D-32: `refusesLink` ignores `guest` memberships, so Require SSO never refuses an agency guest her magic link (PRD §5, §6). Moves upstream with the `guest` role.
- `src/core/env.ts` `7b02fc89058c` — Earmark D-35: `ANTHROPIC_API_KEY` (optional; unset or empty = the explainer's stub). env.ts has no clone section, and the template already prices Anthropic models in `src/core/ai/prices.ts`, so the key belongs upstream (v1.7.0).

**Upstream proposal (template v1.7.0, the D-21 `scorekeeper` precedent):** a `guest` role holding no core permission, with a
test that a guest is refused every core permission and every template settings page. `agencyId` stays clone-side
(`GuestMembership` in `earmark.prisma`), so only the enum value and the empty grant move upstream.
