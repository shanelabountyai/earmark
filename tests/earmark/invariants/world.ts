// A small client org for the E-INV tests: one fiscal year, one line, an agency, seats and the people who hold them.
// Rows are written as the owner role (fixtures bypass RLS); every assertion then runs through the app role.
import { readFileSync } from 'node:fs';
import { dbSystem as db } from '@/core/db/system';
import { signInAs } from '../../helpers/auth';
import { NavSignal } from '../../helpers/next';
import { addMember, makeOrg } from '../../helpers/org';

const RULES = JSON.parse(readFileSync('rules/approval-chains.json', 'utf8'));

export async function world(slug: string, opts: { plannedCents?: bigint } = {}) {
  const org = await makeOrg(slug);
  const orgId = org.id;
  const owner = await addMember(orgId, 'owner', `owner@${slug}.test`);
  const admin = await addMember(orgId, 'admin', `admin@${slug}.test`);
  const requester = await addMember(orgId, 'member', `requester@${slug}.test`);
  const budgetOwner = await addMember(orgId, 'member', `bo@${slug}.test`);
  const ops = await addMember(orgId, 'member', `ops@${slug}.test`);
  const finance = await addMember(orgId, 'member', `finance@${slug}.test`);
  await db.orgSettings.create({ data: { orgId, rules: RULES } });
  const fy = await db.fiscalYear.create({ data: { orgId, label: 'FY26', startsOn: new Date('2026-01-01') } });
  const period = await db.period.create({ data: { orgId, fiscalYearId: fy.id, index: 1, startsOn: new Date('2026-01-01'), endsOn: new Date('2026-01-31') } });
  const program = await db.program.create({ data: { orgId, fiscalYearId: fy.id, name: 'Demand Gen' } });
  const campaign = await db.campaign.create({ data: { orgId, programId: program.id, name: 'Paid Social' } });
  const line = await db.budgetLine.create({ data: { orgId, campaignId: campaign.id, periodId: period.id, name: 'Q1 Paid Social', plannedCents: opts.plannedCents ?? 100_000_000n, ownerSeat: 'Budget Owner' } });
  const agency = await db.agency.create({ data: { orgId, name: 'Meridian Creative', domains: ['meridian.test'] } });
  const seat = async (name: string, ...userIds: string[]) => {
    const s = await db.seat.create({ data: { orgId, name } });
    await db.seatHolder.createMany({ data: userIds.map((userId) => ({ orgId, seatId: s.id, userId })) });
    return s;
  };
  await seat('Budget Owner', budgetOwner.id, requester.id); // the requester holds the seat too (E-INV-01)
  await seat('Marketing Ops', ops.id);
  await seat('Finance', finance.id);
  return { org, orgId, slug, owner, admin, requester, budgetOwner, ops, finance, line, period, agency };
}

/** Adds a guest of `agencyId` in the org (D-12). */
export async function addGuest(orgId: string, agencyId: string, userId: string) {
  await db.membership.create({ data: { orgId, userId, role: 'guest' } });
  await db.guestMembership.create({ data: { orgId, userId, agencyId } });
}

/** An approved request and its commitment, written directly (the trigger still checks them). */
export async function commitmentFor(w: { orgId: string; line: { id: string }; requester: { id: string } }, agencyId: string, amountCents: bigint, po: string) {
  const r = await db.spendRequest.create({
    data: { orgId: w.orgId, budgetLineId: w.line.id, agencyId, amountCents, description: po, requestedById: w.requester.id, state: 'approved', chainSnapshot: {} },
  });
  return db.commitment.create({ data: { orgId: w.orgId, requestId: r.id, agencyId, poNumber: po, amountCents, remainingCents: amountCents } });
}

/** Calls `fn` signed in as `userId` (MFA passed). */
export async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await signInAs(userId, { mfa: true });
  return fn();
}

/** What a call threw, as the response would carry it: the navigation signal's kind and target, or the error's text. */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify({ ok: await p }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    return e instanceof NavSignal ? JSON.stringify({ nav: e.kind, to: e.to ?? null, message: e.message }) : JSON.stringify({ error: String(e) });
  }
}
