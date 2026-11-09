import { randomBytes, randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { assertNotDemo, type SessionCtx } from '@/core/auth/session';
import { AuthzError, type OrgCtx } from '@/core/authz/guards';
import { mayAssign } from '@/core/authz/permissions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { Role } from '@/generated/prisma/enums';

type Tx = Prisma.TransactionClient;

const slugify = (name: string) =>
  name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

/** Creates an org with the caller as its owner; returns the slug. A taken slug gets a random suffix. */
export async function createOrg(s: SessionCtx, name: string): Promise<string> {
  assertNotDemo(s); // an org made by the shared account belongs to every /demo visitor and is never cleaned up
  const base = slugify(name);
  for (let i = 0; i < 5; i++) {
    const slug = i === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    try {
      // The id is chosen here so the owner membership can be written inside the new org's own scope (RLS).
      const id = randomUUID();
      await withOrg({ orgId: id }, async (tx) => {
        const org = await tx.org.create({ data: { id, slug, name, memberships: { create: { userId: s.userId, role: 'owner' } } } });
        await audit({ orgId: org.id, userId: s.userId }, 'org.created', { targetType: 'org', targetId: org.id }, tx);
      });
      return slug;
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }
  throw new Refused('Could not find a free address for that name. Try another.');
}

/**
 * Takes the org row lock, so membership changes in one org run one at a time: two owners demoting
 * each other at once cannot both pass the "another owner remains" check (INV-21).
 */
export async function lockOrg(tx: Tx, orgId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Org" WHERE "id" = ${orgId}::uuid FOR UPDATE`;
}

export async function assertOwnerRemains(tx: Tx, orgId: string, losingUserId: string) {
  if (!(await tx.membership.count({ where: { orgId, role: 'owner', userId: { not: losingUserId } } }))) {
    throw new Refused('An org needs at least one owner. Make someone else an owner first.');
  }
}

/**
 * Runs `fn` under the org lock with the actor's and the target's roles as they are now, not as
 * the guard read them. A target outside this org is notFound, like any other id (INV-02/04).
 */
async function withMembers(ctx: OrgCtx, userId: string, fn: (tx: Tx, actor: Role, target: Role) => Promise<void>) {
  assertNotDemo(ctx.session);
  await withOrg(ctx, async (tx) => {
    await lockOrg(tx, ctx.orgId);
    const [actor, target] = await Promise.all(
      [ctx.userId, userId].map((id) => tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: id } }, select: { role: true } })),
    );
    if (!actor || !target) notFound();
    await fn(tx, actor.role, target.role);
  });
}

/**
 * Revokes the pending invites `userId` sent that their new `role` (null: no longer a member) could not
 * send. `acceptInvite` refuses these anyway; this keeps them out of the pending lists.
 */
const revokeInvitesBeyond = (tx: Tx, orgId: string, userId: string, role: Role | null) =>
  tx.invite.updateMany({
    where: { orgId, invitedById: userId, acceptedAt: null, revokedAt: null, ...(role && { role: { in: Object.values(Role).filter((r) => !mayAssign(role, null, r)) } }) },
    data: { revokedAt: now() },
  });

/** D-11 in core, not the UI: only an owner grants, changes or removes `owner` (INV-28). */
export async function changeRole(ctx: OrgCtx, userId: string, role: Role) {
  await withMembers(ctx, userId, async (tx, actor, from) => {
    if (!mayAssign(actor, from, role)) throw new AuthzError('members.manage');
    if (from === role) return;
    if (from === 'owner') await assertOwnerRemains(tx, ctx.orgId, userId);
    await tx.membership.update({ where: { orgId_userId: { orgId: ctx.orgId, userId } }, data: { role } });
    await revokeInvitesBeyond(tx, ctx.orgId, userId, role);
    await audit(ctx, 'member.role_changed', { targetType: 'user', targetId: userId, data: { from, to: role } }, tx);
  });
}

/** Removes a member, or the caller themself (leaving needs no permission). Never the last owner. */
/**
 * What else ends with a membership, run in its transaction (the app passes `onMembershipEnded` from org-hooks.ts).
 * Required, so no caller can forget it: a credential the person made must not outlive their access (K6, owner 2026-11-05).
 */
export type MembershipEnded = (tx: Prisma.TransactionClient, orgId: string, userId: string) => Promise<void>;

export async function removeMember(ctx: OrgCtx, userId: string, ended: MembershipEnded) {
  const self = userId === ctx.userId;
  await withMembers(ctx, userId, async (tx, actor, from) => {
    if (!self && !mayAssign(actor, from, null)) throw new AuthzError('members.manage');
    if (from === 'owner') await assertOwnerRemains(tx, ctx.orgId, userId);
    await tx.membership.delete({ where: { orgId_userId: { orgId: ctx.orgId, userId } } });
    // K6: a share link outlives its creator's membership otherwise — anyone still holding the
    // URL keeps read access to the org's resource after the person who shared it is gone.
    await tx.shareLink.updateMany({ where: { orgId: ctx.orgId, createdById: userId, revokedAt: null }, data: { revokedAt: now() } });
    await revokeInvitesBeyond(tx, ctx.orgId, userId, null);
    await ended(tx, ctx.orgId, userId);
    await audit(ctx, self ? 'member.left' : 'member.removed', { targetType: 'user', targetId: userId, data: { role: from } }, tx);
  });
}
