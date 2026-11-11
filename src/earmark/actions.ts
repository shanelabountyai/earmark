'use server';
// Earmark's server actions (Phase 2). Each is built by orgAction, so the INV-01..04/22 harness drives it with no
// per-action code; every id is ref('<model>'), resolved with inOrg (a row from another org is the same notFound as
// a row that does not exist). Earmark's own permission is checked first in the body (D-15). Pages arrive in Phase 3.
import { assertNotDemo } from '@/core/auth/session';
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { type Tx, withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { emit as logEvent } from '@/core/events';
import { log } from '@/core/log';
import { sweepWebhooks } from '@/modules/apikeys/webhooks';
import { removeMember } from '@/core/tenancy/orgs';
import { onMembershipEnded } from '@/app/org-hooks';
import type { Prisma } from '@/generated/prisma/client';
import { chainToJson, ruleEditToJson } from '@/lib/earmark/cases';
import { applyDecisions, authorizeRuleEdit, type ChainResult, evaluateChain, parseRules, type RulesJson } from '@/lib/earmark/chain';
import { applyMatch, FINANCE_SEAT } from '@/lib/earmark/match';
import { formatUsd } from '@/lib/earmark/money';
import { draftVarianceNote, drafterFromEnv } from './explainer';
import { dollars, fileInvoice, heldSeats, isoDate, lineAvailable, requirePerm, rulesOf, scopeOf, seatsFor } from './core';

/**
 * Every Earmark event is sent now, not at the next cron (PRD §9 step 6). after() runs once the response is out, so the
 * sweep reads a committed event; a rolled-back one leaves nothing to send. Two in one request are two sweeps, which
 * SKIP LOCKED makes safe (INV-41).
 */
async function emit(...args: Parameters<typeof logEvent>) {
  const { orgId } = args[0];
  after(() => sweepWebhooks({ orgId }).then((r) => log('webhooks.inline', { orgId, ...r })));
  return logEvent(...args);
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

/**
 * The last approval: the request is approved and its commitment issued in the same transaction (D-05, E-INV-02). A
 * reallocation issues no PO: planned moves between its two lines (D-28), if the source still has the money.
 */
async function approve(tx: Tx, ctx: OrgCtx, requestId: string) {
  const r = await tx.spendRequest.update({ where: { id: requestId }, data: { state: 'approved', decidedAt: now() } });
  if (r.kind === 'reallocation') return applyReallocation(tx, ctx, r.id);
  const c = await tx.commitment.create({
    data: { ...inOrg(ctx), requestId: r.id, agencyId: r.agencyId!, poNumber: `PO-${r.id.slice(0, 8).toUpperCase()}`, amountCents: r.amountCents, remainingCents: r.amountCents },
  });
  await audit(ctx, 'request.approved', { targetType: 'spendRequest', targetId: r.id }, tx);
  await audit(ctx, 'commitment.issued', { targetType: 'commitment', targetId: c.id, data: { poNumber: c.poNumber, amountCents: c.amountCents.toString() } }, tx);
  await emit(ctx, 'request.approved', { request: { id: r.id, amountCents: r.amountCents.toString() } }, tx);
  await emit(ctx, 'commitment.issued', { commitment: { id: c.id, poNumber: c.poNumber, agencyId: c.agencyId, amountCents: c.amountCents.toString() } }, tx);
}

async function applyReallocation(tx: Tx, ctx: OrgCtx, requestId: string) {
  const m = (await tx.reallocation.findFirst({ where: { requestId, ...inOrg(ctx) }, include: { fromLine: true, toLine: true } }))!;
  await tx.$queryRawUnsafe(`SELECT 1 FROM "BudgetLine" WHERE id IN ($1::uuid, $2::uuid) AND "orgId" = $3::uuid ORDER BY id FOR UPDATE`, m.fromLineId, m.toLineId, ctx.orgId);
  const available = await lineAvailable(tx, ctx, m.fromLine);
  if (available < m.amountCents) throw new Refused(`${m.fromLine.name} has only ${formatUsd(available)} available now; the reallocation cannot be applied.`);
  const stamp = now();
  await tx.budgetLine.update({ where: { id: m.fromLineId }, data: { plannedCents: { decrement: m.amountCents }, plannedEditedAt: stamp } });
  await tx.budgetLine.update({ where: { id: m.toLineId }, data: { plannedCents: { increment: m.amountCents }, plannedEditedAt: stamp } });
  await audit(ctx, 'request.approved', { targetType: 'spendRequest', targetId: requestId }, tx);
  await audit(ctx, 'reallocation.applied', { targetType: 'reallocation', targetId: m.id, data: { fromLineId: m.fromLineId, toLineId: m.toLineId, amountCents: m.amountCents.toString() } }, tx);
}

/** PRD §2 `Reallocation`, §10.7: planned moves between two lines of one fiscal year, through the `reallocation` chain. */
export const submitReallocation = orgAction(
  null,
  z.object({ fromLineId: ref('budgetLine'), toLineId: ref('budgetLine'), amount: z.string().max(32), description: z.string().trim().min(1, 'Say why the money moves.').max(2000) }),
  async (ctx, i) => {
    requirePerm(ctx, 'request.create');
    const out = await withOrg(ctx, async (tx) => {
      const lineOf = async (id: string) => (await tx.budgetLine.findFirst({ where: { id, ...inOrg(ctx) }, include: { period: { select: { fiscalYearId: true } } } })) ?? notFound();
      const from = await lineOf(i.fromLineId);
      const to = await lineOf(i.toLineId);
      const amountCents = dollars(i.amount);
      if (from.id === to.id) throw new Refused('Pick two different lines.');
      if (to.carryForward) throw new Refused('A carry-forward line takes no new money.');
      const availableCents = await lineAvailable(tx, ctx, from);
      if (amountCents > availableCents) throw new Refused(`${from.name} has only ${formatUsd(availableCents)} available.`);
      const { rules } = await rulesOf(tx, ctx);
      const chain = evaluateChain({
        rules,
        request: { amountCents, requesterId: ctx.userId, kind: 'reallocation', costCenter: from.costCenter, availableCents, crossesFiscalYear: from.period.fiscalYearId !== to.period.fiscalYearId },
        seats: await seatsFor(tx, ctx, from.ownerSeat),
        now: now().toISOString(),
      });
      if (!chain.ok) throw new Refused(chain.error.code === 'REALLOCATION_ACROSS_FISCAL_YEARS' ? 'Money cannot move between fiscal years.' : chain.error.message);
      const r = await tx.spendRequest.create({
        data: { ...inOrg(ctx), kind: 'reallocation', budgetLineId: from.id, amountCents, description: i.description, requestedById: ctx.userId, chainSnapshot: json(chainToJson(chain)) },
      });
      await tx.reallocation.create({ data: { ...inOrg(ctx), fromLineId: from.id, toLineId: to.id, amountCents, requestId: r.id } });
      await tx.approvalStep.createMany({
        data: chain.steps.map((s) => ({ ...inOrg(ctx), requestId: r.id, index: s.index, seat: s.seat, thresholdCents: s.fromCents, source: s.source, approverIds: s.approverIds, blocked: !!s.blocked, requiresNote: s.requiresNote })),
      });
      await audit(ctx, 'request.submitted', { targetType: 'spendRequest', targetId: r.id, data: { kind: 'reallocation', amountCents: amountCents.toString(), toLineId: to.id, steps: chain.steps.map((s) => s.seat) } }, tx);
      if (!chain.steps.length) await approve(tx, ctx, r.id);
      return { id: r.id };
    });
    refresh(ctx);
    return { ...out, notice: 'Reallocation submitted for approval.' };
  },
);

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
    const out = await withOrg(ctx, async (tx) => fileInvoice(tx, ctx, await scopeOf(tx, ctx), { ...i, amountCents: () => dollars(i.amount) }, ctx.userId));
    refresh(ctx);
    return { id: out.id, notice: `Invoice ${out.number} submitted; it is listed below.` };
  },
);

