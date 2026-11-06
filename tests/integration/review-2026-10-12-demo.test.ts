// 2026-10-12 review, demo finding: what a /demo session may do, and what happens to demo accounts once
// DEMO_MODE is off. INV-27 (tests/invariants/inv-27-demo.test.ts) covers who may sign in at /demo.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';

// env.ts parses process.env at import; this file runs with the flag on, as a demo deployment does.
vi.hoisted(() => { process.env.DEMO_MODE = '1'; });

import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { demoSignIn } from '@/core/auth/demo';
import { redeemLink, requestEmailChange, requestLink } from '@/core/auth/link';
import { currentSession, SESSION_COOKIE, sessionFor } from '@/core/auth/session';
import { disableTotp, enrolTotp } from '@/core/auth/totp';
import { requireOrg } from '@/core/authz/guards';
import { deleteAccount, deleteOrg } from '@/core/tenancy/delete';
import { createInvite } from '@/core/tenancy/invites';
import { changeRole, createOrg, removeMember } from '@/core/tenancy/orgs';
import { seedDemo } from '../../scripts/seed-demo';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';
import { jar } from '../helpers/next';

beforeEach(resetAuthTables);

const DEMO = /shared demo account/;
const demoUser = (email: string) => db.user.findUniqueOrThrow({ where: { email } });

/** Signs the jar in the way /demo/signin does. */
async function viaDemo(email: string) {
  const u = await demoUser(email);
  jar.set(SESSION_COOKIE, (await demoSignIn(u.id))!);
  return u;
}

/**
 * Seed-agnostic, like INV-27 and INV-12: a clone's seed-demo.ts has its own orgs, so the first demo org (by slug)
 * and its owner, admin and member are looked up by membership, never by the template's sample addresses.
 */
async function demoOrg() {
  const { org } = await db.membership.findFirstOrThrow({ where: { role: 'owner', user: { isDemo: true } }, orderBy: { org: { slug: 'asc' } }, select: { org: true } });
  const email = async (role: 'owner' | 'admin' | 'member') =>
    (await db.membership.findFirstOrThrow({ where: { orgId: org.id, role, user: { isDemo: true } }, select: { user: { select: { email: true } } } })).user.email;
  return { slug: org.slug, owner: await email('owner'), admin: await email('admin'), member: await email('member') };
}

/** What a demo session must leave as it found it. */
const demoCounts = async (slug: string) => ({
  orgs: await db.org.count({ where: { slug } }),
  demoUsers: await db.user.count({ where: { isDemo: true } }),
  demoTotp: await db.user.count({ where: { isDemo: true, totpEnrolledAt: { not: null } } }),
  memberships: await db.membership.count({ where: { org: { slug } } }),
});

describe('a demo session cannot destroy the demo or change who owns it', () => {
  it('org and account deletion, email change and TOTP changes are refused, on a fresh session', async () => {
    await seedDemo();
    const d = await demoOrg();
    const before = await demoCounts(d.slug);
    await viaDemo(d.owner);
    const ctx = await requireOrg(d.slug);
    await expect(deleteOrg(ctx, d.slug)).rejects.toThrow(DEMO);
    await expect(requestEmailChange(ctx.session, 'mine@example.test')).rejects.toThrow(DEMO);
    await expect(disableTotp()).rejects.toThrow(DEMO);

    const admin = await viaDemo(d.admin);
    await expect(deleteAccount((await currentSession())!, admin.email, onMembershipEnded)).rejects.toThrow(DEMO);
    await viaDemo(d.member);
    await expect(enrolTotp()).rejects.toThrow(DEMO);

    // Every /demo visitor shares the account, so "sign out everywhere" would sign the others out.
    const { signOutAll } = await import('@/app/account/security/actions');
    const sessions = await db.session.count();
    expect(await signOutAll({})).toEqual({ error: expect.stringMatching(DEMO) });
    expect(await db.session.count()).toBe(sessions);

    expect(await demoCounts(d.slug)).toEqual(before);
    expect(before.orgs).toBe(1);
    expect(before.demoTotp).toBeGreaterThan(0); // owners and admins are enrolled, so "TOTP unchanged" means something
    expect(await db.loginToken.count()).toBe(0);
  });

  it('inviting, re-roling, removing and leaving are refused', async () => {
    await seedDemo();
    const d = await demoOrg();
    const before = await demoCounts(d.slug);
    const member = await demoUser(d.member);
    await viaDemo(d.owner);
    const ctx = await requireOrg(d.slug);
    await expect(createInvite(ctx, 'mine@example.test', 'owner')).rejects.toThrow(DEMO);
    await expect(changeRole(ctx, member.id, 'owner')).rejects.toThrow(DEMO);
    await expect(removeMember(ctx, member.id, onMembershipEnded)).rejects.toThrow(DEMO);
    await viaDemo(d.member);
    await expect(removeMember(await requireOrg(d.slug), member.id, onMembershipEnded)).rejects.toThrow(DEMO);

    expect(await db.invite.count()).toBe(0);
    expect(await demoCounts(d.slug)).toEqual(before);
    expect(await db.membership.count({ where: { userId: member.id, role: 'member' } })).toBe(1);
  });

  // Owner decision 2026-10-13. Billing is a removable module, so its half is in tests/invariants/inv-12-webhooks.test.ts.
  // The other half (a demo session can still add and share a project) tests the example resource a clone replaces,
  // so it is in review-2026-10-12-demo-projects.test.ts, which a clone deletes with `/o/[org]/projects`.
  it('creating an org is refused', async () => {
    await seedDemo();
    await viaDemo((await demoOrg()).owner);
    const orgs = await db.org.count();
    await expect(createOrg((await currentSession())!, 'Mine')).rejects.toThrow(DEMO);
    const { startOrg } = await import('@/app/onboarding/actions');
    expect(await startOrg({ name: 'Mine' })).toEqual({ error: expect.stringMatching(DEMO) });
    expect(await db.org.count()).toBe(orgs);
  });

  it('a real account is not affected', async () => {
    const u = await makeUser('real@example.test');
    await signInAs(u.id);
    await requestEmailChange((await currentSession())!, 'real2@example.test');
    expect(await db.loginToken.count({ where: { purpose: 'email_change' } })).toBe(1);
    expect(await createOrg((await currentSession())!, 'Real')).toBe('real');
  });
});

describe('demo accounts stop working when DEMO_MODE is off', () => {
  it('no session resolves for a demo user, however it was made; a real user is unaffected', async () => {
    await seedDemo();
    const owner = await demoUser((await demoOrg()).owner);
    const token = (await demoSignIn(owner.id))!;
    expect(await sessionFor(token, { DEMO_MODE: '1' })).not.toBeNull();
    expect(await sessionFor(token, {})).toBeNull();

    // The magic-link route in: the demo address plus the public TOTP seed is a full login otherwise.
    await requestLink(owner.email, '10.0.0.1');
    const link = (await db.capturedMessage.findFirstOrThrow({ where: { to: owner.email } })).body.match(/\/login\/([\w-]+)/)![1]!;
    expect(await sessionFor((await redeemLink(link))!, {})).toBeNull();

    const real = await makeUser('real@example.test');
    expect(await sessionFor(await signInAs(real.id), {})).not.toBeNull();
  });
});
