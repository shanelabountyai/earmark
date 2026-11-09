# Earmark — PRD v0.1

Nov 4, 2026 · @Shane LaBounty

Earmark is build-log #23: a B2B marketing budget and agency-spend governance tool, sold to several client companies at once. Each client is a tenant with its own SSO. Agencies work across clients, so one agency user belongs to many tenants and must only ever see the one they are in. It starts on saas-foundation v1.5.0 (vitest 5) for Phases 0–1, merges v1.6.0 (the enterprise release) before Phase 2, and is the first clone to turn on row-level security, the SSO module and the `apikeys` module. Repo `shanelabountyai/earmark` (public), port 7600, synthetic data only, not deployed.

## 0. Decisions log

| Id | Decision | Why |
| --- | --- | --- |
| D-01 | **Client company = org.** Every budget, request, commitment and invoice carries the client's `orgId`. An agency is a row in the client's org (`Agency`), not an org of its own. | Keeps the foundation's one-org-per-request model. An agency-as-org would need cross-org queries that RLS is built to refuse. |
| D-02 | **Agency staff are members of each client org with role `guest`.** A new foundation-compatible role added in this clone's `Role` extension, the way Bracketry added `scorekeeper` (L-040). A guest's membership row carries `agencyId`, so a guest sees only their agency's items inside that client. | One user, many memberships, each scoped twice: by org (RLS + `inOrg`) and by agency (app rule). |
| D-03 | **Approval chains are data** in `rules/approval-chains.json`, not code: ordered steps, each with a threshold and an approver role or named seat. Changing a threshold is a data edit with an audit event, never a deploy. | The Lumen governance model was a small named group with dollar thresholds; the tool should let a finance lead change those without engineering. |
| D-04 | **Money is integer cents** (`BigInt`), one currency per org (`Org.currency`, default USD). No floats anywhere in the money path. | Same rule as LoanBook and Ledgerleave. Rounding drift in a variance report is a credibility failure. |
| D-05 | **A commitment is created only by an approved request;** an invoice is matched to a commitment, never to a budget line directly. Actuals = matched, approved invoices. | This is the control. Spend without a prior approval is visible as *unmatched*, not silently absorbed. |
| D-06 | **Period = fiscal month**, with a fiscal-year start month per org (default January). Budgets are planned by period; rollups are derived, never stored. | Marketing budgets are managed monthly against an annual plan. Derived rollups cannot disagree with their rows. |
| D-07 | **The AI feature is one thing: a variance explainer** that drafts a one-paragraph note on why a line moved, from the request and invoice history, wrapped in the foundation's `withBudget`. It drafts; a person publishes. | One AI feature exercises the spend guard without making the app depend on a model. |
| D-08 | **RLS enforce mode is on from the first migration.** `rls:policies` runs over Earmark's tables in Phase 2 and the clone never runs in off mode. | The point of the clone. Running off mode first would mean turning it on later against existing code. |
| D-09 | **Phase 1 is pure engines in `src/lib/earmark/`**: approval-chain evaluation, budget rollups, variance, invoice matching. No database, Python oracles in `tools/`, property tests. Same shape as Quorum, Gavel and Commons. | The money logic is tested in isolation before any UI exists. |
| D-10 | **Unattended cloud build, stop at each gate, branch + PR, no merge.** Fable, with Opus as fallback for the SSO wiring if needed. | The pattern of the last six clones. |

**D-11 (2026-11-04).** The enterprise release is **v1.6.0**, not v1.5.0: `v1.5.0` was already tagged that day for the vitest 5 upgrade (F-05). Earmark starts on `v1.5.0` because Phases 0–1 need nothing from the enterprise release, and merges `v1.6.0` in a Phase 1.5 before any table exists. This replaces the foundation addendum's original D-30 gating.

**Phase 2 decisions (2026-11-09).**

