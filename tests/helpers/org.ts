import { requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import type { Role } from '@/generated/prisma/enums';
import { signInAs } from './auth';

export const makeOrg = (slug = 'acme') => db.org.create({ data: { slug, name: slug } });

/** A user holding `role` in `orgId`, TOTP-enrolled so the guard admits owners and admins. */
export async function addMember(orgId: string, role: Role, email: string) {
  const user = await db.user.create({ data: { email, totpEnrolledAt: now() } });
  await db.membership.create({ data: { orgId, userId: user.id, role } });
  return user;
}

/** Signs in as `userId` (MFA passed) and returns their guard context in `slug`. */
export async function actAs(userId: string, slug: string) {
  await signInAs(userId, { mfa: true });
  return requireOrg(slug);
}

export const roleOf = async (orgId: string, userId: string) =>
  (await db.membership.findUnique({ where: { orgId_userId: { orgId, userId } } }))?.role ?? null;
