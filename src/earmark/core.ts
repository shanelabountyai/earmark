// Earmark's persistence layer (Phase 2): who may do what, the guest scope, the guest projection, and the reads the
// actions share. Every function takes the transaction of a `withOrg` the caller opened, so `app.org_id` is set and
// RLS is in force; every query still spreads `inOrg(ctx)` (spec §7b rules 2–3). The money logic stays in the pure
// engines (src/lib/earmark); this file only loads rows into them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Commitment, Prisma } from '@/generated/prisma/client';
import type { InvoiceState, Role } from '@/generated/prisma/enums';
import { type ApprovalRules, parseRules, type RulesJson, type Seat } from '@/lib/earmark/chain';
import { type Cents, MoneyError, parseDollars } from '@/lib/earmark/money';
import { normalizePo } from '@/lib/earmark/match';
import { type MatchState, rollup } from '@/lib/earmark/rollup';
import { isReplan } from '@/lib/earmark/variance';

// ---------- permissions (D-15: Earmark's own, beside the core Permission union, which is template-owned) ----------

export type EarmarkPerm = 'request.create' | 'rules.edit' | 'invoice.submit' | 'invoice.match' | 'agency.manage' | 'variance.draft' | 'budget.plan' | 'seats.manage';

// PRD §1. Approving is not here: it follows seats, not roles (a member holding a seat approves).
const grants: Record<Role, readonly EarmarkPerm[]> = {
  owner: ['request.create', 'rules.edit', 'invoice.submit', 'invoice.match', 'agency.manage', 'variance.draft', 'budget.plan', 'seats.manage'],
  admin: ['request.create', 'rules.edit', 'invoice.submit', 'invoice.match', 'agency.manage', 'variance.draft', 'budget.plan'],
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

/** A route's [id]: anything else is the notFound of a missing row, never a database error on a uuid column. */
export const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** A dollar string from a form ("$12,000.00") as positive cents, or a Refused the form can show. */
export function dollars(text: string, what = 'Amount', min: Cents = 1n): Cents {
  try {
    const c = parseDollars(text);
    if (c >= min) return c;
  } catch (e) {
    if (!(e instanceof MoneyError)) throw e;
  }
  throw new Refused(`${what} must be a ${min > 0n ? 'positive' : 'non-negative'} dollar amount, like 12,000.00.`);
}

/**
 * An invoice's file reference (PRD §10.3): an https URL or nothing (D-75, review S6). Staff see it as a link, so no
 * `javascript:`, `data:` or plain `http:`. One schema for the guest form and POST /api/v1/invoices.
 */
export const fileRefSchema = z.union([z.literal(''), z.url({ protocol: /^https$/, message: 'The file link must be an https:// address.' }).max(2000)]).default('');

/** A YYYY-MM-DD field, checked in the body after the ids resolve (see submitRequest). */
export function isoDate(text: string, what: string): Date {
  const d = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw new Refused(`${what} must be a date (YYYY-MM-DD).`);
  return d;
}

// ---------- invoices (PRD §4): one set of rules for the guest form and POST /api/v1/invoices ----------

// `amountCents` is parsed only after the agency resolves: a foreign id must be the notFound, never a validation error (INV-02).
export type InvoiceInput = { agencyId: string; number: string; poNumber: string; amountCents: () => Cents; invoicedOn: string; dueOn: string; fileRef: string };

/** Files an invoice. `scope` is the guest's agency (`{}` for staff and API keys); `submittedById` the user, or the key's creator. */
export async function fileInvoice(tx: Tx, ctx: { orgId: string; userId: string | null }, scope: Scope, i: InvoiceInput, submittedById: string) {
  // A guest's other agency is the same notFound as one that does not exist (E-INV-03). Not a spread of
  // { id: scope.agencyId }: that would overwrite the id asked for and file the invoice under the guest's own agency.
  const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
  if (scope.agencyId && agency.id !== scope.agencyId) notFound();
  const amountCents = i.amountCents();
  const invoicedOn = isoDate(i.invoicedOn, 'Invoice date');
  const dueOn = isoDate(i.dueOn, 'Due date');
  if (dueOn < invoicedOn) throw new Refused('Due date cannot be before the invoice date.'); // D-60; the same day (due on receipt) is allowed
  if (agency.offboardedAt) throw new Refused(`${agency.name} has been offboarded.`);
  // D-70: a PO number names a PO of this org and this agency, compared normalised, and is stored as that PO's own
  // number; anything else is refused, so an invoice can never land on another agency's PO or line. None is allowed.
  let poNumber: string | null = null;
  if (normalizePo(i.poNumber)) {
    const pos = await tx.commitment.findMany({ where: { ...inOrg(ctx), agencyId: agency.id }, select: { poNumber: true } });
    poNumber = pos.find((p) => normalizePo(p.poNumber) === normalizePo(i.poNumber))?.poNumber ?? null;
    if (!poNumber) throw new Refused(`No PO ${i.poNumber.trim()} for ${agency.name}.`);
  }
  if (await tx.invoice.findFirst({ where: { ...inOrg(ctx), agencyId: agency.id, number: i.number }, select: { id: true } })) throw new Refused(`Invoice ${i.number} is already in.`);
  const inv = await tx.invoice.create({
    data: { ...inOrg(ctx), agencyId: agency.id, number: i.number, poNumber, amountCents, invoicedOn, dueOn, submittedById, fileRef: i.fileRef || null },
  });
  await audit(ctx, 'invoice.submitted', { targetType: 'invoice', targetId: inv.id, data: { amountCents: amountCents.toString() } }, tx);
  return inv;
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

// An invoice names a PO, not a line: a submitted invoice counts against the line of the PO it names **of its own
// agency**, PO numbers compared normalised (D-71), and one naming no such PO counts once at org level (rollup's
// unassigned). Actual = matches whose invoice is approved for payment. Each submitted invoice carries what is already
// matched to it on any PO, so only its unmatched rest is provision (D-69).
// ponytail: "known" means a PO on the loaded lines, so an invoice naming a PO from another fiscal year counts as
// unassigned on the dashboard; resolve POs org-wide if fiscal-year close (carry-forward) ever leaves such invoices.
const matchState = (s: InvoiceState): MatchState => (s === 'approved' ? 'approved' : s === 'voided' ? 'rejected' : 'pending');
/** The key an invoice and a PO meet on: the agency and the normalised PO number (D-71). */
export const poKey = (agencyId: string, poNumber: string | null | undefined) => `${agencyId}|${normalizePo(poNumber)}`;

/**
 * The rollup engine over the lines `where` selects, plus what the pages show beside it: the submitted invoices it
 * counted, and the lines carrying the replan marker. `orgWide` also counts submitted invoices that name no PO of
 * these lines (the dashboard); without it only invoices naming one of their POs count (a line's available).
 */
export async function ledgerOf(tx: Tx, ctx: Pick<OrgCtx, 'orgId'>, where: Prisma.BudgetLineWhereInput, opts: { orgWide?: boolean } = {}) {
  const lines = await tx.budgetLine.findMany({ where: { ...where, ...inOrg(ctx) }, select: { id: true, campaignId: true, periodId: true, plannedCents: true, plannedEditedAt: true, campaign: { select: { programId: true } } } });
  const commitments = await tx.commitment.findMany({
    where: { ...inOrg(ctx), request: { budgetLineId: { in: lines.map((l) => l.id) } } },
    select: { id: true, agencyId: true, poNumber: true, amountCents: true, closedAt: true, issuedAt: true, request: { select: { budgetLineId: true } }, matches: { select: { invoiceId: true, amountCents: true, invoice: { select: { state: true } } } } },
  });
  const lineOfPo = new Map(commitments.map((c) => [poKey(c.agencyId, c.poNumber), c.request.budgetLineId]));
  const agencies = [...new Set(commitments.map((c) => c.agencyId))];
  const loaded = opts.orgWide || agencies.length
    ? await tx.invoice.findMany({
        where: { ...inOrg(ctx), state: 'submitted', ...(opts.orgWide ? {} : { agencyId: { in: agencies }, poNumber: { not: null } }) },
        select: { id: true, number: true, agencyId: true, poNumber: true, amountCents: true, createdAt: true, agency: { select: { name: true } }, matches: { select: { amountCents: true } } },
      })
    : [];
  const lineOf = (i: { agencyId: string; poNumber: string | null }) => (i.poNumber && lineOfPo.get(poKey(i.agencyId, i.poNumber))) || null;
  const invoices = opts.orgWide ? loaded : loaded.filter((i) => lineOf(i));
  const firstCommitted = new Map<string, Date>();
  for (const c of commitments) {
    const l = c.request.budgetLineId;
    if (!firstCommitted.has(l) || c.issuedAt < firstCommitted.get(l)!) firstCommitted.set(l, c.issuedAt);
  }
  const replan = new Set(lines.filter((l) => l.plannedEditedAt && isReplan({ plannedEditedAt: [l.plannedEditedAt.toISOString()], firstCommittedAt: firstCommitted.get(l.id)?.toISOString() })).map((l) => l.id));
  const r = rollup({
    programs: [...new Set(lines.map((l) => l.campaign.programId))].map((id) => ({ id })),
    campaigns: [...new Map(lines.map((l) => [l.campaignId, { id: l.campaignId, programId: l.campaign.programId }])).values()],
    lines: lines.map((l) => ({ id: l.id, campaignId: l.campaignId, periodId: l.periodId, plannedCents: l.plannedCents })),
    commitments: commitments.map((c) => ({ id: c.id, lineId: c.request.budgetLineId, amountCents: c.amountCents, state: c.closedAt ? 'closed' : 'open' })),
    matches: commitments.flatMap((c) => c.matches.map((m) => ({ invoiceId: m.invoiceId, commitmentId: c.id, amountCents: m.amountCents, state: matchState(m.invoice.state) }))),
    invoices: invoices.map((i) => ({ id: i.id, amountCents: i.amountCents, state: 'submitted', lineId: lineOf(i), submittedOn: i.createdAt.toISOString(), matchedCents: i.matches.reduce((a, m) => a + m.amountCents, 0n) })),
    now: now().toISOString(),
  });
  return { rollup: r, invoices: new Map(invoices.map((i) => [i.id, i])), replan, firstCommitted };
}

/** planned − open commitments − unmatched invoices that name one of this line's POs. */
export async function lineAvailable(tx: Tx, ctx: OrgCtx, line: { id: string }): Promise<Cents> {
  return (await ledgerOf(tx, ctx, { id: line.id })).rollup.lines[0]!.availableCents;
}