export const matchInvoice = orgAction(
  null,
  z.object({ invoiceId: ref('invoice'), commitmentId: ref('commitment'), amount: z.string().max(32), note: z.string().max(2000).default('') }),
  async (ctx, i) => {
    requirePerm(ctx, 'invoice.match');
    const out = await withOrg(ctx, async (tx) => {
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
      return { remainingCents: r.remainingAfter.toString(), poNumber: c.poNumber };
    });
    refresh(ctx);
    return { ...out, notice: `Matched ${formatUsd(dollars(i.amount))} to ${out.poNumber}.` };
  },
);

/**
 * D-25: a fully matched invoice becomes actual (PRD §4) when a Finance seat holder approves it for payment; the AP
 * hand-off is the `invoice.approved_for_payment` event, keyed by invoice so a retry cannot send it twice.
 */
export const approveInvoiceForPayment = orgAction(null, z.object({ invoiceId: ref('invoice') }), async (ctx, i) => {
  const out = await withOrg(ctx, async (tx) => {
    if (ctx.role === 'guest') throw new Refused('You do not have access to that.');
    await lock(tx, 'Invoice', i.invoiceId, ctx.orgId);
    const inv = (await tx.invoice.findFirst({ where: { id: i.invoiceId, ...inOrg(ctx) }, include: { matches: { select: { amountCents: true, commitment: { select: { poNumber: true } } } } } })) ?? notFound();
    if (!(await heldSeats(tx, ctx)).includes(FINANCE_SEAT)) throw new Refused('Only a Finance seat holder can approve an invoice for payment.');
    if (inv.state !== 'matched') throw new Refused(inv.state === 'approved' ? 'This invoice is already approved for payment.' : `A ${inv.state} invoice cannot be approved for payment; match all of it first.`);
    await tx.invoice.update({ where: { id: inv.id }, data: { state: 'approved', approvedForPaymentAt: now() } });
    await audit(ctx, 'invoice.approved_for_payment', { targetType: 'invoice', targetId: inv.id, data: { amountCents: inv.amountCents.toString() } }, tx);
    await emit(ctx, 'invoice.approved_for_payment', {
      invoice: { id: inv.id, number: inv.number, agencyId: inv.agencyId, amountCents: inv.amountCents.toString(), dueOn: inv.dueOn.toISOString().slice(0, 10), matches: inv.matches.map((m) => ({ poNumber: m.commitment.poNumber, amountCents: m.amountCents.toString() })) },
    }, tx, { key: `invoice.approved_for_payment:${inv.id}` });
    return inv.number;
  });
  refresh(ctx);
  return { notice: `Invoice ${out} approved for payment.` };
});

