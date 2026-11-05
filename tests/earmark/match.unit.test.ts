import { describe, expect, it } from 'vitest';
import { applyMatch, applyMatches, type MatchCommitment, matchRunToJson, normalizePo, suggestionsToJson, suggestMatches } from '@/lib/earmark/match';

const commitments: MatchCommitment[] = [
  { id: 'po-1', agencyId: 'ag-a', poNumber: 'PO-1', amountCents: 100000n, remainingCents: 100000n, state: 'open' },
  { id: 'po-2', agencyId: 'ag-a', poNumber: 'PO-2', amountCents: 300000n, remainingCents: 101000n, state: 'open' },
  { id: 'po-3', agencyId: 'ag-b', poNumber: 'PO-3', amountCents: 100000n, remainingCents: 100000n, state: 'open' },
  { id: 'po-4', agencyId: 'ag-a', poNumber: 'PO-4', amountCents: 100000n, remainingCents: 0n, state: 'closed' },
];

describe('suggestMatches (PRD §4: by PO, then agency + amount within 2 %, then agency)', () => {
  it('normalizes PO numbers', () => {
    expect(normalizePo('  po-12  34 ')).toBe('PO-12 34');
    expect(normalizePo(null)).toBe('');
    expect(normalizePo(undefined)).toBe('');
  });
  it('ranks with reasons', () => {
    const s = suggestMatches({ id: 'inv', agencyId: 'ag-a', amountCents: 100000n, poNumber: 'po-1' }, commitments);
    expect(s.invoiceId).toBe('inv');
    expect(s.suggestions.map((x) => [x.rank, x.commitmentId, x.tier, x.reasons])).toEqual([
      [1, 'po-1', 1, ['po-number', 'agency', 'exact-remaining']],
      [2, 'po-2', 3, ['agency', 'amount-within-2pct']],
    ]);
    expect(s.suggestions[1]).toMatchObject({ remainingCents: 101000n, differenceCents: -1000n, wouldOverage: false });
    expect(s.excluded).toEqual([]);
  });
  it('a PO on another agency ranks second tier and is flagged', () => {
    const s = suggestMatches({ id: 'inv', agencyId: 'ag-a', amountCents: 50n, poNumber: 'PO-3' }, commitments);
    expect(s.suggestions[0]).toMatchObject({ commitmentId: 'po-3', tier: 2, reasons: ['po-number', 'agency-mismatch'] });
    expect(s.suggestions.slice(1).map((x) => x.tier)).toEqual([4, 4]);
  });
  it('closed commitments are never suggested; a closed PO hit is reported', () => {
    const s = suggestMatches({ id: 'inv', agencyId: 'ag-a', amountCents: 50n, poNumber: 'PO-4' }, commitments);
    expect(s.suggestions.map((x) => x.commitmentId)).toEqual(['po-1', 'po-2']);
    expect(s.excluded).toEqual([{ commitmentId: 'po-4', reason: 'po-closed' }]);
    const twice = suggestMatches({ id: 'inv', agencyId: 'ag-z', amountCents: 50n, poNumber: 'PO-4' }, [{ ...commitments[3]!, id: 'po-9' }, commitments[3]!, { ...commitments[3]!, id: 'po-5' }]);
    expect(twice.excluded.map((e) => e.commitmentId)).toEqual(['po-4', 'po-5', 'po-9']);
  });
  it('nothing matches a stranger', () => {
    expect(suggestMatches({ id: 'inv', agencyId: 'ag-z', amountCents: 50n }, commitments)).toEqual({ invoiceId: 'inv', suggestions: [], excluded: [] });
  });
  it('flags would-overage', () => {
    const s = suggestMatches({ id: 'inv', agencyId: 'ag-a', amountCents: 100001n }, commitments);
    expect(s.suggestions[0]).toMatchObject({ commitmentId: 'po-1', tier: 3, wouldOverage: true, differenceCents: 1n, reasons: ['agency', 'amount-within-2pct', 'would-overage'] });
    expect(s.suggestions[1]).toMatchObject({ commitmentId: 'po-2', tier: 3, wouldOverage: false, differenceCents: -999n });
  });
  it('refuses a non-integer invoice amount', () => {
    expect(() => suggestMatches({ id: 'inv', agencyId: 'ag-a', amountCents: 1.5 as unknown as bigint }, commitments)).toThrow(/integer number of cents/);
  });
  it('suggestionsToJson writes integers', () => {
    const j = suggestionsToJson(suggestMatches({ id: 'inv', agencyId: 'ag-a', amountCents: 100000n, poNumber: 'PO-1' }, commitments)) as { suggestions: { remainingCents: number; differenceCents: number }[] };
    expect(j.suggestions[0]).toMatchObject({ remainingCents: 100000, differenceCents: 0 });
  });
});

