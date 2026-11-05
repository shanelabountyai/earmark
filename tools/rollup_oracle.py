#!/usr/bin/env python3
"""Budget rollup oracle (PRD §2 derived values, §4 money rules), the Python twin of src/lib/earmark/rollup.ts.

Usage: python3 tools/rollup_oracle.py < fixtures/rollup/<case>.json

Input: a ledger {programs, campaigns, lines, commitments, matches, invoices, periodId?, now?}.
Output: {"ok": true, "rollup": {lines, campaigns, programs, org, unassignedUnmatchedCents, orgAvailableCents,
unmatchedInvoices}} or {"ok": false, "error": {code, message}}.
"""

from _common import LedgerError, MoneyError, age_days, json_cents, ratio_bps, read_input, require_cents, write_output


def by_id(items, key, what):
    m = {}
    for x in items:
        i = str(x[key])
        if i in m:
            raise LedgerError("DUPLICATE_ID", f"{what} {i} appears twice")
        m[i] = x
    return m


def zero():
    return {"plannedCents": 0, "committedCents": 0, "actualCents": 0, "unmatchedProvisionCents": 0, "availableCents": 0}


KEYS = ["plannedCents", "committedCents", "actualCents", "unmatchedProvisionCents", "availableCents"]


def add_totals(t, u):
    for k in KEYS:
        t[k] += u[k]


def rollup(ledger):
    programs = by_id(ledger.get("programs") or [], "id", "program")
    campaigns = by_id(ledger.get("campaigns") or [], "id", "campaign")
    for c in ledger.get("campaigns") or []:
        if c["programId"] not in programs:
            raise LedgerError("UNKNOWN_PROGRAM", f"campaign {c['id']} names unknown program {c['programId']}")
    all_lines = by_id(ledger.get("lines") or [], "id", "line")
    for l in ledger.get("lines") or []:
        if l["campaignId"] not in campaigns:
            raise LedgerError("UNKNOWN_CAMPAIGN", f"line {l['id']} names unknown campaign {l['campaignId']}")
    period = ledger.get("periodId")
    lines = [l for l in ledger.get("lines") or [] if period is None or l["periodId"] == period]
    in_scope = {l["id"] for l in lines}

    commitments = by_id(ledger.get("commitments") or [], "id", "commitment")
    committed = {}
    for c in ledger.get("commitments") or []:
        if c["lineId"] not in all_lines:
            raise LedgerError("UNKNOWN_LINE", f"commitment {c['id']} names unknown line {c['lineId']}")
        amount = require_cents(c.get("amountCents"), f"commitment {c['id']} amountCents", 0)
        if c.get("requestAmountCents") is not None and amount > require_cents(c["requestAmountCents"], f"commitment {c['id']} requestAmountCents", 0):
            raise LedgerError("COMMITMENT_EXCEEDS_REQUEST", f"commitment {c['id']} ({amount}) exceeds its request ({c['requestAmountCents']})")
        if c.get("state") not in ("open", "closed"):
            raise LedgerError("BAD_STATE", f"commitment {c['id']} has state {c.get('state')}")
        if c["state"] == "open" and c["lineId"] in in_scope:
            committed[c["lineId"]] = committed.get(c["lineId"], 0) + amount

    actual = {}
    for m in ledger.get("matches") or []:
        c = commitments.get(m["commitmentId"])
        if c is None:
            raise LedgerError("UNKNOWN_COMMITMENT", f"match for invoice {m['invoiceId']} names unknown commitment {m['commitmentId']}")
        amount = require_cents(m.get("amountCents"), f"match {m['invoiceId']}/{m['commitmentId']} amountCents", 0)
        if m.get("state") not in ("approved", "pending", "rejected"):
            raise LedgerError("BAD_STATE", f"match {m['invoiceId']}/{m['commitmentId']} has state {m.get('state')}")
        if m["state"] == "approved" and c["lineId"] in in_scope:
            actual[c["lineId"]] = actual.get(c["lineId"], 0) + amount

    provision = {}
    unassigned = 0
    unmatched = []
    by_id(ledger.get("invoices") or [], "id", "invoice")
    for inv in ledger.get("invoices") or []:
        amount = require_cents(inv.get("amountCents"), f"invoice {inv['id']} amountCents", 0)
        line_id = inv.get("lineId") or None
        if line_id and line_id not in all_lines:
            raise LedgerError("UNKNOWN_LINE", f"invoice {inv['id']} names unknown line {line_id}")
        if inv.get("state") != "submitted":
            continue
        if line_id and line_id not in in_scope:
            continue
        if line_id:
            provision[line_id] = provision.get(line_id, 0) + amount
        else:
            unassigned += amount
        unmatched.append({"invoiceId": inv["id"], "amountCents": json_cents(amount), "lineId": line_id, "ageDays": age_days(inv.get("submittedOn"), ledger.get("now"))})
    unmatched.sort(key=lambda u: u["invoiceId"])

    line_rows = []
    for l in lines:
        planned = require_cents(l.get("plannedCents"), f"line {l['id']} plannedCents", 0)
        com = committed.get(l["id"], 0)
        act = actual.get(l["id"], 0)
        prov = provision.get(l["id"], 0)
        avail = planned - com - prov
        line_rows.append(
            {
                "lineId": l["id"],
                "campaignId": l["campaignId"],
                "programId": campaigns[l["campaignId"]]["programId"],
                "periodId": l["periodId"],
                "plannedCents": planned,
                "committedCents": com,
                "actualCents": act,
                "unmatchedProvisionCents": prov,
                "availableCents": avail,
                "overCommitted": avail < 0,
                "committedBps": ratio_bps(com, planned),
                "actualBps": ratio_bps(act, planned),
            }
        )
    line_rows.sort(key=lambda r: r["lineId"])

    campaign_rows = {}
    program_rows = {}
    org = {**zero(), "lineCount": 0}
    for r in line_rows:
        c = campaign_rows.setdefault(r["campaignId"], {**zero(), "campaignId": r["campaignId"], "programId": r["programId"], "lineCount": 0})
        add_totals(c, r)
        c["lineCount"] += 1
        p = program_rows.setdefault(r["programId"], {**zero(), "programId": r["programId"], "lineCount": 0})
        add_totals(p, r)
        p["lineCount"] += 1
        add_totals(org, r)
        org["lineCount"] += 1

    return {
        "periodId": period,
        "lines": line_rows,
        "campaigns": sorted(campaign_rows.values(), key=lambda c: c["campaignId"]),
        "programs": sorted(program_rows.values(), key=lambda p: p["programId"]),
        "org": org,
        "unassignedUnmatchedCents": json_cents(unassigned),
        "orgAvailableCents": json_cents(org["availableCents"] - unassigned),
        "unmatchedInvoices": unmatched,
    }


def run(case):
    try:
        return {"ok": True, "rollup": rollup(case)}
    except (MoneyError, LedgerError) as e:
        return {"ok": False, "error": {"code": e.code, "message": e.message}}
    except (KeyError, TypeError, ValueError) as e:
        return {"ok": False, "error": {"code": "BAD_INPUT", "message": str(e)}}


if __name__ == "__main__":
    write_output(run(read_input()))
