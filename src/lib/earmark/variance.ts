// Variance per line per period (PRD §4): actual − planned, as cents and as basis points of planned. A line with
// zero planned and non-zero actual is "unplanned", not a division. Pure; oracle in tools/variance_oracle.py.
//
// The replan marker: planned was edited after the first commitment against the line (PRD §4 "Planned"), derived
// here from the edit instants and the first commitment's instant so the variance view can show it.

import { type Cents, jsonCents, ratioBps, requireCents } from './money';
import { parseInstant } from './chain';

export type VarianceLine = {
  lineId: string;
  plannedCents: Cents;
  actualCents: Cents;
  plannedEditedAt?: string[] | null; // instants planned was edited
  firstCommittedAt?: string | null; // instant of the first commitment against the line
};
export type VarianceInput = { periodId: string; lines: VarianceLine[] };

export type VarianceStatus = 'over' | 'under' | 'on-plan' | 'unplanned';
export type VarianceRow = {
  lineId: string;
  plannedCents: Cents;
  actualCents: Cents;
  varianceCents: Cents;
  varianceBps: bigint | null; // null when planned is zero
  status: VarianceStatus;
  unplanned: boolean;
  replan: boolean;
};
export type VarianceReport = {
  periodId: string;
  rows: VarianceRow[];
  totals: { plannedCents: Cents; actualCents: Cents; varianceCents: Cents; varianceBps: bigint | null; lines: number; unplannedLines: number; replannedLines: number; overLines: number; underLines: number };
};

export function isReplan(line: Pick<VarianceLine, 'plannedEditedAt' | 'firstCommittedAt'>): boolean {
  if (!line.firstCommittedAt || !line.plannedEditedAt?.length) return false;
  const first = parseInstant(line.firstCommittedAt, 'firstCommittedAt');
  return line.plannedEditedAt.some((t) => parseInstant(t, 'plannedEditedAt') > first);
}

export function variance(input: VarianceInput): VarianceReport {
  const seen = new Set<string>();
  const rows: VarianceRow[] = input.lines
    .map((l) => {
      if (seen.has(l.lineId)) throw new Error(`line ${l.lineId} appears twice`);
      seen.add(l.lineId);
      const plannedCents = requireCents(l.plannedCents, `line ${l.lineId} plannedCents`, { min: 0n });
      const actualCents = requireCents(l.actualCents, `line ${l.lineId} actualCents`, { min: 0n });
      const varianceCents = actualCents - plannedCents;
      const unplanned = plannedCents === 0n && actualCents !== 0n;
      const status: VarianceStatus = unplanned ? 'unplanned' : varianceCents > 0n ? 'over' : varianceCents < 0n ? 'under' : 'on-plan';
      return { lineId: l.lineId, plannedCents, actualCents, varianceCents, varianceBps: ratioBps(varianceCents, plannedCents), status, unplanned, replan: isReplan(l) };
    })
    .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
  let plannedCents = 0n;
  let actualCents = 0n;
  for (const r of rows) {
    plannedCents += r.plannedCents;
    actualCents += r.actualCents;
  }
  const varianceCents = actualCents - plannedCents;
  return {
    periodId: input.periodId,
    rows,
    totals: {
      plannedCents,
      actualCents,
      varianceCents,
      varianceBps: ratioBps(varianceCents, plannedCents),
      lines: rows.length,
      unplannedLines: rows.filter((r) => r.unplanned).length,
      replannedLines: rows.filter((r) => r.replan).length,
      overLines: rows.filter((r) => r.status === 'over').length,
      underLines: rows.filter((r) => r.status === 'under').length,
    },
  };
}

export function varianceToJson(v: VarianceReport): unknown {
  return {
    periodId: v.periodId,
    rows: v.rows.map((r) => ({
      ...r,
      plannedCents: jsonCents(r.plannedCents),
      actualCents: jsonCents(r.actualCents),
      varianceCents: jsonCents(r.varianceCents),
      varianceBps: r.varianceBps === null ? null : Number(r.varianceBps),
    })),
    totals: {
      ...v.totals,
      plannedCents: jsonCents(v.totals.plannedCents),
      actualCents: jsonCents(v.totals.actualCents),
      varianceCents: jsonCents(v.totals.varianceCents),
      varianceBps: v.totals.varianceBps === null ? null : Number(v.totals.varianceBps),
    },
  };
}
