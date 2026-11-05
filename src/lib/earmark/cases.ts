// The JSON face of the engines: one function per oracle, fixture input in, the oracle's output shape out.
// tests/earmark/parity.test.ts runs every file in fixtures/ through these and through tools/*_oracle.py and diffs.
// Cents cross this boundary as JSON integers (see money.ts).

import { type ApprovalRules, applyDecisions, authorizeRuleEdit, type ChainResult, type Decision, type DecisionOutcome, evaluateChain, parseRules, type RuleEditResult, type RulesJson, type Seat } from './chain';
import { applyMatches, type MatchCommitment, type MatchDecision, type MatchInvoice, matchRunToJson, suggestionsToJson, suggestMatches } from './match';
import { jsonCents, toCents } from './money';
import { type Ledger, rollup, rollupToJson } from './rollup';
import { variance, type VarianceInput, varianceToJson } from './variance';

type Json = Record<string, unknown>;

const optCents = (v: unknown, what: string) => (v === undefined || v === null ? null : toCents(v, what));

// ---------- chain ----------

export function chainToJson(r: ChainResult): unknown {
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    kind: r.kind,
    amountCents: jsonCents(r.amountCents),
    overBudget: r.overBudget,
    resubmits: r.resubmits,
    steps: r.steps.map((s) => ({ ...s, fromCents: s.fromCents === null ? null : jsonCents(s.fromCents) })),
    skipped: r.skipped.map((s) => ({ ...s, fromCents: jsonCents(s.fromCents) })),
    collapsed: r.collapsed.map((s) => ({ ...s, fromCents: s.fromCents === null ? null : jsonCents(s.fromCents) })),
  };
}

export function ruleEditToJson(r: RuleEditResult): unknown {
  return { ...r, changes: r.changes.map((c) => ({ ...c, before: c.before === null ? null : jsonCents(c.before), after: c.after === null ? null : jsonCents(c.after) })) };
}

/**
 * chain_oracle.py's contract. op "evaluate" (default): { rules, request, seats, now, decisions? } ->
 * { chain, outcome }. op "edit": { role, before, after } -> the rule-edit result.
 */
export function runChainCase(input: Json): unknown {
  if (input.op === 'edit') {
    let before: ApprovalRules;
    let after: ApprovalRules;
    try {
      before = parseRules(input.before as RulesJson);
      after = parseRules(input.after as RulesJson);
    } catch (e) {
      return { ok: false, error: { code: 'RULES_INVALID', message: (e as Error).message } };
    }
    return ruleEditToJson(authorizeRuleEdit(String(input.role), before, after));
  }
  let rules: ApprovalRules;
  try {
    rules = parseRules(input.rules as RulesJson);
  } catch (e) {
    return { chain: { ok: false, error: { code: 'RULES_INVALID', message: (e as Error).message } }, outcome: null };
  }
  const req = (input.request ?? {}) as Json;
  let chain: ChainResult;
  try {
    chain = evaluateChain({
      rules,
      request: {
        amountCents: req.amountCents as bigint, // validated inside evaluateChain
        requesterId: String(req.requesterId ?? ''),
        kind: req.kind === undefined || req.kind === null ? undefined : String(req.kind),
        costCenter: (req.costCenter as string | null | undefined) ?? null,
        availableCents: optCents(req.availableCents, 'availableCents'),
        overBudget: req.overBudget === true,
        crossesFiscalYear: req.crossesFiscalYear === true,
        resubmitsRequestId: (req.resubmitsRequestId as string | null | undefined) ?? null,
      },
      seats: (input.seats ?? []) as Seat[],
      now: String(input.now ?? ''),
    });
  } catch (e) {
    chain = { ok: false, error: { code: 'BAD_INPUT', message: (e as Error).message } };
  }
  let outcome: DecisionOutcome | null = null;
  if (chain.ok && Array.isArray(input.decisions)) outcome = applyDecisions(chain, input.decisions as Decision[], String(req.requesterId ?? ''));
  return { chain: chainToJson(chain), outcome };
}

// ---------- rollup ----------

export function runRollupCase(input: Json): unknown {
  try {
    return { ok: true, rollup: rollupToJson(rollup(input as unknown as Ledger)) };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, error: { code: err.code ?? 'BAD_INPUT', message: err.message } };
  }
}

// ---------- match ----------

export function runMatchCase(input: Json): unknown {
  try {
    const commitments = (input.commitments ?? []) as MatchCommitment[];
    const suggestions = input.invoice ? suggestionsToJson(suggestMatches(input.invoice as MatchInvoice, commitments)) : null;
    const applied = Array.isArray(input.apply) ? matchRunToJson(applyMatches(commitments, input.apply as MatchDecision[])) : null;
    return { ok: true, suggestions, applied };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, error: { code: err.code ?? 'BAD_INPUT', message: err.message } };
  }
}

// ---------- variance ----------

export function runVarianceCase(input: Json): unknown {
  try {
    return { ok: true, variance: varianceToJson(variance(input as unknown as VarianceInput)) };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, error: { code: err.code ?? 'BAD_INPUT', message: err.message } };
  }
}

export const RUNNERS = { chain: runChainCase, rollup: runRollupCase, match: runMatchCase, variance: runVarianceCase } as const;
export type Engine = keyof typeof RUNNERS;
