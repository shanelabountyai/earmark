import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { normalizeEmail } from '@/core/auth/link';
import { assertNotDemo, type SessionCtx } from '@/core/auth/session';
import { AuthzError, inOrg, type OrgCtx } from '@/core/authz/guards';
import { can, mayAssign } from '@/core/authz/permissions';
import { now } from '@/core/clock';
import { asSystem, withOrg } from '@/core/db/rls';
import { sendEmail } from '@/core/email/transport';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { hit, LIMITS } from '@/core/rate-limit';
import { hashToken, newToken } from '@/core/tokens';
import type { Role } from '@/generated/prisma/enums';
import { lockOrg } from './orgs';

const TTL_MS = 7 * 24 * 3600_000;
const INVALID = 'This invite is not valid for your account. It may have expired or been used.';

/** Hashed, 7-day, single-use (spec §7b). Replaces any pending invite to the same address. */
export async function createInvite(ctx: OrgCtx, emailInput: string, role: Role) {
  assertNotDemo(ctx.session);
  const email = normalizeEmail(emailInput);
  if (!email) throw new Refused('Enter a valid email address.');
  const token = newToken();
  const t = now();
  const orgName = await withOrg(ctx, async (tx) => {
    await lockOrg(tx, ctx.orgId);
    const actor = await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } }, include: { org: true } });
    if (!actor) notFound();
    if (!mayAssign(actor.role, null, role)) throw new AuthzError('members.manage'); // INV-28: owner invites need an owner
    // Counted on `db`, not `tx`, so a refused invite still counts (FR-03).
    for (const [key, limit] of [
      [`invite-send:user:${ctx.userId}`, LIMITS.invitePerUserDay],
      [`invite-send:org:${ctx.orgId}`, LIMITS.invitePerOrgDay],
      [`invite-send:email:${email}`, LIMITS.invitePerEmailDay],
    ] as const) {
      if (!(await hit(key, limit))) throw new Refused('Too many invites today. Try again tomorrow.');
    }
    if (await tx.membership.count({ where: { orgId: ctx.orgId, user: { email } } })) throw new Refused('That person is already a member.');
    await tx.invite.updateMany({ where: { ...inOrg(ctx), email, acceptedAt: null, revokedAt: null }, data: { revokedAt: t } });
    const invite = await tx.invite.create({
      data: { ...inOrg(ctx), email, role, tokenHash: hashToken(token), invitedById: ctx.userId, expiresAt: new Date(t.getTime() + TTL_MS) },
    });
    await audit(ctx, 'member.invited', { targetType: 'invite', targetId: invite.id, data: { role } }, tx);
    return actor.org.name;
  });
  await sendEmail({
    to: email,
    subject: `You are invited to ${orgName}`,
    body: `Join ${orgName}: ${env.APP_URL}/onboarding/invite/${token}\n\nSign in with this address (${email}) to accept. The invite expires in 7 days.`,
  });
}

export async function revokeInvite(ctx: OrgCtx, id: string) {
  if (!can(ctx.role, 'members.manage')) throw new AuthzError('members.manage');
  await withOrg(ctx, async (tx) => {
    const { count } = await tx.invite.updateMany({ where: { id, ...inOrg(ctx), acceptedAt: null, revokedAt: null }, data: { revokedAt: now() } });
    if (count !== 1) notFound();
    await audit(ctx, 'invite.revoked', { targetType: 'invite', targetId: id }, tx);
  });
}

/**
 * Accepts an invite for the signed-in user; returns the org slug. Rate-limited per user (INV-09).
 * Unknown, expired, revoked, used and someone else's invites all get the same answer.
 */
export async function acceptInvite(s: SessionCtx, token: string): Promise<string> {
  if (!(await hit(`invite:user:${s.userId}`, LIMITS.inviteAcceptPerUser))) throw new Refused('Too many attempts. Wait a few minutes and try again.');
  const t = now();
  // Cross-org (cross-org.ts): the token names the org, so it cannot be scoped before it is read.
  return asSystem((sys) => sys.$transaction(async (tx) => {
    const spent = await tx.invite.updateMany({
      where: { tokenHash: hashToken(token), email: s.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: t } },
      data: { acceptedAt: t },
    });
    if (spent.count !== 1) throw new Refused(INVALID);
    const invite = await tx.invite.findUniqueOrThrow({ where: { tokenHash: hashToken(token) }, include: { org: { select: { slug: true } } } });
    // An invite carries its issuer's authority as it is now, not as it was when sent: once the issuer is
    // removed, demoted or deleted, the invite must not grant a role they could no longer grant themselves.
    const issuer = invite.invitedById
      ? await tx.membership.findUnique({ where: { orgId_userId: { orgId: invite.orgId, userId: invite.invitedById } }, select: { role: true } })
      : null;
    if (!issuer || !mayAssign(issuer.role, null, invite.role)) throw new Refused(INVALID);
    const key = { orgId_userId: { orgId: invite.orgId, userId: s.userId } };
    // Already a member: keep the role they have. An invite never silently changes one.
    if (!(await tx.membership.findUnique({ where: key }))) {
      await tx.membership.create({ data: { orgId: invite.orgId, userId: s.userId, role: invite.role } });
    }
    await audit({ orgId: invite.orgId, userId: s.userId }, 'invite.accepted', { targetType: 'invite', targetId: invite.id, data: { role: invite.role } }, tx);
    return invite.org.slug;
  }));
}

/** Pending invites to the signed-in user's address, for /onboarding. */
export const pendingInvitesFor = (s: SessionCtx) =>
  asSystem((sys) => sys.invite.findMany({
    where: { email: s.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now() } },
    select: { id: true, role: true, org: { select: { name: true } } },
  }));
