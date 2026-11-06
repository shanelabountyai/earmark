import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { AuthzError, inOrg, type OrgCtx } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { now } from '@/core/clock';
import { asSystem, withOrg } from '@/core/db/rls';
import { env } from '@/core/env';
import { hit, LIMITS } from '@/core/rate-limit';
import { hashToken, newToken } from '@/core/tokens';
import { loadPublicProject } from './project';

// Spec §7c. Each shareable resource type registers its loader here: it takes the link's own
// orgId and returns the allowlisted projection, or null. A clone adds one line per type.
export const shareable = {
  project: loadPublicProject,
} as const;
export type ShareType = keyof typeof shareable;

/** Expiry is required (INV-08): there are no immortal links. Returns the URL, shown once. */
export async function createShareLink(ctx: OrgCtx, resourceType: ShareType, resourceId: string, days: number) {
  if (!can(ctx.role, 'share.create')) throw new AuthzError('share.create');
  if (!(await shareable[resourceType](ctx.orgId, resourceId))) notFound();
  const token = newToken();
  const url = await withOrg(ctx, async (tx) => {
    const link = await tx.shareLink.create({
      data: { ...inOrg(ctx), resourceType, resourceId, tokenHash: hashToken(token), createdById: ctx.userId, expiresAt: new Date(now().getTime() + days * 86_400_000) },
    });
    await audit(ctx, 'share.created', { targetType: 'shareLink', targetId: link.id, data: { resourceType, resourceId, days } }, tx);
    return `${env.APP_URL}/s/${token}`;
  });
  return url; // the raw token exists only in this response
}

/** Takes effect on the next read (INV-08): the lookup filters on revokedAt. */
export async function revokeShareLink(ctx: OrgCtx, id: string) {
  if (!can(ctx.role, 'share.revoke')) throw new AuthzError('share.revoke');
  await withOrg(ctx, async (tx) => {
    const { count } = await tx.shareLink.updateMany({ where: { id, ...inOrg(ctx), revokedAt: null }, data: { revokedAt: now() } });
    if (count !== 1) notFound();
    await audit(ctx, 'share.revoked', { targetType: 'shareLink', targetId: id }, tx);
  });
}

/**
 * The anonymous read behind /s/[token]. Rate-limited per IP (INV-09). Unknown, expired, revoked
 * and orphaned links all return null, so the page shows one 404 for every one of them.
 */
export async function readShare(token: string, ip: string) {
  if (!(await hit(`share:ip:${ip}`, LIMITS.shareReadPerIp))) return 'limited' as const;
  // Cross-org (cross-org.ts): the token names the org. The loader then reads inside that org's scope.
  const link = await asSystem((sys) => sys.shareLink.findFirst({ where: { tokenHash: hashToken(token), revokedAt: null, expiresAt: { gt: now() } } }));
  const load = link && Object.hasOwn(shareable, link.resourceType) && shareable[link.resourceType as ShareType];
  return (load && (await load(link.orgId, link.resourceId))) || null;
}
