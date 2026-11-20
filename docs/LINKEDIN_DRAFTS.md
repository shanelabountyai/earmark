# LinkedIn drafts: Earmark, live closeout (2026-11-19)

Two drafts from the second launch (the design pass and the live deployment). **Unposted, and not in the Lab Intelligence Ledger:** adding them there is an owner step (`NEXT.md`). Posts #168 (Impact, D-23: a closed PO un-spent its money) and #169 (Scale, D-32: Require SSO locked the agency guest out) are already in the Ledger; neither topic is reused here.

Rules these were written to: Earmark is a sample build on synthetic data, with no clients and no client results; the former employer is not named; the only budget line used from Shane's record is the approved wording, verbatim; no job-search language; no tenure count; every number comes from this repo and its file is named under the draft.

## Draft A: the column the design asked for

**Pillar:** AI Integration, riding on Impact (governance). **Anchor:** D-47 in `prd-earmark.md`.

> The design asked for one more column. The control said no.
>
> I governed a $100M+ marketing budget through a three-person governance model. The hard part was never the approvals. It was deciding who gets to see what.
>
> So I built a sample app to test that: Earmark, a marketing budget and agency-spend tool on synthetic data. No clients, no real money. One invented agency account manager works for two competing invented clients.
>
> This month it got a real design. Six screens were drawn up front, and eight more were designed before they were built. One of them, the agency's purchase-order list, had a column called "For" that showed the budget line behind each PO.
>
> It looked right. It was also the one thing an agency should never see: the client's budget behind the order.
>
> The AI agent doing the build left the column out and wrote down why: a design cannot widen what the guest is allowed to see. There is a test that fails if a budget field ever shows up in that view.
>
> That is the part I keep coming back to. A good mock-up is persuasive. Under a deadline, most teams ship the column and call it a UX win.
>
> The governance that survives is the kind written down as a rule something checks, not a preference someone remembers.
>
> Where has a design review quietly overruled a control on your team?
>
> #marketingoperations #governance #martech #aiinpractice

**Where each fact comes from**

| Claim | Source |
|---|---|
| "governed a $100M+ marketing budget through a three-person governance model" | The approved wording, used verbatim. Not from this repo. |
| Sample app, synthetic data, no clients | `README.md` ("Synthetic data only"); `WRITEUP.md` (the "Learning project" note) |
| One agency account manager, two clients | `prd-earmark.md` §5 (Dana, Northwind and Contoso) |
| Six screens drawn up front | `docs/design/HANDOFF.md`, *Artboards* table (six files) |
| Eight more designed before they were built | `docs/design/HANDOFF.md`, "Gap artboards added 2026-11-18" (eight files); `NEXT.md` design-pass entry |
| The "For" column, left out, and why | `prd-earmark.md` D-47 |
| The build was done by an AI agent that recorded the call | `prd-earmark.md`, heading above D-44 ("scheduled run … decided without Shane") |
| A test fails if a budget field shows up | `prd-earmark.md` §8, E-INV-04; `tests/earmark/invariants/e-inv.test.ts` |

## Draft B: the six steps that did not survive going live

**Pillar:** MarTech (shared environments), with a Scale lesson. **Anchor:** D-63 in `prd-earmark.md`.

> My demo script had 14 steps. The live one has 8. The six I cut were the best ones.
>
> Earmark is a sample build I use to test how marketing budget governance holds up in software: approval chains, purchase orders, invoice matching. Synthetic data, invented companies, no clients.
>
> On a laptop the 14-step walk-through works every time, because I reset the data before anyone watches.
>
> A live site has no reset between visitors. Everyone with the link shares one database.
>
> So the most impressive step had to go: changing an approval threshold and watching the next request route differently. On a shared site, that changes the rules for whoever clicks next. Same for the AI spending cap. The demo allows three drafts, so every visitor after that would only ever see the refusal.
>
> What stayed are eight steps that give the same result no matter who came before you.
>
> The lesson is bigger than a sample app. A feature that is safe for one user can be a hazard in a shared environment. The question is not "does it work." It is "what does it do to the next person."
>
> Before you put a pilot in front of other people: which step in your demo only works because you were alone?
>
> #marketingoperations #martech #productdemos #aiinpractice

**Where each fact comes from**

| Claim | Source |
|---|---|
| 14 steps | `prd-earmark.md` §9 ("Script (14 steps, ~10 minutes)") |
| 8 steps on the live site | `README.md`, *Try the live demo*; `prd-earmark.md` D-63 |
| The laptop demo re-seeds first | `docs/DEMO.md`, *Setup* ("Seed (idempotent; replants every Earmark row …)") |
| The live database is shared and not reset between visitors | `README.md`, "What was checked, and where" |
| The rules edit was left out, and why | `prd-earmark.md` D-63 |
| Three AI drafts, then the refusal | `prd-earmark.md` D-35 and D-63 |
| Sample build, synthetic data, no clients | `README.md`; `WRITEUP.md` |

Draft B makes no claim about Shane's career: an earlier version said "I ran shared platforms for large marketing teams", which no file in this repo supports, so it was taken out (D-67). If you want a career line, the only approved budget wording is the one in Draft A.

## Before posting

You: read each one out loud. If it sounds like you, it is ready; if not, change it. Add the ones you keep to the Ledger (https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i) as #170 and #171 or whatever the next free numbers are. Do not post two of the same pillar back to back.
