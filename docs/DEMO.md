# Earmark — demo script

Synthetic data only. Northwind, Contoso and Meridian Creative are invented; every person is `@*.demo.test`; no money moves and no invoice is paid, approval for payment is a status. Every screen below is checked by an e2e spec (`e2e/demo.spec.ts`, `e2e/enterprise.spec.ts`) against the same seed; the spec is named at each step.

**Time:** about 12 minutes. **Machine:** the Mac, Postgres 17 running locally, `earmark` database (the one `.env.local` points at), production build on port 7600.

## Setup (once, before the audience arrives)

```bash
cd ~/Projects/earmark
lsof -ti :7600                        # prints nothing; if it prints a pid, stop that server
sysctl -n kern.memorystatus_level     # well above 30

# 1. Seed (idempotent; replants every Earmark row and resets the AI spend, so step 10 refuses on the fourth draft)
npm run seed:demo                     # ends: TOTP secret for the (TOTP) accounts ...

# 2. Serve the production build (about a minute cold)
rm -rf .next && npm run build && npm start
```

When `curl -s localhost:7600/api/health` prints `{"ok":true}`, open <http://localhost:7600/demo>.

**`.env.local` must carry** (names only; `grep -oE '^[A-Z_]+=' .env.local` lists them):

| Name | Why | Without it |
|---|---|---|
| `DEMO_MODE=1` | the `/demo` one-click sign-in | `/demo` is a 404 |
| `WEBHOOK_ALLOW_PRIVATE=1` | step 6: the demo receiver is `http://localhost` (D-34) | delivery refused; the endpoint pauses after 10 failures |
| `SSO_ENABLED=1` and the seven `SSO_TEST_*` | steps 1, 8, 11–14 live (the template's Google and Okta test apps) | `seed:demo` seeds no SSO; run those steps from the e2e instead |
| `ANTHROPIC_API_KEY` **unset** | step 10: the stub bills a fixed cost, so the fourth draft is refused (D-35) | real Haiku drafts cost ~$0.0002 and the cap is not reached in four |

**SSO, once per machine.** Both test apps must list `http://localhost:7600/login/sso/callback` as a redirect URI (Google Cloud console → the OAuth client; Okta admin → the app → Sign-in redirect URIs). The template's apps were registered for port 4100.

**Accounts.** `/demo` lists every seeded account; no password is typed. They exist only because `DEMO_MODE=1` and `scripts/seed-demo.ts` set `isDemo`. The demo accounts are deliberately refused API keys, exports and member removal (D-33, D-36), so steps 8, 11, 13 and 14 run as a **real owner** (below).

| Account | Who | Use it for |
|---|---|---|
| `owner@northwind.demo.test` | owner of Northwind | dashboard, line page, explainer, security page |
| `member@northwind.demo.test` | campaign manager, also holds Demand Gen Owner | submitting requests; the self-approval refusal |
| `demandgen@northwind.demo.test` | Demand Gen Owner seat | step 1 of the chain |
| `admin@northwind.demo.test` | admin, Marketing Ops seat | rules, matching, step 2 of the chain |
| `finance@northwind.demo.test` | Finance seat | approve for payment |
| `dana@meridian.demo.test` | Meridian Creative staff, `guest` in Northwind and Contoso | the agency view |

Seed: Northwind 40 requests, 25 POs, 60 invoices (6 unmatched); Contoso 8 requests, 5 POs, 7 invoices (2 unmatched). Thresholds: Budget Owner from $0, Marketing Ops $10k, Finance $50k, CMO $100k, CFO $250k (`rules/approval-chains.json`).

**The real owner (D-37).** After the step 1 Google sign-in (Northwind) and an Okta sign-in to Contoso, the presenter's SSO users are members (SSO never makes an owner, INV-38). Promote them once:

```bash
psql earmark -c "UPDATE \"Membership\" m SET role='owner' FROM \"User\" u WHERE u.id=m.\"userId\" AND u.email IN ('<your google email>','<your okta email>')"
```

An owner whose IdP did not report MFA is asked to enrol TOTP once on the next owner-only page.

## 1. The client's view (3 min)

1. **Sign in to Northwind through Google** (`/login`, your Workspace email, *Email me a link* redirects to Google because the domain is SSO). Land on **Your orgs** → **Northwind**: Planned, Committed, Actual, Available, and **Unmatched invoices (n)**. *Say:* "every number here is derived from rows on read; nothing is stored that can disagree with its rows." *(enterprise.spec step 1, with a mock IdP standing in for Google.)* No SSO set up: sign in at `/demo` as `owner@northwind.demo.test`.
2. **Demand Gen → Q2 Paid Social.** The heading carries a **Replan** marker; *Line history* shows `Planned edited to …` after the first PO. *Say:* "a plan edited after money was committed is flagged, not hidden." *(demo.spec step 2.)*

## 2. A request and its chain (3 min)

Open three windows: `member@`, `demandgen@`, `admin@` (all Northwind, from `/demo`).

3. As **member**: **Requests** → Budget line `Demand Gen / Paid Social / Q2 Paid Social`, Agency `Meridian Creative`, Amount `12,000.00`, a description → **Submit request**. Open it: the **Approval chain** table reads `Budget Owner`, `Marketing Ops`. *Say:* "the chain is frozen onto the request at submit."
4. Still as member, **Approve** → *You cannot approve your own request.* (she holds the Demand Gen Owner seat; the refusal is the action's, not the page's). As **demandgen**: **Approvals** → the request → **Approve**; the page moves to *Decide step 2: Marketing Ops* and *Request audit* shows `request.step.approved`.
5. As **admin**: **Rules** → in *Rules JSON* change Marketing Ops `"fromCents": 1000000` to `1500000` → **Save rules** → *Saved 1 change.*; *Rule edits* shows the before/after. As member, submit a second $12,000 request: its chain is `Budget Owner` only. Reopen the first: still two steps. *(demo.spec steps 3–5.)*

## 3. The PO and the webhook (1 min)

6. As **admin**, approve the first request (Marketing Ops): it is approved and a **PO-…** link appears. The `commitment.issued` webhook is sent as the response finishes, to the demo receiver, which answers 401 to a bad signature:

```bash
psql earmark -c "SELECT d.status, d.\"lastResponseStatus\", d.\"lastResponseExcerpt\" FROM \"WebhookDelivery\" d ORDER BY d.\"createdAt\" DESC LIMIT 1"
# succeeded | 200 | {"ok":true,"verified":true,...}
```

*(demo.spec step 6.)*

## 4. The agency (2 min)

7. New private window, `/demo` → **dana@meridian.demo.test**. Her home is **Purchase orders**: Meridian's only, no Requests tab, no budget figures. Open an `open ·` PO → Invoice number, Amount `1,250.00`, dates → **Submit invoice**. *Say:* "Require SSO is on for Northwind's staff; Dana is not on Northwind's IdP, so guests keep magic links." *(demo.spec steps 7–8; enterprise.spec step 7's link half.)*
8. Change `/o/northwind/` to `/o/contoso/` in her URL: **404**, the same page as an id that does not exist. Then the API with Contoso's key: as the **real owner in Contoso**, Settings → API keys → create a `read` key, then

