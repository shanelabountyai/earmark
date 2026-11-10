// Phase 3 item 6, planning (D-26): a fiscal year gets twelve fiscal months; a line's period must be in its campaign's
// year and its owner seat must exist; planned edits are audited, stamped for the replan marker, and stop at lock.
import { beforeEach, expect, it } from 'vitest';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { createFiscalYear, createLine, setPlanned } from '@/earmark/actions';
import { ledgerOf } from '@/earmark/core';
import { resetAuthTables } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { as, commitmentFor, world } from './world';

beforeEach(resetAuthTables);

it('a July fiscal year has twelve months ending in June, and only a planner can create one', async () => {
  const w = await world('acme');
  expect(await as(w.requester.id, () => createFiscalYear(w.slug, { label: 'FY27', startsOn: '2026-07-01' }))).toEqual({ error: 'You do not have access to that.' });
  expect(await as(w.admin.id, () => createFiscalYear(w.slug, { label: 'FY27', startsOn: '2026-07-15' }))).toEqual({ error: 'A fiscal year starts on the first of a month.' });
  expect(await as(w.admin.id, () => createFiscalYear(w.slug, { label: 'FY27', startsOn: '2026-07-01' }))).toEqual({ notice: 'FY27 created with 12 periods.' });
  const periods = await db.period.findMany({ where: { fiscalYear: { orgId: w.orgId, label: 'FY27' } }, orderBy: { index: 'asc' } });
  expect(periods.map((p) => [p.index, p.startsOn.toISOString().slice(0, 10), p.endsOn.toISOString().slice(0, 10)])).toEqual(
    [['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31'],
      ['2027-01-01', '2027-01-31'], ['2027-02-01', '2027-02-28'], ['2027-03-01', '2027-03-31'], ['2027-04-01', '2027-04-30'], ['2027-05-01', '2027-05-31'], ['2027-06-01', '2027-06-30']].map(([s, e], k) => [k + 1, s, e]),
  );
});

it('a line takes a period of its own year and an existing seat', async () => {
  const w = await world('acme');
  const line = (periodId: string, ownerSeat = 'Budget Owner') =>
    as(w.admin.id, () => createLine(w.slug, { campaignId: (w.line as { campaignId: string }).campaignId, periodId, name: 'Q1 Search', planned: '20,000.00', ownerSeat }));
  await as(w.admin.id, () => createFiscalYear(w.slug, { label: 'FY27', startsOn: '2027-01-01' }));
  const other = await db.period.findFirstOrThrow({ where: { fiscalYear: { orgId: w.orgId, label: 'FY27' } } });
  expect(await line(other.id)).toEqual({ error: 'That period is in a different fiscal year than the campaign.' });
  expect(await line(w.period.id, 'Nobody')).toEqual({ error: 'There is no seat named Nobody.' });
  expect(await line(w.period.id)).toEqual({ notice: 'Line Q1 Search created.' });
  expect(await db.budgetLine.findFirstOrThrow({ where: { orgId: w.orgId, name: 'Q1 Search' } })).toMatchObject({ plannedCents: 2_000_000n, ownerSeat: 'Budget Owner', plannedEditedAt: null });
});

it('a planned edit after the first PO is audited and marks a replan; a locked year refuses it', async () => {
  const w = await world('acme', { plannedCents: 1_000_000n });
  await commitmentFor(w, w.agency.id, 100_000n, 'PO-1');
  expect(await as(w.admin.id, () => setPlanned(w.slug, { budgetLineId: w.line.id, planned: '$12,500.00' }))).toEqual({ notice: 'Planned saved.' });
  const audit = await db.auditEvent.findFirstOrThrow({ where: { orgId: w.orgId, action: 'plan.line.planned_edited' } });
  expect(audit.data).toEqual({ beforeCents: '1000000', afterCents: '1250000' });
  const ctx = await actAs(w.admin.id, w.slug);
  const ledger = await withOrg(ctx, (tx) => ledgerOf(tx, ctx, { id: w.line.id }), { atomic: false });
  expect(ledger.replan.has(w.line.id)).toBe(true);
  expect(ledger.rollup.lines[0]!.plannedCents).toBe(1_250_000n);

  await db.fiscalYear.updateMany({ where: { orgId: w.orgId }, data: { lockedAt: new Date() } });
  expect(await as(w.admin.id, () => setPlanned(w.slug, { budgetLineId: w.line.id, planned: '0.00' }))).toEqual({ error: 'FY26 is locked; its plan cannot change.' });
});
