// Approval chains as data (PRD D-03, §3). Pure: a chain is evaluated once at submit from rules/approval-chains.json,
// the seats and their holders, and the request; the result is what the app freezes on the request as chainSnapshot.
// Oracle: tools/chain_oracle.py. Every rule below is numbered as in PRD §3.
//
//   1. A requester never approves their own request: they are dropped from every step they hold (or are delegated),
//      and a step they alone could decide refuses the whole evaluation with a clear message.
//   2. One person counts once per request: each approver is placed on the first step they are eligible for; a step
//      left with nobody new collapses into the step that already holds its approvers.
//   3. Delegation: an active holder with delegateToId passes the step to the delegate; both ids are recorded.
//   4. Over budget (amount > the line's available) adds a mandatory Finance step with a required note, or marks the
//      Finance step the chain already has; the result is flagged overBudget.
//   5. A rejection ends the chain (applyDecisions). A resubmission is a new request linking the old one.
//   6. Rule edits: admin for thresholds below the top step, owner for the top step and for adding or removing seats;
//      every edit carries the before and after JSON (authorizeRuleEdit).
//
// PRD §10.6 default: a seat with no active holder blocks its step; it never auto-skips.

import { type Cents, jsonCents, MoneyError, requireCents, toCents } from './money';

export type RuleStep = { seat: string; fromCents: Cents };
export type RuleOverride = { when: Record<string, string>; append: RuleStep[] };
export type ApprovalRules = { chains: Record<string, RuleStep[]>; overrides: RuleOverride[] };

/** The JSON file shape: every key but `overrides` is a chain. Cents may be integers or digit strings. */
export type RulesJson = Record<string, unknown>;

export type SeatHolder = { userId: string; activeFrom?: string | null; activeTo?: string | null; delegateToId?: string | null };
export type Seat = { name: string; holders: SeatHolder[] };

export type ChainRequest = {
  amountCents: Cents;
  requesterId: string;
  kind?: string; // 'default' | 'reallocation' | any chain the rules define
  costCenter?: string | null;
  availableCents?: Cents | null; // the line's available at submit (rule 4)
  overBudget?: boolean; // explicit alternative to availableCents
  crossesFiscalYear?: boolean; // reallocation across fiscal years is refused (PRD §10.7)
  resubmitsRequestId?: string | null; // rule 5
};

export type ChainInput = { rules: ApprovalRules; request: ChainRequest; seats: Seat[]; now: string };

export type StepSource = 'chain' | 'over-budget' | 'override';
export type Delegation = { from: string; to: string };
export type ChainStep = {
  index: number;
  seat: string;
  fromCents: Cents | null; // null for the over-budget step: it has no threshold
  source: StepSource;
  approverIds: string[];
  delegations: Delegation[];
  blocked: 'no-active-holder' | null;
  overBudget: boolean;
  requiresNote: boolean;
};
export type SkippedStep = { seat: string; fromCents: Cents; source: StepSource };
export type CollapsedStep = { seat: string; fromCents: Cents | null; source: StepSource; into: number; approverIds: string[] };

export type ChainError = { code: string; message: string };
export type ChainResult =
  | {
      ok: true;
      kind: string;
      amountCents: Cents;
      overBudget: boolean;
      resubmits: string | null;
      steps: ChainStep[];
      skipped: SkippedStep[];
      collapsed: CollapsedStep[];
    }
  | { ok: false; error: ChainError };

export const FINANCE_SEAT = 'Finance';

// ---------- rules ----------

