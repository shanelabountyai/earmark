# Proposal for saas-foundation: clone hooks for the landing page, the demo account list and the TOTP issuer

From Earmark, 2026-11-21 (review fixes, D-75; Shane's decision 3 (c)). A proposal only: nothing in the saas-foundation repository was edited. When a release ships these hooks, Earmark drops its two `FOUNDATION_PATCHES.md` lines for `src/app/page.tsx` and `src/app/(public)/demo/page.tsx` and moves its copy into the hooks.

## Why

A clone that deploys a demo shows the template's own words on its first two screens:

- `/` says "SaaS Foundation" (`src/app/page.tsx`). Earmark's five-lens review (2026-11-19, finding U5) ranked it the second most visible flaw: it is the very first screen.
- `/demo` is a flat, alphabetical list of every seeded account (`src/app/(public)/demo/page.tsx`): 17 identical buttons in Earmark, with nothing saying which accounts tell the story (U4, G1).
- The TOTP issuer is "SaaS Foundation" (`src/core/auth/totp.ts`), so a clone's users see the template's name in their authenticator app.

Earmark overrode the two pages in place (patch lines). The issuer is left as it is: it is core, and a demo account cannot enrol TOTP anyway.

## Proposed hooks (clone-owned files, like `src/app/org-hooks.ts`)

1. **`src/app/brand.ts`**: `export const APP_NAME = 'SaaS Foundation'` and an optional `tagline`. The template's landing page and `totp.ts` read `APP_NAME`; a clone changes one line. Test: the landing renders `APP_NAME`; the issuer in an enrolment URI is `APP_NAME`.
2. **`src/app/landing.tsx`**: the clone-owned body of `/`. The template's `src/app/page.tsx` keeps the route, `dynamic = 'force-dynamic'` and the legal footer, and renders `<Landing demo={demoEnabled()} />`. The template ships the current body as the default.
3. **`src/app/demo-accounts.ts`**: `export function arrangeDemoAccounts(users): { featured: { user, note?, start? }[]; rest: typeof users }`. The template's `/demo` page keeps `listDemoUsers`, `keepListedOrgs` and the form, and renders the featured accounts as cards (with an optional *Start here*) and the rest under a fold. The default returns `featured: []`, which renders today's flat list. Test (INV-27 sibling): every account the hook returns still signs in only through `/demo/signin`, and an account the hook leaves out still appears under the fold.

## What Earmark would move into them

- `APP_NAME = 'Earmark'`.
- The landing body from `src/app/page.tsx`.
- `WALK_ACCOUNTS` from `src/earmark/demo-accounts.ts` as `featured`.

## Not part of this proposal

The other template items from the review (`requireOrg` answering 404 in pages, `ActionForm` focus, `/api/cron` job isolation, destructive button class, `/onboarding` styling) are listed in `docs/audits/FIVE-LENS-2026-11-19.md` §5 and in NEXT.md *For a foundation release*.
