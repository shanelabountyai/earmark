// Invoice-to-commitment matching (PRD §4, D-05). Pure; oracle in tools/match_oracle.py.
//
// suggestMatches proposes, a person decides: ranked by PO number on the invoice, then agency + amount within 2 %
// of what the commitment has left, then agency alone, each with its reasons. applyMatch is the decision's money
// rule: a match that would take a commitment negative is an overage, refused unless the matcher holds the Finance
// seat and adds a note; an accepted overage is flagged so it is tracked.

import { abs, type Cents, jsonCents, requireCents, withinPercent } from './money';

export const AMOUNT_TOLERANCE_PERCENT = 2n;
export const FINANCE_SEAT = 'Finance';

export type MatchInvoice = { id: string; agencyId: string; amountCents: Cents; poNumber?: string | null };
export type MatchCommitment = { id: string; agencyId: string; poNumber: string; amountCents: Cents; remainingCents: Cents; state: 'open' | 'closed' };

export type Tier = 1 | 2 | 3 | 4;
export type Suggestion = {
  rank: number; // 1 = best
  commitmentId: string;
  tier: Tier; // 1 po+agency, 2 po only, 3 agency+amount, 4 agency
  reasons: string[];
  remainingCents: Cents;
  differenceCents: Cents; // invoice − remaining (positive = the invoice bills more than is left)
  wouldOverage: boolean;
};
export type Excluded = { commitmentId: string; reason: 'po-closed' };
export type Suggestions = { invoiceId: string; suggestions: Suggestion[]; excluded: Excluded[] };

/** PO numbers compare trimmed, upper-cased, with runs of whitespace collapsed. */
export const normalizePo = (po: string | null | undefined): string => (po ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export function suggestMatches(invoice: MatchInvoice, commitments: MatchCommitment[]): Suggestions {
  const amount = requireCents(invoice.amountCents, `invoice ${invoice.id} amountCents`, { min: 0n });
  const po = normalizePo(invoice.poNumber);
  const rows: Omit<Suggestion, 'rank'>[] = [];
  const excluded: Excluded[] = [];
  for (const c of commitments) {
    const remaining = requireCents(c.remainingCents, `commitment ${c.id} remainingCents`);
    const poHit = po !== '' && normalizePo(c.poNumber) === po;
    const agencyHit = c.agencyId === invoice.agencyId;
    if (c.state !== 'open') {
      if (poHit) excluded.push({ commitmentId: c.id, reason: 'po-closed' });
      continue;
    }
    let tier: Tier;
    const reasons: string[] = [];
    if (poHit && agencyHit) {
      tier = 1;
      reasons.push('po-number', 'agency');
    } else if (poHit) {
      tier = 2;
      reasons.push('po-number', 'agency-mismatch');
    } else if (agencyHit && remaining >= 0n && withinPercent(amount, remaining, AMOUNT_TOLERANCE_PERCENT)) {
      tier = 3;
      reasons.push('agency', 'amount-within-2pct');
    } else if (agencyHit) {
      tier = 4;
      reasons.push('agency');
    } else continue;
    const difference = amount - remaining;
    if (difference === 0n) reasons.push('exact-remaining');
    const wouldOverage = difference > 0n;
    if (wouldOverage) reasons.push('would-overage');
    rows.push({ commitmentId: c.id, tier, reasons, remainingCents: remaining, differenceCents: difference, wouldOverage });
  }
  rows.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const da = abs(a.differenceCents);
    const db = abs(b.differenceCents);
    if (da !== db) return da < db ? -1 : 1;
    if (a.remainingCents !== b.remainingCents) return a.remainingCents > b.remainingCents ? -1 : 1;
    return a.commitmentId < b.commitmentId ? -1 : a.commitmentId > b.commitmentId ? 1 : 0;
  });
  excluded.sort((a, b) => (a.commitmentId < b.commitmentId ? -1 : a.commitmentId > b.commitmentId ? 1 : 0));
  return { invoiceId: invoice.id, suggestions: rows.map((r, i) => ({ rank: i + 1, ...r })), excluded };
}

