// Phase 3 item 6, reallocation (D-28): routed through the `reallocation` chain; refused across fiscal years and beyond
// the source's available; on the last approval planned moves between the lines, re-checked at that moment.
import { beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { decideStep, submitReallocation } from '@/earmark/actions';
import { resetAuthTables } from '../../helpers/auth';
import { as, commitmentFor, world } from './world';

beforeEach(resetAuthTables);

async function setup() {
  const w = await world('acme', { plannedCents: 5_000_000n });
  const to = await db.budgetLine.create({ data: { orgId: w.orgId, campaignId: w.line.campaignId, periodId: w.period.id, name: 'Q1 Search', plannedCents: 1_000_000n, ownerSeat: 'Budget Owner' } });
  const move = (amount: string, toLineId = to.id) => as(w.requester.id, () => submitReallocation(w.slug, { fromLineId: w.line.id, toLineId, amount, description: 'Shift to search' }));
  return { w, to, move };
}

it('moves planned on the last approval, through Marketing Ops then Finance above $25,000', async () => {
  const { w, to, move } = await setup();
  const r = (await move('30,000.00')) as { id: string };
  expect((await db.approvalStep.findMany({ where: { requestId: r.id }, orderBy: { index: 'asc' } })).map((s) => s.seat)).toEqual(['Marketing Ops', 'Finance']);
  await as(w.ops.id, () => decideStep(w.slug, { requestId: r.id, decision: 'approve' }));
  expect((await db.budgetLine.findUniqueOrThrow({ where: { id: to.id } })).plannedCents).toBe(1_000_000n); // not yet
  await as(w.finance.id, () => decideStep(w.slug, { requestId: r.id, decision: 'approve' }));
  expect((await db.budgetLine.findUniqueOrThrow({ where: { id: w.line.id } })).plannedCents).toBe(2_000_000n);
  expect((await db.budgetLine.findUniqueOrThrow({ where: { id: to.id } })).plannedCents).toBe(4_000_000n);
  expect(await db.commitment.count({ where: { orgId: w.orgId } })).toBe(0);
  expect(await db.auditEvent.count({ where: { orgId: w.orgId, action: 'reallocation.applied' } })).toBe(1);
});

it('refuses beyond available, across fiscal years, and at approval when the money has since been committed', async () => {
  const { w, move } = await setup();
  expect(await move('50,000.01')).toEqual({ error: 'Q1 Paid Social has only $50,000.00 available.' });
  const fy = await db.fiscalYear.create({ data: { orgId: w.orgId, label: 'FY27', startsOn: new Date('2027-01-01') } });
  const p = await db.period.create({ data: { orgId: w.orgId, fiscalYearId: fy.id, index: 1, startsOn: new Date('2027-01-01'), endsOn: new Date('2027-01-31') } });
  const next = await db.budgetLine.create({ data: { orgId: w.orgId, campaignId: w.line.campaignId, periodId: p.id, name: 'Next year', plannedCents: 0n, ownerSeat: 'Budget Owner' } });
  expect(await move('1,000.00', next.id)).toEqual({ error: 'Money cannot move between fiscal years.' });

  const r = (await move('10,000.00')) as { id: string };
  await commitmentFor(w, w.agency.id, 4_500_000n, 'PO-1'); // available drops to $5,000
  expect(await as(w.ops.id, () => decideStep(w.slug, { requestId: r.id, decision: 'approve' }))).toEqual({ error: 'Q1 Paid Social has only $5,000.00 available now; the reallocation cannot be applied.' });
  expect(await db.spendRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ state: 'submitted' });
  expect((await db.budgetLine.findUniqueOrThrow({ where: { id: w.line.id } })).plannedCents).toBe(5_000_000n);
});
