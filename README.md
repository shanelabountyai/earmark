# Earmark

> Cloned from saas-foundation v1.5.0. Port 7600. Upgrade with `npm run foundation:status`; template-owned paths are listed in the template's plan §3.2.

Earmark is build-log #23: a multi-tenant marketing budget and agency-spend governance app. Each client company is an org
with its own SSO; agency staff are `guest` members of each client they serve and see only their agency's commitments
inside that client. Approval chains are data (`rules/approval-chains.json`), money is integer cents (`BigInt`), and a
commitment exists only for an approved request. The spec is `prd-earmark.md` (decisions D-01 to D-11 are fixed).

Synthetic data only. Not deployed in v0.1.

## Status

| Phase | State |
|---|---|
| 0 Kickoff | done: cloned from `v1.5.0`, `new-project earmark 7600`, `billing` and `notifications` removed |
| 1 Engines | done: pure engines in `src/lib/earmark/`, Python oracles in `tools/`, fixtures in `fixtures/`, parity + property + unit tests |
| 1.5 Upgrade | next: merge foundation `v1.6.0` once tagged (brings the `sso` and `apikeys` modules, row-level security) |
| 2–5 | see `prd-earmark.md` §7 |

## Quickstart (about 10 minutes)

Needs Node 22, Python 3 (stdlib only, for the oracles) and a local Postgres 17 you can create databases in
(Homebrew `postgresql@17` works with no password).

```bash
git clone git@github.com:shanelabountyai/earmark.git
cd earmark
npm ci
npm run db:setup                     # creates earmark and earmark_test, writes .env.local and .env.test, migrates both
npm run seed:demo                    # two orgs, owner/admin/member each; owners and admins have TOTP
npm run dev                          # http://localhost:7600/demo
```

`db:setup` never overwrites an existing `.env.*` and never prints a value. It uses your OS user against `localhost:5432`;
set `PGUSER`/`PGPASSWORD` or `LOCAL_PG_URL_BASE` for a different Postgres. A real Resend key is optional and goes in
`.env.local`; without it email is captured in the database.

## Modules

| Module | State | Why |
|---|---|---|
| `billing` | removed in Phase 0 | Earmark is sold by contract, not self-serve card (PRD §6) |
| `notifications` | removed in Phase 0 | alerts go by email through core; no SMS (PRD §6) |
| `sso` | arrives with foundation v1.6.0 in Phase 1.5 | client staff sign in with their own IdP; guests use magic links |
| `apikeys` | arrives with foundation v1.6.0 in Phase 1.5 | a client's AP system reads commitments and posts invoices |

The removal followed the template's "Removing a module" recipe exactly (the paths in `scripts/foundation-modules.ts`
plus the marked lines); `npm run foundation:check-modules` and `npm run foundation:drift` stay green.

### Row-level security on Neon (optional, `RLS_MODE=enforce`)

`db:setup` gives you two roles locally: the owner (`DATABASE_URL` while RLS is off, `DATABASE_URL_SYSTEM`, `DIRECT_URL`) and
`<name>_app_rw` with `NOBYPASSRLS` (`DATABASE_URL_APP_RW`). To enforce locally, set `DATABASE_URL` to the app_rw URL and
`RLS_MODE=enforce` together: app_rw with RLS off sees no org rows, because off mode sets no org. On Neon, the role the console creates is a `neon_superuser` with `BYPASSRLS`, so the app role is made
in SQL, as the owner, on the branch:

```sql
CREATE ROLE app_rw LOGIN PASSWORD '<generate one>' NOBYPASSRLS NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
```

Then in Vercel: `DATABASE_URL` = app_rw through the pooler (`-pooler` host), `DATABASE_URL_SYSTEM` = the owner through the pooler,
`DIRECT_URL` = the owner without the pooler, `RLS_MODE=enforce`. Run `npm run rls:policies` once for your own org-owned models and
commit the migration; INV-30 fails until you do. The pooler accepts an SQL-created role (spike S4a ran through it).

## Commands

| Command | What it does |
|---|---|
| `npm test` | vitest against the local test database: unit, integration, all foundation invariants, and Earmark's engine tests (unit, fast-check properties, oracle parity) |
| `npm run test:e2e` | Playwright against a production build (`E2E_DEV=1` runs the dev server for debugging one spec) |
| `npm run lint` / `typecheck` | ESLint (including the core-boundary rule) and `tsc` |
| `npm run db:migrate` | create a migration in dev; `db:migrate:test` applies to the test database |
| `npm run seed:demo` | idempotent demo accounts; refuses a cloud database |
| `npm run foundation:drift` | fails if a template-owned file was edited |
| `npm run foundation:status` | current vs latest release, and any `security:` changelog entries between |
| `npm run foundation:check-modules` | builds a scratch copy with the removable modules deleted (CI runs it) |
| `python3 tools/chain_oracle.py < fixtures/chain/basic-7500.json` | run one oracle by hand (same for `rollup`, `match`, `variance`) |

## Layout

- `src/core/`: env, db, auth, tenancy, authz, audit, tokens, email, share links, cron. Template-owned; never edited here.
- `src/lib/earmark/`: Earmark's pure engines (Phase 1). `money.ts` (integer cents), `chain.ts` (approval chains, PRD §3),
  `rollup.ts` (planned / committed / actual / available per node), `match.ts` (ranked invoice-to-commitment suggestions,
  PRD §4), `variance.ts` (actual − planned per line per period). No database, no Prisma, no UI.
- `rules/`: `approval-chains.json`, the seeded chain thresholds (Budget Owner $0, Marketing Ops $10k+, Finance $50k+, CMO $100k+, CFO $250k+).
- `tools/`: Python stdlib oracles, one per engine, JSON in and JSON out. `fixtures/`: hand-written cases the parity test
  runs through both implementations.
- `src/app/`: routes. `src/app/cron-jobs.ts` is where Earmark's cron work goes (alerts, Phase 3). `src/app/org-hooks.ts` holds
  `beforeOrgDelete` and `filterListedOrgs`.
- `prisma/schema/`: `core.prisma` (template-owned). Earmark's tables arrive in `earmark.prisma` in Phase 2.
- `tests/invariants/`: the foundation's security rules as tests. `tests/earmark/`: the engine tests. `tests/fixtures/app.ts` holds the clone's harness rows.

## Staying current

Template-owned paths (core, modules, invariants, security routes) are never edited in a clone, so `git merge vX.Y.Z` is clean.
An urgent local patch goes in `FOUNDATION_PATCHES.md` as `` `path` `hash` — reason `` (drift prints the hash to paste in) and moves upstream at the next release.
Upgrade steps and versioning rules: the template's `IMPLEMENTATION_PLAN.md` §3.3.

## Not included

Legal pages are stubs (`/legal/privacy`, `/legal/terms`) and are not legal advice.

No cookie banner: the foundation sets only strictly necessary cookies (`session`, `totp_pending`), and those need no consent.
If you add analytics, ads or any other non-essential tracker, you need consent first (spec D-20).
