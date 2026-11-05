// Earmark money primitives (PRD D-04, §4): integer cents as BigInt, one currency per org, no floats anywhere.
// Pure: no database, no Prisma, no UI. Every other engine in src/lib/earmark/ builds on these.
//
// JSON boundary: fixtures and oracle output carry cents as JSON integers (Python's native int). `toCents` reads
// an integer or a digit string into a BigInt; `jsonCents` writes a BigInt back as an integer and refuses anything
// outside the safe-integer range, so the two implementations compare exactly.

export type Cents = bigint;

export const ZERO: Cents = 0n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class MoneyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Reads cents from JSON (an integer, a digit string, or a bigint). Anything fractional or non-numeric is refused. */
export function toCents(value: unknown, what = 'amount'): Cents {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MoneyError('NOT_INTEGER_CENTS', `${what} must be an integer number of cents, got ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new MoneyError('NOT_INTEGER_CENTS', `${what} must be an integer number of cents, got ${JSON.stringify(value)}`);
}

/** Cents as a JSON integer. Refuses values the JSON side could not carry exactly. */
export function jsonCents(c: Cents): number {
  if (c > MAX_SAFE || c < -MAX_SAFE) throw new MoneyError('CENTS_OUT_OF_RANGE', `${c} cents does not fit a JSON integer`);
  return Number(c);
}

/** "9999.99" | "-12" | "$10,000.00" -> cents. Two decimals at most; no exponent, no rounding. */
export function parseDollars(text: string): Cents {
  const m = /^\s*(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) throw new MoneyError('BAD_DOLLAR_STRING', `cannot parse ${JSON.stringify(text)} as dollars`);
  const whole = BigInt(m[2]!.replaceAll(',', ''));
  const frac = BigInt((m[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100n + frac;
  return m[1] ? -cents : cents;
}

/** cents -> "$1,234.56" / "-$0.07". Display only; never parsed back into arithmetic. */
export function formatUsd(c: Cents): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

export const add = (a: Cents, b: Cents): Cents => a + b;
export const sub = (a: Cents, b: Cents): Cents => a - b;
export const sum = (xs: Iterable<Cents>): Cents => {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
};
export const min = (a: Cents, b: Cents): Cents => (a < b ? a : b);
export const max = (a: Cents, b: Cents): Cents => (a > b ? a : b);
export const abs = (a: Cents): Cents => (a < 0n ? -a : a);

/**
 * Integer division rounded half away from zero (so 1.5 -> 2 and -1.5 -> -2). The one rounding rule in Earmark,
 * mirrored exactly in tools/_oracle_common.py. Used only for display ratios (basis points), never for money itself.
 */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new MoneyError('DIVIDE_BY_ZERO', 'division by zero');
  const negative = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** part / whole as basis points (1% = 100 bps), rounded half away from zero; null when whole is zero. */
export function ratioBps(part: Cents, whole: Cents): bigint | null {
  if (whole === 0n) return null;
  return divRound(part * 10000n, whole);
}

/** |a - b| <= pct% of b, in integer arithmetic (b must be >= 0). */
export function withinPercent(a: Cents, b: Cents, pct: bigint): boolean {
  if (pct < 0n) throw new MoneyError('BAD_PERCENT', 'percent must be >= 0');
  return abs(a - b) * 100n <= pct * b;
}

/** Validates a money field read from JSON and returns it. `min` is inclusive. */
export function requireCents(value: unknown, what: string, opts: { min?: Cents } = {}): Cents {
  const c = toCents(value, what);
  if (opts.min !== undefined && c < opts.min) throw new MoneyError('CENTS_BELOW_MIN', `${what} must be >= ${opts.min}, got ${c}`);
  return c;
}
