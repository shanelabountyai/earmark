// PRD-A A2, A3 (Shane's decisions 1 (c) and 2 (a), D-73): the nightly demo reset replants the demo orgs' Earmark rows
// and leaves the audit log alone; it does nothing outside DEMO_MODE; one failing cron job does not stop the rest.
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { runJobs } from '@/app/cron-jobs';
import { cronDemoReset } from '@/earmark/demo-reset';
import { seedDemo } from '../../scripts/seed-demo';
import { resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);

const SEED_RULES = JSON.parse(readFileSync('rules/approval-chains.json', 'utf8'));

/** What a visitor with the shared password could do before the guards: rules, a seat, a plan. */
async function spoil() {
  const org = await db.org.findUniqueOrThrow({ where: { slug: 'northwind' } });
  await db.orgSettings.update({ where: { orgId: org.id }, data: { rules: { ...SEED_RULES, default: [{ seat: 'Budget Owner', fromCents: 0 }] } } });
  const finance = await db.seat.findFirstOrThrow({ where: { orgId: org.id, name: 'Finance' } });
  await db.seatHolder.updateMany({ where: { orgId: org.id, seatId: finance.id }, data: { activeTo: new Date() } });
  await db.budgetLine.updateMany({ where: { orgId: org.id, name: 'Q2 Paid Social' }, data: { plannedCents: 1n } });
  await db.auditEvent.create({ data: { orgId: org.id, action: 'rules.edited', targetType: 'orgSettings', targetId: org.id } });
  return org.id;
}

const state = async (orgId: string) => ({
  rules: (await db.orgSettings.findFirstOrThrow({ where: { orgId } })).rules,
  financeEnded: (await db.seatHolder.count({ where: { orgId, seat: { name: 'Finance' }, activeTo: { not: null } } })) > 0,
  planned: (await db.budgetLine.findFirstOrThrow({ where: { orgId, name: 'Q2 Paid Social' } })).plannedCents,
});

it('replants rules, seats and planned in DEMO_MODE and keeps every audit row', async () => {
  await seedDemo();
  const orgId = await spoil();
  const audit = await db.auditEvent.count({ where: { orgId } });
  expect(await state(orgId)).toMatchObject({ financeEnded: true, planned: 1n });

  expect(await cronDemoReset({ DEMO_MODE: '1' })).toEqual({ reset: ['northwind', 'contoso'] });
  expect(await state(orgId)).toEqual({ rules: SEED_RULES, financeEnded: false, planned: 22_500_000n });
  expect(await db.auditEvent.count({ where: { orgId } })).toBeGreaterThanOrEqual(audit); // append-only: nothing deleted
  const dana = await db.user.findUniqueOrThrow({ where: { email: 'dana@meridian.demo.test' } });
  expect(await db.guestMembership.count({ where: { userId: dana.id } })).toBe(2); // tied to Meridian in both clients again
});

it('does nothing outside DEMO_MODE, or when the demo orgs are not there', async () => {
  expect(await cronDemoReset({ DEMO_MODE: '1' })).toEqual({ skipped: 'no demo orgs' });
  await seedDemo();
  const orgId = await spoil();
  expect(await cronDemoReset({ DEMO_MODE: undefined })).toEqual({ skipped: 'not demo mode' });
  expect(await state(orgId)).toMatchObject({ financeEnded: true, planned: 1n });
});

it('one failing cron job is recorded and the jobs after it still run', async () => {
  const ran: string[] = [];
  const out = await runJobs([
    ['first', async () => { ran.push('first'); return 1; }],
    ['broken', async () => { throw new TypeError('boom'); }],
    ['last', async () => { ran.push('last'); return 3; }],
  ]);
  expect(out).toEqual({ first: 1, broken: { failed: true }, last: 3 });
  expect(ran).toEqual(['first', 'last']);
});
