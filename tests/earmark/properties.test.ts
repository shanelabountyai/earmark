// Property tests (PRD §8): rollups equal the sum of their leaves for any tree; no sequence of matches takes a
// commitment below zero without the overage flag; chain evaluation is deterministic and skips exactly the steps
// whose threshold exceeds the amount; cents arithmetic never produces a non-integer.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ApprovalRules, applyDecisions, evaluateChain, type Seat } from '@/lib/earmark/chain';
import { applyMatches, type MatchCommitment, type MatchDecision, suggestMatches } from '@/lib/earmark/match';
import { add, divRound, formatUsd, parseDollars, ratioBps, sub, sum, withinPercent } from '@/lib/earmark/money';
import { type Ledger, rollup } from '@/lib/earmark/rollup';
import { variance } from '@/lib/earmark/variance';

const cents = (max = 1_000_000_000) => fc.bigInt({ min: 0n, max: BigInt(max) });
const anyCents = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
const id = (prefix: string) => fc.integer({ min: 0, max: 40 }).map((n) => `${prefix}-${n}`);
const RUNS = { numRuns: 200 };

describe('cents arithmetic never produces a non-integer', () => {
  it('add, sub, sum, divRound and ratioBps stay bigint', () => {
    fc.assert(
      fc.property(anyCents, anyCents, fc.bigInt({ min: 1n, max: 10n ** 9n }), (a, b, d) => {
        expect(typeof add(a, b)).toBe('bigint');
        expect(typeof sub(a, b)).toBe('bigint');
        expect(typeof sum([a, b, d])).toBe('bigint');
        expect(typeof divRound(a, d)).toBe('bigint');
        expect(typeof ratioBps(a, d)).toBe('bigint');
        expect(add(a, b) - b).toBe(a);
      }),
      RUNS,
    );
  });
  it('divRound is within half of the exact quotient and rounds half away from zero', () => {
    fc.assert(
      fc.property(anyCents, fc.bigInt({ min: 1n, max: 10n ** 6n }), (n, d) => {
        const q = divRound(n, d);
        const twiceErr = (q * d - n) * 2n; // |q - n/d| <= 1/2  <=>  |2(qd - n)| <= d
        expect(twiceErr <= d && twiceErr >= -d).toBe(true);
        if (twiceErr === d || twiceErr === -d) expect(q < 0n ? -q : q).toBe((n < 0n ? -n : n) / d + 1n); // exact half: away from zero
      }),
      RUNS,
    );
  });
  it('formatUsd and parseDollars round-trip every amount', () => {
    fc.assert(
      fc.property(anyCents, (c) => {
        expect(parseDollars(formatUsd(c))).toBe(c);
      }),
      RUNS,
    );
  });
  it('withinPercent is exact at the boundary', () => {
    fc.assert(
      fc.property(cents(), fc.bigInt({ min: 0n, max: 100n }), (b, pct) => {
        const edge = (pct * b) / 100n; // the largest difference that is within
        expect(withinPercent(b + edge, b, pct)).toBe(true);
        expect(withinPercent(b - edge, b, pct)).toBe(true);
        if ((pct * b) % 100n === 0n) {
          expect(withinPercent(b + edge + 1n, b, pct)).toBe(false);
        }
      }),
      RUNS,
    );
  });
});

