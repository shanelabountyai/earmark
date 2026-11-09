import { beforeEach, describe, expect, it } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { AuthzError, requireOrg } from '@/core/authz/guards';
import { can, type Permission } from '@/core/authz/permissions';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { createInvite } from '@/core/tenancy/invites';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { Role } from '@/generated/prisma/enums';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { actAs, addMember, makeOrg, roleOf } from '../helpers/org';

beforeEach(resetAuthTables);

// D-21 (v1.3.0): a scorekeeper holds results.write and nothing else, and is not MFA-gated.
const all: Permission[] = ['org.update', 'org.delete', 'members.manage', 'billing.manage', 'share.create', 'share.revoke', 'audit.read', 'results.write'];

describe('scorekeeper role (D-21)', () => {
  it('holds exactly results.write; owner and admin hold it too, member does not', () => {
    const held = (r: Role) => all.filter((p) => can(r, p));
    expect(held('scorekeeper')).toEqual(['results.write']);
    expect(can('owner', 'results.write') && can('admin', 'results.write')).toBe(true);
    expect(held('member')).toEqual(['share.create']);
  });

  it('a scorekeeper with no TOTP passes the guard for results.write, and is refused everything else; a member is refused results.write', async () => {
    const org = await makeOrg();
    const sk = await db.user.create({ data: { email: 'sk@example.test' } }); // never enrolled
    await db.membership.create({ data: { orgId: org.id, userId: sk.id, role: 'scorekeeper' } });
    await signInAs(sk.id);
    await expect(requireOrg(org.slug, 'results.write')).resolves.toMatchObject({ role: 'scorekeeper' });
    for (const p of all.filter((x) => x !== 'results.write')) await expect(requireOrg(org.slug, p)).rejects.toBeInstanceOf(AuthzError);

    const member = await addMember(org.id, 'member', 'member@example.test');
    await signInAs(member.id, { mfa: true });
    await expect(requireOrg(org.slug, 'results.write')).rejects.toBeInstanceOf(AuthzError);
  });

  it('an admin invites, assigns and removes a scorekeeper', async () => {
    const org = await makeOrg();
    const admin = await addMember(org.id, 'admin', 'admin@example.test');
    const member = await addMember(org.id, 'member', 'member@example.test');
    const ctx = await actAs(admin.id, org.slug);
    await createInvite(ctx, 'new@example.test', 'scorekeeper');
    await changeRole(ctx, member.id, 'scorekeeper');
    expect(await roleOf(org.id, member.id)).toBe('scorekeeper');
    await removeMember(ctx, member.id, onMembershipEnded);
    expect(await roleOf(org.id, member.id)).toBeNull();
    expect(await db.invite.count({ where: { role: 'scorekeeper', revokedAt: null } })).toBe(1);
  });

  it('an admin demoted to scorekeeper loses the scorekeeper invite they sent (the role list comes from the enum)', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const admin = await addMember(org.id, 'admin', 'admin@example.test');
    await createInvite(await actAs(admin.id, org.slug), 'new@example.test', 'scorekeeper');
    await changeRole(await actAs(owner.id, org.slug), admin.id, 'scorekeeper');
    expect(await db.invite.count({ where: { role: 'scorekeeper', revokedAt: null } })).toBe(0);
  });
});
