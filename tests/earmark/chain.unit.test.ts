import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyDecisions, authorizeRuleEdit, type ChainResult, evaluateChain, holderActive, parseInstant, parseRules, rulesToJson, type RulesJson, type Seat } from '@/lib/earmark/chain';

const RULES_JSON = JSON.parse(readFileSync('rules/approval-chains.json', 'utf8')) as RulesJson;
const rules = parseRules(RULES_JSON);
const NOW = '2026-11-05T12:00:00Z';
const seats: Seat[] = [
  { name: 'Budget Owner', holders: [{ userId: 'u-bo1' }, { userId: 'u-bo2' }] },
  { name: 'Marketing Ops', holders: [{ userId: 'u-mo1' }] },
  { name: 'Finance', holders: [{ userId: 'u-fin1' }] },
  { name: 'CMO', holders: [{ userId: 'u-cmo1' }] },
  { name: 'CFO', holders: [{ userId: 'u-cfo1' }] },
  { name: 'Events Lead', holders: [{ userId: 'u-ev1' }] },
];
const ok = (r: ChainResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
};
const run = (amountCents: bigint, extra: Record<string, unknown> = {}) => evaluateChain({ rules, request: { amountCents, requesterId: 'u-req1', ...extra }, seats, now: NOW });

describe('rules file', () => {
  it('rules/approval-chains.json carries the thresholds set 2026-11-04 (PRD §3, §10.1)', () => {
    expect(rules.chains.default).toEqual([
      { seat: 'Budget Owner', fromCents: 0n },
      { seat: 'Marketing Ops', fromCents: 1000000n },
      { seat: 'Finance', fromCents: 5000000n },
      { seat: 'CMO', fromCents: 10000000n },
      { seat: 'CFO', fromCents: 25000000n },
    ]);
    expect(rules.chains.reallocation).toEqual([
      { seat: 'Marketing Ops', fromCents: 0n },
      { seat: 'Finance', fromCents: 2500000n },
    ]);
    expect(rules.overrides).toEqual([{ when: { costCenter: 'Events' }, append: [{ seat: 'Events Lead', fromCents: 0n }] }]);
    expect(rulesToJson(rules)).toEqual(RULES_JSON);
  });
  it('parseRules reports every problem at once', () => {
    expect(() => parseRules({ default: 'nope' })).toThrow(/non-empty list/);
    expect(() => parseRules({ default: [] })).toThrow(/non-empty list/);
    expect(() => parseRules({ default: [{ seat: '', fromCents: 0 }] })).toThrow(/seat must be a non-empty string/);
    expect(() => parseRules({ default: [{ seat: 'A', fromCents: -1 }] })).toThrow(/must be >= 0/);
    expect(() => parseRules({ default: [{ seat: 'A', fromCents: 0 }], overrides: 'x' })).toThrow(/overrides: must be a list/);
    expect(() => parseRules({ default: [{ seat: 'A', fromCents: 0 }], overrides: [{ when: { costCenter: 1 }, append: [] }] })).toThrow(/object of string fields/);
    expect(() => parseRules({ default: [{ seat: 'A', fromCents: 0 }], overrides: [{ when: { costCenter: 'Events' }, append: [] }] })).toThrow(/append: must be a non-empty list/);
    expect(() => parseRules({ default: [null] })).toThrow(/seat must be a non-empty string/);
    expect(() => parseRules({ reallocation: [{ seat: 'A', fromCents: 0 }] })).toThrow(/"default" chain/);
    expect(parseRules({ default: [{ seat: 'A', fromCents: '5' }] }).chains.default).toEqual([{ seat: 'A', fromCents: 5n }]);
  });
});