describe('rollups equal the sum of their leaves for any tree', () => {
  const ledgerArb: fc.Arbitrary<Ledger> = fc
    .record({
      programs: fc.uniqueArray(id('p'), { minLength: 1, maxLength: 4 }),
      campaigns: fc.uniqueArray(id('c'), { minLength: 1, maxLength: 6 }),
      lines: fc.uniqueArray(id('l'), { minLength: 0, maxLength: 12 }),
      periods: fc.uniqueArray(fc.constantFrom('2026-01', '2026-02', '2026-03'), { minLength: 1, maxLength: 3 }),
      seed: fc.array(fc.nat(), { minLength: 64, maxLength: 64 }),
    })
    .chain(({ programs, campaigns, lines, periods, seed }) => {
      let i = 0;
      const pick = <T>(xs: T[]): T => xs[seed[i++ % 64]! % xs.length]!;
      const camps = campaigns.map((c) => ({ id: c, programId: pick(programs) }));
      const ls = lines.map((l) => ({ id: l, campaignId: pick(campaigns), periodId: pick(periods) }));
      return fc.record({
        programs: fc.constant(programs.map((p) => ({ id: p }))),
        campaigns: fc.constant(camps),
        lines: fc.constant(ls),
        planned: fc.array(cents(10_000_000), { minLength: ls.length, maxLength: ls.length }),
        commitments: fc.array(fc.record({ lineIx: fc.nat(), amountCents: cents(5_000_000), state: fc.constantFrom('open', 'closed') as fc.Arbitrary<'open' | 'closed'> }), { maxLength: 15 }),
        matches: fc.array(fc.record({ cIx: fc.nat(), amountCents: cents(3_000_000), state: fc.constantFrom('approved', 'pending', 'rejected') as fc.Arbitrary<'approved' | 'pending' | 'rejected'> }), { maxLength: 15 }),
        invoices: fc.array(fc.record({ lineIx: fc.option(fc.nat(), { nil: null }), amountCents: cents(3_000_000), state: fc.constantFrom('submitted', 'matched', 'voided') as fc.Arbitrary<'submitted' | 'matched' | 'voided'> }), { maxLength: 10 }),
        periodId: fc.option(fc.constantFrom(...periods), { nil: null }),
      });
    })
    .map((r): Ledger => {
      const lines = r.lines.map((l, ix) => ({ ...l, plannedCents: r.planned[ix]! }));
      const commitments = lines.length ? r.commitments.map((c, ix) => ({ id: `po-${ix}`, lineId: lines[c.lineIx % lines.length]!.id, amountCents: c.amountCents, state: c.state })) : [];
      const matches = commitments.length ? r.matches.map((m, ix) => ({ invoiceId: `m-${ix}`, commitmentId: commitments[m.cIx % commitments.length]!.id, amountCents: m.amountCents, state: m.state })) : [];
      const invoices = r.invoices.map((inv, ix) => ({ id: `inv-${ix}`, amountCents: inv.amountCents, state: inv.state, lineId: inv.lineIx === null || !lines.length ? null : lines[inv.lineIx % lines.length]!.id }));
      return { programs: r.programs, campaigns: r.campaigns, lines, commitments, matches, invoices, periodId: r.periodId };
    });

  it('campaign, program and org totals are exactly the sums of their line rows', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const r = rollup(ledger);
        const keys = ['plannedCents', 'committedCents', 'actualCents', 'unmatchedProvisionCents', 'availableCents'] as const;
        for (const c of r.campaigns) {
          const rows = r.lines.filter((l) => l.campaignId === c.campaignId);
          expect(rows.length).toBe(c.lineCount);
          for (const k of keys) expect(c[k]).toBe(sum(rows.map((x) => x[k])));
        }
        for (const p of r.programs) {
          const rows = r.lines.filter((l) => l.programId === p.programId);
          expect(rows.length).toBe(p.lineCount);
          for (const k of keys) expect(p[k]).toBe(sum(rows.map((x) => x[k])));
          expect(sum(r.campaigns.filter((c) => c.programId === p.programId).map((c) => c.plannedCents))).toBe(p.plannedCents);
        }
        for (const k of keys) expect(r.org[k]).toBe(sum(r.lines.map((x) => x[k])));
        expect(r.org.lineCount).toBe(r.lines.length);
        for (const l of r.lines) {
          expect(l.availableCents).toBe(l.plannedCents - l.committedCents - l.unmatchedProvisionCents);
          expect(l.overCommitted).toBe(l.availableCents < 0n);
          if (ledger.periodId) expect(l.periodId).toBe(ledger.periodId);
        }
        expect(r.orgAvailableCents).toBe(r.org.availableCents - r.unassignedUnmatchedCents);
        expect(r.unassignedUnmatchedCents + sum(r.lines.map((l) => l.unmatchedProvisionCents))).toBe(sum(r.unmatchedInvoices.map((u) => u.amountCents)));
      }),
      RUNS,
    );
  });

  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const a = JSON.stringify(rollup(ledger), (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
        const b = JSON.stringify(rollup(structuredClone(ledger)), (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
        expect(a).toBe(b);
      }),
      { numRuns: 50 },
    );
  });
});