// ---------- variance notes (PRD §4, D-07, D-25) ----------

/**
 * A person publishes the note on a line (D-07): the text replaces the line's latest unpublished draft, kept beside it so
 * the edit shows; with no draft (the explainer was not run) the text is both. A later publish adds a new row.
 */
export const publishVarianceNote = orgAction(
  null,
  z.object({ budgetLineId: ref('budgetLine'), text: z.string().trim().min(1, 'Write the note.').max(4000) }),
  async (ctx, i) => {
    requirePerm(ctx, 'variance.draft');
    await withOrg(ctx, async (tx) => {
      const line = (await tx.budgetLine.findFirst({ where: { id: i.budgetLineId, ...inOrg(ctx) } })) ?? notFound();
      const published = { published: i.text, publishedAt: now(), publishedById: ctx.userId };
      const draft = await tx.varianceNote.findFirst({ where: { ...inOrg(ctx), budgetLineId: line.id, periodId: line.periodId, published: null }, orderBy: { createdAt: 'desc' } });
      const note = draft
        ? await tx.varianceNote.update({ where: { id: draft.id }, data: published })
        : await tx.varianceNote.create({ data: { ...inOrg(ctx), budgetLineId: line.id, periodId: line.periodId, draft: i.text, createdById: ctx.userId, ...published } });
      await audit(ctx, 'variance.published', { targetType: 'varianceNote', targetId: note.id, data: { budgetLineId: line.id, edited: note.draft !== i.text } }, tx);
    });
    refresh(ctx);
    return { notice: 'Note published.' };
  },
);

