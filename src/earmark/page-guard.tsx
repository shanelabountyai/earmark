import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { can, type Permission } from '@/core/authz/permissions';

/**
 * A layout that answers the 404 to a member whose role lacks `perm` (D-57). The template's settings pages call
 * `requireOrg(org, perm)`, which throws on a missing permission; in a page that renders the error page with a 500,
 * and the rest of the app says "not yours" as "not found". A layout renders before the page under it, so the 404
 * wins. It only ever refuses someone the page would have refused; anyone holding `perm` reaches the page unchanged,
 * and the page still makes its own check.
 */
export function pageGuard(perm: Permission) {
  return async function Guarded({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
    const ctx = await requireOrg((await params).org);
    if (!can(ctx.role, perm)) notFound();
    return children;
  };
}