```bash
KEY=api_...   # shown once on creation
curl -s -w ' %{http_code}\n' -H "authorization: Bearer $KEY" localhost:7600/api/v1/commitments/<the Northwind PO id from Dana's URL>
curl -s -w ' %{http_code}\n' -H "authorization: Bearer $KEY" localhost:7600/api/v1/commitments/00000000-0000-4000-8000-000000000000
# the same body and 404 twice
```

*(enterprise.spec step 8, with a planted key.)*

## 5. Money in (2 min)

9. As **admin**: **Invoices** → *To match* → Dana's invoice. *Suggested POs* ranks the PO first with the reason `PO number and agency` → **Match to PO-…**. The *Matches* table shows it. **Approve for payment** as admin → *Only a Finance seat holder can approve an invoice for payment.* As **finance**, the same page → **Approve for payment** → Status `approved`. **Variance** shows the line. *(demo.spec step 9.)*
10. As **owner**, Q2 Paid Social → **Draft with AI**: *Draft (no model configured): Planned …*. Edit, **Publish note**; it shows as *Published note*. **Draft with AI** twice more (*Draft ready*), then a fourth time → refused: *monthly AI spending limit*. *Say:* "the cap is $1.00 a month; the guard reserves the worst case before the call, so a refused draft writes nothing." *(demo.spec step 10.)*