describe('no sequence of matches takes a commitment below zero without the overage flag', () => {
  const commitmentsArb = fc.uniqueArray(id('po'), { minLength: 1, maxLength: 5 }).chain((ids) =>
    fc.tuple(...ids.map((cid) => fc.record({ id: fc.constant(cid), agencyId: fc.constantFrom('ag-a', 'ag-b'), poNumber: fc.constant(cid.toUpperCase()), amountCents: cents(), remainingCents: cents(), state: fc.constantFrom('open', 'closed') as fc.Arbitrary<'open' | 'closed'> }))),
  );
  const decisionsArb = (ids: string[]) =>
    fc.array(
      fc.record({ commitmentId: fc.constantFrom(...ids, 'po-missing'), amountCents: fc.bigInt({ min: -5n, max: 2_000_000_000n }), matcherSeats: fc.subarray(['Finance', 'Marketing Ops', 'Budget Owner']), note: fc.option(fc.constantFrom('', '  ', 'agreed rush fee'), { nil: null }) }),
      { maxLength: 12 },
    );

  it('remaining goes negative only through an accepted overage, and every accepted overage is flagged', () => {
    fc.assert(
      fc.property(
        commitmentsArb.chain((cs) => fc.tuple(fc.constant(cs as MatchCommitment[]), decisionsArb(cs.map((c) => c.id)))),
        ([commitments, decisions]) => {
          const run = applyMatches(commitments, decisions as MatchDecision[]);
          const anyOverage = run.results.some((r) => r.ok && r.overage);
          expect(run.overageFlagged).toBe(anyOverage);
          let remaining = new Map(commitments.map((c) => [c.id, c.remainingCents]));
          for (const [i, r] of run.results.entries()) {
            const d = decisions[i]!;
            if (!r.ok) {
              expect(remaining.get(d.commitmentId) ?? 0n).toBe(r.remainingBefore); // a refusal changes nothing
              continue;
            }
            expect(r.remainingBefore).toBe(remaining.get(d.commitmentId));
            expect(r.remainingAfter).toBe(r.remainingBefore - r.amountCents);
            if (r.remainingAfter < 0n) {
              expect(r.overage).toBe(true);
              expect(d.matcherSeats).toContain('Finance');
              expect((d.note ?? '').trim()).not.toBe('');
              expect(r.overageCents).toBe(-r.remainingAfter);
            } else expect(r.overage).toBe(false);
            remaining.set(d.commitmentId, r.remainingAfter);
          }
          remaining = new Map([...remaining].filter(([k]) => commitments.some((c) => c.id === k)));
          for (const [k, v] of remaining) expect(run.remaining[k]).toBe(v);
        },
      ),
      RUNS,
    );
  });

  it('suggestions are ranked by tier, then closeness, and never list a closed commitment', () => {
    fc.assert(
      fc.property(commitmentsArb, fc.record({ id: fc.constant('inv-1'), agencyId: fc.constantFrom('ag-a', 'ag-b', 'ag-c'), amountCents: cents(), poNumber: fc.option(fc.constantFrom('PO-0', 'PO-1', 'po-2', 'x'), { nil: null }) }), (commitments, invoice) => {
        const s = suggestMatches(invoice, commitments as MatchCommitment[]);
        expect(s.suggestions.map((x) => x.rank)).toEqual(s.suggestions.map((_, i) => i + 1));
        for (let i = 1; i < s.suggestions.length; i++) {
          const a = s.suggestions[i - 1]!;
          const b = s.suggestions[i]!;
          expect(a.tier <= b.tier).toBe(true);
          if (a.tier === b.tier) {
            const da = a.differenceCents < 0n ? -a.differenceCents : a.differenceCents;
            const db = b.differenceCents < 0n ? -b.differenceCents : b.differenceCents;
            expect(da <= db).toBe(true);
          }
        }
        for (const x of s.suggestions) {
          const c = commitments.find((k) => k.id === x.commitmentId)!;
          expect(c.state).toBe('open');
          expect(x.wouldOverage).toBe(invoice.amountCents > c.remainingCents);
          expect(x.differenceCents).toBe(invoice.amountCents - c.remainingCents);
        }
      }),
      RUNS,
    );
  });
});