| Id | Decision | Why |
| --- | --- | --- |
| D-12 | **`guest` is a patched core enum value; `agencyId` lives in a clone-owned `GuestMembership(orgId, userId, agencyId)`** (Shane, 2026-11-09). `guest` is added to `enum Role` and `guest: []` to the core grants, both listed in `FOUNDATION_PATCHES.md` and proposed upstream for template v1.7.0 (the `scorekeeper` D-21 precedent). `GuestMembership` references `Membership` by `(orgId, userId)` and is deleted with it. A guest with no row, or whose agency is offboarded, sees nothing. | `Role` and the grants are template-owned and have no extension seam. A side table keeps core's `Membership` untouched, so only two lines differ from the template. |
| D-13 | **Children reference their parent by the composite `(id, orgId)`.** Only `OrgSettings`, `FiscalYear`, `Agency` and `Seat` reference `Org`. Actor ids (`requestedById`, `decidedById`, …) are plain uuids, not foreign keys. | A foreign-key check bypasses RLS, so a single-column FK would let a bug link one client's commitment to another client's request. The composite key makes that impossible in the database. Actor history outlives a deleted user. |
| D-14 | **The live approval rules are a row (`OrgSettings.rules`)**, seeded from `rules/approval-chains.json` on the org's first read. The file is the seed, not the runtime source. | D-03 says a threshold change is a data edit with an audit event, never a deploy. A file in the repo cannot be edited per org without a deploy. |
| D-15 | **Earmark's permissions are clone-owned (`earmarkCan` in `src/earmark/core.ts`).** Actions pass `perm: null` to `orgAction` and check Earmark's permission first in the body. Approving is not a permission: it follows seat holdings, so a member who holds a seat approves. | The core `Permission` union is template-owned. Seats, not roles, are PRD §1's approval model. |
| D-16 | **The E-INV tests are in `tests/earmark/invariants/`**, not `tests/invariants/earmark/` as §8 says. | `tests/invariants/**` is template-owned, so any file added there fails `foundation:drift`. |
| D-17 | **The Phase 2 actions are:** submit, decide a step, withdraw, edit rules, submit an invoice, match an invoice, tie a guest to an agency, offboard an agency. **They move to Phase 3, with the pages that use them:** planning CRUD, seat management, the reallocation flow, publishing a variance note, approving an invoice for payment, and binding a guest's agency at invite time. `draftVarianceNote` takes the model as an argument; Phase 4 passes the real one and adds its action. | Phase 2's gate is persistence and invariants. An action no page calls yet is untested surface. |
| D-18 | **The chain's `Budget Owner` step resolves to the holders of the line's `ownerSeat`.** The default `ownerSeat` is `Budget Owner`. | Northwind has four budget owners. A line names which one approves it without a chain per line. |
| D-19 | **The approval rules are also enforced in the database:**<br>• A trigger refuses a `Commitment` whose request is not approved or whose amount exceeds the request (E-INV-02).<br>• `CHECK`s keep money positive and `remainingCents ≤ amountCents`.<br>**Two ordering and atomicity rules:**<br>• Actions resolve every id before they validate amounts or dates, so a foreign id is always the 404 of a missing one.<br>• Offboarding marks the agency and closes its POs in one transaction (its guests see nothing from that moment), then removes each guest through core's `removeMember`. | Defence in depth for the one control the product exists to enforce. The ordering is what INV-02/03 require of every action. |

**Phase 3 decisions (2026-11-09).**

| Id | Decision | Why |
| --- | --- | --- |
| D-20 | **The demo seed is `scripts/seed-earmark.ts`, called from `seed-demo.ts`, and it replants the org's Earmark rows on every run.** Northwind and Contoso replace the template's Acme and Globex. Budget Owner × 4 is one seat per program (`Brand Owner`, `Demand Gen Owner`, …), each line's `ownerSeat` (D-18). The campaign manager (`member@`) also holds `Demand Gen Owner`, so step 4's self-approval refusal is real. Every request runs through the chain engine and every match through `applyMatch`, so the seeded ledger obeys the same rules as live data. INV-27's demo-user count is made seed-agnostic (a `FOUNDATION_PATCHES.md` line). | Replanting keeps frozen approver ids pointing at users that exist after a test truncates the user table. Seeding through the engines means the demo cannot show a state the app could never reach. |
| D-21 | **Phase 3 ships as seven commits on `phase-3`**: (1) demo seed; (2) dashboard, budget tree and line page with replan marker; (3) request form, chain view, approvals inbox, rules settings; (4) commitments and the guest view, guest invoice submit; (5) invoice match with suggestions, approve-for-payment, variance view and published notes; (6) planning CRUD, seats, reallocation, guest agency at invite; (7) alerts cron and the e2e for demo steps 1–8. Step 8's API half needs Phase 4's scopes, so Phase 3's e2e covers the URL half. | One item per session; each commit leaves the gate green. |
| D-22 | **Phase 3's gate runs steps 1, 6 and 8 with stand-ins, and Phase 4's gate re-runs them for real** (Shane, 2026-11-09). Step 1 signs in through `/demo`, not Google. Step 6 asserts the `commitment.issued` event row is written, not that the webhook reaches the demo receiver. Step 8 checks the URL 404 only, not the API with Contoso's key. Phase 4's e2e covers all three as written. | Google sign-in, webhook delivery and API scopes are Phase 4 work (§7). Writing the stand-ins down keeps the Phase 3 gate from quietly checking less than it says. |

