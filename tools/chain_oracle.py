#!/usr/bin/env python3
"""Approval-chain oracle (PRD §3 rules 1–6), the Python twin of src/lib/earmark/chain.ts.

Usage: python3 tools/chain_oracle.py < fixtures/chain/<case>.json   (or a file argument)

op "evaluate" (default): {rules, request, seats, now, decisions?} -> {"chain": ..., "outcome": ...}
op "edit": {role, before, after} -> the rule-edit authorization with its audit before/after.
"""

import json

from _common import MoneyError, json_cents, parse_instant, read_input, require_cents, to_cents, write_output

FINANCE_SEAT = "Finance"


# ---------- rules ----------


def parse_rules(raw):
    chains = {}
    problems = []

    def steps_of(items, where):
        if not isinstance(items, list) or not items:
            problems.append(f"{where}: must be a non-empty list of steps")
            return []
        out = []
        seen = set()
        last = -1
        for i, s in enumerate(items):
            seat = s.get("seat") if isinstance(s, dict) else None
            if not isinstance(seat, str) or not seat.strip():
                problems.append(f"{where}[{i}]: seat must be a non-empty string")
                continue
            try:
                frm = require_cents(s.get("fromCents"), f"{where}[{i}].fromCents", 0)
            except MoneyError as e:
                problems.append(e.message)
                continue
            if seat in seen:
                problems.append(f'{where}[{i}]: seat "{seat}" appears twice')
            if frm < last:
                problems.append(f"{where}[{i}]: fromCents {frm} is below the previous step's {last}; steps must be in ascending order")
            seen.add(seat)
            last = frm
            out.append({"seat": seat, "fromCents": frm})
        return out

    for name, items in raw.items():
        if name == "overrides":
            continue
        chains[name] = steps_of(items, name)
    if "default" not in chains:
        problems.append('rules must define a "default" chain')
    overrides = []
    raw_overrides = raw.get("overrides") or []
    if not isinstance(raw_overrides, list):
        problems.append("overrides: must be a list")
    else:
        for i, o in enumerate(raw_overrides):
            when = o.get("when") if isinstance(o, dict) else None
            if not isinstance(when, dict) or not when or any(not isinstance(v, str) for v in when.values()):
                problems.append(f"overrides[{i}].when: must be an object of string fields")
                continue
            overrides.append({"when": dict(when), "append": steps_of(o.get("append"), f"overrides[{i}].append")})
    if problems:
        raise ValueError("approval rules invalid: " + "; ".join(problems))
    return {"chains": chains, "overrides": overrides}


def rules_to_json(rules):
    out = {name: [{"seat": s["seat"], "fromCents": json_cents(s["fromCents"])} for s in steps] for name, steps in rules["chains"].items()}
    out["overrides"] = [{"when": dict(o["when"]), "append": [{"seat": s["seat"], "fromCents": json_cents(s["fromCents"])} for s in o["append"]]} for o in rules["overrides"]]
    return out


# ---------- evaluation ----------


def holder_active(h, now_ms):
    if h.get("activeFrom") and parse_instant(h["activeFrom"], "activeFrom") > now_ms:
        return False
    if h.get("activeTo") and parse_instant(h["activeTo"], "activeTo") <= now_ms:
        return False
    return True


def uniq(xs):
    out = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


def kind_of(request):
    kind = request.get("kind")
    return "default" if kind is None else str(kind)


def override_applies(o, request):
    fields = {"costCenter": request.get("costCenter"), "kind": kind_of(request)}
    return all(fields.get(k) == v for k, v in o["when"].items())