describe('chain evaluation is deterministic and skips exactly the steps whose threshold exceeds the amount', () => {
  const rulesArb: fc.Arbitrary<ApprovalRules> = fc
    .uniqueArray(fc.constantFrom('Budget Owner', 'Marketing Ops', 'Finance', 'CMO', 'CFO', 'VP Marketing'), { minLength: 1, maxLength: 6 })
    .chain((seats) => fc.tuple(fc.constant(seats), fc.array(cents(50_000_000), { minLength: seats.length, maxLength: seats.length })))
    .map(([seats, thresholds]) => {
      const sorted = [...thresholds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return { chains: { default: seats.map((seat, i) => ({ seat, fromCents: sorted[i]! })) }, overrides: [] };
    });
  const seatsArb: fc.Arbitrary<Seat[]> = fc.array(
    fc.record({
      name: fc.constantFrom('Budget Owner', 'Marketing Ops', 'Finance', 'CMO', 'CFO', 'VP Marketing'),
      holders: fc.array(fc.record({ userId: fc.constantFrom('u1', 'u2', 'u3', 'u4', 'req'), delegateToId: fc.option(fc.constantFrom('u1', 'u5', 'req'), { nil: null }), activeTo: fc.option(fc.constantFrom('2020-01-01', '2030-01-01'), { nil: null }) }), { maxLength: 3 }),
    }),
    { maxLength: 6 },
  );
  const requestArb = fc.record({ amountCents: fc.bigInt({ min: 1n, max: 60_000_000n }), requesterId: fc.constantFrom('req', 'u9'), availableCents: fc.option(cents(60_000_000), { nil: null }) });

  it('partitions the chain into kept and skipped by the threshold, in order, and never names the requester', () => {
    fc.assert(
      fc.property(rulesArb, seatsArb, requestArb, (rules, seats, request) => {
        const r = evaluateChain({ rules, request, seats, now: '2026-11-05T00:00:00Z' });
        const again = evaluateChain({ rules, request, seats: structuredClone(seats), now: '2026-11-05T00:00:00Z' });
        expect(JSON.stringify(again, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).toBe(JSON.stringify(r, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
        if (!r.ok) {
          expect(r.error.code).toBe('REQUESTER_ONLY_HOLDER');
          return;
        }
        const chain = rules.chains.default!;
        const expectedSkipped = chain.filter((s) => s.fromCents > request.amountCents).map((s) => s.seat);
        const expectedKept = chain.filter((s) => s.fromCents <= request.amountCents).map((s) => s.seat);
        expect(r.skipped.map((s) => s.seat)).toEqual(expectedSkipped);
        const chainKept = [...r.steps, ...r.collapsed].filter((s) => s.source === 'chain').map((s) => s.seat);
        expect([...chainKept].sort()).toEqual([...expectedKept].sort());
        const seen = new Set<string>();
        for (const s of r.steps) {
          expect(s.approverIds).not.toContain(request.requesterId);
          for (const a of s.approverIds) {
            expect(seen.has(a)).toBe(false); // one person counts once
            seen.add(a);
          }
          if (s.blocked) expect(s.approverIds).toEqual([]);
        }
        expect(r.steps.map((s) => s.index)).toEqual(r.steps.map((_, i) => i));
        const overBudget = request.availableCents !== null && request.amountCents > request.availableCents;
        expect(r.overBudget).toBe(overBudget);
        const financeSteps = r.steps.filter((s) => s.seat === 'Finance');
        if (overBudget) expect(financeSteps.length + r.collapsed.filter((c) => c.seat === 'Finance').length).toBeGreaterThanOrEqual(1);
        else expect(r.steps.every((s) => s.source !== 'over-budget' && !s.requiresNote)).toBe(true);
      }),
      RUNS,
    );
  });

  it('walks decisions one step at a time; a rejection ends the chain', () => {
    fc.assert(
      fc.property(rulesArb, seatsArb, requestArb, fc.array(fc.record({ step: fc.nat(6), byId: fc.constantFrom('u1', 'u2', 'u3', 'u4', 'u5', 'req'), decision: fc.constantFrom('approve', 'reject') as fc.Arbitrary<'approve' | 'reject'>, note: fc.option(fc.constant('ok'), { nil: null }) }), { maxLength: 10 }), (rules, seats, request, decisions) => {
        const r = evaluateChain({ rules, request, seats, now: '2026-11-05T00:00:00Z' });
        if (!r.ok) return;
        const o = applyDecisions(r, decisions, request.requesterId);
        expect(o.results.length).toBe(decisions.length);
        const accepted = o.decided;
        for (const [i, d] of accepted.entries()) expect(d.step).toBe(i); // strictly in order
        const rejectIx = accepted.findIndex((d) => d.decision === 'reject');
        if (rejectIx >= 0) {
          expect(o.state).toBe('rejected');
          expect(o.rejectedAt).toBe(rejectIx);
          expect(accepted.length).toBe(rejectIx + 1);
          expect(o.currentStep).toBeNull();
        } else if (accepted.length === r.steps.length) {
          expect(o.state).toBe('approved');
          expect(o.currentStep).toBeNull();
        } else {
          expect(o.state).toBe('pending');
          expect(o.currentStep).toBe(accepted.length);
        }
        for (const d of accepted) expect(d.byId).not.toBe(request.requesterId);
      }),
      RUNS,
    );
  });
});

describe('variance', () => {
  it('totals are the sums of the rows and the status follows the sign', () => {
    fc.assert(
      fc.property(fc.uniqueArray(id('l'), { maxLength: 10 }).chain((ids) => fc.tuple(fc.constant(ids), fc.array(fc.tuple(cents(), cents()), { minLength: ids.length, maxLength: ids.length }))), ([ids, amounts]) => {
        const v = variance({ periodId: 'p', lines: ids.map((lineId, i) => ({ lineId, plannedCents: amounts[i]![0], actualCents: amounts[i]![1] })) });
        expect(v.totals.plannedCents).toBe(sum(v.rows.map((r) => r.plannedCents)));
        expect(v.totals.actualCents).toBe(sum(v.rows.map((r) => r.actualCents)));
        expect(v.totals.varianceCents).toBe(v.totals.actualCents - v.totals.plannedCents);
        for (const r of v.rows) {
          expect(r.varianceCents).toBe(r.actualCents - r.plannedCents);
          if (r.plannedCents === 0n) expect(r.varianceBps).toBeNull();
          else expect(r.varianceBps).toBe(divRound(r.varianceCents * 10000n, r.plannedCents));
          expect(r.status).toBe(r.unplanned ? 'unplanned' : r.varianceCents > 0n ? 'over' : r.varianceCents < 0n ? 'under' : 'on-plan');
        }
      }),
      RUNS,
    );
  });
});
