import { audit } from '@/core/audit';
import { assertFresh, signOut, type SessionCtx } from '@/core/auth/session';
import { AuthzError, type OrgCtx } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { asSystem, withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { assertOwnerRemains, lockOrg, type MembershipEnded } from './orgs';

/**
 * org.delete + the slug typed to confirm + a fresh sign-in (INV-26). Rows cascade; audit events stay.
 * `beforeDelete` runs once those checks pass (the app passes `beforeOrgDelete`); if it throws, the org stays.
 */
export async function deleteOrg(ctx: OrgCtx, confirm: string, beforeDelete: (orgId: string) => Promise<void> = async () => {}) {
  if (!can(ctx.role, 'org.delete')) throw new AuthzError('org.delete');
  assertFresh(ctx.session);
  if (confirm.trim() !== ctx.slug) throw new Refused('Type the org address exactly to confirm.');
  await beforeDelete(ctx.orgId);
  await withOrg(ctx, async (tx) => {
    await tx.org.delete({ where: { id: ctx.orgId } });
    await audit(ctx, 'org.deleted', { targetType: 'org', targetId: ctx.orgId, data: { slug: ctx.slug } }, tx);
  });
}

/** Fresh sign-in + email typed to confirm (INV-26). Refused while the user is any org's only owner (INV-21). */
export async function deleteAccount(s: SessionCtx, confirm: string, ended: MembershipEnded) {
  assertFresh(s);
  if (confirm.trim().toLowerCase() !== s.email) throw new Refused('Type your email address exactly to confirm.');
  // Cross-org (cross-org.ts): the user's memberships in every org they belong to.
  await asSystem((sys) => sys.$transaction(async (tx) => {
    const memberships = await tx.membership.findMany({ where: { userId: s.userId }, select: { orgId: true, role: true }, orderBy: { orgId: 'asc' } });
    for (const m of memberships) {
      if (m.role !== 'owner') continue;
      await lockOrg(tx, m.orgId); // sorted order, so two deletions cannot deadlock
      await assertOwnerRemains(tx, m.orgId, s.userId);
    }
    for (const m of memberships) {
      await ended(tx, m.orgId, s.userId);
      await audit({ orgId: m.orgId, userId: s.userId }, 'member.account_deleted', { targetType: 'user', targetId: s.userId }, tx);
    }
    await tx.user.delete({ where: { id: s.userId } });
    await audit({ userId: s.userId }, 'account.deleted', { targetType: 'user', targetId: s.userId }, tx);
  }));
  await signOut();
}