def evaluate_chain(rules, request, seats, now):
    def fail(code, message):
        return {"ok": False, "error": {"code": code, "message": message}}

    try:
        amount = require_cents(request.get("amountCents"), "amountCents", 1)
    except MoneyError as e:
        return fail(e.code, e.message)
    requester = request.get("requesterId") or ""
    if not requester:
        return fail("NO_REQUESTER", "request.requesterId is required")
    kind = kind_of(request)
    chain = rules["chains"].get(kind)
    if chain is None:
        return fail("UNKNOWN_CHAIN", f'no "{kind}" chain in the approval rules')
    if kind == "reallocation" and request.get("crossesFiscalYear") is True:
        return fail("REALLOCATION_ACROSS_FISCAL_YEARS", "a reallocation across fiscal years is refused (PRD §10.7)")
    try:
        now_ms = parse_instant(now, "now")
    except ValueError as e:
        return fail("BAD_NOW", str(e))

    available = request.get("availableCents")
    over_budget = request.get("overBudget") is True or (available is not None and amount > to_cents(available, "availableCents"))

    skipped = []

    def keep(steps, source):
        kept = []
        for s in steps:
            if amount >= s["fromCents"]:
                kept.append({"seat": s["seat"], "fromCents": s["fromCents"], "source": source})
            else:
                skipped.append({"seat": s["seat"], "fromCents": s["fromCents"], "source": source})
        return kept

    from_chain = keep(chain, "chain")
    from_overrides = []
    for o in rules["overrides"]:
        if override_applies(o, request):
            from_overrides.extend(keep(o["append"], "override"))

    candidates = list(from_chain)
    finance_already = any(c["seat"] == FINANCE_SEAT for c in from_chain + from_overrides)
    if over_budget and not finance_already:
        candidates.append({"seat": FINANCE_SEAT, "fromCents": None, "source": "over-budget"})
    candidates.extend(from_overrides)

    seat_by_name = {s["name"]: s for s in seats}
    resolved = []
    for c in candidates:
        holders = [h for h in (seat_by_name.get(c["seat"], {}).get("holders") or []) if holder_active(h, now_ms)]
        effective = []
        delegations = []
        for h in holders:
            to = h.get("delegateToId")
            to = to if to and to != h["userId"] else None
            if to:
                delegations.append({"from": h["userId"], "to": to})
            effective.append(to or h["userId"])
        all_ids = uniq(effective)
        eligible = [i for i in all_ids if i != requester]
        if all_ids and not eligible:
            return fail(
                "REQUESTER_ONLY_HOLDER",
                f"{requester} is the only active approver for the {c['seat']} seat and may not approve their own request; "
                "add another holder or a delegate, or have someone else submit it.",
            )
        resolved.append(
            {
                **c,
                "eligible": eligible,
                "delegations": [d for d in delegations if d["to"] in eligible],
                "blocked": None if holders else "no-active-holder",
            }
        )

    steps = []
    collapsed = []
    placed_at = {}
    for r in resolved:
        is_over_budget_step = over_budget and r["seat"] == FINANCE_SEAT
        fresh = [i for i in r["eligible"] if i not in placed_at]
        if r["eligible"] and not fresh:
            into = min(placed_at[i] for i in r["eligible"])
            collapsed.append({"seat": r["seat"], "fromCents": r["fromCents"], "source": r["source"], "into": into, "approverIds": r["eligible"]})
            if is_over_budget_step:
                steps[into]["overBudget"] = True
                steps[into]["requiresNote"] = True
            continue
        index = len(steps)
        for i in fresh:
            placed_at[i] = index
        steps.append(
            {
                "index": index,
                "seat": r["seat"],
                "fromCents": r["fromCents"],
                "source": r["source"],
                "approverIds": fresh,
                "delegations": [d for d in r["delegations"] if d["to"] in fresh],
                "blocked": r["blocked"],
                "overBudget": is_over_budget_step,
                "requiresNote": is_over_budget_step,
            }
        )

    return {
        "ok": True,
        "kind": kind,
        "amountCents": json_cents(amount),
        "overBudget": over_budget,
        "resubmits": request.get("resubmitsRequestId"),
        "steps": [{**s, "fromCents": None if s["fromCents"] is None else json_cents(s["fromCents"])} for s in steps],
        "skipped": [{**s, "fromCents": json_cents(s["fromCents"])} for s in skipped],
        "collapsed": [{**s, "fromCents": None if s["fromCents"] is None else json_cents(s["fromCents"])} for s in collapsed],
    }


# ---------- rule 5: decisions ----------


def apply_decisions(chain, decisions, requester):
    steps = chain["steps"]
    out = {"state": "pending", "currentStep": 0 if steps else None, "rejectedAt": None, "decided": [], "results": []}
    if not steps:
        out["state"] = "approved"
    for d in decisions:
        def refuse(reason):
            out["results"].append({"accepted": False, "reason": reason})

        if out["state"] != "pending":
            refuse("CHAIN_ENDED")
            continue
        idx = d.get("step")
        step = steps[idx] if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < len(steps) else None
        if step is None:
            refuse("NO_SUCH_STEP")
            continue
        if idx != out["currentStep"]:
            refuse("OUT_OF_ORDER")
            continue
        if step["blocked"]:
            refuse("STEP_BLOCKED")
            continue
        by = d.get("byId")
        if by == requester:
            refuse("SELF_APPROVAL")
            continue
        if by not in step["approverIds"]:
            refuse("NOT_AN_APPROVER")
            continue
        decision = d.get("decision")
        if decision not in ("approve", "reject"):
            refuse("BAD_DECISION")
            continue
        note = d.get("note")
        if step["requiresNote"] and not (note or "").strip():
            refuse("NOTE_REQUIRED")
            continue
        out["results"].append({"accepted": True, "reason": None})
        out["decided"].append({"step": idx, "byId": by, "decision": decision, "note": note if note is not None else None})
        if decision == "reject":
            out["state"] = "rejected"
            out["rejectedAt"] = idx
            out["currentStep"] = None
        elif idx + 1 >= len(steps):
            out["state"] = "approved"
            out["currentStep"] = None
        else:
            out["currentStep"] = idx + 1
    return out


