// One runnable check per finding fixed from the 2026-10-12 review (see CHANGELOG.md, Unreleased).
import { beforeEach, describe, expect, it } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { requestEmailChange } from '@/core/auth/link';
import { currentSession } from '@/core/auth/session';
import { LIMITS } from '@/core/rate-limit';
import { acceptInvite, createInvite, pendingInvitesFor } from '@/core/tenancy/invites';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { actAs, addMember, makeOrg, roleOf } from '../helpers/org';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

const inviteToken = async (to: string) =>
  (await db.capturedMessage.findFirstOrThrow({ where: { to }, orderBy: { createdAt: 'desc' } })).body.match(/invite\/([\w-]+)/)![1]!;

/** Signs in as a new user with `email` and tries the invite sent to it. */
async function accept(email: string, token: string) {
  const u = await makeUser(email);
  await signInAs(u.id);
  return { userId: u.id, result: acceptInvite((await currentSession())!, token) };
}

describe('an invite grants no more than its issuer could grant now', () => {
  it('a removed owner cannot come back through an owner invite they sent to a spare address', async () => {
    const org = await makeOrg();
    const a = await addMember(org.id, 'owner', 'a@example.test');
    const b = await addMember(org.id, 'owner', 'b@example.test');
    await createInvite(await actAs(a.id, org.slug), 'spare@example.test', 'owner');
    const token = await inviteToken('spare@example.test');
    await removeMember(await actAs(b.id, org.slug), a.id, onMembershipEnded);

    const { userId, result } = await accept('spare@example.test', token);
    await expect(result).rejects.toThrow('not valid');
    expect(await roleOf(org.id, userId)).toBeNull();
    expect(await pendingInvitesFor((await currentSession())!)).toHaveLength(0);
  });

  it('a demoted admin\'s pending admin invite dies; an owner demoted to admin keeps only what an admin may send', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const admin = await addMember(org.id, 'admin', 'admin@example.test');
    const second = await addMember(org.id, 'owner', 'second@example.test');
    await createInvite(await actAs(admin.id, org.slug), 'x@example.test', 'admin');
    await createInvite(await actAs(second.id, org.slug), 'y@example.test', 'owner');
    await createInvite(await actAs(second.id, org.slug), 'z@example.test', 'member');
    const [x, y, z] = [await inviteToken('x@example.test'), await inviteToken('y@example.test'), await inviteToken('z@example.test')];
    const ctx = await actAs(owner.id, org.slug);
    await changeRole(ctx, admin.id, 'member');
    await changeRole(ctx, second.id, 'admin');

    await expect((await accept('x@example.test', x)).result).rejects.toThrow('not valid');
    await expect((await accept('y@example.test', y)).result).rejects.toThrow('not valid');
    const ok = await accept('z@example.test', z);
    expect(await ok.result).toBe(org.slug);
    expect(await roleOf(org.id, ok.userId)).toBe('member');
  });

  it('an invite whose issuer lost the role after it was sent is refused even if the row was never revoked', async () => {
    const org = await makeOrg();
    const a = await addMember(org.id, 'owner', 'a@example.test');
    await addMember(org.id, 'owner', 'b@example.test');
    await createInvite(await actAs(a.id, org.slug), 'spare@example.test', 'owner');
    const token = await inviteToken('spare@example.test');
    await db.membership.delete({ where: { orgId_userId: { orgId: org.id, userId: a.id } } }); // e.g. the issuer's account was deleted

    const { userId, result } = await accept('spare@example.test', token);
    await expect(result).rejects.toThrow('not valid');
    expect(await roleOf(org.id, userId)).toBeNull();
  });
});

describe('requestEmailChange does not say whether an address has an account', () => {
  it('a taken address gets the same answer as a free one, and no mail', async () => {
    await makeUser('taken@example.test');
    await signInAs((await makeUser('ada@example.test')).id);
    const s = (await currentSession())!;
    await expect(requestEmailChange(s, 'Taken@Example.test')).resolves.toBeUndefined();
    await expect(requestEmailChange(s, 'free@example.test')).resolves.toBeUndefined();
    expect(await db.capturedMessage.count({ where: { to: 'taken@example.test' } })).toBe(0);
    expect(await db.loginToken.count({ where: { purpose: 'email_change', email: 'taken@example.test' } })).toBe(0);
    expect(await db.capturedMessage.count({ where: { to: 'free@example.test' } })).toBe(1);
  });

  it('probes of taken addresses count against the rate limit', async () => {
    await makeUser('taken@example.test');
    await signInAs((await makeUser('ada@example.test')).id);
    const s = (await currentSession())!;
    for (let i = 0; i < LIMITS.linkPerEmail.limit; i++) await requestEmailChange(s, 'taken@example.test');
    await expect(requestEmailChange(s, 'taken@example.test')).rejects.toThrow('Too many');
  });
});