describe('applyMatch (PRD §4 overage rule)', () => {
  const open = { id: 'po', remainingCents: 1000n, state: 'open' as const };
  it('under, exact, over', () => {
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 400n, matcherSeats: [] })).toEqual({ ok: true, commitmentId: 'po', amountCents: 400n, remainingBefore: 1000n, remainingAfter: 600n, variance: 'under', overage: false, overageCents: 0n, closes: false });
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 1000n, matcherSeats: [] })).toMatchObject({ ok: true, variance: 'exact', closes: true, remainingAfter: 0n });
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 1001n, matcherSeats: ['Finance'], note: 'rush fee' })).toMatchObject({ ok: true, variance: 'over', overage: true, overageCents: 1n, closes: true, remainingAfter: -1n });
  });
  it('refuses overage without Finance or without a note, a closed commitment, and a bad amount', () => {
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 1001n, matcherSeats: ['Budget Owner'] })).toMatchObject({ ok: false, code: 'OVERAGE_NEEDS_FINANCE', remainingBefore: 1000n, amountCents: 1001n });
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 1001n, matcherSeats: ['Finance'], note: ' ' })).toMatchObject({ ok: false, code: 'OVERAGE_NEEDS_NOTE' });
    expect(applyMatch({ ...open, state: 'closed' }, { commitmentId: 'po', amountCents: 1n, matcherSeats: [] })).toMatchObject({ ok: false, code: 'COMMITMENT_CLOSED' });
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 0n, matcherSeats: [] })).toMatchObject({ ok: false, code: 'BAD_AMOUNT', amountCents: 0n });
    expect(applyMatch(open, { commitmentId: 'po', amountCents: 2.5 as unknown as bigint, matcherSeats: [] })).toMatchObject({ ok: false, code: 'BAD_AMOUNT' });
    expect(() => applyMatch({ ...open, remainingCents: 'x' as unknown as bigint }, { commitmentId: 'po', amountCents: 1n, matcherSeats: [] })).toThrow(/remainingCents/);
  });
});

describe('applyMatches', () => {
  it('threads remaining through a sequence and closes fully matched commitments', () => {
    const run = applyMatches(commitments, [
      { commitmentId: 'po-1', amountCents: 100000n, matcherSeats: [] },
      { commitmentId: 'po-1', amountCents: 1n, matcherSeats: ['Finance'], note: 'x' },
      { commitmentId: 'po-9', amountCents: 1n, matcherSeats: [] },
      { commitmentId: 'po-2', amountCents: 101500n, matcherSeats: ['Finance'], note: 'agreed overage' },
    ]);
    expect(run.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'COMMITMENT_CLOSED', 'UNKNOWN_COMMITMENT', 'ok']);
    expect(run.remaining).toEqual({ 'po-1': 0n, 'po-2': -500n, 'po-3': 100000n, 'po-4': 0n });
    expect(run.overageFlagged).toBe(true);
    const j = matchRunToJson(run) as { results: ({ ok: true; remainingAfter: number } | { ok: false; remainingBefore: number })[]; remaining: Record<string, number> };
    expect(j.remaining).toEqual({ 'po-1': 0, 'po-2': -500, 'po-3': 100000, 'po-4': 0 });
    expect(j.results[0]).toMatchObject({ ok: true, remainingAfter: 0 });
    expect(j.results[2]).toMatchObject({ ok: false, remainingBefore: 0 });
  });
  it('is not flagged without an overage', () => {
    expect(applyMatches(commitments, [{ commitmentId: 'po-1', amountCents: 5n, matcherSeats: [] }]).overageFlagged).toBe(false);
    expect(applyMatches([], []).remaining).toEqual({});
  });
});