## 6. Governance (2 min)

As the **real owner** in Northwind (14 before 11, so the audit log has today's export):

14. Settings → Danger → **Export data**; reload until **Download the zip**. The page prints the manifest's sha256. Check it:

```bash
unzip -p ~/Downloads/<the zip> manifest.json | shasum -a 256     # equals the sha256 on the page
unzip -p ~/Downloads/<the zip> manifest.json | python3 -m json.tool | head -30   # each table: rows and sha256
```

11. Settings → Audit → Actor email = your email, From and To = today (UTC) → **Filter**: `export.requested` among your rows → **Download CSV** (the same rows). *(enterprise.spec steps 11, 14.)*
12. Settings → Security: the members table shows who signs in by **SSO** and who by link, and **On. Required: yes.** *(enterprise.spec step 12.)*
13. Switch to **Contoso** (real owner) → Settings → Agencies → Meridian Creative → **Offboard**; the row reads `offboarded`. Reload Dana's Contoso tab: **404**. Her Northwind tab still lists her POs. *Run it last; `npm run seed:demo` restores her.* *(demo.spec step 13.)*

## Live site: https://earmark.labintelligence.co (D-43)

Behind a shared password (HTTP Basic, any username; ask the owner). Sign in at `/demo` with the shared accounts. **The live site has email off and no SSO keys**, so these steps are **local-only**: step 1 (company sign-in), step 7's emailed link, steps 11, 13 and 14 as the real owner, and promoting your own SSO user. Everything else, including the webhook delivery (step 6) and step 8's two `curl`s (send the key as `Authorization: Bearer`; the gate lets `/api/v1` through), works live. Not yet run live by Claude: the click-through after the first deploy. The short, no-setup version for a visitor (eight steps with the shared accounts only) is *Try the live demo* in the [README](../README.md); since D-58 a `/demo` account with one org lands straight in it, and Dana still picks her client on *Your orgs*.

## Live demo: the walk-through on https://earmark.labintelligence.co (closeout, 2026-11-19)

The README's eight steps (*Try the live demo*, D-63), one stop per screen, for a presenter or a visitor on the live site. Shared accounts only; nothing here needs a laptop, SSO, email or a real owner. About five minutes.

**How to read the mark on each stop.** *Verified by e2e* names the spec and test that drive that screen against a production build on the demo seed (the same code the live site runs, not the live site itself); the whole suite was re-run for this closeout on 2026-11-20 UTC at `main` = `7968689`: 41 passed (`docs/RELEASE_NOTES.md`). *Verified live* means someone loaded it on the live site and recorded it. **No stop is verified live yet:** the closeout run could not read the site from the cloud (three GETs, `client_error`, at 02:06 and again at 14:14 UTC on 2026-11-20), so every stop also carries *not yet clicked through by the owner* until Shane walks it once and ticks the table at the end.

**Before you start.** The live database is shared and is not reset between visitors: lists include earlier visitors' requests and invoices, and if a visitor has edited the approval rules, stop 3's chain may differ. To change account, go back to `/demo` and pick another.

| # | Stop (screen) | Do | You should see | Mark |
|---|---|---|---|---|
| 0 | **The gate and the account list** (`/demo`) | Open the site; enter the shared password (any username; the owner gives it out). | A list of the seeded accounts, each a button. No email or password is typed. | Gate logic: unit test `tests/earmark/demo-gate.test.ts`. The password prompt itself exists only on the live site: **not yet clicked through by the owner**. |
| 1 | **The client's dashboard** (`/o/northwind`) | Pick `owner@northwind.demo.test`. | You land in Northwind, not on *Your orgs*: Planned, Committed, Actual, Available, then **Lines at risk** and **Unmatched invoices**. | Verified by e2e: `e2e/demo.spec.ts` "demo sign-in lands a seeded owner in their org", "step 1: the dashboard shows the four totals and the aged unmatched invoices", "design: the sidebar marks the current page and the dashboard leads with totals, then lines at risk". Not yet clicked through by the owner. |
| 2 | **A replanned line** (the line page) | Click **Q2 Paid Social**. | A **Replan** marker in the heading and `Planned edited to …` in *Line history*. | Verified by e2e: `e2e/demo.spec.ts` "step 2: Demand Gen → Q2 Paid Social shows its history with the replan marker". Not yet clicked through by the owner. |
| 3 | **A request and its frozen chain** (Requests, then the request page) | Pick `member@northwind.demo.test`. **Requests** → Budget line `Demand Gen / Paid Social / Q2 Paid Social`, Agency `Meridian Creative`, Amount `12,000.00`, a description → **Submit request**; press **Open it** in the *Request submitted* notice (D-64; or open it from the list); press **Approve**. | The **Approval chain** reads `Budget Owner`, then `Marketing Ops`. Approve is refused: *You cannot approve your own request.* | Verified by e2e: `e2e/demo.spec.ts` "steps 3–5: frozen chain, self-approval refused, rule edit applies only to the next request" (its `submit` helper follows the *Open it* link; the live walk-through skips that test's rule edit on purpose, D-63). Not yet clicked through by the owner. |
| 4 | **Two approvals, one PO** (Approvals, then the request page) | Pick `demandgen@northwind.demo.test` → **Approvals** → your request → **Approve**. Then `admin@northwind.demo.test` → **Approvals** → the request → **Approve**. | After the first: *Step 2 is waiting on Marketing Ops*. After the second: **Approved** and a **PO-…** link. Note the PO number. | Verified by e2e: `e2e/demo.spec.ts` "steps 3–5 …" (first approval) and "step 6: the last approval issues a PO, and commitment.issued reaches the demo receiver signed". Not yet clicked through by the owner. |
| 5 | **The agency's view** (*Your orgs*, then Purchase orders, then the PO page) | Pick `dana@meridian.demo.test`; choose **Northwind**. Open your PO; invoice number, Amount `1,250.00`, an invoice date and a later due date → **Submit invoice**. | **Purchase orders** only: her agency's POs, no budgets, no Requests. The invoice appears under *Invoices on this PO*. | Verified by e2e: `e2e/demo.spec.ts` "demo sign-in leaves an account with two orgs on Your orgs to pick one", "steps 7–8: a guest invoices her PO; the same id under another client is a 404". Not yet clicked through by the owner. |
| 6 | **The tenant wall** (the 404) | Still as Dana, on the PO page, change `/o/northwind/` to `/o/contoso/` in the address bar. | **Page not found**, the same page as an id that does not exist. | Verified by e2e: `e2e/demo.spec.ts` "steps 7–8 …"; `e2e/design.spec.ts` "axe: the guest pages and the 404 pass too". Not yet clicked through by the owner. |
| 7 | **Match and approve for payment** (Invoices, then the invoice page) | Pick `admin@northwind.demo.test` → **Invoices** → *To match* → Dana's invoice → **Match to PO-…** → **Approve for payment**. Then `finance@northwind.demo.test`, the same invoice under *To approve for payment* → **Approve for payment**. | Your PO ranked first under *Suggested POs*, reason `PO number and agency`. Admin is refused: *Only a Finance seat holder can approve an invoice for payment.* Finance gets Status `approved`. | Verified by e2e: `e2e/demo.spec.ts` "step 9: match to the ranked suggestion, approve for payment, variance view". Not yet clicked through by the owner. |
| 8 | **The audit trail** (Settings → Audit log) | Pick `owner@northwind.demo.test` → **Audit log**. | Every act above with its actor: `request.submitted`, `request.step.approved`, `commitment.issued`, `invoice.submitted`, `invoice.matched`, `invoice.approved_for_payment`. | Partly covered: `e2e/enterprise.spec.ts` "step 11: the audit viewer filters to today's actor and downloads the same rows as CSV" drives the audit page as a non-demo owner, not as the shared `/demo` owner, and `e2e/design.spec.ts` runs axe on it. The README records one manual run of this step in the test environment (2026-11-19). **Not yet clicked through by the owner.** |

**Owner's live click-through (fill in once).** You: walk stops 0 to 8 on the live site, on a laptop and once on a phone, and record it here.

| Date | Device | Stops walked | Result |
|---|---|---|---|
| | | | |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/demo` is a 404 | `DEMO_MODE=1` missing from `.env.local` | add it, rebuild and restart |
| Port 7600 busy | another server | `lsof -ti :7600 \| xargs -r kill` |
| Step 6 delivery `failed` / endpoint paused | `WEBHOOK_ALLOW_PRIVATE` not set, or the server was down at approval | set it, restart, `npm run seed:demo` (re-creates the endpoint) |
| Step 10 never refuses | `ANTHROPIC_API_KEY` set, or a sweep's drafts already used the month | unset it; `npm run seed:demo` resets the spend |
| Step 7: Dana sees nothing in Contoso | step 13 already ran | `npm run seed:demo` |
| Sign-in to Northwind/Contoso sends no link and no redirect | Require SSO is on and the email is staff, not on the SSO domain | use `/demo`, or the SSO domain email |
| Google/Okta says `redirect_uri_mismatch` | the test app has no `localhost:7600` redirect | add `http://localhost:7600/login/sso/callback` |
| Export, key creation or Offboard refused for `owner@…demo.test` | the demo guard, by design (D-33, D-36) | use the real owner |
| Dashboard empty | seed not run against this database | `npm run seed:demo` |
| Pages from an old build | stale `.next` | `rm -rf .next`, rebuild |

## Concede before you're asked

- **Synthetic everything, and not deployed.** Two invented clients and one invented agency on a laptop. No AP system is connected; "approved for payment" is a status, nothing is paid.
- **The live SSO is the template's test tenants**, a Google Workspace domain and an Okta Integrator Free org, not a customer IdP. The e2e runs step 1 through a mock IdP.
- **The real owner is promoted by hand** with `psql`. SSO never makes an owner (INV-38), and the shared demo accounts are blocked from keys, exports and removals on purpose.
- **The AI cap is demonstrated with a stub.** With a real key, Haiku drafts cost ~$0.0002 and the fourth is not refused; the guard is the same code either way (E-INV-08).
- **One currency per org, monthly periods, no fiscal-year close.** Rename and delete of plan rows and close/carry-forward were left out on purpose (D-26).
- **No separation of duties between matcher and payment approver** beyond the Finance seat (D-25).
- **Template patches.** The `guest` role and the guest SSO exemption are four patched lines in template-owned files, listed in `FOUNDATION_PATCHES.md` and proposed upstream for v1.7.0.

## Hand checks (PRD §7, Phase 4 gate)

| Date | IdP | Org | Who | Result |
|---|---|---|---|---|
| 2026-11-17 | Google Workspace | Northwind | Shane | Signed in; passed |
| 2026-11-17 | Okta | Contoso | Shane | Signed in; passed |
