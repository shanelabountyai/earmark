# Foundation patches

Template-owned files this clone has changed, each excused by its diff hash (`foundation:drift` prints it). Each moves
upstream at the next template release and its line is then deleted.

- `prisma/schema/core.prisma` `2fe88c595b0e` — Earmark D-02/D-12: `guest` added to `enum Role` (agency staff). The `// app` back-relations beside it need no excuse.
- `src/core/authz/permissions.ts` `c43866caf6d5` — Earmark D-02/D-12: `guest: []` in `grants`; `Record<Role, …>` must cover the new enum value. A guest holds no core permission and is not MFA-gated (the guard's MFA line is owner/admin only).
- `tests/invariants/inv-27-demo.test.ts` `7aead86b8a77` — Earmark Phase 3 (D-20): the re-run check counted the template seed's six demo users; Earmark's seed adds its seat holders and Dana. Now: at least six, and a second run adds none. Seed-agnostic, as the test's sibling `review-2026-10-12-demo.test.ts` already is; propose upstream with v1.7.0.

**Upstream proposal (template v1.7.0, the D-21 `scorekeeper` precedent):** a `guest` role holding no core permission, with a
test that a guest is refused every core permission and every template settings page. `agencyId` stays clone-side
(`GuestMembership` in `earmark.prisma`), so only the enum value and the empty grant move upstream.
