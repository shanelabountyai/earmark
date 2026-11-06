import { beforeEach, describe, expect, it } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { currentSession } from '@/core/auth/session';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { deleteAccount } from '@/core/tenancy/delete';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { actAs, addMember, makeOrg, roleOf } from '../helpers/org';

beforeEach(resetAuthTables);

const LAST = /at least one owner/;

describe('INV-21 an org never reaches zero owners', () => {
  it('the sole owner cannot demote themself, leave, or be removed', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const ctx = await actAs(owner.id, org.slug);
    await expect(changeRole(ctx, owner.id, 'admin')).rejects.toThrow(LAST);
    await expect(removeMember(ctx, owner.id, onMembershipEnded)).rejects.toThrow(LAST);
    expect(await roleOf(org.id, owner.id)).toBe('owner');
  });

  it('the sole owner cannot delete their account', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    await signInAs(owner.id, { mfa: true });
    await expect(deleteAccount((await currentSession())!, 'owner@example.test', onMembershipEnded)).rejects.toThrow(LAST);
    expect(await db.user.count({ where: { id: owner.id } })).toBe(1);
  });

  it('with a second owner, each of those is allowed', async () => {
    const org = await makeOrg();
    const a = await addMember(org.id, 'owner', 'a@example.test');
    const b = await addMember(org.id, 'owner', 'b@example.test');
    await changeRole(await actAs(a.id, org.slug), a.id, 'admin');
    expect(await roleOf(org.id, a.id)).toBe('admin');
    await signInAs(b.id, { mfa: true });
    await expect(deleteAccount((await currentSession())!, 'b@example.test', onMembershipEnded)).rejects.toThrow(LAST); // b is now the only owner
  });

  it('two owners demoting each other at once: exactly one wins', async () => {
    const org = await makeOrg();
    const a = await addMember(org.id, 'owner', 'a@example.test');
    const b = await addMember(org.id, 'owner', 'b@example.test');
    const [ctxA, ctxB] = [await actAs(a.id, org.slug), await actAs(b.id, org.slug)];
    const results = await Promise.allSettled([changeRole(ctxA, b.id, 'member'), changeRole(ctxB, a.id, 'member')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await db.membership.count({ where: { orgId: org.id, role: 'owner' } })).toBe(1);
  });
});