/** The explainer drafts the line's note under the org's AI cap (D-07); a refusal is shown and writes nothing (E-INV-08). */
export const explainVariance = orgAction(null, z.object({ budgetLineId: ref('budgetLine') }), async (ctx, i) => {
  await draftVarianceNote(ctx, i.budgetLineId, drafterFromEnv());
  refresh(ctx);
  return { notice: 'Draft ready. Edit it below, then publish.' };
});

// ---------- planning (PRD §4, D-06, D-26) ----------

const name = z.string().trim().min(1, 'Give it a name.').max(120);
const unlocked = (fy: { label: string; lockedAt: Date | null }) => {
  if (fy.lockedAt) throw new Refused(`${fy.label} is locked; its plan cannot change.`);
};

/** A fiscal year and its twelve fiscal months (D-06), the first starting on `startsOn`. */
export const createFiscalYear = orgAction(null, z.object({ label: name, startsOn: z.string().max(10) }), async (ctx, i) => {
  requirePerm(ctx, 'budget.plan');
  const start = isoDate(i.startsOn, 'Start date');
  if (start.getUTCDate() !== 1) throw new Refused('A fiscal year starts on the first of a month.');
  await withOrg(ctx, async (tx) => {
    if (await tx.fiscalYear.findFirst({ where: { ...inOrg(ctx), label: i.label }, select: { id: true } })) throw new Refused(`${i.label} already exists.`);
    const fy = await tx.fiscalYear.create({ data: { ...inOrg(ctx), label: i.label, startsOn: start } });
    const month = (n: number) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, 1));
    await tx.period.createMany({ data: Array.from({ length: 12 }, (_, k) => ({ ...inOrg(ctx), fiscalYearId: fy.id, index: k + 1, startsOn: month(k), endsOn: new Date(month(k + 1).getTime() - 86_400_000) })) });
    await audit(ctx, 'plan.fiscal_year.created', { targetType: 'fiscalYear', targetId: fy.id, data: { label: fy.label } }, tx);
  });
  refresh(ctx);
  return { notice: `${i.label} created with 12 periods.` };
});

export const createProgram = orgAction(null, z.object({ fiscalYearId: ref('fiscalYear'), name }), async (ctx, i) => {
  requirePerm(ctx, 'budget.plan');
  await withOrg(ctx, async (tx) => {
    const fy = (await tx.fiscalYear.findFirst({ where: { id: i.fiscalYearId, ...inOrg(ctx) } })) ?? notFound();
    unlocked(fy);
    const p = await tx.program.create({ data: { ...inOrg(ctx), fiscalYearId: fy.id, name: i.name } });
    await audit(ctx, 'plan.program.created', { targetType: 'program', targetId: p.id, data: { name: p.name } }, tx);
  });
  refresh(ctx);
  return { notice: `Program ${i.name} created.` };
});

export const createCampaign = orgAction(null, z.object({ programId: ref('program'), name }), async (ctx, i) => {
  requirePerm(ctx, 'budget.plan');
  await withOrg(ctx, async (tx) => {
    const p = (await tx.program.findFirst({ where: { id: i.programId, ...inOrg(ctx) }, include: { fiscalYear: true } })) ?? notFound();
    unlocked(p.fiscalYear);
    const c = await tx.campaign.create({ data: { ...inOrg(ctx), programId: p.id, name: i.name } });
    await audit(ctx, 'plan.campaign.created', { targetType: 'campaign', targetId: c.id, data: { name: c.name } }, tx);
  });
  refresh(ctx);
  return { notice: `Campaign ${i.name} created.` };
});