# ---------- rule 6: rule edits ----------

RANK = {"owner": 2, "admin": 1}


def authorize_rule_edit(role, before, after):
    changes = []
    names = uniq(list(before["chains"].keys()) + list(after["chains"].keys()))
    for name in names:
        b = before["chains"].get(name)
        a = after["chains"].get(name)
        if b is None:
            changes.append({"chain": name, "kind": "chain-added", "seat": None, "before": None, "after": None, "requires": "owner"})
            continue
        if a is None:
            changes.append({"chain": name, "kind": "chain-removed", "seat": None, "before": None, "after": None, "requires": "owner"})
            continue
        b_seats = [s["seat"] for s in b]
        a_seats = [s["seat"] for s in a]
        for s in b:
            if s["seat"] not in a_seats:
                changes.append({"chain": name, "kind": "seat-removed", "seat": s["seat"], "before": json_cents(s["fromCents"]), "after": None, "requires": "owner"})
        for s in a:
            if s["seat"] not in b_seats:
                changes.append({"chain": name, "kind": "seat-added", "seat": s["seat"], "before": None, "after": json_cents(s["fromCents"]), "requires": "owner"})
        common = [s for s in b_seats if s in a_seats]
        a_order = [s for s in a_seats if s in common]
        if common != a_order:
            changes.append({"chain": name, "kind": "seat-reordered", "seat": None, "before": None, "after": None, "requires": "owner"})
        top = a[-1]["seat"]
        for seat in common:
            bc = next(s["fromCents"] for s in b if s["seat"] == seat)
            ac = next(s["fromCents"] for s in a if s["seat"] == seat)
            if bc != ac:
                changes.append({"chain": name, "kind": "threshold", "seat": seat, "before": json_cents(bc), "after": json_cents(ac), "requires": "owner" if seat == top else "admin"})
    if json.dumps(rules_to_json(before)["overrides"], sort_keys=True) != json.dumps(rules_to_json(after)["overrides"], sort_keys=True):
        changes.append({"chain": "overrides", "kind": "overrides", "seat": None, "before": None, "after": None, "requires": "owner"})
    if any(c["requires"] == "owner" for c in changes):
        required = "owner"
    elif changes:
        required = "admin"
    else:
        required = "none"
    have = RANK.get(role, 0)
    ok = required == "none" or have >= RANK[required]
    refused = None
    if not ok:
        what = ", ".join(f"{c['kind']}{' ' + c['seat'] if c['seat'] else ''} in {c['chain']}" for c in changes if c["requires"] == required)
        refused = f"{role} may not make this edit: it needs {required} ({what})"
    return {"ok": ok, "required": required, "role": role, "changes": changes, "refused": refused, "audit": {"before": rules_to_json(before), "after": rules_to_json(after)}}


# ---------- main ----------


def run(case):
    if case.get("op") == "edit":
        try:
            before = parse_rules(case["before"])
            after = parse_rules(case["after"])
        except ValueError as e:
            return {"ok": False, "error": {"code": "RULES_INVALID", "message": str(e)}}
        return authorize_rule_edit(str(case.get("role")), before, after)
    try:
        rules = parse_rules(case["rules"])
    except ValueError as e:
        return {"chain": {"ok": False, "error": {"code": "RULES_INVALID", "message": str(e)}}, "outcome": None}
    request = case.get("request") or {}
    try:
        chain = evaluate_chain(rules, request, case.get("seats") or [], case.get("now") or "")
    except (MoneyError, ValueError) as e:
        chain = {"ok": False, "error": {"code": "BAD_INPUT", "message": str(e)}}
    outcome = None
    if chain["ok"] and isinstance(case.get("decisions"), list):
        outcome = apply_decisions(chain, case["decisions"], request.get("requesterId") or "")
    return {"chain": chain, "outcome": outcome}


if __name__ == "__main__":
    write_output(run(read_input()))