export type Variance = 'exact' | 'under' | 'over';
export type MatchDecision = { commitmentId: string; amountCents: Cents; matcherSeats: string[]; note?: string | null };
export type MatchApplied =
  | { ok: true; commitmentId: string; amountCents: Cents; remainingBefore: Cents; remainingAfter: Cents; variance: Variance; overage: boolean; overageCents: Cents; closes: boolean }
  | { ok: false; commitmentId: string; amountCents: Cents; code: string; message: string; remainingBefore: Cents };

/** One match against one commitment's remaining balance. Pure: returns the new remaining, never stores it. */
export function applyMatch(commitment: { id: string; remainingCents: Cents; state: 'open' | 'closed' }, decision: MatchDecision): MatchApplied {
  const remainingBefore = requireCents(commitment.remainingCents, `commitment ${commitment.id} remainingCents`);
  const refuse = (code: string, message: string, amountCents: Cents): MatchApplied => ({ ok: false, commitmentId: commitment.id, amountCents, code, message, remainingBefore });
  let amount: Cents;
  try {
    amount = requireCents(decision.amountCents, 'match amountCents', { min: 1n });
  } catch (e) {
    return refuse('BAD_AMOUNT', (e as Error).message, 0n);
  }
  if (commitment.state !== 'open') return refuse('COMMITMENT_CLOSED', `commitment ${commitment.id} is closed; reopen it or match another`, amount);
  const after = remainingBefore - amount;
  const overage = after < 0n;
  if (overage) {
    if (!decision.matcherSeats.includes(FINANCE_SEAT)) return refuse('OVERAGE_NEEDS_FINANCE', `matching ${amount} would take commitment ${commitment.id} to ${after}; only a Finance seat holder may record an overage`, amount);
    if (!(decision.note ?? '').trim()) return refuse('OVERAGE_NEEDS_NOTE', `an overage on commitment ${commitment.id} needs a note`, amount);
  }
  return {
    ok: true,
    commitmentId: commitment.id,
    amountCents: amount,
    remainingBefore,
    remainingAfter: after,
    variance: after === 0n ? 'exact' : after > 0n ? 'under' : 'over',
    overage,
    overageCents: overage ? -after : 0n,
    closes: after <= 0n,
  };
}

export type MatchRun = { results: MatchApplied[]; remaining: Record<string, Cents>; overageFlagged: boolean };

/** A sequence of matches over a set of commitments, remaining threaded through in order. */
export function applyMatches(commitments: MatchCommitment[], decisions: MatchDecision[]): MatchRun {
  const state = new Map(commitments.map((c) => [c.id, { id: c.id, remainingCents: requireCents(c.remainingCents, `commitment ${c.id} remainingCents`), state: c.state }]));
  const results: MatchApplied[] = [];
  let overageFlagged = false;
  for (const d of decisions) {
    const c = state.get(d.commitmentId);
    if (!c) {
      results.push({ ok: false, commitmentId: d.commitmentId, amountCents: requireCents(d.amountCents, 'match amountCents'), code: 'UNKNOWN_COMMITMENT', message: `no commitment ${d.commitmentId}`, remainingBefore: 0n });
      continue;
    }
    const r = applyMatch(c, d);
    results.push(r);
    if (r.ok) {
      c.remainingCents = r.remainingAfter;
      if (r.closes) c.state = 'closed';
      if (r.overage) overageFlagged = true;
    }
  }
  const remaining: Record<string, Cents> = {};
  for (const c of [...state.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) remaining[c.id] = c.remainingCents;
  return { results, remaining, overageFlagged };
}

export function suggestionsToJson(s: Suggestions): unknown {
  return {
    invoiceId: s.invoiceId,
    suggestions: s.suggestions.map((x) => ({ ...x, remainingCents: jsonCents(x.remainingCents), differenceCents: jsonCents(x.differenceCents) })),
    excluded: s.excluded,
  };
}

export function matchRunToJson(run: MatchRun): unknown {
  return {
    results: run.results.map((r) =>
      r.ok
        ? { ...r, amountCents: jsonCents(r.amountCents), remainingBefore: jsonCents(r.remainingBefore), remainingAfter: jsonCents(r.remainingAfter), overageCents: jsonCents(r.overageCents) }
        : { ...r, amountCents: jsonCents(r.amountCents), remainingBefore: jsonCents(r.remainingBefore) },
    ),
    remaining: Object.fromEntries(Object.entries(run.remaining).map(([k, v]) => [k, jsonCents(v)])),
    overageFlagged: run.overageFlagged,
  };
}
