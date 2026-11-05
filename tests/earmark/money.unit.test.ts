import { describe, expect, it } from 'vitest';
import { abs, add, divRound, formatUsd, jsonCents, max, min, MoneyError, parseDollars, ratioBps, requireCents, sub, sum, toCents, withinPercent, ZERO } from '@/lib/earmark/money';

describe('money: integer cents only (PRD D-04)', () => {
  it('reads integers, digit strings and bigints; refuses floats, bools and words', () => {
    expect(toCents(123)).toBe(123n);
    expect(toCents('-45')).toBe(-45n);
    expect(toCents(7n)).toBe(7n);
    expect(() => toCents(1.5)).toThrow(MoneyError);
    expect(() => toCents('1.50')).toThrow(/integer number of cents/);
    expect(() => toCents(true)).toThrow(MoneyError);
    expect(() => toCents(null)).toThrow(MoneyError);
    expect(() => toCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(/integer number of cents/);
    try {
      toCents('abc', 'plannedCents');
    } catch (e) {
      expect((e as MoneyError).code).toBe('NOT_INTEGER_CENTS');
      expect((e as MoneyError).message).toContain('plannedCents');
    }
  });
  it('writes JSON integers and refuses what JSON cannot carry exactly', () => {
    expect(jsonCents(0n)).toBe(0);
    expect(jsonCents(-1234n)).toBe(-1234);
    expect(() => jsonCents(2n ** 53n)).toThrow(/does not fit/);
    expect(() => jsonCents(-(2n ** 53n))).toThrow(MoneyError);
  });
  it('parses dollar strings without floats', () => {
    expect(parseDollars('9999.99')).toBe(999999n);
    expect(parseDollars('10000.00')).toBe(1000000n);
    expect(parseDollars('$10,000')).toBe(1000000n);
    expect(parseDollars(' -$0.07 ')).toBe(-7n);
    expect(parseDollars('1.5')).toBe(150n);
    expect(parseDollars('0')).toBe(0n);
    expect(() => parseDollars('1.234')).toThrow(/cannot parse/);
    expect(() => parseDollars('1e3')).toThrow(MoneyError);
    expect(() => parseDollars('')).toThrow(MoneyError);
  });
  it('formats for display', () => {
    expect(formatUsd(0n)).toBe('$0.00');
    expect(formatUsd(999999n)).toBe('$9,999.99');
    expect(formatUsd(123456789n)).toBe('$1,234,567.89');
    expect(formatUsd(-7n)).toBe('-$0.07');
    expect(formatUsd(-100000000n)).toBe('-$1,000,000.00');
  });
  it('arithmetic helpers', () => {
    expect(add(1n, 2n)).toBe(3n);
    expect(sub(1n, 2n)).toBe(-1n);
    expect(sum([])).toBe(ZERO);
    expect(sum([1n, 2n, 3n])).toBe(6n);
    expect(min(1n, 2n)).toBe(1n);
    expect(min(3n, 2n)).toBe(2n);
    expect(max(1n, 2n)).toBe(2n);
    expect(max(3n, 2n)).toBe(3n);
    expect(abs(-5n)).toBe(5n);
    expect(abs(5n)).toBe(5n);
  });
  it('divRound rounds half away from zero and refuses zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(5n, -2n)).toBe(-3n);
    expect(divRound(-5n, -2n)).toBe(3n);
    expect(divRound(7n, 3n)).toBe(2n);
    expect(divRound(8n, 3n)).toBe(3n);
    expect(divRound(0n, 3n)).toBe(0n);
    expect(() => divRound(1n, 0n)).toThrow(/division by zero/);
  });
  it('ratioBps: basis points of a whole, null for a zero whole', () => {
    expect(ratioBps(1n, 3n)).toBe(3333n);
    expect(ratioBps(2n, 3n)).toBe(6667n);
    expect(ratioBps(1n, 4000n)).toBe(3n);
    expect(ratioBps(-1n, 4000n)).toBe(-3n);
    expect(ratioBps(80n, 100n)).toBe(8000n);
    expect(ratioBps(5n, 0n)).toBeNull();
  });
  it('withinPercent is exact integer arithmetic', () => {
    expect(withinPercent(1020000n, 1000000n, 2n)).toBe(true);
    expect(withinPercent(1020001n, 1000000n, 2n)).toBe(false);
    expect(withinPercent(980000n, 1000000n, 2n)).toBe(true);
    expect(withinPercent(979999n, 1000000n, 2n)).toBe(false);
    expect(withinPercent(0n, 0n, 2n)).toBe(true);
    expect(withinPercent(1n, 0n, 2n)).toBe(false);
    expect(() => withinPercent(1n, 1n, -1n)).toThrow(/percent/);
  });
  it('requireCents enforces a minimum', () => {
    expect(requireCents(5, 'x', { min: 5n })).toBe(5n);
    expect(requireCents('6', 'x')).toBe(6n);
    expect(() => requireCents(4, 'x', { min: 5n })).toThrow(/must be >= 5/);
    try {
      requireCents(-1, 'amountCents', { min: 0n });
    } catch (e) {
      expect((e as MoneyError).code).toBe('CENTS_BELOW_MIN');
      expect((e as MoneyError).name).toBe('MoneyError');
    }
  });
});
