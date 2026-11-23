import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { can } from '@/core/authz/permissions';
import { guardMetadata } from '@/earmark/ui/titles';

// Earmark D-57: a role without `audit.read` gets the 404, the app's answer to "not yours", instead of the error page.
// The page below calls requireOrg(org, 'audit.read'), which throws on a missing permission, and a throw in a page
// renders as a 500. The 404 wins, but layouts and pages render in parallel (D-57 as corrected, D-80), so the page still runs and logs its AuthzError. It refuses only someone the
// page would refuse; whoever holds the permission reaches the page unchanged, and the page still checks for itself.
// D-79: the same check in the metadata, so the tab reads "Page not found" rather than the page's own title.
export const generateMetadata = guardMetadata((r) => can(r, 'audit.read'));

export default async function SecurityGuard({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!can(ctx.role, 'audit.read')) notFound();
  return children;
}
