// CLONE-OWNED. The INV-01..04 harness seeds these rows in both fixture orgs, so it can drive
// actions whose inputs use ref('<model>') for the clone's own tables. Return { model: id } for
// one row of each model, owned by `org.orgId`. INV-29 (RLS enforce) calls it too, so every org-owned clone table has rows to scope. The template has no app tables, so it seeds none.
//
// Earmark: one row in every one of its 17 tables (INV-29 needs each to hold A rows), and a ref for every model an action
// names. The spendRequest ref is a submitted request waiting at Budget Owner; the commitment ref is an approved one's PO.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

const RULES = JSON.parse(readFileSync('rules/approval-chains.json', 'utf8'));

export async function seedApp(org: { orgId: string; userId: string }, key: 'a' | 'b'): Promise<Record<string, string>> {
  const { orgId, userId } = org;
  // The harness reseeds before every call and keeps the refs from its first seed, so ids must come out the same each
  // time: derived from the org id and a name. INV-29's random org ids give fresh ones.
  const id = (name: string) => createHash('sha256').update(`${orgId}:${name}`).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/, '$1-$2-4$3-8$4-$5');
  const tag = `${key}-${orgId.slice(-8)}`;
  await db.orgSettings.create({ data: { orgId, rules: RULES } });
  const fy = await db.fiscalYear.create({ data: { id: id('fy'), orgId, label: `FY ${tag}`, startsOn: new Date('2026-01-01') } });
  const period = await db.period.create({ data: { id: id('period'), orgId, fiscalYearId: fy.id, index: 1, startsOn: new Date('2026-01-01'), endsOn: new Date('2026-01-31') } });
  const program = await db.program.create({ data: { id: id('program'), orgId, fiscalYearId: fy.id, name: 'Demand Gen' } });
  const campaign = await db.campaign.create({ data: { id: id('campaign'), orgId, programId: program.id, name: 'Paid Social' } });
  const line = { orgId, campaignId: campaign.id, periodId: period.id, plannedCents: 5_000_000n, ownerSeat: 'Budget Owner' };
  const budgetLine = await db.budgetLine.create({ data: { ...line, id: id('line'), name: 'Q1 Paid Social' } });
  const otherLine = await db.budgetLine.create({ data: { ...line, id: id('line2'), name: 'Q1 Search' } });
  const agency = await db.agency.create({ data: { id: id('agency'), orgId, name: `Meridian ${key}`, domains: ['meridian.example.test'] } });

  // A second approver holds Budget Owner beside the actor, so the actor's own request still has someone to approve it.
  const approver = await db.user.create({ data: { id: id('approver'), email: `approver-${tag}@example.test` } });
  await db.membership.create({ data: { orgId, userId: approver.id, role: 'member' } });
  const guest = await db.user.create({ data: { id: id('guest'), email: `guest-${tag}@meridian.example.test` } });
  await db.membership.create({ data: { orgId, userId: guest.id, role: 'guest' } });
  await db.guestMembership.create({ data: { orgId, userId: guest.id, agencyId: agency.id } });
  const seat = await db.seat.create({ data: { id: id('seat'), orgId, name: 'Budget Owner' } });
  await db.seatHolder.createMany({ data: [userId, approver.id].map((u) => ({ id: id(`holder-${u}`), orgId, seatId: seat.id, userId: u })) });

  const step = (requestId: string, decided: boolean) => ({
    id: id(`step-${requestId}`), orgId, requestId, index: 0, seat: 'Budget Owner', thresholdCents: 0n, source: 'chain', approverIds: [approver.id],
    ...(decided ? { decidedById: approver.id, decision: 'approve' as const, decidedAt: new Date() } : {}),
  });
  const chainSnapshot = { ok: true, kind: 'default', steps: [{ index: 0, seat: 'Budget Owner' }] };
  const base = { orgId, budgetLineId: budgetLine.id, agencyId: agency.id, amountCents: 750_000n, requestedById: userId, chainSnapshot };
  const pending = await db.spendRequest.create({ data: { ...base, id: id('pending'), description: 'Fixture: waiting at Budget Owner' } });
  await db.approvalStep.create({ data: step(pending.id, false) });
  const approved = await db.spendRequest.create({ data: { ...base, id: id('approved'), description: 'Fixture: approved', state: 'approved', decidedAt: new Date() } });
  await db.approvalStep.create({ data: step(approved.id, true) });
  const commitment = await db.commitment.create({ data: { id: id('commitment'), orgId, requestId: approved.id, agencyId: agency.id, poNumber: `PO-${tag}`, amountCents: 750_000n, remainingCents: 750_000n } });

  const invoice = await db.invoice.create({
    data: { id: id('invoice'), orgId, agencyId: agency.id, number: `INV-${tag}`, poNumber: commitment.poNumber, amountCents: 100_000n, invoicedOn: new Date('2026-01-10'), dueOn: new Date('2026-02-09'), submittedById: guest.id },
  });
  const matched = await db.invoice.create({
    data: { id: id('invoice-m'), orgId, agencyId: agency.id, number: `INV-${tag}-m`, amountCents: 50_000n, invoicedOn: new Date('2026-01-05'), dueOn: new Date('2026-02-04'), submittedById: guest.id, state: 'matched' },
  });
  await db.invoiceMatch.create({ data: { id: id('match'), orgId, invoiceId: matched.id, commitmentId: commitment.id, amountCents: 50_000n, matchedById: userId, variance: 'under' } });
  await db.commitment.update({ where: { id: commitment.id }, data: { remainingCents: 700_000n } });

  const realloc = await db.spendRequest.create({ data: { ...base, id: id('realloc-req'), kind: 'reallocation', description: 'Fixture: reallocation', state: 'approved' } });
  await db.reallocation.create({ data: { id: id('realloc'), orgId, fromLineId: otherLine.id, toLineId: budgetLine.id, amountCents: 750_000n, requestId: realloc.id } });
  await db.varianceNote.create({ data: { id: id('note'), orgId, budgetLineId: budgetLine.id, periodId: period.id, draft: 'Fixture draft.', createdById: userId } });

  return { budgetLine: budgetLine.id, agency: agency.id, spendRequest: pending.id, commitment: commitment.id, invoice: invoice.id };
}
