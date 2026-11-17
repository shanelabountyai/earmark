#!/usr/bin/env python3
"""Build audit/scorecard.json from the baseline audit/<repo>.md tables + OVERRIDES + the foundation row.
Re-run at each template release / after SEC fixes: edit OVERRIDES, run, then publish scorecard.html (see plan M9)."""
import re, json, glob, datetime
KEYS = [f"K{i}" for i in range(1, 15)]
NAMES = {"K1":"Sessions","K2":"MFA","K3":"Guard","K4":"Scoping","K5":"Rate limit","K6":"Cap. links","K7":"Headers",
         "K8":"Secrets","K9":"Webhooks","K10":"Log safety","K11":"Env schema","K12":"Test DB","K13":"Audit trail","K14":"Deploy"}
REPOS = {  # file stem -> display
 "alongside-handhold":"alongside / handholdcare","bookable":"Bookable","claude-dashboard":"claude-dashboard","clinic":"Clearpath (clinic)",
 "countertop":"Countertop","design-bridge":"design bridge (dead)","event-toolkit":"event toolkit","groundwork":"groundwork",
 "rental-business":"rental business","restaurant-reservations":"restaurant reservations","showcall":"showcall",
 "storage-business":"storage business","talk4me":"talk4me","use-case-studio":"Use-Case Studio","use-case-trio":"use-case trio (scaffolds)"}
