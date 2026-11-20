# Release notes

One entry per launch. The decisions behind each are in `prd-earmark.md` §0; the next steps are in `NEXT.md`.

## 2026-11-19: live on https://earmark.labintelligence.co (second launch)

The first closeout (2026-11-12/13) covered a product that ran only on a laptop. This entry covers what went out after it: the design pass, the live gate and the deployment.

**What shipped**

| When (UTC) | What | Where |
|---|---|---|
| 2026-11-17 16:45 | First production deployment: the shared-password gate and deploy prep (D-42, D-43) | PR #7; Vercel deployment record |
| 2026-11-17 to 11-18 | Foundation security releases v1.6.4, v1.6.5/v1.6.6, v1.7.0 | PRs #8, #9, #10 |
| 2026-11-19 14:19 | The design pass: Earmark's own look on every org page, eight gap screens, guest client switcher (D-44 to D-55) | PR #11 |
| 2026-11-19 16:36 | Production migrations run during the Vercel build (`scripts/vercel-build.mjs`) | PR #12 |
| 2026-11-19 16:47 | Production builds only; Preview deployments skipped (D-56) | PR #13 |
| 2026-11-20 01:12 | The live gate: settings 404s, demo landing, phone members page, invoice dates, README's eight-step demo (D-57 to D-63) | PR #14, commit `6a4df45` |
| 2026-11-20 14:11 | The *Request submitted* notice carries an *Open it* link to the new request (D-64) | PR #15, commit `7968689`; merged while this closeout was running |

**Closeout pack (D-65 to D-68)**

| Item | Where | State |
|---|---|---|
| Live verification | below | Site not readable from the cloud (tried twice, 02:06 and 14:14 UTC on 2026-11-20); deployment record and runtime errors read from Vercel; page checks are owner steps |
| Demo script for the live site | [`docs/DEMO.md`](DEMO.md), *Live demo* | Written; every stop is covered by a named e2e test or marked; none clicked through live yet |
| Exec brief, second launch | **Earmark Live in Brief**: https://claude.ai/artifact/7h7spt45ccKWWUXZQ2diNS (a Claude Docs document, private until Shane shares it) | Published 2026-11-20 UTC |
| Exec brief, first launch | **Earmark in Brief**: https://claude.ai/artifact/Xwpdyi152Ct3HWeyD99yGs | Unchanged |
| LinkedIn drafts | [`docs/LINKEDIN_DRAFTS.md`](LINKEDIN_DRAFTS.md): Draft A (the column the design asked for, D-47), Draft B (the six steps that did not survive going live, D-63) | Drafted, unposted, not in the Ledger |
| Cost review | `prd-earmark.md` D-65, and below | Vercel read; database host and domain not read |
| Five-lens review | [`docs/audits/FIVE-LENS-2026-11-19.md`](audits/FIVE-LENS-2026-11-19.md) | Report only; nothing fixed |

### Live verification

Two attempts, each one GET per URL, no retry inside an attempt, no workaround: 2026-11-20 02:06 UTC (8:06 PM CT on the 19th) and 2026-11-20 14:14 UTC (8:14 AM CT).

