import { describe, expect, it } from 'vitest';
import { RUNNERS, runChainCase, runMatchCase, runRollupCase, runVarianceCase } from '@/lib/earmark/cases';
import { isReplan, variance, varianceToJson } from '@/lib/earmark/variance';

describe('variance (PRD §4)', () => {
  it('actual − planned, as cents and basis points; unplanned instead of a division', () => {
    const v = variance({
      periodId: '2026-11',
      lines: [
        { lineId: 'b', plannedCents: 1000n, actualCents: 1250n },
        { lineId: 'a', plannedCents: 0n, actualCents: 5n },
        { lineId: 'c', plannedCents: 1000n, actualCents: 0n },
        { lineId: 'd', plannedCents: 0n, actualCents: 0n },
      ],
    });
    expect(v.rows.map((r) => r.lineId)).toEqual(['a', 'b', 'c', 'd']);
    expect(v.rows[0]).toMatchObject({ varianceCents: 5n, varianceBps: null, status: 'unplanned', unplanned: true, replan: false });
    expect(v.rows[1]).toMatchObject({ varianceCents: 250n, varianceBps: 2500n, status: 'over' });
    expect(v.rows[2]).toMatchObject({ varianceCents: -1000n, varianceBps: -10000n, status: 'under' });
    expect(v.rows[3]).toMatchObject({ varianceCents: 0n, varianceBps: null, status: 'on-plan', unplanned: false });
    expect(v.totals).toEqual({ plannedCents: 2000n, actualCents: 1255n, varianceCents: -745n, varianceBps: -3725n, lines: 4, unplannedLines: 1, replannedLines: 0, overLines: 1, underLines: 1 });
  });
  it('replan: a planned edit strictly after the first commitment', () => {
    expect(isReplan({ plannedEditedAt: ['2026-10-20'], firstCommittedAt: '2026-10-10' })).toBe(true);
    expect(isReplan({ plannedEditedAt: ['2026-10-01'], firstCommittedAt: '2026-10-10' })).toBe(false);
    expect(isReplan({ plannedEditedAt: ['2026-10-10'], firstCommittedAt: '2026-10-10' })).toBe(false);
    expect(isReplan({ plannedEditedAt: [], firstCommittedAt: '2026-10-10' })).toBe(false);
    expect(isReplan({ plannedEditedAt: null, firstCommittedAt: '2026-10-10' })).toBe(false);
    expect(isReplan({ plannedEditedAt: ['2026-10-20'] })).toBe(false);
    const v = variance({ periodId: 'p', lines: [{ lineId: 'x', plannedCents: 1n, actualCents: 1n, plannedEditedAt: ['2026-10-20'], firstCommittedAt: '2026-10-10' }] });
    expect(v.rows[0]!.replan).toBe(true);
    expect(v.totals.replannedLines).toBe(1);
  });
  it('refuses duplicates and bad money', () => {
    expect(() => variance({ periodId: 'p', lines: [{ lineId: 'x', plannedCents: 1n, actualCents: 1n }, { lineId: 'x', plannedCents: 1n, actualCents: 1n }] })).toThrow(/appears twice/);
    expect(() => variance({ periodId: 'p', lines: [{ lineId: 'x', plannedCents: -1n, actualCents: 1n }] })).toThrow(/plannedCents/);
    expect(() => variance({ periodId: 'p', lines: [{ lineId: 'x', plannedCents: 1n, actualCents: 0.5 as unknown as bigint }] })).toThrow(/actualCents/);
  });
  it('varianceToJson writes integers and nulls', () => {
    const j = varianceToJson(variance({ periodId: 'p', lines: [{ lineId: 'x', plannedCents: 0n, actualCents: 3n }, { lineId: 'y', plannedCents: 4n, actualCents: 3n }] })) as { rows: { varianceBps: number | null; varianceCents: number }[]; totals: { varianceBps: number | null } };
    expect(j.rows[0]).toMatchObject({ varianceCents: 3, varianceBps: null });
    expect(j.rows[1]).toMatchObject({ varianceCents: -1, varianceBps: -2500 });
    expect(j.totals.varianceBps).toBe(5000);
  });
});

describe('cases: the JSON face of the engines', () => {
  it('exposes one runner per oracle', () => {
    expect(Object.keys(RUNNERS).sort()).toEqual(['chain', 'match', 'rollup', 'variance']);
  });
  it('chain: invalid rules, bad input and the edit op', () => {
    expect(runChainCase({ rules: { default: [] }, request: { amountCents: 1, requesterId: 'r' }, seats: [], now: '2026-11-05' })).toMatchObject({ chain: { ok: false, error: { code: 'RULES_INVALID' } }, outcome: null });
    expect(runChainCase({ rules: { default: [{ seat: 'A', fromCents: 0 }] }, request: { amountCents: 1, requesterId: 'r', availableCents: 'x' }, seats: [], now: '2026-11-05' })).toMatchObject({ chain: { ok: false, error: { code: 'BAD_INPUT' } } });
    expect(runChainCase({ rules: { default: [{ seat: 'A', fromCents: 0 }] }, seats: [{ name: 'A', holders: [{ userId: 'a' }] }], now: '2026-11-05' })).toMatchObject({ chain: { ok: false, error: { code: 'NOT_INTEGER_CENTS' } } });
    expect(runChainCase({ rules: { default: [{ seat: 'A', fromCents: 0 }] }, request: { amountCents: 5, requesterId: 'r', kind: null }, seats: [{ name: 'A', holders: [{ userId: 'a' }] }], now: '2026-11-05', decisions: [{ step: 0, byId: 'a', decision: 'approve' }] })).toMatchObject({
      chain: { ok: true, kind: 'default', steps: [{ seat: 'A', approverIds: ['a'] }] },
      outcome: { state: 'approved' },
    });
    expect(runChainCase({ op: 'edit', role: 'owner', before: { default: [] }, after: { default: [] } })).toMatchObject({ ok: false, error: { code: 'RULES_INVALID' } });
    expect(runChainCase({ op: 'edit', role: 'owner', before: { default: [{ seat: 'A', fromCents: 0 }] }, after: { default: [{ seat: 'A', fromCents: 5 }] } })).toMatchObject({ ok: true, required: 'owner', changes: [{ before: 0, after: 5 }] });
  });
  it('rollup, match and variance runners report errors as codes', () => {
    expect(runRollupCase({ programs: [], campaigns: [], lines: [{ id: 'l', campaignId: 'c', periodId: 'p', plannedCents: 1 }], commitments: [], matches: [], invoices: [] })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CAMPAIGN' } });
    expect(runRollupCase({ programs: null } as never)).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(runMatchCase({ invoice: { id: 'i', agencyId: 'a', amountCents: 'x' }, commitments: [] })).toMatchObject({ ok: false, error: { code: 'NOT_INTEGER_CENTS' } });
    expect(runMatchCase({ commitments: null } as never)).toMatchObject({ ok: true, suggestions: null, applied: null });
    expect(runMatchCase({ commitments: [{ id: 'c' }], apply: [{ commitmentId: 'c', amountCents: 1 }] })).toMatchObject({ ok: false, error: { code: 'NOT_INTEGER_CENTS' } });
    expect(runVarianceCase({ periodId: 'p', lines: [{ lineId: 'x', plannedCents: 1, actualCents: -1 }] })).toMatchObject({ ok: false, error: { code: 'CENTS_BELOW_MIN' } });
    expect(runVarianceCase({ periodId: 'p', lines: null } as never)).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
  });
});
