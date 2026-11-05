#!/usr/bin/env python3
"""Invoice-to-commitment match oracle (PRD §4), the Python twin of src/lib/earmark/match.ts.

Usage: python3 tools/match_oracle.py < fixtures/match/<case>.json

Input: {invoice?, commitments, apply?}. Output: {"ok": true, "suggestions": ranked list with reasons (or null),
"applied": the result of the apply sequence (or null)}.
"""

import re

from _common import MoneyError, json_cents, read_input, require_cents, within_percent, write_output

TOLERANCE_PERCENT = 2
FINANCE_SEAT = "Finance"


def normalize_po(po):
    return re.sub(r"\s+", " ", (po or "").strip().upper())


def suggest(invoice, commitments):
    amount = require_cents(invoice.get("amountCents"), f"invoice {invoice['id']} amountCents", 0)
    po = normalize_po(invoice.get("poNumber"))
    rows = []
    excluded = []
    for c in commitments:
        remaining = require_cents(c.get("remainingCents"), f"commitment {c['id']} remainingCents")
        po_hit = po != "" and normalize_po(c.get("poNumber")) == po
        agency_hit = c.get("agencyId") == invoice.get("agencyId")
        if c.get("state") != "open":
            if po_hit:
                excluded.append({"commitmentId": c["id"], "reason": "po-closed"})
            continue
        reasons = []
        if po_hit and agency_hit:
            tier = 1
            reasons += ["po-number", "agency"]
        elif po_hit:
            tier = 2
            reasons += ["po-number", "agency-mismatch"]
        elif agency_hit and remaining >= 0 and within_percent(amount, remaining, TOLERANCE_PERCENT):
            tier = 3
            reasons += ["agency", "amount-within-2pct"]
        elif agency_hit:
            tier = 4
            reasons += ["agency"]
        else:
            continue
        difference = amount - remaining
        if difference == 0:
            reasons.append("exact-remaining")
        would_overage = difference > 0
        if would_overage:
            reasons.append("would-overage")
        rows.append({"commitmentId": c["id"], "tier": tier, "reasons": reasons, "remainingCents": remaining, "differenceCents": difference, "wouldOverage": would_overage})
    rows.sort(key=lambda r: (r["tier"], abs(r["differenceCents"]), -r["remainingCents"], r["commitmentId"]))
    excluded.sort(key=lambda e: e["commitmentId"])
    return {
        "invoiceId": invoice["id"],
        "suggestions": [{"rank": i + 1, **r, "remainingCents": json_cents(r["remainingCents"]), "differenceCents": json_cents(r["differenceCents"])} for i, r in enumerate(rows)],
        "excluded": excluded,
    }


def apply_match(commitment, decision):
    before = require_cents(commitment["remainingCents"], f"commitment {commitment['id']} remainingCents")

    def refuse(code, message, amount):
        return {"ok": False, "commitmentId": commitment["id"], "amountCents": json_cents(amount), "code": code, "message": message, "remainingBefore": json_cents(before)}

    try:
        amount = require_cents(decision.get("amountCents"), "match amountCents", 1)
    except MoneyError as e:
        return refuse("BAD_AMOUNT", e.message, 0)
    if commitment["state"] != "open":
        return refuse("COMMITMENT_CLOSED", f"commitment {commitment['id']} is closed; reopen it or match another", amount)
    after = before - amount
    overage = after < 0
    if overage:
        if FINANCE_SEAT not in (decision.get("matcherSeats") or []):
            return refuse("OVERAGE_NEEDS_FINANCE", f"matching {amount} would take commitment {commitment['id']} to {after}; only a Finance seat holder may record an overage", amount)
        if not (decision.get("note") or "").strip():
            return refuse("OVERAGE_NEEDS_NOTE", f"an overage on commitment {commitment['id']} needs a note", amount)
    return {
        "ok": True,
        "commitmentId": commitment["id"],
        "amountCents": json_cents(amount),
        "remainingBefore": json_cents(before),
        "remainingAfter": json_cents(after),
        "variance": "exact" if after == 0 else ("under" if after > 0 else "over"),
        "overage": overage,
        "overageCents": json_cents(-after) if overage else 0,
        "closes": after <= 0,
    }


def apply_matches(commitments, decisions):
    state = {c["id"]: {"id": c["id"], "remainingCents": require_cents(c.get("remainingCents"), f"commitment {c['id']} remainingCents"), "state": c["state"]} for c in commitments}
    results = []
    flagged = False
    for d in decisions:
        c = state.get(d["commitmentId"])
        if c is None:
            results.append({"ok": False, "commitmentId": d["commitmentId"], "amountCents": json_cents(require_cents(d.get("amountCents"), "match amountCents")), "code": "UNKNOWN_COMMITMENT", "message": f"no commitment {d['commitmentId']}", "remainingBefore": 0})
            continue
        r = apply_match(c, d)
        results.append(r)
        if r["ok"]:
            c["remainingCents"] = r["remainingAfter"]
            if r["closes"]:
                c["state"] = "closed"
            if r["overage"]:
                flagged = True
    remaining = {c["id"]: json_cents(c["remainingCents"]) for c in sorted(state.values(), key=lambda c: c["id"])}
    return {"results": results, "remaining": remaining, "overageFlagged": flagged}


def run(case):
    try:
        commitments = case.get("commitments") or []
        suggestions = suggest(case["invoice"], commitments) if case.get("invoice") else None
        applied = apply_matches(commitments, case["apply"]) if isinstance(case.get("apply"), list) else None
        return {"ok": True, "suggestions": suggestions, "applied": applied}
    except MoneyError as e:
        return {"ok": False, "error": {"code": e.code, "message": e.message}}
    except (KeyError, TypeError, ValueError) as e:
        return {"ok": False, "error": {"code": "BAD_INPUT", "message": str(e)}}


if __name__ == "__main__":
    write_output(run(read_input()))
