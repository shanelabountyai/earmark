// Earmark's persistence layer (Phase 2): who may do what, the guest scope, the guest projection, and the reads the
// actions share. Every function takes the transaction of a `withOrg` the caller opened, so `app.org_id` is set and
// RLS is in force; every query still spreads `inOrg(ctx)` (spec §7b rules 2–3). The money logic stays in the pure
// engines (src/lib/earmark); this file only loads rows into them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { notFound } from 'next/navigation';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Commitment, Prisma } from '@/generated/prisma/client';
import type { Role } from '@/generated/prisma/enums';
import { type ApprovalRules, parseRules, type RulesJson, type Seat } from '@/lib/earmark/chain';
import { type Cents, MoneyError, parseDollars } from '@/lib/earmark/money';
import { rollup } from '@/lib/earmark/rollup';

// ---------- permissions (D-15: Earmark's own, beside the core Permission union, which is template-owned) ----------

export type EarmarkPerm = 'request.create' | 'rules.edit' | 'invoice.submit' | 'invoice.match' | 'agency.manage' | 'variance.draft';

// PRD §1. Approving is not here: it follows seats, not roles (a member holding a seat approves).
const grants: Record<Role, readonly EarmarkPerm[]> = {
  owner: ['request.create', 'rules.edit', 'invoice.submit', 'invoice.match', 'agency.manage', 'variance.draft'],
  admin: ['request.create', 'rules.edit', 'invoice.submit', 'invoice.match', 'agency.manage', 'variance.draft'],
  member: ['request.create', 'invoice.match'],
  scorekeeper: [],
  guest: ['invoice.submit'],
};

export const earmarkCan = (role: Role, p: EarmarkPerm) => grants[role]?.includes(p) ?? false;

export function requirePerm(ctx: OrgCtx, p: EarmarkPerm) {
  if (!earmarkCan(ctx.role, p)) throw new Refused('You do not have access to that.');
}

// ---------- the guest scope (PRD §5 layer 4, E-INV-03) ----------

export type Scope = { agencyId?: string };

/**
 * `{}` for client staff; `{ agencyId }` for a guest, to spread into every query on an agency-owned row. A guest with
 * no GuestMembership, or whose agency is offboarded, sees nothing: the same notFound as a row that does not exist.
 */
export async function scopeOf(tx: Tx, ctx: OrgCtx): Promise<Scope> {
  if (ctx.role !== 'guest') return {};
  const g = await tx.guestMembership.findFirst({ where: { ...inOrg(ctx), userId: ctx.userId }, select: { agencyId: true, agency: { select: { offboardedAt: true } } } });
  if (!g || g.agency.offboardedAt) notFound();
  return { agencyId: g.agencyId };
}

/** One commitment as the reader may see it: a guest only their agency's, anyone else any in the org. */
export async function findCommitment(tx: Tx, ctx: OrgCtx, id: string) {
  const c = await tx.commitment.findFirst({ where: { id, ...inOrg(ctx), ...(await scopeOf(tx, ctx)) }, include: { matches: { select: { invoice: { select: { dueOn: true } } } } } });
  return c ?? notFound();
}

// ---------- the guest projection (PRD §5 layer 5, E-INV-04) ----------

export type GuestCommitment = {
  id: string;
  poNumber: string;
  amountCents: string;
  remainingCents: string;
  issuedAt: string;
  closedAt: string | null;
  matchStatus: 'unmatched' | 'partial' | 'matched';
  invoiceDueDates: string[];
};

/** An allowlist, never a spread: a column added to Commitment later stays out until someone adds it here. */
export function toGuestCommitment(c: Commitment & { matches?: { invoice: { dueOn: Date } }[] }): GuestCommitment {
  return {
    id: c.id,
    poNumber: c.poNumber,
    amountCents: c.amountCents.toString(),
    remainingCents: c.remainingCents.toString(),
    issuedAt: c.issuedAt.toISOString(),
    closedAt: c.closedAt?.toISOString() ?? null,
    matchStatus: c.remainingCents === c.amountCents ? 'unmatched' : c.remainingCents > 0n ? 'partial' : 'matched',
    invoiceDueDates: [...new Set((c.matches ?? []).map((m) => m.invoice.dueOn.toISOString().slice(0, 10)))].sort(),
  };
}