# (status, text, evidence) — cells re-verified against code on 2026-09-25 after fixes landed. Everything else is the 2026-09-23 baseline.
OVERRIDES = {
 "clinic": {
  "K7": ("✔", "Global headers: frame-ancestors 'none', nosniff, Referrer-Policy, poweredByHeader off (SEC-05, fixed); HSTS from Vercel.", "clinic/next.config.ts:7-21; 17d5496"),
  "K12": ("✔", "Guard is now a loopback allowlist; cloud needs CLEARPATH_ALLOW_CLOUD_DB (SEC-06, fixed).", "clinic/src/db.ts:14; b72b1f3"),
  "K3": ("✔", "Every action and route calls requireSession() and the permission matrix; the demo gate (SEC-01, fixed) now fronts everything except /api/cron and /enquire. Identity itself is self-chosen, which is scored under K1.", "clinic/NEXT.md:89; app/(staff)/*/actions.ts"),
  "K6": ("✗", "Tokens stored plaintext: SEC-04 closed as an accepted risk; Referrer-Policy is same-origin, not no-referrer.", "clinic/next.config.ts:21; 39189e3"),
  "K1": ("✗", "Still no real auth: a shared Basic-auth demo gate (SEC-01, fixed) fronts a self-chosen identity picker; cookie unsigned by decision (SEC-03).", "clinic/NEXT.md:89"),
  "K11": ("✔", "Zod schema over every var the running app reads, fails at boot with the var name on missing/malformed input; OPS-04 was already satisfied (.env.example lists DEMO_ACCESS_PASSWORD, CLEARPATH_SESSION_SECRET and the nonresponse cron).", "clinic/src/env.ts; a2e07eb"),
 },
 "event-toolkit": {
  "K7": ("✔", "Global XFO DENY, CSP frame-ancestors, nosniff, referrer, HSTS (SEC-04, fixed; verified live).", "event-planner-app/apps/web/next.config.ts; c7cf9f2"),
  "K1": ("✗", "Tokens now stored as SHA-256 (SEC-02, fixed); the magic link is still spent on GET (SEC-05, open); no MFA.", "packages/server-db/src/tokens.ts; 192eec4"),
  "K5": ("✗", "Sign-in limited per email and IP (SEC-03, fixed); the share-link issue write and token reads are still unlimited (SEC-06, open).", "apps/web/app/(auth)/sign-in/actions.ts; f5edb2d"),
  "K6": ("✗", "Tokens hashed now (SEC-02); Referrer-Policy is strict-origin-when-cross-origin, not no-referrer, and no no-store.", "apps/web/next.config.ts; 192eec4"),
 },
}
# 2026-09-26: Opus exhaustive K4 sweeps of the rows the Sonnet re-score only spot-checked, plus the rental re-check
# after 681fbb4. Findings: audit/K4-SWEEP-2026-09-26.md. Fourth element is the basis.
K4S = "Opus K4 sweep 2026-09-26"
OVERRIDES.setdefault("clinic", {})["K4"] = ("✔", "Swept 77 entry points; K4-C1 (HIGH: book another caseload's client, then sign their note) fixed as SEC-07 — notes decide on the client, booking is caseload-scoped; appointment by-id, group roster and worklists scoped (SEC-08–10, MED), series inside guarded() (SEC-11). Two LOWs open: forms issue/read for any client, and a not-found vs forbidden oracle.", "clinic 8c060a5; src/notes/service.ts; src/auth/permissions.ts:377; src/scheduling/caseload.test.ts", K4S + ", fixed 8c060a5, CI green 62d7f1c")
OVERRIDES["alongside-handhold"] = {"K4": ("✔", "Swept 93 by-id consumer routes in 16 modules plus the admin surface: every read and write resolves membership from the row's own lovedOneId and answers 404 for not-yours; secondary ids are checked. Five LOW items (403/400-vs-404 oracles, packet route ignores its path lovedOneId, ban/mute not tied to the report).", "backend/src/permissions/service.ts:19-31; backend/src/family/service.ts:460-466; backend/src/vault/service.ts:539-557", K4S)}
OVERRIDES["restaurant-reservations"] = {"K4": ("N/A", "Swept 10 guest entry points: single restaurant, no tenant id in the schema, every /m write resolves from the manage token. Two LOW items: an idempotency-key replay returns another guest's booking without an owner check, and manage tokens never expire.", "apps/web/app/book/actions.ts:43; packages/db/placement.ts:103-107; packages/db/guest.ts:122-128", K4S)}
OVERRIDES["rental-business"] = {
 "K4": ("✔", "Swept 324 entry points; K4-R1/R2/R3 (HIGH) fixed as SEC-09–11 — applicants scoped to the lease's property, updateUnit scoped by {id, propertyId}, and currentScope has no default so every page passes its guarding permission (source test over all callers); MED secondary ids fixed (SEC-12–15). Open: SEC-16 unrouted inbox (who triages mail from an unknown sender is a design question) and the LOWs.", "rental 6d75d45; lib/scope/current-scope.ts; lib/scope/current-scope-callers.test.ts; lib/auth/cross-property-ids.test.ts", K4S + ", fixed 6d75d45"),
 "K1": ("✗", "Magic link now redeemed by POST, single-use, expiring (681fbb4); but tenant and guarantor sign-out is a bare signOut() that never bumps sessionsValidFrom, so a copied JWT lives out its 12h.", "apps/web/lib/portal/actions.ts:12-20; apps/web/lib/auth/actions.ts:222-248", "re-checked 2026-09-26"),
 "K6": ("✗", "Tokens hashed with TTLs; but Referrer-Policy is same-origin (deliberate, for no-JS Origin checks) and the token pages send no Cache-Control: no-store.", "apps/web/next.config.ts:40; app/pay/[token]/page.tsx", "re-checked 2026-09-26"),
 "K7": ("✔", "Global nosniff, XFO DENY, HSTS, Referrer-Policy; frame-ancestors 'none' in the CSP; pinned by next-config.test.ts.", "apps/web/next.config.ts:33-45; apps/web/proxy.ts:107-110", "re-checked 2026-09-26"),
 "K11": ("✗", "assertEnv() runs at boot and names the var, but covers 6 variables; ~18 more the app reads (CRON_SECRET, Stripe, Twilio, webhook secrets) are unchecked.", "apps/web/lib/env.ts:29-36; apps/web/instrumentation.ts", "re-checked 2026-09-26"),
 "K12": ("✔", "Vitest global setup refuses any DATABASE_URL host but localhost/127.0.0.1; e2e defaults to build + start.", "packages/db/test-database-guard.ts:15-28; playwright.config.ts:197", "re-checked 2026-09-26"),
}
FOUNDATION = {
 "K1": ("INV-05,07,17", "src/core/auth/session.ts; src/core/auth/link.ts; tests/invariants/inv-05-sign-out-everywhere.test.ts"),
 "K2": ("INV-24,25,26", "src/core/auth/totp.ts; tests/invariants/inv-24-totp-replay.test.ts"),
 "K3": ("INV-01", "src/core/authz/action.ts; tests/invariants/inv-01-04-22-actions.test.ts"),
 "K4": ("INV-02,03,04", "src/core/authz/guards.ts; tests/invariants/harness.ts"),
 "K5": ("INV-09", "src/core/rate-limit.ts; tests/invariants/inv-09-rate-limits.test.ts"),
 "K6": ("INV-07,08", "src/core/share/links.ts; tests/invariants/inv-08-share-links.test.ts"),
 "K7": ("INV-15", "next.config.ts:8-16; e2e header specs"),
 "K8": ("INV-10,11,16,20", "src/core/cron.ts; tests/invariants/inv-10-11-16-cron-secrets.test.ts"),
 "K9": ("INV-12", "src/modules/billing/webhook.ts; tests/invariants/inv-12-webhooks.test.ts"),
 "K10": ("INV-13", "src/core/email; tests/invariants/inv-13-email.test.ts"),
 "K11": ("INV-14", "src/core/env.ts; tests/invariants/inv-14-env.test.ts"),
 "K12": ("INV-18", "src/core/db/local-guard.ts; tests/invariants/inv-18-cloud-guard.test.ts"),
 "K13": ("INV-19", "src/core/audit.ts; tests/invariants/inv-19-audit-append-only.test.ts"),
 "K14": ("CLAUDE.md", "vercel.json (ignoreCommand); package.json (port 4100); src/core/cron.ts"),
}
# Retired rows stay listed but are not scored (owner decision 2026-11-09).
RETIRED = {"design-bridge": "retired, not scored (project is dead)"}
# Accepted state: put ("≈", "<reason>, D-xxx", evidence) in OVERRIDES. Only with a decision-log row in the project first.
def split(s):
    m = re.match(r"\s*(✔|✗|N/A|\?)\s*[—:\-]?\s*(.*)", s, re.S)
    return (m.group(1), m.group(2).strip()) if m else ("?", s.strip())