## 1. Who uses it

Four people inside a client company and one outside it.

| Role (foundation `Role`) | Who | May |
| --- | --- | --- |
| `owner` | Client finance lead or CMO | Everything: budgets, rules, approvals at any threshold, SSO and export, agency onboarding |
| `admin` | Marketing operations manager | Plan budgets, edit approval rules below the top threshold, approve within their seat, manage agencies and guests, run reports |
| `member` | Campaign manager / requester | Create spend requests against lines they are assigned to, see their programs' budgets, match invoices they receive |
| `guest` (new, D-02) | Agency account staff | Inside one client org and one agency: see commitments issued to their agency, submit invoices against them, see match status. Nothing else: no budgets, no other agencies, no approvals |
| `integration` (from `apikeys`) | The client's finance system or a Zapier flow | Scoped API: read commitments and actuals, post invoices, receive webhooks on approval and match events |

**Approver seats** are not roles. A seat (`Budget Owner`, `Marketing Ops`, `Finance`) is a named position in `rules/approval-chains.json` held by one or more users of the org. A chain step names a seat; the seat resolves to people at evaluation time. This is how a three-person governance group is modelled without three roles.

**What a `guest` never sees, enforced three ways:** other clients (RLS + `inOrg`), other agencies in the same client (`agencyId` predicate in every guest query, tested by E-INV-03), and budget amounts above the commitment they are working against (the `toGuest*` projection, the share-link pattern from spec §7c applied to a role).

## 2. Domain model

All tables carry `orgId` and get an RLS policy from `rls:policies`. Amounts are `BigInt` cents (D-04). Schema file `prisma/schema/earmark.prisma`.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `FiscalYear` | The annual plan | `startsOn`, `label`, `lockedAt` (no line edits after lock) |
| `Program` → `Campaign` → `BudgetLine` | The hierarchy. Only lines hold money; programs and campaigns are groupings. | `BudgetLine`: `campaignId`, `periodId`, `plannedCents`, `ownerSeat`, `costCenter`, `glCode` |
| `Period` | One fiscal month | `fiscalYearId`, `index` 1–12, `startsOn`, `endsOn` |
| `Agency` | A vendor the client works with | `name`, `domains[]` (for guest email matching), `paymentTermsDays`, `activeAt`, `offboardedAt` |
| `SpendRequest` | A request to commit money against one line | `budgetLineId`, `agencyId?`, `amountCents`, `description`, `requestedById`, `state`, `chainSnapshot` (the rules evaluated at submit, frozen) |
| `ApprovalStep` | One step of a request's chain | `requestId`, `index`, `seat`, `thresholdCents`, `decidedById?`, `decision?`, `decidedAt?`, `note` |
| `Commitment` | Approved money, issued to an agency as a PO | `requestId` (unique), `poNumber`, `amountCents`, `remainingCents` (derived, cached with a check), `issuedAt`, `closedAt` |
| `Invoice` | What an agency bills | `agencyId`, `number`, `amountCents`, `invoicedOn`, `dueOn`, `submittedById`, `state`, `fileRef?` |
| `InvoiceMatch` | An invoice applied to a commitment | `invoiceId`, `commitmentId`, `amountCents`, `matchedById`, `matchedAt`, `variance` (over, under, exact) |
| `Reallocation` | Money moved between lines in a period | `fromLineId`, `toLineId`, `amountCents`, `requestId` (reallocations route through the same chain) |
| `VarianceNote` | The explainer's draft and the published note | `budgetLineId`, `periodId`, `draft`, `published?`, `aiUsageId?` |
| `Seat` / `SeatHolder` | Named approver positions and who holds them | `name`, `userId`, `activeFrom`, `activeTo`, `delegateToId?` |

