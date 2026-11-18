# Design handoff

Source of truth for the UI built on branch `design/impl`. Exported 2026-11-18 from the Claude Design canvas so cloud runs don't depend on artifact access.

- Canvas: https://claude.ai/artifact/Mg1iqfuNLVesgVUYxk8d9E
- Brief: https://claude.ai/artifact/8CE4yYenfEN6ezfUETN2by

## Artboards (`docs/design/*.dc.html`)

Each file is a self-contained Design Component: HTML with inline styles, `{{holes}}` filled by the `renderVals()` script at the bottom. Read the markup and the script together; the script holds the sample data.

| File | Screen | Frame |
| --- | --- | --- |
| `Main.dc.html` | Dashboard — Northwind (desktop) | 1280×1240 |
| `Request.dc.html` | Request + frozen chain (desktop, clickable) | 1280×1240 |
| `Line.dc.html` | Budget line — Q2 Paid Social (desktop) | 1280×1240 |
| `Guest.dc.html` | Agency guest — Dana at Meridian (desktop) | 1280×1000 |
| `Invoice.dc.html` | Invoice match (desktop) | 1280×1000 |
| `Rules.dc.html` | Settings — approval rules (desktop) | 1280×1000 |

## Owner calls (binding)

- Earmark gets its OWN look, not the shared clone tokens: D-42 palette (paper #f7f6f2, ink #1c1b18, green #1f5f4a), deep-green sidebar #173f33, 3–4 px corners, flat ruled cards (no shadows), money in monospace, sans-serif only, a dog-eared corner on what is earmarked (Available total, published notes, logo). Outcomes stay word → glyph → colour. (Shane, 2026-11-18)
- Dashboard leads with org totals, then lines at risk. (Shane, 2026-11-18)
- Agency guests get a client switcher in the sidebar; switching never reveals anything about the other client (cross-client PO id stays a byte-identical 404). (Shane, 2026-11-18)
- Approval rules stay a JSON textarea (D-24) with a read-only chain view beside it. (Shane, 2026-11-18)

## Gaps: screens the PRD needs that no artboard covers

- Plan (fiscal year, programs → campaigns → lines)
- Variance view (per period, notes)
- Approvals inbox (steps waiting on my seats, incl. delegated)
- Requests list + new-request form
- Commitments list (staff view)
- Invoices list (To match / matched / approved)
- Settings: seats + delegation, agencies + offboarding (rules is designed)

Design each gap as a new `docs/design/<Name>.dc.html` in the same look before building it.

**Gap artboards added 2026-11-18 (design pass, scheduled run):** `Plan.dc.html`, `Variance.dc.html`, `Approvals.dc.html`, `Requests.dc.html`, `Commitments.dc.html` (staff POs), `Invoices.dc.html`, `Seats.dc.html`, `Agencies.dc.html`, all in `canvas.json`. They also fix the staff sidebar's shape: the seven main items, then a *Settings* group (Rules, Seats, Agencies, Members, Audit log, Security, …) filtered by permission, and the signed-in user at the foot. Not yet on the Claude Design canvas; add them there if wanted.

## Placeholders

[Bracketed] values (committed, actual, available, PO numbers, dates) are placeholders; compute from real rows, never hard-code.