export const createLine = orgAction(
  null,
  z.object({ campaignId: ref('campaign'), periodId: ref('period'), name, planned: z.string().max(32), ownerSeat: name, costCenter: z.string().trim().max(64).default(''), glCode: z.string().trim().max(64).default('') }),
  async (ctx, i) => {
    requirePerm(ctx, 'budget.plan');
    await withOrg(ctx, async (tx) => {
      const c = (await tx.campaign.findFirst({ where: { id: i.campaignId, ...inOrg(ctx) }, include: { program: { include: { fiscalYear: true } } } })) ?? notFound();
      const period = (await tx.period.findFirst({ where: { id: i.periodId, ...inOrg(ctx) } })) ?? notFound();
      const plannedCents = dollars(i.planned, 'Planned', 0n);
      if (period.fiscalYearId !== c.program.fiscalYearId) throw new Refused('That period is in a different fiscal year than the campaign.');
      unlocked(c.program.fiscalYear);
      if (!(await tx.seat.findFirst({ where: { ...inOrg(ctx), name: i.ownerSeat }, select: { id: true } }))) throw new Refused(`There is no seat named ${i.ownerSeat}.`);
      const l = await tx.budgetLine.create({ data: { ...inOrg(ctx), campaignId: c.id, periodId: period.id, name: i.name, plannedCents, ownerSeat: i.ownerSeat, costCenter: i.costCenter, glCode: i.glCode } });
      await audit(ctx, 'plan.line.created', { targetType: 'budgetLine', targetId: l.id, data: { name: l.name, plannedCents: plannedCents.toString() } }, tx);
    });
    refresh(ctx);
    return { notice: `Line ${i.name} created.` };
  },
);

/** PRD §4 "Planned": editable until the year locks; every edit is audited and stamped, which the replan marker reads. */
export const setPlanned = orgAction(null, z.object({ budgetLineId: ref('budgetLine'), planned: z.string().max(32) }), async (ctx, i) => {
  requirePerm(ctx, 'budget.plan');
  await withOrg(ctx, async (tx) => {
    const l = (await tx.budgetLine.findFirst({ where: { id: i.budgetLineId, ...inOrg(ctx) }, include: { period: { include: { fiscalYear: true } } } })) ?? notFound();
    const plannedCents = dollars(i.planned, 'Planned', 0n);
    unlocked(l.period.fiscalYear);
    if (plannedCents === l.plannedCents) return;
    await tx.budgetLine.update({ where: { id: l.id }, data: { plannedCents, plannedEditedAt: now() } });
    await audit(ctx, 'plan.line.planned_edited', { targetType: 'budgetLine', targetId: l.id, data: { beforeCents: l.plannedCents.toString(), afterCents: plannedCents.toString() } }, tx);
  });
  refresh(ctx);
  return { notice: 'Planned saved.' };
});

// ---------- seats (PRD §1–2, D-27) ----------

/** The org's staff member `userId` (never a guest: a guest approves nothing), or notFound. */
async function staffMember(tx: Tx, ctx: OrgCtx, userId: string) {
  const m = (await tx.membership.findFirst({ where: { userId, ...inOrg(ctx) }, select: { userId: true, role: true } })) ?? notFound();
  if (m.role === 'guest') throw new Refused('A guest cannot hold or take a seat.');
  return m;
}

export const createSeat = orgAction(null, z.object({ name }), async (ctx, i) => {
  requirePerm(ctx, 'seats.manage');
  await withOrg(ctx, async (tx) => {
    if (await tx.seat.findFirst({ where: { ...inOrg(ctx), name: i.name }, select: { id: true } })) throw new Refused(`There is already a ${i.name} seat.`);
    const s = await tx.seat.create({ data: { ...inOrg(ctx), name: i.name } });
    await audit(ctx, 'seat.created', { targetType: 'seat', targetId: s.id, data: { name: s.name } }, tx);
  });
  refresh(ctx);
  return { notice: `Seat ${i.name} created.` };
});