/** Parses and validates the rules file. Throws MoneyError on a bad amount, Error with a list of problems otherwise. */
export function parseRules(json: RulesJson): ApprovalRules {
  const chains: Record<string, RuleStep[]> = {};
  const problems: string[] = [];
  const stepsOf = (raw: unknown, where: string): RuleStep[] => {
    if (!Array.isArray(raw) || raw.length === 0) {
      problems.push(`${where}: must be a non-empty list of steps`);
      return [];
    }
    const out: RuleStep[] = [];
    const seen = new Set<string>();
    let last = -1n;
    for (const [i, s] of raw.entries()) {
      const step = s as { seat?: unknown; fromCents?: unknown };
      if (typeof step?.seat !== 'string' || !step.seat.trim()) {
        problems.push(`${where}[${i}]: seat must be a non-empty string`);
        continue;
      }
      let from: Cents;
      try {
        from = requireCents(step.fromCents, `${where}[${i}].fromCents`, { min: 0n });
      } catch (e) {
        problems.push((e as Error).message);
        continue;
      }
      if (seen.has(step.seat)) problems.push(`${where}[${i}]: seat "${step.seat}" appears twice`);
      if (from < last) problems.push(`${where}[${i}]: fromCents ${from} is below the previous step's ${last}; steps must be in ascending order`);
      seen.add(step.seat);
      last = from;
      out.push({ seat: step.seat, fromCents: from });
    }
    return out;
  };
  for (const [name, raw] of Object.entries(json)) {
    if (name === 'overrides') continue;
    chains[name] = stepsOf(raw, name);
  }
  if (!('default' in chains)) problems.push('rules must define a "default" chain');
  const overrides: RuleOverride[] = [];
  const rawOverrides = json.overrides ?? [];
  if (!Array.isArray(rawOverrides)) problems.push('overrides: must be a list');
  else
    for (const [i, o] of rawOverrides.entries()) {
      const ov = o as { when?: unknown; append?: unknown };
      const when = ov?.when;
      if (!when || typeof when !== 'object' || Array.isArray(when) || Object.keys(when).length === 0 || Object.values(when).some((v) => typeof v !== 'string')) {
        problems.push(`overrides[${i}].when: must be an object of string fields`);
        continue;
      }
      overrides.push({ when: when as Record<string, string>, append: stepsOf(ov.append, `overrides[${i}].append`) });
    }
  if (problems.length) throw new Error(`approval rules invalid: ${problems.join('; ')}`);
  return { chains, overrides };
}

/** Rules back to their JSON shape (cents as integers), e.g. for the audit event of rule 6. */
export function rulesToJson(rules: ApprovalRules): RulesJson {
  const out: RulesJson = {};
  for (const [name, steps] of Object.entries(rules.chains)) out[name] = steps.map((s) => ({ seat: s.seat, fromCents: jsonCents(s.fromCents) }));
  out.overrides = rules.overrides.map((o) => ({ when: { ...o.when }, append: o.append.map((s) => ({ seat: s.seat, fromCents: jsonCents(s.fromCents) })) }));
  return out;
}

// ---------- time ----------

/** ISO 8601 instant or date (date = midnight UTC) to epoch milliseconds. Mirrors parse_instant in the oracle. */
export function parseInstant(text: string, what = 'instant'): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`${what}: cannot parse ${JSON.stringify(text)} as an ISO 8601 instant`);
  return t;
}

export function holderActive(h: SeatHolder, nowMs: number): boolean {
  if (h.activeFrom && parseInstant(h.activeFrom, 'activeFrom') > nowMs) return false;
  if (h.activeTo && parseInstant(h.activeTo, 'activeTo') <= nowMs) return false;
  return true;
}

// ---------- evaluation ----------

type Candidate = { seat: string; fromCents: Cents | null; source: StepSource };