describe('time', () => {
  it('parseInstant reads instants and dates, refuses the rest', () => {
    expect(parseInstant('2026-11-05')).toBe(Date.UTC(2026, 10, 5));
    expect(parseInstant('2026-11-05T12:00:00Z')).toBe(Date.UTC(2026, 10, 5, 12));
    expect(parseInstant('2026-11-05T07:00:00-05:00')).toBe(Date.UTC(2026, 10, 5, 12));
    expect(() => parseInstant('soon', 'activeFrom')).toThrow(/activeFrom: cannot parse/);
  });
  it('holderActive: activeFrom inclusive, activeTo exclusive, null bounds open', () => {
    const now = parseInstant(NOW);
    expect(holderActive({ userId: 'u' }, now)).toBe(true);
    expect(holderActive({ userId: 'u', activeFrom: NOW }, now)).toBe(true);
    expect(holderActive({ userId: 'u', activeFrom: '2026-11-06' }, now)).toBe(false);
    expect(holderActive({ userId: 'u', activeTo: NOW }, now)).toBe(false);
    expect(holderActive({ userId: 'u', activeTo: '2026-11-06' }, now)).toBe(true);
    expect(holderActive({ userId: 'u', activeFrom: null, activeTo: null }, now)).toBe(true);
  });
});