def cell(status, text, ev, basis):
    return {"s": status, "text": text, "evidence": ev, "secs": sorted(set(re.findall(r"SEC-\d+", text + " " + ev)), key=lambda x:int(x[4:])), "basis": basis}
import os
RESC = {st: json.load(open(f"rescore/{st}.json")) for st in REPOS if os.path.exists(f"rescore/{st}.json")}
out = {"asOf": "2026-11-13", "foundationVersion": open("../FOUNDATION_VERSION").read().strip(), "keys": NAMES, "rows": []}
f = {k: cell("✔", v[0] + " tests green (npm test, 286 pass + 21 skipped, 2026-11-09)", v[1], "verified") for k, v in FOUNDATION.items()}
out["rows"].append({"id": "foundation", "name": "saas foundation (template)", "cells": f})
for stem, name in REPOS.items():
    raw = {}
    for l in open(f"{stem}.md"):
        m = re.match(r"\|\s*(K\d+)\b[^|]*\|(.*)$", l)
        if m:
            c = [x.strip() for x in l.strip().strip("|").split("|")]
            raw[m.group(1)] = c[1:]
    cells = {}
    for k in KEYS:
        # 2026-11-10 re-score wins over older OVERRIDES, except the Opus K4 sweeps (more thorough than the Sonnet pass)
        if k in OVERRIDES.get(stem, {}) and (k == "K4" or k not in RESC.get(stem, {})):
            s, t, e, *b = OVERRIDES[stem][k]; cells[k] = cell(s, t, e, b[0] if b else "verified 2026-09-25")
        elif k in RESC.get(stem, {}):
            c = RESC[stem][k]; cells[k] = cell(c["s"], c["text"], c.get("evidence", ""), "rescored 2026-11-10 (agent sweep)")
        elif k in raw:
            s, t = split(raw[k][0]); cells[k] = cell(s, t, raw[k][1] if len(raw[k]) > 1 else "", "baseline 2026-09-23")
        else:
            cells[k] = cell("N/A", "not scored in the baseline (no such surface)", "", "baseline 2026-09-23")
    row = {"id": stem, "name": name, "cells": cells}
    if stem in RETIRED: row["retired"] = RETIRED[stem]
    out["rows"].append(row)
# Clone rows (F-15, 2026-11-13): clone-owned code only, one Sonnet sweep per clone against origin/main at v1.6.x.
CLONES = ["adjuster","bracketry","callboard","commons","coursework","earmark","footnote","gavel","housefile","ledgerleave","loanbook","pulseboard","quorum","tradepost"]
for c in CLONES:
    d = json.load(open(f"rescore/clones/{c}.json"))
    out["rows"].append({"id": "clone-"+c, "name": c+" (clone)", "cells": {k: cell(v["s"], v["text"], v.get("evidence",""), "clone sweep 2026-11-13 (agent, origin/main)") for k, v in d.items()}})
out["rows"].append({"id": "clone-boxloop", "name": "boxloop (clone)", "cells": {}, "retired": "paused, not scored (on hold since 2026-10-19, still on v1.2.1)"})
json.dump(out, open("scorecard.json", "w"), indent=1, ensure_ascii=False)
tot = {}
for r in out["rows"]:
    c = [x["s"] for x in r["cells"].values()]
    if r.get("retired"): print(f'{r["name"]:34}', r["retired"]); continue
    print(f'{r["name"]:34}', "✔%d ✗%d N/A%d ?%d" % tuple(c.count(x) for x in ("✔","✗","N/A","?")) + (" ≈%d" % c.count("≈")))
