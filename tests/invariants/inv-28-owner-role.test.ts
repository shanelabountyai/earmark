import { beforeEach, describe, expect, it } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { AuthzError } from '@/core/authz/guards';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { createInvite } from '@/core/tenancy/invites';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg, roleOf } from '../helpers/org';

beforeEach(resetAuthTables);

async function fixture() {
  const org = await makeOrg();
  return {
    org,
    owner: await addMember(org.id, 'owner', 'owner@example.test'),
    admin: await addMember(org.id, 'admin', 'admin@example.test'),
    member: await addMember(org.id, 'member', 'member@example.test'),
  };
}
const rows = async () => JSON.stringify([await db.membership.findMany({ orderBy: { userId: 'asc' } }), await db.invite.findMany()]);

describe('INV-28 only an owner grants, changes or removes the owner role (D-11)', () => {
  it('an admin is refused every owner-role change, and no row changes', async () => {
    const { org, owner, admin, member } = await fixture();
    const ctx = await actAs(admin.id, org.slug);
    const before = await rows();
    for (const attempt of [
      () => changeRole(ctx, admin.id, 'owner'), // promote self
      () => changeRole(ctx, member.id, 'owner'), // promote another
      () => createInvite(ctx, 'new@example.test', 'owner'), // invite an owner
      () => changeRole(ctx, owner.id, 'member'), // demote an owner
      () => removeMember(ctx, owner.id, onMembershipEnded), // remove an owner
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(AuthzError);
    }
    expect(await rows()).toBe(before);
  });

  it('an admin still manages admins and members', async () => {
    const { org, admin, member } = await fixture();
    const ctx = await actAs(admin.id, org.slug);
    await changeRole(ctx, member.id, 'admin');
    expect(await roleOf(org.id, member.id)).toBe('admin');
    await removeMember(ctx, member.id, onMembershipEnded);
    expect(await roleOf(org.id, member.id)).toBeNull();
  });

  it('an owner can do each of them', async () => {
    const { org, owner, admin, member } = await fixture();
    const ctx = await actAs(owner.id, org.slug);
    await changeRole(ctx, member.id, 'owner');
    await createInvite(ctx, 'new@example.test', 'owner');
    await changeRole(ctx, member.id, 'admin');
    await changeRole(ctx, admin.id, 'owner');
    await removeMember(ctx, admin.id, onMembershipEnded);
    expect(await db.invite.count({ where: { role: 'owner' } })).toBe(1);
    expect(await roleOf(org.id, admin.id)).toBeNull();
  });
});