**Derived, never stored:** committed per line = sum of open commitments; actual per line = sum of approved matches; available = planned − committed − unmatched actuals; rollups to campaign, program and org. `Commitment.remainingCents` is the one cached number, protected by a check that recomputes it in tests (E-INV-05).

**States**

- `SpendRequest`: draft → submitted → (in review, one step at a time) → approved | rejected | withdrawn. Approved creates the `Commitment` in the same transaction.
- `Invoice`: submitted → matched | disputed → approved for payment | voided. Payment itself is out of scope; `approvedForPaymentAt` is the hand-off to the client's AP system through a webhook.
- `Commitment`: open → closed (fully matched or manually closed with a reason).

Each state change writes an `AuditEvent` and, when the `apikeys` module is present, an outbound event of the same name.

## 3. Approval chains as data (D-03)

A chain is an ordered list of steps. Each step names a seat and the amount at which it starts to apply. A request walks the steps in order; a step whose threshold is above the request amount is skipped. The chain is evaluated once at submit and frozen on the request (`chainSnapshot`), so a later rule change never alters a request in flight; this is the Ledgerleave rule for approval routing, reused.

**Sample rules** (`rules/approval-chains.json`, seeded; thresholds set by Shane 2026-11-04):

```json
{
  "default": [
    { "seat": "Budget Owner",  "fromCents": 0 },
    { "seat": "Marketing Ops", "fromCents": 1000000 },
    { "seat": "Finance",       "fromCents": 5000000 },
    { "seat": "CMO",           "fromCents": 10000000 },
    { "seat": "CFO",           "fromCents": 25000000 }
  ],
  "reallocation": [
    { "seat": "Marketing Ops", "fromCents": 0 },
    { "seat": "Finance",       "fromCents": 2500000 }
  ],
  "overrides": [
    { "when": { "costCenter": "Events" }, "append": [{ "seat": "Events Lead", "fromCents": 0 }] }
  ]
}
```

So a $7,500 request stops at Budget Owner; $25,000 adds Marketing Ops ($10k+); $75,000 adds Finance ($50k+); $150,000 adds the CMO ($100k+); $300,000 adds the CFO ($250k+).

**Rules the engine enforces** (pure, in `src/lib/earmark/chain.ts`, oracle in `tools/chain_oracle.py`):