// ---------- inputs ----------

/** A dollar string from a form ("$12,000.00") as positive cents, or a Refused the form can show. */
export function dollars(text: string, what = 'Amount'): Cents {
  try {
    const c = parseDollars(text);
    if (c > 0n) return c;
  } catch (e) {
    if (!(e instanceof MoneyError)) throw e;
  }
  throw new Refused(`${what} must be a positive dollar amount, like 12,000.00.`);
}

// ---------- rules (D-03, D-14) ----------

const SEED_RULES = path.join(process.cwd(), 'rules/approval-chains.json');

/** The org's live rules. The first read seeds them from rules/approval-chains.json. */
export async function rulesOf(tx: Tx, ctx: OrgCtx): Promise<{ json: RulesJson; rules: ApprovalRules }> {
  let s = await tx.orgSettings.findFirst({ where: inOrg(ctx) });
  s ??= await tx.orgSettings.create({ data: { ...inOrg(ctx), rules: JSON.parse(readFileSync(SEED_RULES, 'utf8')) as Prisma.InputJsonValue } });
  const json = s.rules as RulesJson;
  return { json, rules: parseRules(json) };
}

// ---------- seats ----------

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Every seat with its holders, in the engine's shape. `Budget Owner` resolves to the line's owner seat (PRD §2). */
export async function seatsFor(tx: Tx, ctx: OrgCtx, ownerSeat: string): Promise<Seat[]> {
  const rows = await tx.seat.findMany({ where: inOrg(ctx), include: { holders: { where: inOrg(ctx), orderBy: { userId: 'asc' } } }, orderBy: { name: 'asc' } });
  const seats = rows.map((s) => ({ name: s.name, holders: s.holders.map((h) => ({ userId: h.userId, activeFrom: iso(h.activeFrom), activeTo: iso(h.activeTo), delegateToId: h.delegateToId })) }));
  const owner = seats.find((s) => s.name === ownerSeat);
  return owner && ownerSeat !== 'Budget Owner' ? [...seats.filter((s) => s.name !== 'Budget Owner'), { name: 'Budget Owner', holders: owner.holders }] : seats;
}

/** The seat names the user holds right now: the match engine's overage check reads Finance from here. */
export async function heldSeats(tx: Tx, ctx: OrgCtx): Promise<string[]> {
  const t = now();
  const rows = await tx.seatHolder.findMany({
    where: { ...inOrg(ctx), userId: ctx.userId, activeFrom: { lte: t }, OR: [{ activeTo: null }, { activeTo: { gt: t } }] },
    select: { seat: { select: { name: true } } },
  });
  return rows.map((r) => r.seat.name);
}

// ---------- a line's available (PRD §4), through the rollup engine ----------

/** planned − open commitments − unmatched invoices that name one of this line's POs. */
export async function lineAvailable(tx: Tx, ctx: OrgCtx, line: { id: string; campaignId: string; periodId: string; plannedCents: bigint }): Promise<Cents> {
  const commitments = await tx.commitment.findMany({ where: { ...inOrg(ctx), request: { budgetLineId: line.id } }, select: { id: true, poNumber: true, amountCents: true, closedAt: true } });
  const pos = commitments.map((c) => c.poNumber);
  const invoices = pos.length ? await tx.invoice.findMany({ where: { ...inOrg(ctx), state: 'submitted', poNumber: { in: pos } }, select: { id: true, amountCents: true } }) : [];
  const r = rollup({
    programs: [{ id: 'p' }],
    campaigns: [{ id: line.campaignId, programId: 'p' }],
    lines: [{ id: line.id, campaignId: line.campaignId, periodId: line.periodId, plannedCents: line.plannedCents }],
    commitments: commitments.map((c) => ({ id: c.id, lineId: line.id, amountCents: c.amountCents, state: c.closedAt ? 'closed' : 'open' })),
    matches: [],
    invoices: invoices.map((i) => ({ id: i.id, amountCents: i.amountCents, state: 'submitted', lineId: line.id })),
  });
  return r.lines[0]!.availableCents;
}
