// PRD-A A1, A4 (review U1, U2, S1, C2; Shane's decision 1 (c), D-72): a shared demo account cannot change what the
// next visitor's walk depends on. Every configuration action refuses an `isDemo` session before it writes; the walk's
// own acts (a request, a decision) still work, with free text capped at 200 characters for a demo session.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { env } from '@/core/env';
import {
  assignGuestAgency, assignSeat, clearDelegation, createAgency, createCampaign, createFiscalYear, createLine, createProgram, createSeat,
  delegateSeat, editRules, endSeat, setPlanned, submitReallocation, submitRequest,
} from '@/earmark/actions';
import { resetAuthTables } from '../../helpers/auth';
import { addGuest, as, world } from './world';

const was = env.DEMO_MODE;
beforeEach(async () => {
  await resetAuthTables();
  env.DEMO_MODE = '1'; // a demo user's session resolves only in DEMO_MODE
});
afterEach(() => {
  env.DEMO_MODE = was;
});

const REFUSED = { error: 'This is a shared demo account, so that is switched off here.' };

it('every configuration action refuses a shared demo session and writes nothing', async () => {
  const w = await world('demo-guard', { plannedCents: 10_000_000n });
  await db.user.updateMany({ where: { id: { in: [w.owner.id, w.admin.id, w.requester.id] } }, data: { isDemo: true } });
  const other = await db.budgetLine.create({ data: { orgId: w.orgId, campaignId: (w.line as { campaignId: string }).campaignId, periodId: w.period.id, name: 'Q1 Search', plannedCents: 1_000_000n, ownerSeat: 'Budget Owner' } });
  const fy = await db.fiscalYear.findFirstOrThrow({ where: { orgId: w.orgId } });
  const program = await db.program.findFirstOrThrow({ where: { orgId: w.orgId } });
  const finance = await db.seat.findFirstOrThrow({ where: { orgId: w.orgId, name: 'Finance' } });
  const dana = await db.user.create({ data: { email: 'dana@meridian.test', isDemo: true } });
  await addGuest(w.orgId, w.agency.id, dana.id);
  const rules = JSON.stringify((await db.orgSettings.findFirstOrThrow({ where: { orgId: w.orgId } })).rules);
  const audited = () => db.auditEvent.count({ where: { orgId: w.orgId } });
  const before = await audited();

  const owner = <T,>(fn: () => Promise<T>) => as(w.owner.id, fn);
  const calls: [string, () => Promise<unknown>][] = [
    ['editRules', () => owner(() => editRules(w.slug, { rules: rules.replace('1000000', '1500000') }))],
    ['createFiscalYear', () => owner(() => createFiscalYear(w.slug, { label: 'FY27', startsOn: '2027-01-01' }))],
    ['createProgram', () => owner(() => createProgram(w.slug, { fiscalYearId: fy.id, name: 'Brand' }))],
    ['createCampaign', () => owner(() => createCampaign(w.slug, { programId: program.id, name: 'Search' }))],
    ['createLine', () => owner(() => createLine(w.slug, { campaignId: (w.line as { campaignId: string }).campaignId, periodId: w.period.id, name: 'Q1 Video', planned: '1.00', ownerSeat: 'Budget Owner' }))],
    ['setPlanned', () => owner(() => setPlanned(w.slug, { budgetLineId: w.line.id, planned: '1.00' }))],
    ['createSeat', () => owner(() => createSeat(w.slug, { name: 'Legal' }))],
    ['assignSeat', () => owner(() => assignSeat(w.slug, { seatId: finance.id, userId: w.admin.id, activeTo: '' }))],
    ['endSeat', () => owner(() => endSeat(w.slug, { seatId: finance.id, userId: w.finance.id }))],
    ['delegateSeat', () => owner(() => delegateSeat(w.slug, { seatId: finance.id, userId: w.finance.id, delegateToId: w.ops.id }))],
    ['clearDelegation', () => owner(() => clearDelegation(w.slug, { seatId: finance.id, userId: w.finance.id }))],
    ['createAgency', () => owner(() => createAgency(w.slug, { name: 'Northstar', domains: '' }))],
    ['assignGuestAgency', () => owner(() => assignGuestAgency(w.slug, { userId: dana.id, agencyId: w.agency.id }))],
    ['submitReallocation', () => as(w.requester.id, () => submitReallocation(w.slug, { fromLineId: w.line.id, toLineId: other.id, amount: '1.00', description: 'Shift' }))],
  ];
  for (const [name, call] of calls) expect([name, await call()]).toEqual([name, REFUSED]);
  expect(await audited()).toBe(before);
  expect(await db.seatHolder.findFirstOrThrow({ where: { orgId: w.orgId, seatId: finance.id, userId: w.finance.id } })).toMatchObject({ activeTo: null });
  expect((await db.budgetLine.findUniqueOrThrow({ where: { id: w.line.id } })).plannedCents).toBe(10_000_000n);

  // The walk itself still works for the same shared account.
  expect(await as(w.requester.id, () => submitRequest(w.slug, { budgetLineId: w.line.id, agencyId: w.agency.id, amount: '12,000.00', description: 'Demo walk-through' }))).toMatchObject({ notice: expect.any(String) });
});

it('a demo session keeps free text to 200 characters; a real account keeps the general caps', async () => {
  const w = await world('demo-text', { plannedCents: 10_000_000n });
  await db.user.update({ where: { id: w.requester.id }, data: { isDemo: true } });
  const submit = (userId: string, description: string) => as(userId, () => submitRequest(w.slug, { budgetLineId: w.line.id, agencyId: w.agency.id, amount: '100.00', description }));
  expect(await submit(w.requester.id, 'x'.repeat(201))).toEqual({ error: 'On the shared demo, keep text to 200 characters.' });
  expect(await submit(w.requester.id, 'x'.repeat(200))).toMatchObject({ notice: expect.any(String) });
  expect(await submit(w.admin.id, 'x'.repeat(201))).toMatchObject({ notice: expect.any(String) });
});