1. A requester never approves their own request, even if they hold the seat; the step moves to the seat's next holder or, if none, is refused with a clear message.
2. One person may hold several seats but counts once per request: holding Budget Owner and Finance collapses to a single decision.
3. Delegation: a seat holder with `delegateToId` set and `activeTo` in the future passes the step to the delegate; the audit row records both.
4. Over-budget requests (amount exceeds the line's available) are allowed to submit but gain a mandatory *Over budget* step at the Finance seat and a required note. They are flagged in every list.
5. Rejection at any step ends the chain. Resubmission is a new request that links to the old one.
6. Rule edits need `admin` for thresholds below the top step and `owner` for the top step and for adding or removing seats; every edit is an audit event with the before and after JSON.

**Expected outcome for the demo:** a finance lead can change a threshold in settings, see the change in the audit log, and watch the next request route differently, with no deploy.

## 4. Money rules

- **Planned** is set per line per period and can be edited until the fiscal year is locked. Edits after the first commitment against a line are allowed but audited and shown as a *replan* marker on the variance view.
- **Committed** is the sum of open commitments on the line. A commitment cannot exceed the request it came from.
- **Actual** is the sum of approved invoice matches. An invoice can match several commitments; a commitment can take several invoices. A match that takes a commitment negative is refused unless the matcher holds the Finance seat and adds a note (an *overage*, tracked).
- **Unmatched invoices** are the control exception: visible on the org dashboard from the moment they are submitted, aged in days, and they count against *available* as a provision so nobody spends money an invoice is already claiming.
- **Available** = planned − committed − unmatched provision, never below the line's display even when negative.
- **Variance** per line per period = actual − planned, shown as cents and as a percentage of planned; a line with zero planned and non-zero actual shows *unplanned*, not a division.
- **Alerts** (data in `rules/alerts.json`): committed reaches 80 % of planned; actual reaches 100 %; an invoice is unmatched for 14 days; an agency's invoices exceed its open commitments. Each alert emails the line's seat holders once per period through the foundation transport and writes an audit event.
- **Invoice-to-PO match** is a suggestion, then a decision: the engine proposes matches by `poNumber` on the invoice, then by agency + amount within 2 %, then by agency alone; a person confirms. The proposer is pure (`src/lib/earmark/match.ts`, oracle `tools/match_oracle.py`) and returns a ranked list with reasons, the Housefile pattern applied to invoices.
- **Fiscal year close**: locks every line, closes commitments with zero remaining, and carries open commitments forward into the new year's first period as a *carry-forward* line that cannot take new requests.

## 5. Cross-tenant guests (D-02)

One agency account manager, Dana, works for two clients: Northwind (SSO via Google Workspace) and Contoso (SSO via Okta). Dana has one `User` row and two `Membership` rows, each `role = guest` with an `agencyId` pointing at her agency's row *inside that client*.

**How Dana signs in.** Her email domain is her agency's, not a client's, so neither client's SSO matches. She gets a magic link (the foundation default) and lands on `/onboarding`, which lists both clients. Picking one puts her at `/o/northwind/…`. Every request from then on names the org in the URL and is membership-checked (spec §12 Q2).

**What refuses the rest, in layers**

1. **URL + `requireOrg`**: `/o/contoso/…` while acting for Northwind is a different membership check; without one it is 404.
2. **`inOrg(ctx)`** on every query, as in every clone (INV-02/03/04).
3. **RLS** (enforce mode): even a query with a missing `inOrg` returns nothing from another client's rows, because `app.org_id` is Northwind's for that transaction (foundation INV-29).
4. **Agency predicate**: inside Northwind, a guest's queries carry `agencyId = membership.agencyId`. Another agency's commitments in the same client are 404 to her (E-INV-03). RLS cannot do this one, since both agencies' rows share an `orgId`; it is the app's rule and is tested like one.
5. **Projection**: `toGuestCommitment()` returns PO number, amount, remaining, due dates and match status, and nothing about the budget line above it (E-INV-04).

**Agency offboarding.** Setting `Agency.offboardedAt` revokes every guest membership tied to that agency in that client on the next request (foundation INV-05 behaviour) and closes its open commitments with reason *offboarded*. Dana keeps her Contoso access untouched.

**The demo moment:** sign in as Dana, open a Northwind commitment, copy its id into a Contoso URL, get a 404; then run the same id through the API with Contoso's key, get the same 404 body (INV-04). Then show the Postgres log where the row-level policy filtered the row even with a deliberately unscoped query in a test.

## 6. Foundation v1.6.0 features turned on

| Feature | Earmark setting | What it does here |
| --- | --- | --- |
| Row-level security | `RLS_MODE=enforce` from the first migration (D-08); `rls:policies` run over `earmark.prisma` in Phase 2 | Every Earmark table is policy-protected; foundation INV-29/30/33 run in CI |
| SSO module | kept; `SSO_ENABLED=1`; Northwind → Google Workspace, Contoso → Okta, `required = true` on both | Client staff sign in with their own IdP; guests use magic links; owners cannot be created by SSO (INV-38) |
| `apikeys` module | kept; scopes `read`, `write`, `invoices`; events `request.approved`, `commitment.issued`, `invoice.matched`, `invoice.approved_for_payment` | A client's AP system receives approvals and matched invoices; a Zapier flow posts invoices from email |
| Data export | registers `FiscalYear`, `Program`, `Campaign`, `BudgetLine`, `SpendRequest`, `ApprovalStep`, `Commitment`, `Invoice`, `InvoiceMatch`, `Reallocation`, `VarianceNote` in `export-hooks.ts` | Tenant offboarding: a client takes its whole ledger as JSONL with a manifest |
| Audit viewer + security page | on by default | Every threshold change, approval and match is visible to owners and admins |
| AI spend guard | `withBudget(ctx, 'variance-explainer', …)`; org cap left at the default; demo orgs seeded at $1.00 | The explainer drafts a variance note; the refusal path is shown live in the demo when the cap is hit |
| Billing module | **deleted** | Earmark is sold by contract, not self-serve card; removing a module is itself a demo of the foundation |
| Notifications module | **deleted** | Alerts go by email through core; no SMS |

Port 7600, Neon project `earmark`, no Vercel deployment in v0.1 (synthetic data only, like Quorum and Ledgerleave).

## 7. Phases and gates (D-09, D-10)

Each phase is one unattended cloud session that stops at its gate on the open PR. Nothing merges without Shane.

| Phase | Builds | Gate (stop here) |
| --- | --- | --- |
| 0 Kickoff | Clone from the `v1.5.0` tag, `new-project earmark 7600`, delete `billing` and `notifications`, CI green on an empty app, `README`, `prd-earmark.md` committed | Phase 1 plan posted on the PR |
| 1 Engines | `src/lib/earmark/{money,chain,rollup,match,variance}.ts`, pure, `BigInt` cents; `tools/*_oracle.py` (stdlib only) with `fixtures/` cases; property tests (fast-check) and oracle parity tests | Oracle parity 100 % on fixtures; coverage of `src/lib/earmark` ≥ 95 % |
| 1.5 Upgrade | Merge foundation `v1.6.0` once tagged; keep `sso` and `apikeys`; `RLS_MODE=enforce` | Foundation INV-01 to 41 green under enforce on the empty app |
| 2 Persistence | `earmark.prisma`, migrations, `rls:policies` output committed, `guest` role + `agencyId` on `Membership` (clone extension), server actions via `orgAction`, `tests/fixtures/app.ts` rows, E-INV-01 to 08 | Foundation invariants green under enforce; E-INV green |
| 3 Approvals and money UI | Budget tree, request form and chain view, approvals inbox per seat, commitments, invoice submit (guest) and match (admin), variance view with replan markers, alerts cron in `cron-jobs.ts` | e2e: demo script steps 1–8 pass |
| 4 Enterprise wiring | SSO connections for the two demo orgs from `.env.local`, `apikeys` scopes and events, `export-hooks.ts`, variance explainer under `withBudget`, audit viewer checks | e2e: demo steps 9–14; one manual Google and one Okta sign-in recorded in `docs/DEMO.md` |
| 5 Close-out | `WRITEUP.md`, `docs/DEMO.md`, CMO brief artifact, `CLONES.md` row in the foundation, build-log card updated | Shane marks #23 shipped |

**Session rules** carried from Commons and Quorum: the build runs on branch `kickoff` then `phase-N`; every phase ends with typecheck, lint, `npm test`, `foundation:drift` and a build; the PR body lists decisions taken under the open-decision defaults in §10; a gate failure stops the session rather than working around it.

## 8. Oracles and tests

**Python oracles** (`tools/`, stdlib only, the Gavel and Quorum pattern): `chain_oracle.py` walks a chain for an amount and a set of seat holders and prints the step list; `rollup_oracle.py` computes planned, committed, actual and available per node from a fixture ledger; `match_oracle.py` ranks commitments for an invoice; `variance_oracle.py` computes variance rows for a period. Each reads a JSON fixture and prints JSON; the vitest parity test runs both implementations over every file in `fixtures/` and diffs.

**Property tests** (fast-check): rollups equal the sum of their leaves for any tree; no sequence of matches takes a commitment below zero without the overage flag; chain evaluation is deterministic and skips exactly the steps whose threshold exceeds the amount; cents arithmetic never produces a non-integer.

**Clone invariants** (`tests/invariants/earmark/`, run beside the foundation's):

| ID | Invariant | How it is tested |
| --- | --- | --- |
| E-INV-01 | A requester cannot approve their own request through any seat they hold. | Requester holds Budget Owner; approve as self → refused, no `ApprovalStep.decision` written. |
| E-INV-02 | A commitment exists only for an approved request, with an amount ≤ the request. | Direct insert attempt via action → refused; approve → one commitment, same transaction. |
| E-INV-03 | A guest sees only their agency's rows inside the client. | Two agencies in one org; guest of A reads B's commitment id → 404, byte-identical to a nonexistent id. |
| E-INV-04 | `toGuestCommitment()` exposes no budget-line fields. | Object-keys test on the projection with a dummy field added to the row. |
| E-INV-05 | `Commitment.remainingCents` equals the recomputed value after any sequence of matches. | Property test over random match sequences; mismatch fails. |
| E-INV-06 | Rule edits are audited with before and after, and in-flight requests keep their `chainSnapshot`. | Edit a threshold mid-request; the request's steps are unchanged; audit row carries both JSONs. |
| E-INV-07 | Offboarding an agency revokes its guests in that client only. | Dana loses Northwind on the next request and keeps Contoso. |
| E-INV-08 | The variance explainer is refused once the org's AI cap is hit and writes no draft. | Foundation INV-39 fixture reused with the explainer as the caller. |

## 9. Demo seed and script

`seed:demo` creates two clients and one agency that spans them. All names and figures are synthetic; no real people, no real vendors.

| Org | IdP | Fiscal year | Programs | Seats |
| --- | --- | --- | --- | --- |
| Northwind | Google Workspace (labintelligence.co test tenant) | Jan–Dec, $4.8M planned | Brand, Demand Gen, Events, Content | Budget Owner × 4, Marketing Ops × 1, Finance × 1, CMO × 1, CFO × 1 |
| Contoso | Okta Integrator Free | Jul–Jun, $1.2M planned | Product Launch, Partner Marketing | Budget Owner × 2, Marketing Ops × 1, Finance × 1, CMO × 1, CFO × 1 |
| Agency: Meridian Creative | guests by magic link | — | serves both clients; Dana is a guest in both | — |

The seed also plants: 40 requests across states, 25 commitments, 60 invoices of which 6 are unmatched and 2 are overages, one over-budget request waiting at Finance, one delegated seat, and an AI cap of $1.00 so the explainer refuses on the fourth draft.

**Script (14 steps, \~10 minutes)**

1. Sign in to Northwind through Google; land on the dashboard: planned, committed, actual, available, aged unmatched invoices.
2. Open Demand Gen → Q2 Paid Social; show the line's history with a replan marker.
3. Submit a $12,000 request; show the frozen chain (Budget Owner, Marketing Ops).
4. Approve as Budget Owner; show the step and audit row; try to approve as the requester → refused.
5. Change the Marketing Ops threshold to $15,000 in settings; show the audit diff; submit a second $12,000 request → stops at Budget Owner only; the first request is unchanged.
6. Approve the first; a PO is issued; `commitment.issued` webhook fires to the demo receiver.
7. Sign in as Dana (magic link); pick Northwind; submit an invoice against the PO.
8. Switch to Contoso in the same browser; paste the Northwind PO id into the Contoso URL → 404; same via the API with Contoso's key → identical 404 body.
9. Back in Northwind as admin: match the invoice; show the ranked suggestions and reasons; confirm; variance view updates.
10. Run the variance explainer on the line; publish the draft; run it three more times → the fourth is refused by the spend guard.
11. Open the audit viewer; filter to today's actor; download CSV.
12. Open the security page; show who signs in by SSO vs link; show *Require SSO* on.
13. Offboard Meridian in Contoso; Dana's Contoso access is gone on refresh, Northwind intact.
14. Export Northwind; open the manifest; show row counts and sha256 per file.

The written demo (`docs/DEMO.md`) carries the step list with the expected screen for each, the Showcall and Gavel format.

## 10. Open decisions (defaults taken) and kickoff

1. **Real thresholds.** Set 2026-11-04: $10k / $50k / $100k / $250k+ (§3).
2. **Multi-currency.** Default: one currency per org. A client with EUR and USD lines is out of scope for v0.1.
3. **Invoice files.** Default: no uploads in v0.1 (`fileRef` is a URL the guest pastes). File uploads are out of foundation scope (§11) and would be Earmark's own storage seam.
4. **Payment status.** Default: Earmark stops at *approved for payment* and emits the event; AP status flows back only if a clone-side integration posts it through the API. No payment rails.
5. **Agency guests without a client email.** Default: magic link, as designed. If an agency wanted its own SSO, that is a second connection per org, which the foundation defers.
6. **Seat holders who leave.** Default: a seat with no active holder blocks its step and alerts the owner; it does not auto-skip.
7. **Reallocation across programs.** Default: allowed within a fiscal year through the `reallocation` chain; across fiscal years refused.

**Claude Code kickoff** for Phases 0–1 is `kickoff-prompt.txt` on this branch (scheduled 2026-11-04 8:00 PM CT, cloud).