describe('evaluateChain', () => {
  it('walks the PRD §3 examples', () => {
    const names = (c: bigint) => ok(run(c)).steps.map((s) => s.seat);
    expect(names(750000n)).toEqual(['Budget Owner']);
    expect(names(2500000n)).toEqual(['Budget Owner', 'Marketing Ops']);
    expect(names(7500000n)).toEqual(['Budget Owner', 'Marketing Ops', 'Finance']);
    expect(names(15000000n)).toEqual(['Budget Owner', 'Marketing Ops', 'Finance', 'CMO']);
    expect(names(30000000n)).toEqual(['Budget Owner', 'Marketing Ops', 'Finance', 'CMO', 'CFO']);
  });
  it('threshold boundaries are inclusive at fromCents', () => {
    expect(ok(run(999999n)).steps).toHaveLength(1);
    expect(ok(run(1000000n)).steps).toHaveLength(2);
    expect(ok(run(4999999n)).steps).toHaveLength(2);
    expect(ok(run(5000000n)).steps).toHaveLength(3);
    expect(ok(run(9999999n)).steps).toHaveLength(3);
    expect(ok(run(10000000n)).steps).toHaveLength(4);
    expect(ok(run(24999999n)).steps).toHaveLength(4);
    expect(ok(run(25000000n)).steps).toHaveLength(5);
  });
  it('records the frozen shape: indexes, sources, thresholds, approvers', () => {
    const r = ok(run(2500000n, { costCenter: 'Events', availableCents: 1n }));
    expect(r.steps.map((s) => [s.index, s.seat, s.source, s.fromCents])).toEqual([
      [0, 'Budget Owner', 'chain', 0n],
      [1, 'Marketing Ops', 'chain', 1000000n],
      [2, 'Finance', 'over-budget', null],
      [3, 'Events Lead', 'override', 0n],
    ]);
    expect(r.steps[2]).toMatchObject({ overBudget: true, requiresNote: true, approverIds: ['u-fin1'], blocked: null });
    expect(r.overBudget).toBe(true);
    expect(r.resubmits).toBeNull();
    expect(r.kind).toBe('default');
    expect(r.amountCents).toBe(2500000n);
  });
  it('refuses bad input with codes, never throws for a bad amount', () => {
    expect(run(0n)).toMatchObject({ ok: false, error: { code: 'CENTS_BELOW_MIN' } });
    expect(evaluateChain({ rules, request: { amountCents: 1.5 as unknown as bigint, requesterId: 'r' }, seats, now: NOW })).toMatchObject({ ok: false, error: { code: 'NOT_INTEGER_CENTS' } });
    expect(run(1n, { requesterId: '' })).toMatchObject({ ok: false, error: { code: 'NO_REQUESTER' } });
    expect(run(1n, { kind: 'bonus' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHAIN' } });
    expect(run(1n, { kind: 'reallocation', crossesFiscalYear: true })).toMatchObject({ ok: false, error: { code: 'REALLOCATION_ACROSS_FISCAL_YEARS' } });
    expect(evaluateChain({ rules, request: { amountCents: 1n, requesterId: 'r' }, seats, now: 'never' })).toMatchObject({ ok: false, error: { code: 'BAD_NOW' } });
    expect(() => run(1n, { availableCents: 'lots' })).toThrow(/availableCents/);
  });
  it('rule 1: the requester is dropped, or the evaluation is refused with a clear message', () => {
    const r = ok(evaluateChain({ rules, request: { amountCents: 100n, requesterId: 'u-bo1' }, seats, now: NOW }));
    expect(r.steps[0]!.approverIds).toEqual(['u-bo2']);
    const solo = evaluateChain({ rules, request: { amountCents: 100n, requesterId: 'u-bo1' }, seats: [{ name: 'Budget Owner', holders: [{ userId: 'u-bo1' }] }], now: NOW });
    expect(solo.ok).toBe(false);
    if (!solo.ok) {
      expect(solo.error.code).toBe('REQUESTER_ONLY_HOLDER');
      expect(solo.error.message).toContain('u-bo1');
      expect(solo.error.message).toContain('Budget Owner');
    }
  });
  it('rule 2: one person counts once; the collapsed step points at the step that holds them', () => {
    const multi: Seat[] = [
      { name: 'Budget Owner', holders: [{ userId: 'u-m' }] },
      { name: 'Marketing Ops', holders: [{ userId: 'u-mo' }] },
      { name: 'Finance', holders: [{ userId: 'u-m' }, { userId: 'u-f' }] },
      { name: 'CMO', holders: [{ userId: 'u-m' }] },
    ];
    const r = ok(evaluateChain({ rules, request: { amountCents: 15000000n, requesterId: 'u-r' }, seats: multi, now: NOW }));
    expect(r.steps.map((s) => [s.seat, s.approverIds])).toEqual([
      ['Budget Owner', ['u-m']],
      ['Marketing Ops', ['u-mo']],
      ['Finance', ['u-f']],
    ]);
    expect(r.collapsed).toEqual([{ seat: 'CMO', fromCents: 10000000n, source: 'chain', into: 0, approverIds: ['u-m'] }]);
  });
  it('rule 3: delegation passes the step and records both ids; inactive holders block', () => {
    const del: Seat[] = [{ name: 'Budget Owner', holders: [{ userId: 'u-bo1', delegateToId: 'u-d', activeTo: '2026-12-01' }] }];
    const r = ok(evaluateChain({ rules, request: { amountCents: 100n, requesterId: 'u-r' }, seats: del, now: NOW }));
    expect(r.steps[0]).toMatchObject({ approverIds: ['u-d'], delegations: [{ from: 'u-bo1', to: 'u-d' }] });
    const gone = ok(evaluateChain({ rules, request: { amountCents: 100n, requesterId: 'u-r' }, seats: del, now: '2026-12-02' }));
    expect(gone.steps[0]).toMatchObject({ approverIds: [], blocked: 'no-active-holder', delegations: [] });
  });
  it('rule 4: over budget marks an existing Finance step rather than adding one', () => {
    const r = ok(run(7500000n, { availableCents: 7499999n }));
    expect(r.steps.filter((s) => s.seat === 'Finance')).toHaveLength(1);
    expect(r.steps[2]).toMatchObject({ seat: 'Finance', source: 'chain', overBudget: true, requiresNote: true });
    expect(ok(run(7500000n, { availableCents: 7500000n })).steps[2]).toMatchObject({ overBudget: false, requiresNote: false });
    expect(ok(run(100n, { overBudget: true })).steps.map((s) => s.source)).toEqual(['chain', 'over-budget']);
  });
});

describe('applyDecisions (rule 5)', () => {
  const chain = ok(run(2500000n));
  it('approves step by step and ends on the last step', () => {
    const o = applyDecisions(chain, [{ step: 0, byId: 'u-bo1', decision: 'approve' }, { step: 1, byId: 'u-mo1', decision: 'approve', note: 'fine' }], 'u-req1');
    expect(o).toMatchObject({ state: 'approved', currentStep: null, rejectedAt: null });
    expect(o.decided).toEqual([
      { step: 0, byId: 'u-bo1', decision: 'approve', note: null },
      { step: 1, byId: 'u-mo1', decision: 'approve', note: 'fine' },
    ]);
  });
  it('a rejection ends the chain', () => {
    const o = applyDecisions(chain, [{ step: 0, byId: 'u-bo1', decision: 'reject' }, { step: 1, byId: 'u-mo1', decision: 'approve' }], 'u-req1');
    expect(o).toMatchObject({ state: 'rejected', rejectedAt: 0, currentStep: null });
    expect(o.results).toEqual([{ accepted: true, reason: null }, { accepted: false, reason: 'CHAIN_ENDED' }]);
  });
  it('refuses with the reason', () => {
    const reasons = applyDecisions(
      chain,
      [
        { step: 1, byId: 'u-mo1', decision: 'approve' },
        { step: 9, byId: 'u-bo1', decision: 'approve' },
        { step: 0, byId: 'u-req1', decision: 'approve' },
        { step: 0, byId: 'u-mo1', decision: 'approve' },
        { step: 0, byId: 'u-bo1', decision: 'defer' as 'approve' },
      ],
      'u-req1',
    ).results.map((r) => r.reason);
    expect(reasons).toEqual(['OUT_OF_ORDER', 'NO_SUCH_STEP', 'SELF_APPROVAL', 'NOT_AN_APPROVER', 'BAD_DECISION']);
  });
  it('an empty chain is approved outright', () => {
    const empty = { ...chain, steps: [] };
    expect(applyDecisions(empty, [{ step: 0, byId: 'x', decision: 'approve' }], 'r')).toMatchObject({ state: 'approved', currentStep: null, results: [{ accepted: false, reason: 'CHAIN_ENDED' }] });
  });
});

describe('authorizeRuleEdit (rule 6)', () => {
  const edited = (chain: string, seat: string, cents: bigint) => ({
    chains: { ...rules.chains, [chain]: rules.chains[chain]!.map((s) => (s.seat === seat ? { ...s, fromCents: cents } : s)) },
    overrides: rules.overrides,
  });
  it('admin may move a threshold below the top step; the audit carries before and after', () => {
    const r = authorizeRuleEdit('admin', rules, edited('default', 'Marketing Ops', 1500000n));
    expect(r).toMatchObject({ ok: true, required: 'admin', refused: null });
    expect(r.changes).toEqual([{ chain: 'default', kind: 'threshold', seat: 'Marketing Ops', before: 1000000n, after: 1500000n, requires: 'admin' }]);
    expect(r.audit.before).toEqual(RULES_JSON);
    expect((r.audit.after as { default: { fromCents: number }[] }).default[1]!.fromCents).toBe(1500000);
  });
  it('the top step and seat changes need owner', () => {
    expect(authorizeRuleEdit('admin', rules, edited('default', 'CFO', 1n)).refused).toMatch(/needs owner \(threshold CFO in default\)/);
    expect(authorizeRuleEdit('owner', rules, edited('default', 'CFO', 1n)).ok).toBe(true);
    const fewer = { chains: { ...rules.chains, default: rules.chains.default!.slice(0, 4) }, overrides: rules.overrides };
    expect(authorizeRuleEdit('admin', rules, fewer)).toMatchObject({ ok: false, required: 'owner', changes: [{ kind: 'seat-removed', seat: 'CFO' }] });
    expect(authorizeRuleEdit('owner', fewer, rules)).toMatchObject({ ok: true, changes: [{ kind: 'seat-added', seat: 'CFO', after: 25000000n }] });
    expect(authorizeRuleEdit('owner', rules, { ...rules, overrides: [] })).toMatchObject({ ok: true, required: 'owner', changes: [{ kind: 'overrides' }] });
    expect(authorizeRuleEdit('admin', rules, { chains: { ...rules.chains, extra: [{ seat: 'X', fromCents: 0n }] }, overrides: rules.overrides })).toMatchObject({ ok: false, changes: [{ kind: 'chain-added', chain: 'extra' }] });
    expect(authorizeRuleEdit('owner', { chains: { ...rules.chains, extra: [{ seat: 'X', fromCents: 0n }] }, overrides: rules.overrides }, rules)).toMatchObject({ ok: true, changes: [{ kind: 'chain-removed', chain: 'extra' }] });
  });
  it('no change needs nobody; unknown roles may change nothing', () => {
    expect(authorizeRuleEdit('guest', rules, rules)).toMatchObject({ ok: true, required: 'none', changes: [] });
    expect(authorizeRuleEdit('intern', rules, edited('default', 'Marketing Ops', 1n))).toMatchObject({ ok: false, required: 'admin' });
    expect(authorizeRuleEdit('member', rules, edited('reallocation', 'Finance', 1n))).toMatchObject({ ok: false, required: 'owner' });
  });
});