/** Seats a member from now, until `activeTo` if given; a past holder is re-seated on the same row. */
export const assignSeat = orgAction(null, z.object({ seatId: ref('seat'), userId: ref('member'), activeTo: z.string().max(10).default('') }), async (ctx, i) => {
  requirePerm(ctx, 'seats.manage');
  await withOrg(ctx, async (tx) => {
    const seat = (await tx.seat.findFirst({ where: { id: i.seatId, ...inOrg(ctx) } })) ?? notFound();
    const m = await staffMember(tx, ctx, i.userId);
    const activeTo = i.activeTo ? isoDate(i.activeTo, 'End date') : null;
    if (activeTo && activeTo <= now()) throw new Refused('The end date must be in the future.');
    const data = { activeFrom: now(), activeTo, delegateToId: null };
    await tx.seatHolder.upsert({ where: { seatId_userId: { seatId: seat.id, userId: m.userId } }, create: { ...inOrg(ctx), seatId: seat.id, userId: m.userId, ...data }, update: data });
    await audit(ctx, 'seat.assigned', { targetType: 'seat', targetId: seat.id, data: { userId: m.userId, activeTo: activeTo?.toISOString() ?? null } }, tx);
  });
  refresh(ctx);
  return { notice: 'Seat assigned.' };
});

/** A foreign seat or member is notFound; an in-org pair that is not a holding is a refusal. */
async function holding(tx: Tx, ctx: OrgCtx, seatId: string, userId: string) {
  const seat = (await tx.seat.findFirst({ where: { id: seatId, ...inOrg(ctx) }, select: { id: true, name: true } })) ?? notFound();
  if (!(await tx.membership.findFirst({ where: { userId, ...inOrg(ctx) }, select: { userId: true } }))) notFound();
  const h = await tx.seatHolder.findFirst({ where: { ...inOrg(ctx), seatId: seat.id, userId } });
  if (!h) throw new Refused(`That person does not hold the ${seat.name} seat.`);
  return h;
}

export const endSeat = orgAction(null, z.object({ seatId: ref('seat'), userId: ref('member') }), async (ctx, i) => {
  requirePerm(ctx, 'seats.manage');
  await withOrg(ctx, async (tx) => {
    const h = await holding(tx, ctx, i.seatId, i.userId);
    await tx.seatHolder.update({ where: { id: h.id }, data: { activeTo: now(), delegateToId: null } });
    await audit(ctx, 'seat.ended', { targetType: 'seat', targetId: h.seatId, data: { userId: h.userId } }, tx);
  });
  refresh(ctx);
  return { notice: 'Seat ended.' };
});

/** PRD §3 rule 3: the holder's steps go to the delegate until the delegation is cleared (or the holding ends). */
export const delegateSeat = orgAction(null, z.object({ seatId: ref('seat'), userId: ref('member'), delegateToId: ref('member') }), async (ctx, i) => {
  requirePerm(ctx, 'seats.manage');
  await withOrg(ctx, async (tx) => {
    if (!(await tx.membership.findFirst({ where: { userId: i.delegateToId, ...inOrg(ctx) }, select: { userId: true } }))) notFound(); // every id resolves before any refusal
    const h = await holding(tx, ctx, i.seatId, i.userId);
    const to = await staffMember(tx, ctx, i.delegateToId);
    if (to.userId === h.userId) throw new Refused('A holder cannot delegate to themselves.');
    await tx.seatHolder.update({ where: { id: h.id }, data: { delegateToId: to.userId } });
    await audit(ctx, 'seat.delegated', { targetType: 'seat', targetId: h.seatId, data: { from: h.userId, to: to.userId } }, tx);
  });
  refresh(ctx);
  return { notice: 'Delegation set.' };
});

export const clearDelegation = orgAction(null, z.object({ seatId: ref('seat'), userId: ref('member') }), async (ctx, i) => {
  requirePerm(ctx, 'seats.manage');
  await withOrg(ctx, async (tx) => {
    const h = await holding(tx, ctx, i.seatId, i.userId);
    await tx.seatHolder.update({ where: { id: h.id }, data: { delegateToId: null } });
    await audit(ctx, 'seat.delegation_cleared', { targetType: 'seat', targetId: h.seatId, data: { from: h.userId, to: h.delegateToId } }, tx);
  });
  refresh(ctx);
  return { notice: 'Delegation cleared.' };
});

// ---------- agencies and guests (PRD §5) ----------

