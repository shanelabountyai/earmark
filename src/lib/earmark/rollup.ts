// Budget rollups (PRD §2 "derived, never stored", §4 money rules). Pure; oracle in tools/rollup_oracle.py.
//
//   committed per line  = sum of open commitments on the line
//   actual per line     = sum of approved invoice matches against the line's commitments (open or closed)
//   unmatched provision = sum of submitted (not yet matched) invoices that name the line
//   available           = planned − committed − unmatched provision; shown even when negative, never clamped
//
// Campaign, program and org rows are sums of their lines, so a rollup can never disagree with its rows. Invoices
// that name no line still count once, at the org level, as unassignedUnmatchedCents.

import { type Cents, jsonCents, ratioBps, requireCents } from './money';

export type Program = { id: string; name?: string };
export type Campaign = { id: string; programId: string; name?: string };
export type BudgetLine = { id: string; campaignId: string; periodId: string; plannedCents: Cents };
export type CommitmentState = 'open' | 'closed';
export type LedgerCommitment = { id: string; lineId: string; amountCents: Cents; state: CommitmentState; requestAmountCents?: Cents | null };
export type MatchState = 'approved' | 'pending' | 'rejected';
export type LedgerMatch = { invoiceId: string; commitmentId: string; amountCents: Cents; state: MatchState };
export type InvoiceState = 'submitted' | 'matched' | 'disputed' | 'approved' | 'voided';
export type LedgerInvoice = { id: string; amountCents: Cents; state: InvoiceState; lineId?: string | null; submittedOn?: string | null };

export type Ledger = {
  programs: Program[];
  campaigns: Campaign[];
  lines: BudgetLine[];
  commitments: LedgerCommitment[];
  matches: LedgerMatch[];
  invoices: LedgerInvoice[];
  periodId?: string | null; // restrict to one fiscal month
  now?: string | null; // for unmatched-invoice ages
};

export type Totals = { plannedCents: Cents; committedCents: Cents; actualCents: Cents; unmatchedProvisionCents: Cents; availableCents: Cents };
export type LineRollup = Totals & { lineId: string; campaignId: string; programId: string; periodId: string; overCommitted: boolean; committedBps: bigint | null; actualBps: bigint | null };
export type CampaignRollup = Totals & { campaignId: string; programId: string; lineCount: number };
export type ProgramRollup = Totals & { programId: string; lineCount: number };
export type UnmatchedInvoice = { invoiceId: string; amountCents: Cents; lineId: string | null; ageDays: number | null };
export type Rollup = {
  periodId: string | null;
  lines: LineRollup[];
  campaigns: CampaignRollup[];
  programs: ProgramRollup[];
  org: Totals & { lineCount: number };
  unassignedUnmatchedCents: Cents; // submitted invoices naming no line: counted once, here
  orgAvailableCents: Cents; // org.availableCents − unassignedUnmatchedCents
  unmatchedInvoices: UnmatchedInvoice[];
};

export class LedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

