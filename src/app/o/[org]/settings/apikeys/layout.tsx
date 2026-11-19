import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';

// Earmark D-57: a role without `apikeys.manage` gets the 404, the app's answer to "not yours", instead of the error page.
// The page below calls requireOrg(org, 'apikeys.manage'), which throws on a missing permission, and a throw in a page
// renders as a 500. A layout renders before the page under it, so this answers first. It refuses only someone the
// page would refuse; whoever holds the permission reaches the page unchanged, and the page still checks for itself.
export default async function ApiKeysGuard({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!can(ctx.role, 'apikeys.manage')) notFound();
  return children;
}
