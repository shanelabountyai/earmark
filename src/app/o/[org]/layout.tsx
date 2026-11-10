import Link from 'next/link';
import { can } from '@/core/authz/permissions';
import { earmarkCan } from '@/earmark/core';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';

// Navigation only. Layouts do not re-run on every navigation, so each page calls requireOrg itself.
export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  const base = `/o/${ctx.slug}`;
  return (
    <>
      <nav>
        <strong>{org.name}</strong> · <Link href={base}>Home</Link> · <Link href={`${base}/commitments`}>Purchase orders</Link> · {ctx.role !== 'guest' && <><Link href={`${base}/requests`}>Requests</Link> · <Link href={`${base}/approvals`}>Approvals</Link> · <Link href={`${base}/invoices`}>Invoices</Link> · <Link href={`${base}/variance`}>Variance</Link> · {earmarkCan(ctx.role, 'budget.plan') && <><Link href={`${base}/plan`}>Plan</Link> · </>}{earmarkCan(ctx.role, 'seats.manage') && <><Link href={`${base}/settings/seats`}>Seats</Link> · </>}<Link href={`${base}/settings/rules`}>Rules</Link> · </>}<Link href={`${base}/projects`}>Projects</Link> · <Link href={`${base}/settings/members`}>Members</Link>
        {can(ctx.role, 'audit.read') && <> · <Link href={`${base}/settings/audit`}>Audit log</Link> · <Link href={`${base}/settings/security`}>Security</Link></>}
        {ctx.role === 'owner' && <> · <Link href={`${base}/settings/sso`}>SSO</Link></>} {/* sso */}
        {can(ctx.role, 'apikeys.manage') && <> · <Link href={`${base}/settings/apikeys`}>API keys</Link></>} {/* apikeys */}
        {can(ctx.role, 'org.delete') && <> · <Link href={`${base}/settings/danger`}>Export or delete</Link></>}
        {' · '}<Link href="/onboarding">Your orgs</Link> · <Link href="/account/security">Account</Link>
      </nav>
      {children}
    </>
  );
}