/** Ties a `guest` member to one agency in this org (D-12). Phase 3 binds it at invite time. */
export const assignGuestAgency = orgAction(null, z.object({ userId: ref('member'), agencyId: ref('agency') }), async (ctx, i) => {
  requirePerm(ctx, 'agency.manage');
  await withOrg(ctx, async (tx) => {
    const m = (await tx.membership.findFirst({ where: { userId: i.userId, ...inOrg(ctx) } })) ?? notFound();
    const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
    if (m.role !== 'guest') throw new Refused('Only a guest can be tied to an agency.');
    if (agency.offboardedAt) throw new Refused(`${agency.name} has been offboarded.`);
    await tx.guestMembership.upsert({ where: { orgId_userId: { orgId: ctx.orgId, userId: m.userId } }, create: { ...inOrg(ctx), userId: m.userId, agencyId: agency.id }, update: { agencyId: agency.id } });
    await audit(ctx, 'guest.agency.assigned', { targetType: 'user', targetId: m.userId, data: { agencyId: agency.id } }, tx);
  });
  refresh(ctx);
  return { notice: 'Guest tied to the agency.' };
});

/** An agency the client works with; `domains` are its email domains, used to suggest a new guest's agency (D-29). */
export const createAgency = orgAction(null, z.object({ name, domains: z.string().max(500).default('') }), async (ctx, i) => {
  requirePerm(ctx, 'agency.manage');
  const domains = [...new Set(i.domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  if (domains.some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) throw new Refused('Domains look like meridian.com, separated by commas.');
  await withOrg(ctx, async (tx) => {
    if (await tx.agency.findFirst({ where: { ...inOrg(ctx), name: i.name }, select: { id: true } })) throw new Refused(`${i.name} already exists.`);
    const a = await tx.agency.create({ data: { ...inOrg(ctx), name: i.name, domains } });
    await audit(ctx, 'agency.created', { targetType: 'agency', targetId: a.id, data: { name: a.name, domains } }, tx);
  });
  refresh(ctx);
  return { notice: `${i.name} added.` };
});

/**
 * PRD §5: offboarding closes the agency's open POs and ends every guest membership tied to it in this org only
 * (E-INV-07). The agency is marked first, in its own transaction, so its guests see nothing from that moment
 * (scopeOf fails closed) even if a membership removal below fails; each removal then runs core's removeMember
 * (share links, invites, the membership hook, its own audit row). Rerunning it after a failed removal finishes the job.
 */
export const offboardAgency = orgAction(null, z.object({ agencyId: ref('agency') }), async (ctx, i) => {
  requirePerm(ctx, 'agency.manage');
  assertNotDemo(ctx.session); // removeMember refuses the shared demo account; refuse before the agency is marked
  const { name, retry, guests } = await withOrg(ctx, async (tx) => {
    const agency = (await tx.agency.findFirst({ where: { id: i.agencyId, ...inOrg(ctx) } })) ?? notFound();
    if (!agency.offboardedAt) {
      await tx.agency.update({ where: { id: agency.id }, data: { offboardedAt: now() } });
      const closed = await tx.commitment.updateMany({ where: { ...inOrg(ctx), agencyId: agency.id, closedAt: null }, data: { closedAt: now(), closeReason: 'offboarded' } });
      await audit(ctx, 'agency.offboarded', { targetType: 'agency', targetId: agency.id, data: { commitmentsClosed: closed.count } }, tx);
    }
    // GuestMembership outlives the membership, so only guests still in the org: a retry after a failed removal
    // below finishes the job instead of being refused as already offboarded.
    const tied = await tx.guestMembership.findMany({ where: { ...inOrg(ctx), agencyId: agency.id }, select: { userId: true } });
    const guests = await tx.membership.findMany({ where: { ...inOrg(ctx), userId: { in: tied.map((t) => t.userId) } }, select: { userId: true } });
    return { name: agency.name, retry: !!agency.offboardedAt, guests };
  });
  if (retry && !guests.length) throw new Refused(`${name} is already offboarded.`);
  for (const g of guests) await removeMember(ctx, g.userId, onMembershipEnded);
  refresh(ctx);
  return { guestsRemoved: guests.length, notice: `Offboarded; ${guests.length} guest${guests.length === 1 ? '' : 's'} removed.` };
});