const zeroTotals = (): Totals => ({ plannedCents: 0n, committedCents: 0n, actualCents: 0n, unmatchedProvisionCents: 0n, availableCents: 0n });
const addTotals = (t: Totals, u: Totals) => {
  t.plannedCents += u.plannedCents;
  t.committedCents += u.committedCents;
  t.actualCents += u.actualCents;
  t.unmatchedProvisionCents += u.unmatchedProvisionCents;
  t.availableCents += u.availableCents;
};
const byId = <T extends object>(xs: T[], key: keyof T, what: string): Map<string, T> => {
  const m = new Map<string, T>();
  for (const x of xs) {
    const id = String(x[key]);
    if (m.has(id)) throw new LedgerError('DUPLICATE_ID', `${what} ${id} appears twice`);
    m.set(id, x);
  }
  return m;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Whole days from `from` to `now` (UTC, floored); null when either is missing. */
export function ageDays(from: string | null | undefined, now: string | null | undefined): number | null {
  if (!from || !now) return null;
  const f = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00Z` : from);
  const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(now) ? `${now}T00:00:00Z` : now);
  if (Number.isNaN(f) || Number.isNaN(n)) throw new LedgerError('BAD_DATE', `cannot parse ${from} / ${now}`);
  return Math.floor((n - f) / 86_400_000);
}

export function rollup(ledger: Ledger): Rollup {
  const programs = byId(ledger.programs, 'id', 'program');
  const campaigns = byId(ledger.campaigns, 'id', 'campaign');
  for (const c of ledger.campaigns) if (!programs.has(c.programId)) throw new LedgerError('UNKNOWN_PROGRAM', `campaign ${c.id} names unknown program ${c.programId}`);
  const allLines = byId(ledger.lines, 'id', 'line');
  for (const l of ledger.lines) if (!campaigns.has(l.campaignId)) throw new LedgerError('UNKNOWN_CAMPAIGN', `line ${l.id} names unknown campaign ${l.campaignId}`);
  const periodId = ledger.periodId ?? null;
  const lines = ledger.lines.filter((l) => periodId === null || l.periodId === periodId);
  const inScope = new Set(lines.map((l) => l.id));

  const commitments = byId(ledger.commitments, 'id', 'commitment');
  const committed = new Map<string, Cents>();
  for (const c of ledger.commitments) {
    if (!allLines.has(c.lineId)) throw new LedgerError('UNKNOWN_LINE', `commitment ${c.id} names unknown line ${c.lineId}`);
    const amount = requireCents(c.amountCents, `commitment ${c.id} amountCents`, { min: 0n });
    if (c.requestAmountCents != null && amount > requireCents(c.requestAmountCents, `commitment ${c.id} requestAmountCents`, { min: 0n }))
      throw new LedgerError('COMMITMENT_EXCEEDS_REQUEST', `commitment ${c.id} (${amount}) exceeds its request (${c.requestAmountCents})`);
    if (c.state !== 'open' && c.state !== 'closed') throw new LedgerError('BAD_STATE', `commitment ${c.id} has state ${String(c.state)}`);
    if (c.state === 'open' && inScope.has(c.lineId)) committed.set(c.lineId, (committed.get(c.lineId) ?? 0n) + amount);
  }

  const actual = new Map<string, Cents>();
  for (const m of ledger.matches) {
    const c = commitments.get(m.commitmentId);
    if (!c) throw new LedgerError('UNKNOWN_COMMITMENT', `match for invoice ${m.invoiceId} names unknown commitment ${m.commitmentId}`);
    const amount = requireCents(m.amountCents, `match ${m.invoiceId}/${m.commitmentId} amountCents`, { min: 0n });
    if (m.state !== 'approved' && m.state !== 'pending' && m.state !== 'rejected') throw new LedgerError('BAD_STATE', `match ${m.invoiceId}/${m.commitmentId} has state ${String(m.state)}`);
    if (m.state === 'approved' && inScope.has(c.lineId)) actual.set(c.lineId, (actual.get(c.lineId) ?? 0n) + amount);
  }

  const provision = new Map<string, Cents>();
  let unassigned = 0n;
  const unmatched: UnmatchedInvoice[] = [];
  byId(ledger.invoices, 'id', 'invoice');
  for (const inv of ledger.invoices) {
    const amount = requireCents(inv.amountCents, `invoice ${inv.id} amountCents`, { min: 0n });
    if (inv.lineId && !allLines.has(inv.lineId)) throw new LedgerError('UNKNOWN_LINE', `invoice ${inv.id} names unknown line ${inv.lineId}`);
    if (inv.state !== 'submitted') continue;
    const lineId = inv.lineId || null;
    if (lineId && !inScope.has(lineId)) continue; // another period's line
    if (lineId) provision.set(lineId, (provision.get(lineId) ?? 0n) + amount);
    else unassigned += amount;
    unmatched.push({ invoiceId: inv.id, amountCents: amount, lineId, ageDays: ageDays(inv.submittedOn, ledger.now) });
  }
  unmatched.sort((a, b) => cmp(a.invoiceId, b.invoiceId));

  const lineRows: LineRollup[] = lines
    .map((l) => {
      const plannedCents = requireCents(l.plannedCents, `line ${l.id} plannedCents`, { min: 0n });
      const committedCents = committed.get(l.id) ?? 0n;
      const actualCents = actual.get(l.id) ?? 0n;
      const unmatchedProvisionCents = provision.get(l.id) ?? 0n;
      const availableCents = plannedCents - committedCents - unmatchedProvisionCents;
      return {
        lineId: l.id,
        campaignId: l.campaignId,
        programId: campaigns.get(l.campaignId)!.programId,
        periodId: l.periodId,
        plannedCents,
        committedCents,
        actualCents,
        unmatchedProvisionCents,
        availableCents,
        overCommitted: availableCents < 0n,
        committedBps: ratioBps(committedCents, plannedCents),
        actualBps: ratioBps(actualCents, plannedCents),
      };
    })
    .sort((a, b) => cmp(a.lineId, b.lineId));

  const campaignRows = new Map<string, CampaignRollup>();
  const programRows = new Map<string, ProgramRollup>();
  const org = { ...zeroTotals(), lineCount: 0 };
  for (const r of lineRows) {
    const c = campaignRows.get(r.campaignId) ?? { ...zeroTotals(), campaignId: r.campaignId, programId: r.programId, lineCount: 0 };
    addTotals(c, r);
    c.lineCount += 1;
    campaignRows.set(r.campaignId, c);
    const p = programRows.get(r.programId) ?? { ...zeroTotals(), programId: r.programId, lineCount: 0 };
    addTotals(p, r);
    p.lineCount += 1;
    programRows.set(r.programId, p);
    addTotals(org, r);
    org.lineCount += 1;
  }

  return {
    periodId,
    lines: lineRows,
    campaigns: [...campaignRows.values()].sort((a, b) => cmp(a.campaignId, b.campaignId)),
    programs: [...programRows.values()].sort((a, b) => cmp(a.programId, b.programId)),
    org,
    unassignedUnmatchedCents: unassigned,
    orgAvailableCents: org.availableCents - unassigned,
    unmatchedInvoices: unmatched,
  };
}

/** The rollup with cents as JSON integers, for fixtures and the parity test. */
export function rollupToJson(r: Rollup): unknown {
  const totals = (t: Totals) => ({
    plannedCents: jsonCents(t.plannedCents),
    committedCents: jsonCents(t.committedCents),
    actualCents: jsonCents(t.actualCents),
    unmatchedProvisionCents: jsonCents(t.unmatchedProvisionCents),
    availableCents: jsonCents(t.availableCents),
  });
  return {
    periodId: r.periodId,
    lines: r.lines.map((l) => ({
      lineId: l.lineId,
      campaignId: l.campaignId,
      programId: l.programId,
      periodId: l.periodId,
      ...totals(l),
      overCommitted: l.overCommitted,
      committedBps: l.committedBps === null ? null : Number(l.committedBps),
      actualBps: l.actualBps === null ? null : Number(l.actualBps),
    })),
    campaigns: r.campaigns.map((c) => ({ campaignId: c.campaignId, programId: c.programId, lineCount: c.lineCount, ...totals(c) })),
    programs: r.programs.map((p) => ({ programId: p.programId, lineCount: p.lineCount, ...totals(p) })),
    org: { lineCount: r.org.lineCount, ...totals(r.org) },
    unassignedUnmatchedCents: jsonCents(r.unassignedUnmatchedCents),
    orgAvailableCents: jsonCents(r.orgAvailableCents),
    unmatchedInvoices: r.unmatchedInvoices.map((u) => ({ invoiceId: u.invoiceId, amountCents: jsonCents(u.amountCents), lineId: u.lineId, ageDays: u.ageDays })),
  };
}
