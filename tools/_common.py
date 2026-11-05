"""Shared helpers for Earmark's Python oracles (stdlib only).

The oracles are the second implementation of src/lib/earmark/: same rules, written independently in Python, read a
JSON case from stdin (or a file argument) and print the result as JSON. tests/earmark/parity.test.ts diffs them
against the TypeScript engines over every file in fixtures/. Cents are JSON integers; Python ints are exact.
"""

import json
import sys
from datetime import datetime, timezone

MAX_SAFE = 2**53 - 1


class MoneyError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class LedgerError(MoneyError):
    pass


def to_cents(value, what="amount"):
    """A JSON integer or digit string -> int. Floats, bools and anything else are refused."""
    if isinstance(value, bool):
        raise MoneyError("NOT_INTEGER_CENTS", f"{what} must be an integer number of cents, got {json.dumps(value)}")
    if isinstance(value, int):
        if abs(value) > MAX_SAFE:
            raise MoneyError("NOT_INTEGER_CENTS", f"{what} must be an integer number of cents, got {value}")
        return value
    if isinstance(value, str) and value.lstrip("-").isdigit() and value.count("-") <= 1 and not value.startswith("--"):
        if value.startswith("-") and len(value) == 1:
            raise MoneyError("NOT_INTEGER_CENTS", f"{what} must be an integer number of cents, got {json.dumps(value)}")
        return int(value)
    raise MoneyError("NOT_INTEGER_CENTS", f"{what} must be an integer number of cents, got {json.dumps(value)}")


def json_cents(c):
    if abs(c) > MAX_SAFE:
        raise MoneyError("CENTS_OUT_OF_RANGE", f"{c} cents does not fit a JSON integer")
    return int(c)


def require_cents(value, what, minimum=None):
    c = to_cents(value, what)
    if minimum is not None and c < minimum:
        raise MoneyError("CENTS_BELOW_MIN", f"{what} must be >= {minimum}, got {c}")
    return c


def div_round(num, den):
    """Integer division rounded half away from zero; the one rounding rule, mirrored from money.ts."""
    if den == 0:
        raise MoneyError("DIVIDE_BY_ZERO", "division by zero")
    negative = (num < 0) != (den < 0)
    n, d = abs(num), abs(den)
    q = (2 * n + d) // (2 * d)
    return -q if negative else q


def ratio_bps(part, whole):
    if whole == 0:
        return None
    return div_round(part * 10000, whole)


def within_percent(a, b, pct):
    if pct < 0:
        raise MoneyError("BAD_PERCENT", "percent must be >= 0")
    return abs(a - b) * 100 <= pct * b


def parse_instant(text, what="instant"):
    """ISO 8601 instant or date (date = midnight UTC) -> epoch milliseconds, like parseInstant in chain.ts."""
    if not isinstance(text, str):
        raise ValueError(f"{what}: cannot parse {json.dumps(text)} as an ISO 8601 instant")
    s = text
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        s = s + "T00:00:00+00:00"
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise ValueError(f"{what}: cannot parse {json.dumps(text)} as an ISO 8601 instant")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def age_days(start, now):
    if not start or not now:
        return None
    try:
        f = parse_instant(start, "from")
        n = parse_instant(now, "now")
    except ValueError:
        raise LedgerError("BAD_DATE", f"cannot parse {start} / {now}")
    return (n - f) // 86_400_000


def read_input():
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        with open(sys.argv[1], encoding="utf-8") as f:
            return json.load(f)
    return json.load(sys.stdin)


def write_output(obj):
    json.dump(obj, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


def sort_key(s):
    """Code-point order, the way JavaScript compares strings with < and >."""
    return [ord(ch) for ch in s]
