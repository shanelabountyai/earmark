#!/usr/bin/env python3
"""Variance oracle (PRD §4), the Python twin of src/lib/earmark/variance.ts.

Usage: python3 tools/variance_oracle.py < fixtures/variance/<case>.json

Input: {periodId, lines: [{lineId, plannedCents, actualCents, plannedEditedAt?, firstCommittedAt?}]}.
Output: {"ok": true, "variance": {periodId, rows, totals}}.
"""

from _common import MoneyError, json_cents, parse_instant, ratio_bps, read_input, require_cents, write_output


def is_replan(line):
    first = line.get("firstCommittedAt")
    edits = line.get("plannedEditedAt") or []
    if not first or not edits:
        return False
    first_ms = parse_instant(first, "firstCommittedAt")
    return any(parse_instant(t, "plannedEditedAt") > first_ms for t in edits)


def variance(case):
    seen = set()
    rows = []
    for l in case.get("lines") or []:
        if l["lineId"] in seen:
            raise ValueError(f"line {l['lineId']} appears twice")
        seen.add(l["lineId"])
        planned = require_cents(l.get("plannedCents"), f"line {l['lineId']} plannedCents", 0)
        actual = require_cents(l.get("actualCents"), f"line {l['lineId']} actualCents", 0)
        var = actual - planned
        unplanned = planned == 0 and actual != 0
        status = "unplanned" if unplanned else ("over" if var > 0 else ("under" if var < 0 else "on-plan"))
        rows.append(
            {
                "lineId": l["lineId"],
                "plannedCents": json_cents(planned),
                "actualCents": json_cents(actual),
                "varianceCents": json_cents(var),
                "varianceBps": ratio_bps(var, planned),
                "status": status,
                "unplanned": unplanned,
                "replan": is_replan(l),
            }
        )
    rows.sort(key=lambda r: r["lineId"])
    planned = sum(r["plannedCents"] for r in rows)
    actual = sum(r["actualCents"] for r in rows)
    var = actual - planned
    return {
        "periodId": case["periodId"],
        "rows": rows,
        "totals": {
            "plannedCents": json_cents(planned),
            "actualCents": json_cents(actual),
            "varianceCents": json_cents(var),
            "varianceBps": ratio_bps(var, planned),
            "lines": len(rows),
            "unplannedLines": sum(1 for r in rows if r["unplanned"]),
            "replannedLines": sum(1 for r in rows if r["replan"]),
            "overLines": sum(1 for r in rows if r["status"] == "over"),
            "underLines": sum(1 for r in rows if r["status"] == "under"),
        },
    }


def run(case):
    try:
        return {"ok": True, "variance": variance(case)}
    except MoneyError as e:
        return {"ok": False, "error": {"code": e.code, "message": e.message}}
    except (KeyError, TypeError, ValueError) as e:
        return {"ok": False, "error": {"code": "BAD_INPUT", "message": str(e)}}


if __name__ == "__main__":
    write_output(run(read_input()))
