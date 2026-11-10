'use server';
// Earmark's server actions (Phase 2). Each is built by orgAction, so the INV-01..04/22 harness drives it with no
// per-action code; every id is ref('<model>'), resolved with inOrg (a row from another org is the same notFound as
// a row that does not exist). Earmark's own permission is checked first in the body (D-15). Pages arrive in Phase 3.
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { type Tx, withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { emit } from '@/core/events';
import { removeMember } from '@/core/tenancy/orgs';
import { onMembershipEnded } from '@/app/org-hooks';
import type { Prisma } from '@/generated/prisma/client';
import { chainToJson, ruleEditToJson } from '@/lib/earmark/cases';
import { applyDecisions, authorizeRuleEdit, type ChainResult, evaluateChain, parseRules, type RulesJson } from '@/lib/earmark/chain';
import { applyMatch } from '@/lib/earmark/match';
import { dollars, heldSeats, lineAvailable, requirePerm, rulesOf, scopeOf, seatsFor } from './core';

/** A YYYY-MM-DD form field, checked in the body after the ids resolve (see submitRequest). */
function isoDate(text: string, what: string): Date {
  const d = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw new Refused(`${what} must be a date (YYYY-MM-DD).`);
  return d;
}
const json = (v: unknown) => v as Prisma.InputJsonValue;
/** After a write, every org page re-renders with it (the action returns a value, so nothing redirects). */
const refresh = (ctx: OrgCtx) => revalidatePath(`/o/${ctx.slug}`, 'layout');

/** Locks one row of the org for the rest of the transaction, so two decisions or matches on it serialize. */
const lock = (tx: Tx, table: 'SpendRequest' | 'Commitment' | 'Invoice', id: string, orgId: string) =>
  tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1::uuid AND "orgId" = $2::uuid FOR UPDATE`, id, orgId);

// ---------- requests (PRD §3) ----------

export const submitRequest = orgAction(
  null,
  z.object({
    budgetLineId: ref('budgetLine'),
    agencyId: ref('agency'),
    amount: z.string().max(32),
    description: z.string().trim().min(1, 'Say what the money is for.').max(2000),
  }),
  async (ctx, i) => {
    requirePerm(ctx, 'request.create');
    const out = await withOrg(ctx, async (tx) => {
      const line = (await tx.budgetLine.findFirst({ where: { id: i.budgetLineId, ...inOrg(ctx) } })) ?? notFound();
      const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
      const amountCents = dollars(i.amount); // after every id resolves: a foreign id is notFound, never a form error
      if (line.carryForward) throw new Refused('A carry-forward line takes no new requests.');
      if (agency.offboardedAt) throw new Refused(`${agency.name} has been offboarded.`);
      const { rules } = await rulesOf(tx, ctx);
      const chain = evaluateChain({
        rules,
        request: { amountCents, requesterId: ctx.userId, kind: 'default', costCenter: line.costCenter, availableCents: await lineAvailable(tx, ctx, line) },
        seats: await seatsFor(tx, ctx, line.ownerSeat),
        now: now().toISOString(),
      });
      if (!chain.ok) throw new Refused(chain.error.message);
      const r = await tx.spendRequest.create({
        data: { ...inOrg(ctx), budgetLineId: line.id, agencyId: agency.id, amountCents, description: i.description, requestedById: ctx.userId, overBudget: chain.overBudget, chainSnapshot: json(chainToJson(chain)) },
      });
      await tx.approvalStep.createMany({
        data: chain.steps.map((s) => ({ ...inOrg(ctx), requestId: r.id, index: s.index, seat: s.seat, thresholdCents: s.fromCents, source: s.source, approverIds: s.approverIds, blocked: !!s.blocked, requiresNote: s.requiresNote })),
      });
      await audit(ctx, 'request.submitted', { targetType: 'spendRequest', targetId: r.id, data: { amountCents: amountCents.toString(), steps: chain.steps.map((s) => s.seat), overBudget: chain.overBudget } }, tx);
      if (!chain.steps.length) await approve(tx, ctx, r.id);
      return { id: r.id };
    });
    refresh(ctx);
    return { ...out, notice: 'Request submitted; it is listed below.' };
  },
);

const REFUSALS: Record<string, string> = {
  SELF_APPROVAL: 'You cannot approve your own request.',
  NOT_AN_APPROVER: 'You do not hold the seat this step is waiting on.',
  STEP_BLOCKED: 'This step has no active seat holder; the owner has been told.',
  NOTE_REQUIRED: 'This step needs a note.',
  CHAIN_ENDED: 'This request has already been decided.',
};

export const decideStep = orgAction(
  null,
  z.object({ requestId: ref('spendRequest'), decision: z.enum(['approve', 'reject']), note: z.string().max(2000).default('') }),
  async (ctx, i) => {
    const res = await withOrg(ctx, async (tx) => {
      if (ctx.role === 'guest') throw new Refused('You do not have access to that.');
      await lock(tx, 'SpendRequest', i.requestId, ctx.orgId);
      const r = (await tx.spendRequest.findFirst({ where: { id: i.requestId, ...inOrg(ctx) }, include: { steps: { orderBy: { index: 'asc' } } } })) ?? notFound();
      if (r.state !== 'submitted') throw new Refused(REFUSALS.CHAIN_ENDED!);
      // The frozen steps, back into the engine's shape, with every earlier decision replayed before this one.
      const chain: Extract<ChainResult, { ok: true }> = {
        ok: true, kind: r.kind === 'spend' ? 'default' : r.kind, amountCents: r.amountCents, overBudget: r.overBudget, resubmits: null, skipped: [], collapsed: [],
        steps: r.steps.map((s) => ({ index: s.index, seat: s.seat, fromCents: s.thresholdCents, source: s.source as 'chain', approverIds: s.approverIds, delegations: [], blocked: s.blocked ? 'no-active-holder' : null, overBudget: s.source === 'over-budget', requiresNote: s.requiresNote })),
      };
      const past = r.steps.filter((s) => s.decision).map((s) => ({ step: s.index, byId: s.decidedById!, decision: s.decision!, note: s.note }));
      const step = r.steps.find((s) => !s.decision);
      const out = applyDecisions(chain, [...past, { step: step?.index ?? -1, byId: ctx.userId, decision: i.decision, note: i.note }], r.requestedById);
      const mine = out.results.at(-1)!;
      if (!mine.accepted) throw new Refused(REFUSALS[mine.reason!] ?? 'That decision cannot be recorded.');
      await tx.approvalStep.update({ where: { id: step!.id }, data: { decidedById: ctx.userId, decision: i.decision, decidedAt: now(), note: i.note } });
      await audit(ctx, `request.step.${i.decision === 'approve' ? 'approved' : 'rejected'}`, { targetType: 'spendRequest', targetId: r.id, data: { step: step!.index, seat: step!.seat } }, tx);
      if (out.state === 'rejected') {
        await tx.spendRequest.update({ where: { id: r.id }, data: { state: 'rejected', decidedAt: now() } });
        await audit(ctx, 'request.rejected', { targetType: 'spendRequest', targetId: r.id }, tx);
      } else if (out.state === 'approved') await approve(tx, ctx, r.id);
      return { state: out.state };
    });
    refresh(ctx);
    return res;
  },
);

/** The last approval: the request is approved and its commitment issued in the same transaction (D-05, E-INV-02). */
async function approve(tx: Tx, ctx: OrgCtx, requestId: string) {
  const r = await tx.spendRequest.update({ where: { id: requestId }, data: { state: 'approved', decidedAt: now() } });
  const c = await tx.commitment.create({
    data: { ...inOrg(ctx), requestId: r.id, agencyId: r.agencyId!, poNumber: `PO-${r.id.slice(0, 8).toUpperCase()}`, amountCents: r.amountCents, remainingCents: r.amountCents },
  });
  await audit(ctx, 'request.approved', { targetType: 'spendRequest', targetId: r.id }, tx);
  await audit(ctx, 'commitment.issued', { targetType: 'commitment', targetId: c.id, data: { poNumber: c.poNumber, amountCents: c.amountCents.toString() } }, tx);
  await emit(ctx, 'request.approved', { request: { id: r.id, amountCents: r.amountCents.toString() } }, tx);
  await emit(ctx, 'commitment.issued', { commitment: { id: c.id, poNumber: c.poNumber, agencyId: c.agencyId, amountCents: c.amountCents.toString() } }, tx);
}

export const withdrawRequest = orgAction(null, z.object({ requestId: ref('spendRequest') }), async (ctx, i) => {
  await withOrg(ctx, async (tx) => {
    await lock(tx, 'SpendRequest', i.requestId, ctx.orgId);
    const r = (await tx.spendRequest.findFirst({ where: { id: i.requestId, ...inOrg(ctx) } })) ?? notFound();
    if (r.requestedById !== ctx.userId) throw new Refused('Only the requester can withdraw a request.');
    if (r.state !== 'submitted') throw new Refused(REFUSALS.CHAIN_ENDED!);
    await tx.spendRequest.update({ where: { id: r.id }, data: { state: 'withdrawn', decidedAt: now() } });
    await audit(ctx, 'request.withdrawn', { targetType: 'spendRequest', targetId: r.id }, tx);
  });
  refresh(ctx);
});

// ---------- rules (PRD §3 rule 6, E-INV-06) ----------

export const editRules = orgAction(null, z.object({ rules: z.string().max(20_000) }), async (ctx, i) => {
  requirePerm(ctx, 'rules.edit');
  let after;
  try {
    after = parseRules(JSON.parse(i.rules) as RulesJson);
  } catch (e) {
    throw new Refused(`Those rules do not parse: ${(e as Error).message}`);
  }
  const out = await withOrg(ctx, async (tx) => {
    await rulesOf(tx, ctx); // seeds the row on first edit
    await tx.$queryRawUnsafe(`SELECT 1 FROM "OrgSettings" WHERE "orgId" = $1::uuid FOR UPDATE`, ctx.orgId);
    const { rules: before } = await rulesOf(tx, ctx);
    const edit = authorizeRuleEdit(ctx.role, before, after);
    if (!edit.ok) throw new Refused(edit.refused!);
    if (!edit.changes.length) return { changes: 0 };
    await tx.orgSettings.update({ where: { orgId: ctx.orgId }, data: { rules: json(edit.audit.after) } });
    await audit(ctx, 'rules.edited', { targetType: 'orgSettings', targetId: ctx.orgId, data: json(ruleEditToJson(edit)) }, tx);
    return { changes: edit.changes.length };
  });
  refresh(ctx);
  return { ...out, notice: out.changes ? `Saved ${out.changes} change${out.changes === 1 ? '' : 's'}.` : 'No changes.' };
});

// ---------- invoices (PRD §4) ----------

export const submitInvoice = orgAction(
  null,
  z.object({
    agencyId: ref('agency'),
    number: z.string().trim().min(1, 'Give the invoice number.').max(64),
    poNumber: z.string().trim().max(64).default(''),
    amount: z.string().max(32),
    invoicedOn: z.string().max(10),
    dueOn: z.string().max(10),
    fileRef: z.union([z.literal(''), z.url().max(2000)]).default(''),
  }),
  async (ctx, i) => {
    requirePerm(ctx, 'invoice.submit');
    const out = await withOrg(ctx, async (tx) => {
      const scope = await scopeOf(tx, ctx);
      // A guest's other agency is the same notFound as one that does not exist (E-INV-03). Not a spread of
      // { id: scope.agencyId }: that would overwrite the id asked for and file the invoice under the guest's own agency.
      const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
      if (scope.agencyId && agency.id !== scope.agencyId) notFound();
      const amountCents = dollars(i.amount);
      const invoicedOn = isoDate(i.invoicedOn, 'Invoice date');
      const dueOn = isoDate(i.dueOn, 'Due date');
      if (agency.offboardedAt) throw new Refused(`${agency.name} has been offboarded.`);
      if (await tx.invoice.findFirst({ where: { ...inOrg(ctx), agencyId: agency.id, number: i.number }, select: { id: true } })) throw new Refused(`Invoice ${i.number} is already in.`);
      const inv = await tx.invoice.create({
        data: { ...inOrg(ctx), agencyId: agency.id, number: i.number, poNumber: i.poNumber || null, amountCents, invoicedOn, dueOn, submittedById: ctx.userId, fileRef: i.fileRef || null },
      });
      await audit(ctx, 'invoice.submitted', { targetType: 'invoice', targetId: inv.id, data: { amountCents: amountCents.toString() } }, tx);
      return { id: inv.id, number: inv.number };
    });
    refresh(ctx);
    return { id: out.id, notice: `Invoice ${out.number} submitted; it is listed below.` };
  },
);

export const matchInvoice = orgAction(
  null,
  z.object({ invoiceId: ref('invoice'), commitmentId: ref('commitment'), amount: z.string().max(32), note: z.string().max(2000).default('') }),
  async (ctx, i) => {
    requirePerm(ctx, 'invoice.match');
    return withOrg(ctx, async (tx) => {
      // Invoice first, then PO, always in that order: the invoice lock stops one invoice being matched against two POs
      // at once for more than it billed; the PO lock stops two invoices taking one PO's remaining at once.
      await lock(tx, 'Invoice', i.invoiceId, ctx.orgId);
      await lock(tx, 'Commitment', i.commitmentId, ctx.orgId);
      const inv = (await tx.invoice.findFirst({ where: { id: i.invoiceId, ...inOrg(ctx) }, include: { matches: { select: { amountCents: true } } } })) ?? notFound();
      const c = (await tx.commitment.findFirst({ where: { id: i.commitmentId, ...inOrg(ctx) } })) ?? notFound();
      const amountCents = dollars(i.amount);
      if (inv.agencyId !== c.agencyId) throw new Refused('That invoice is from a different agency than the PO.');
      if (inv.state !== 'submitted' && inv.state !== 'matched') throw new Refused(`A ${inv.state} invoice cannot be matched.`);
      const matched = inv.matches.reduce((a, m) => a + m.amountCents, 0n);
      if (matched + amountCents > inv.amountCents) throw new Refused('That is more than is left unmatched on the invoice.');
      const r = applyMatch({ id: c.id, remainingCents: c.remainingCents, state: c.closedAt ? 'closed' : 'open' }, { commitmentId: c.id, amountCents, matcherSeats: await heldSeats(tx, ctx), note: i.note });
      if (!r.ok) throw new Refused(r.message);
      const m = await tx.invoiceMatch.create({ data: { ...inOrg(ctx), invoiceId: inv.id, commitmentId: c.id, amountCents, matchedById: ctx.userId, variance: r.variance, overage: r.overage, note: i.note } });
      await tx.commitment.update({ where: { id: c.id }, data: { remainingCents: r.remainingAfter, ...(r.closes ? { closedAt: now(), closeReason: r.overage ? 'overage' : 'fully matched' } : {}) } });
      if (matched + amountCents === inv.amountCents) await tx.invoice.update({ where: { id: inv.id }, data: { state: 'matched' } });
      await audit(ctx, 'invoice.matched', { targetType: 'invoiceMatch', targetId: m.id, data: { invoiceId: inv.id, commitmentId: c.id, amountCents: amountCents.toString(), overage: r.overage } }, tx);
      await emit(ctx, 'invoice.matched', { match: { id: m.id, invoiceId: inv.id, commitmentId: c.id, poNumber: c.poNumber, amountCents: amountCents.toString() } }, tx);
      return { remainingCents: r.remainingAfter.toString() };
    });
  },
);

// ---------- agencies and guests (PRD §5) ----------

/** Ties a `guest` member to one agency in this org (D-12). Phase 3 binds it at invite time. */
export const assignGuestAgency = orgAction(null, z.object({ userId: ref('member'), agencyId: ref('agency') }), async (ctx, i) => {
  requirePerm(ctx, 'agency.manage');
  return withOrg(ctx, async (tx) => {
    const m = (await tx.membership.findFirst({ where: { userId: i.userId, ...inOrg(ctx) } })) ?? notFound();
    const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
    if (m.role !== 'guest') throw new Refused('Only a guest can be tied to an agency.');
    if (agency.offboardedAt) throw new Refused(`${agency.name} has been offboarded.`);
    await tx.guestMembership.upsert({ where: { orgId_userId: { orgId: ctx.orgId, userId: m.userId } }, create: { ...inOrg(ctx), userId: m.userId, agencyId: agency.id }, update: { agencyId: agency.id } });
    await audit(ctx, 'guest.agency.assigned', { targetType: 'user', targetId: m.userId, data: { agencyId: agency.id } }, tx);
  });
});

/**
 * PRD §5: offboarding closes the agency's open POs and ends every guest membership tied to it in this org only
 * (E-INV-07). The agency is marked first, in its own transaction, so its guests see nothing from that moment
 * (scopeOf fails closed) even if a membership removal below fails; each removal then runs core's removeMember
 * (share links, invites, the membership hook, its own audit row).
 */
export const offboardAgency = orgAction(null, z.object({ agencyId: ref('agency') }), async (ctx, i) => {
  requirePerm(ctx, 'agency.manage');
  const guests = await withOrg(ctx, async (tx) => {
    const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
    if (agency.offboardedAt) throw new Refused(`${agency.name} is already offboarded.`);
    await tx.agency.update({ where: { id: agency.id }, data: { offboardedAt: now() } });
    const closed = await tx.commitment.updateMany({ where: { ...inOrg(ctx), agencyId: agency.id, closedAt: null }, data: { closedAt: now(), closeReason: 'offboarded' } });
    await audit(ctx, 'agency.offboarded', { targetType: 'agency', targetId: agency.id, data: { commitmentsClosed: closed.count } }, tx);
    return tx.guestMembership.findMany({ where: { ...inOrg(ctx), agencyId: agency.id }, select: { userId: true } });
  });
  for (const g of guests) await removeMember(ctx, g.userId, onMembershipEnded);
  return { guestsRemoved: guests.length };
});