| Check | Result | How |
|---|---|---|
| `GET https://earmark.labintelligence.co/` | **Not read**, both times. The fetch tool reported `client_error` ("failed at its site … nothing of the page was retrieved"); no status code was given. | WebFetch |
| `GET …/demo` | **Not read**, both times. Same error. | WebFetch |
| `GET …/api/health` | **Not read**, both times. Same error. | WebFetch |
| Current production deployment (read 14:15 UTC) | `dpl_CTPB6uks1m7KSybA9wqVi5ztgvSN`, state **READY**, target production, commit `7968689` (merge of PR #15) on `main`, created 2026-11-20 14:11:04 UTC, ready 14:11:26 UTC, region `iad1`. Aliases: `earmark.labintelligence.co`, `earmark-tau.vercel.app`, `earmark-shanelabountyai-8212s-projects.vercel.app`, `earmark-git-main-shanelabountyai-8212s-projects.vercel.app`; `aliasError` null. | Vercel, read-only (`list_deployments`, `get_deployment`) |
| The deployment before it | `dpl_5a17ivSKmjoQD6F43Xyk8B8GHtnX`, READY, commit `6a4df45` (PR #14), created 01:12:02 UTC. | Same |
| Runtime errors, last 7 days (read 14:15 UTC) | **One group, 12 occurrences, 4 users**, first 2026-11-18 06:00:08 UTC, last 2026-11-20 06:00:08 UTC, last on `dpl_5a17…` (PR #14): a Node warning from the `pg` connection-string parser that the SSL modes `prefer`, `require` and `verify-ca` will mean something weaker in `pg` v9. Routes named: `/demo`, `/demo.rsc`, `/demo/signin`, `/onboarding`, `/api/cron`, a line page, an invoice page, `settings/apikeys`. A warning, not a failed request. Nothing recorded against the current deployment in the four minutes between its start and the read. | Vercel, read-only (`get_runtime_errors`, `since: 7d`) |
| The daily cron runs in production | The group's first and last occurrences are on `/api/cron` at 06:00:08 UTC (2026-11-18 and 2026-11-20), the `vercel.json` schedule. | Inferred from the same read |
| Preview builds | This branch's and PR #15's branch builds were **CANCELED** (D-56 working as written). | Vercel, `list_deployments` |

**What a 401 would look like.** `src/proxy.ts` answers every route except `/api/cron`, `/api/v1/*` and `/api/demo/webhook` with `401` and a Basic challenge when no password is sent. That includes `/api/health`. A `client_error` on all three URLs is consistent with that gate, but the status code was not seen, so this is not a confirmation that the gate is up.

**Owner steps for the page checks** (also in `NEXT.md`):

- You: open https://earmark.labintelligence.co/ in a private window. Expect the browser's password prompt; cancel it and expect "Password required".
- You: enter the shared password. Expect `/demo` to list the six demo accounts.
- You: with the password, open `/api/health`. Expect `{"ok":true}`.
- You: open https://earmark-tau.vercel.app/ in a private window. Expect the same password prompt (the gate is in the app, so it should cover every alias; this was read in code, not seen live).
- You: walk the nine stops in `docs/DEMO.md`, *Live demo*, on a laptop and once on a phone, and fill in the table at its end.

### Local gate for this closeout (2026-11-20 UTC, cloud sandbox, Postgres 16, RLS enforce, branch at `main` = `7968689` plus docs)

| Step | Result |
|---|---|
| `npm ci` | **Failed** (exit 1, 1m07s): the `postinstall` `prisma generate` could not fetch Prisma's schema-engine checksum (`binaries.prisma.sh`, 403 from the sandbox proxy). Worked around as earlier cloud runs did: `npm ci --ignore-scripts` (exit 0), then `prisma generate` with a stub schema-engine path (client generated). |
| `npm run lint` | exit 0: `1 problem (0 errors, 1 warning)`: `src/app/org-hooks.ts` 8:39, `'orgId' is defined but never used` |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0: `Test Files 64 passed (64)`, `Tests 652 passed \| 1 skipped (653)` |
| `npm run build` | exit 0 |
| `npm run test:e2e` | exit 0: `41 passed (1.6m)`, including the axe sweep in `e2e/design.spec.ts` |

Not run here: `prisma migrate deploy` (no schema engine; the 24 migrations were applied with `psql` in order), `npm run test:engines`, `npm run foundation:drift`, Postgres 17. This branch changes documentation only. CI on the pull request is the gate.

### Cost review (D-65)

Read 2026-11-20 at about 14:20 UTC with Vercel's billing charges, one call per UTC day from 2026-11-16 to 2026-11-21. Vercel's charge periods run 08:00 to 08:00 UTC, and each day's call returned the period that ended at 08:00 that day, so the five calls cover 2026-11-15 08:00 to 2026-11-20 08:00 UTC; the period that started 2026-11-20 08:00 (which includes PR #15's build) was not returned.

| Service | Measured | Period (UTC) | Notes |
|---|---|---|---|
| Vercel, Build CPU Minutes, records tagged project `earmark` | **$0.294** for 84 build minutes ($0.126 for 36, $0.112 for 32, $0.056 for 16) | 2026-11-17 08:00 to 2026-11-20 08:00 | From the `Tags.ProjectName` field of the 100-record sample each call returns. Earmark's function memory in the same sample adds $0.0002. Other Earmark records may exist outside the sample. |
| Vercel, all usage, every project on the team | **$0.556** ($0.269997 + $0.227869 + $0.058329) | 2026-11-17 08:00 to 2026-11-20 08:00 | Complete: the summary covers every record (about 1,000 to 1,260 a day). Earmark's functions, CDN and observability usage is inside it and cannot be separated. So Earmark's Vercel usage for these three days is at least $0.294 and at most $0.556. The two days before Earmark's first deploy were $0.0029 and $0.0023 for the whole team. |
| Vercel subscription | $0.667 a day (effective cost; billed $0 per day in this data) | same | Category *Subscription Licenses*; team-wide and there before Earmark; not a cost this deployment added |
| Neon (database host) | **not read** | | No Neon access in this run |
| Domain `labintelligence.co` (the `earmark` subdomain) | **not read** | | No registrar or DNS billing access in this run |
| Anthropic API | **not read** | | Whether `ANTHROPIC_API_KEY` is set in Production was not checked (no environment variable was read) |
| GitHub Actions | **not read** | | |

New billable pieces since D-38's $0 baseline: the Vercel project (builds, function time, CDN requests, observability events); the daily cron at 06:00 UTC, now actually running; a hosted Postgres database; the subdomain. Builds are almost all of the measured figure, which is what D-42 predicted and why D-56 skips Previews and `vercel.json` skips builds for docs-only changes.
