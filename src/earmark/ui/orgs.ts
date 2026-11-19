import { asSystem } from '@/core/db/rls';
import { keepListedOrgs } from '@/core/tenancy/listed';
import { filterListedOrgs } from '@/app/org-hooks';

/**
 * The signed-in user's own orgs, for the sidebar's client switcher (HANDOFF.md owner call, D-45). The same read
 * /onboarding makes: the user's memberships by their own user id, names and slugs only, filtered like every org
 * list. It says nothing about any org the user is not a member of, and nothing inside one.
 */
export async function myOrgs(userId: string): Promise<{ slug: string; name: string }[]> {
  // Cross-org (cross-org.ts): the user's memberships in every org.
  const all = await asSystem((sys) => sys.membership.findMany({ where: { userId }, select: { org: { select: { id: true, slug: true, name: true } } }, orderBy: { createdAt: 'asc' } }));
  return (await keepListedOrgs(userId, all, filterListedOrgs)).map((m) => ({ slug: m.org.slug, name: m.org.name }));
}