function overrideApplies(o: RuleOverride, request: ChainRequest): boolean {
  const fields: Record<string, string | null | undefined> = { costCenter: request.costCenter, kind: request.kind ?? 'default' };
  return Object.entries(o.when).every(([k, v]) => fields[k] === v);
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Rules 1–4 over one request. Never throws on a bad request; returns { ok: false } with a code instead. */
export function evaluateChain(input: ChainInput): ChainResult {
  const { rules, request, seats } = input;
  const fail = (code: string, message: string): ChainResult => ({ ok: false, error: { code, message } });

  let amount: Cents;
  try {
    amount = requireCents(request.amountCents, 'amountCents', { min: 1n });
  } catch (e) {
    return fail((e as MoneyError).code ?? 'BAD_AMOUNT', (e as Error).message);
  }
  if (!request.requesterId) return fail('NO_REQUESTER', 'request.requesterId is required');
  const kind = request.kind ?? 'default';
  const chain = rules.chains[kind];
  if (!chain) return fail('UNKNOWN_CHAIN', `no "${kind}" chain in the approval rules`);
  if (kind === 'reallocation' && request.crossesFiscalYear) return fail('REALLOCATION_ACROSS_FISCAL_YEARS', 'a reallocation across fiscal years is refused (PRD §10.7)');
  let nowMs: number;
  try {
    nowMs = parseInstant(input.now, 'now');
  } catch (e) {
    return fail('BAD_NOW', (e as Error).message);
  }

  const overBudget = request.overBudget === true || (request.availableCents != null && amount > toCents(request.availableCents, 'availableCents'));

  // Threshold filter (a step whose threshold is above the amount is skipped), chain first, then overrides.
  const skipped: SkippedStep[] = [];
  const keep = (steps: RuleStep[], source: StepSource): Candidate[] => {
    const kept: Candidate[] = [];
    for (const s of steps) {
      if (amount >= s.fromCents) kept.push({ seat: s.seat, fromCents: s.fromCents, source });
      else skipped.push({ seat: s.seat, fromCents: s.fromCents, source });
    }
    return kept;
  };
  const fromChain = keep(chain, 'chain');
  const fromOverrides = rules.overrides.filter((o) => overrideApplies(o, request)).flatMap((o) => keep(o.append, 'override'));

  // Rule 4: the mandatory over-budget step at Finance, unless Finance is already in the chain.
  const candidates: Candidate[] = [...fromChain];
  const financeAlready = [...fromChain, ...fromOverrides].some((c) => c.seat === FINANCE_SEAT);
  if (overBudget && !financeAlready) candidates.push({ seat: FINANCE_SEAT, fromCents: null, source: 'over-budget' });
  candidates.push(...fromOverrides);

  // Rules 3 and 1: resolve holders to approvers, delegation first, then drop the requester.
  const seatByName = new Map(seats.map((s) => [s.name, s]));
  type Resolved = Candidate & { eligible: string[]; delegations: Delegation[]; blocked: 'no-active-holder' | null };
  const resolved: Resolved[] = [];
  for (const c of candidates) {
    const holders = (seatByName.get(c.seat)?.holders ?? []).filter((h) => holderActive(h, nowMs));
    const effective: string[] = [];
    const delegations: Delegation[] = [];
    for (const h of holders) {
      const to = h.delegateToId && h.delegateToId !== h.userId ? h.delegateToId : null;
      if (to) delegations.push({ from: h.userId, to });
      effective.push(to ?? h.userId);
    }
    const all = uniq(effective);
    const eligible = all.filter((id) => id !== request.requesterId);
    if (all.length && !eligible.length)
      return fail(
        'REQUESTER_ONLY_HOLDER',
        `${request.requesterId} is the only active approver for the ${c.seat} seat and may not approve their own request; add another holder or a delegate, or have someone else submit it.`,
      );
    resolved.push({ ...c, eligible, delegations: delegations.filter((d) => eligible.includes(d.to)), blocked: holders.length ? null : 'no-active-holder' });
  }

  // Rule 2: each person on the first step they are eligible for; a step left with nobody new collapses into the
  // earliest step that already holds one of its approvers. Rule 4's note requirement follows the Finance step there.
  const steps: ChainStep[] = [];
  const collapsed: CollapsedStep[] = [];
  const placedAt = new Map<string, number>(); // approver -> index of the step that holds them
  for (const r of resolved) {
    const isOverBudgetStep = overBudget && r.seat === FINANCE_SEAT;
    const fresh = r.eligible.filter((id) => !placedAt.has(id));
    if (r.eligible.length && !fresh.length) {
      const into = Math.min(...r.eligible.map((id) => placedAt.get(id)!));
      collapsed.push({ seat: r.seat, fromCents: r.fromCents, source: r.source, into, approverIds: r.eligible });
      if (isOverBudgetStep) {
        steps[into]!.overBudget = true;
        steps[into]!.requiresNote = true;
      }
      continue;
    }
    const index = steps.length;
    for (const id of fresh) placedAt.set(id, index);
    steps.push({
      index,
      seat: r.seat,
      fromCents: r.fromCents,
      source: r.source,
      approverIds: fresh,
      delegations: r.delegations.filter((d) => fresh.includes(d.to)),
      blocked: r.blocked,
      overBudget: isOverBudgetStep,
      requiresNote: isOverBudgetStep,
    });
  }

  return { ok: true, kind, amountCents: amount, overBudget, resubmits: request.resubmitsRequestId ?? null, steps, skipped, collapsed };
}

// ---------- rule 5: decisions ----------

export type Decision = { step: number; byId: string; decision: 'approve' | 'reject'; note?: string | null };
export type DecisionResult = { accepted: boolean; reason: string | null };
export type ChainState = 'pending' | 'approved' | 'rejected';
export type DecisionOutcome = {
  state: ChainState;
  currentStep: number | null; // the step waiting for a decision, null once the chain has ended
  rejectedAt: number | null;
  decided: Decision[];
  results: DecisionResult[]; // one per input decision, in order
};

/**
 * Walks decisions over a frozen chain, one step at a time. A rejection ends the chain; every later decision is
 * refused with CHAIN_ENDED. A requester (excluded at evaluation) is refused again here as SELF_APPROVAL.
 */
export function applyDecisions(chain: Extract<ChainResult, { ok: true }>, decisions: Decision[], requesterId: string): DecisionOutcome {
  const out: DecisionOutcome = { state: 'pending', currentStep: chain.steps.length ? 0 : null, rejectedAt: null, decided: [], results: [] };
  if (!chain.steps.length) out.state = 'approved';
  for (const d of decisions) {
    const refuse = (reason: string) => out.results.push({ accepted: false, reason });
    if (out.state !== 'pending') {
      refuse('CHAIN_ENDED');
      continue;
    }
    const step = chain.steps[d.step];
    if (!step) {
      refuse('NO_SUCH_STEP');
      continue;
    }
    if (d.step !== out.currentStep) {
      refuse('OUT_OF_ORDER');
      continue;
    }
    if (step.blocked) {
      refuse('STEP_BLOCKED');
      continue;
    }
    if (d.byId === requesterId) {
      refuse('SELF_APPROVAL');
      continue;
    }
    if (!step.approverIds.includes(d.byId)) {
      refuse('NOT_AN_APPROVER');
      continue;
    }
    if (d.decision !== 'approve' && d.decision !== 'reject') {
      refuse('BAD_DECISION');
      continue;
    }
    if (step.requiresNote && !(d.note ?? '').trim()) {
      refuse('NOTE_REQUIRED');
      continue;
    }
    out.results.push({ accepted: true, reason: null });
    out.decided.push({ step: d.step, byId: d.byId, decision: d.decision, note: d.note ?? null });
    if (d.decision === 'reject') {
      out.state = 'rejected';
      out.rejectedAt = d.step;
      out.currentStep = null;
    } else if (d.step + 1 >= chain.steps.length) {
      out.state = 'approved';
      out.currentStep = null;
    } else out.currentStep = d.step + 1;
  }
  return out;
}

// ---------- rule 6: rule edits ----------

export type EditRequirement = 'admin' | 'owner';
export type RuleChange = { chain: string; kind: 'threshold' | 'seat-added' | 'seat-removed' | 'seat-reordered' | 'overrides' | 'chain-added' | 'chain-removed'; seat: string | null; before: Cents | null; after: Cents | null; requires: EditRequirement };
export type RuleEditResult = {
  ok: boolean;
  required: EditRequirement | 'none';
  role: string;
  changes: RuleChange[];
  refused: string | null;
  audit: { before: RulesJson; after: RulesJson };
};

const RANK: Record<string, number> = { owner: 2, admin: 1 };

/** What an edit changes, who may make it, and the before/after JSON for the audit event. */
export function authorizeRuleEdit(role: string, before: ApprovalRules, after: ApprovalRules): RuleEditResult {
  const changes: RuleChange[] = [];
  const names = uniq([...Object.keys(before.chains), ...Object.keys(after.chains)]);
  for (const name of names) {
    const b = before.chains[name];
    const a = after.chains[name];
    if (!b) {
      changes.push({ chain: name, kind: 'chain-added', seat: null, before: null, after: null, requires: 'owner' });
      continue;
    }
    if (!a) {
      changes.push({ chain: name, kind: 'chain-removed', seat: null, before: null, after: null, requires: 'owner' });
      continue;
    }
    const bSeats = b.map((s) => s.seat);
    const aSeats = a.map((s) => s.seat);
    for (const s of b) if (!aSeats.includes(s.seat)) changes.push({ chain: name, kind: 'seat-removed', seat: s.seat, before: s.fromCents, after: null, requires: 'owner' });
    for (const s of a) if (!bSeats.includes(s.seat)) changes.push({ chain: name, kind: 'seat-added', seat: s.seat, before: null, after: s.fromCents, requires: 'owner' });
    const common = bSeats.filter((s) => aSeats.includes(s));
    const aOrder = aSeats.filter((s) => common.includes(s));
    if (common.join('\u0000') !== aOrder.join('\u0000')) changes.push({ chain: name, kind: 'seat-reordered', seat: null, before: null, after: null, requires: 'owner' });
    const top = a[a.length - 1]!.seat; // the top step is the last one of the chain as edited
    for (const seat of common) {
      const bc = b.find((s) => s.seat === seat)!.fromCents;
      const ac = a.find((s) => s.seat === seat)!.fromCents;
      if (bc !== ac) changes.push({ chain: name, kind: 'threshold', seat, before: bc, after: ac, requires: seat === top ? 'owner' : 'admin' });
    }
  }
  if (JSON.stringify(rulesToJson(before).overrides) !== JSON.stringify(rulesToJson(after).overrides))
    changes.push({ chain: 'overrides', kind: 'overrides', seat: null, before: null, after: null, requires: 'owner' });

  const required: EditRequirement | 'none' = changes.some((c) => c.requires === 'owner') ? 'owner' : changes.length ? 'admin' : 'none';
  const have = RANK[role] ?? 0;
  const ok = required === 'none' || have >= RANK[required]!;
  return {
    ok,
    required,
    role,
    changes,
    refused: ok ? null : `${role} may not make this edit: it needs ${required} (${changes.filter((c) => c.requires === required).map((c) => `${c.kind}${c.seat ? ` ${c.seat}` : ''} in ${c.chain}`).join(', ')})`,
    audit: { before: rulesToJson(before), after: rulesToJson(after) },
  };
}
