// One runnable check per LOW finding fixed from audit/FOUNDATION-REVIEW-2026-09-26.md on
// 2026-09-28 (K1, K2, K5, K6, K13 — see that file for what each is and why it matters).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { now } from '@/core/clock';
import { clientIp } from '@/core/http';
import { confirmEmailChange, redeemLink, requestEmailChange } from '@/core/auth/link';
import { currentSession, SESSION_COOKIE, signOutEverywhere } from '@/core/auth/session';
import { confirmTotp, enrolTotp } from '@/core/auth/totp';
import { hashToken, newToken } from '@/core/tokens';
import { revokeInvite } from '@/core/tenancy/invites';
import { removeMember } from '@/core/tenancy/orgs';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { codeFor, makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

const lastMessage = async () => (await db.capturedMessage.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).body;

async function plantLoginToken(userId: string, email: string) {
  const token = newToken();
  await db.loginToken.create({
    data: { hash: hashToken(token), purpose: 'login', email, userId, createdAt: now(), expiresAt: new Date(now().getTime() + 900_000) },
  });
  return token;
}

describe('K1: outstanding sign-in links die with the session boundary that should have ended them', () => {
  it('sign-out-everywhere spends every unused sign-in link for that user', async () => {
    const u = await makeUser();
    const token = await plantLoginToken(u.id, u.email);
    await signOutEverywhere(u.id);
    expect(await redeemLink(token)).toBeNull();
  });

  it('confirming an email change spends other unused sign-in links for the old address', async () => {
    const u = await makeUser('old@example.test');
    await signInAs(u.id);
    const stale = await plantLoginToken(u.id, u.email);
    await requestEmailChange((await currentSession())!, 'new@example.test');
    const confirmToken = (await lastMessage()).match(/\/account\/email\/([\w-]+)/)![1]!;
    expect(await confirmEmailChange((await currentSession())!, confirmToken)).toBe(true);
    expect(await redeemLink(stale)).toBeNull();
  });
});

it('K1: the session cookie uses the __Host- prefix', () => {
  expect(SESSION_COOKIE).toBe('__Host-session');
});

describe('K2: confirming TOTP enrolment cannot double-issue recovery codes', () => {
  it('a stale session is refused', async () => {
    const u = await makeUser();
    await signInAs(u.id);
    await enrolTotp();
    const { advanceClock } = await import('@/core/clock');
    advanceClock(5 * 60_000 + 1000);
    await expect(confirmTotp('000000')).rejects.toThrow();
  });

  it('two concurrent confirms leave exactly one enrolment and ten recovery codes', async () => {
    const u = await makeUser();
    await signInAs(u.id);
    const { secret } = await enrolTotp();
    const code = codeFor(secret);
    const [a, b] = await Promise.all([confirmTotp(code), confirmTotp(code)]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(await db.recoveryCode.count({ where: { userId: u.id } })).toBe(10);
  });
});

describe('K5: an IPv6 rate-limit key is scoped to a /64, not the exact address', () => {
  it('two addresses in the same /64 map to the same key', () => {
    const h = (ip: string) => new Headers({ 'x-forwarded-for': ip });
    expect(clientIp(h('2001:db8:1:2:aaaa::1'))).toBe(clientIp(h('2001:db8:1:2:ffff::2')));
  });

  it('addresses in different /64s map to different keys', () => {
    const h = (ip: string) => new Headers({ 'x-forwarded-for': ip });
    expect(clientIp(h('2001:db8:1:2::1'))).not.toBe(clientIp(h('2001:db8:1:3::1')));
  });

  it('IPv4 is untouched and an absent header stays "unknown"', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '10.0.0.1' }))).toBe('10.0.0.1');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('K6: a share link does not outlive its creator\'s membership', () => {
  it('removing a member revokes the share links they created', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const bob = await addMember(org.id, 'member', 'bob@example.test');
    const project = await db.project.create({ data: { orgId: org.id, name: 'P', notes: '' } });
    const link = await db.shareLink.create({
      data: { orgId: org.id, resourceType: 'project', resourceId: project.id, tokenHash: hashToken(newToken()), createdById: bob.id, expiresAt: new Date(now().getTime() + 86_400_000) },
    });
    await removeMember(await actAs(owner.id, org.slug), bob.id, onMembershipEnded);
    expect((await db.shareLink.findUniqueOrThrow({ where: { id: link.id } })).revokedAt).not.toBeNull();
  });
});

describe('K13: a write and its audit row commit together', () => {
  it('revokeInvite rolls back the invite revoke when the audit write fails', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const ctx = await actAs(owner.id, org.slug);
    const invite = await db.invite.create({
      data: { orgId: org.id, email: 'x@example.test', role: 'member', tokenHash: hashToken(newToken()), invitedById: owner.id, expiresAt: new Date(now().getTime() + 86_400_000) },
    });
    const auditModule = await import('@/core/audit');
    const spy = vi.spyOn(auditModule, 'audit').mockRejectedValueOnce(new Error('boom'));
    await expect(revokeInvite(ctx, invite.id)).rejects.toThrow('boom');
    expect((await db.invite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).toBeNull();
    spy.mockRestore();
  });
});
