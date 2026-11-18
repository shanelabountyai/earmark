import { can } from '@/core/authz/permissions';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { withOrg } from '@/core/db/rls';
import { earmarkCan } from '@/earmark/core';
import { myOrgs } from '@/earmark/ui/orgs';
import { type NavLink, SideNav } from '@/earmark/ui/side-nav';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest', scorekeeper: 'Scorekeeper' };

// The shell (D-44): the sidebar and the page. Navigation only, so layouts not re-running on navigation is harmless;
// each page calls requireOrg itself. A guest sees one item, her POs (PRD §1), and a client switcher.
export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const guest = ctx.role === 'guest';
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  const { fy, agency } = await withOrg(ctx, async (tx) => ({
    fy: guest ? null : await tx.fiscalYear.findFirst({ where: inOrg(ctx), orderBy: { startsOn: 'desc' }, select: { label: true } }),
    agency: guest ? await tx.guestMembership.findFirst({ where: { ...inOrg(ctx), userId: ctx.userId }, select: { agency: { select: { name: true } } } }) : null,
  }), { atomic: false });
  const base = `/o/${ctx.slug}`;
  const L = (path: string, label: string, exact = false): NavLink => ({ href: `${base}${path}`, label, exact });

  const main: NavLink[] = guest ? [L('/commitments', 'Purchase orders')] : [
    L('', 'Dashboard', true),
    ...(earmarkCan(ctx.role, 'budget.plan') ? [L('/plan', 'Plan')] : []),
    L('/requests', 'Requests'), L('/approvals', 'Approvals'), L('/commitments', 'Purchase orders'), L('/invoices', 'Invoices'), L('/variance', 'Variance'),
  ];
  const settings: NavLink[] = guest ? [] : [
    L('/settings/rules', 'Rules'),
    ...(earmarkCan(ctx.role, 'seats.manage') ? [L('/settings/seats', 'Seats')] : []),
    ...(earmarkCan(ctx.role, 'agency.manage') ? [L('/settings/agencies', 'Agencies')] : []),
    L('/settings/members', 'Members'),
    ...(can(ctx.role, 'audit.read') ? [L('/settings/audit', 'Audit log'), L('/settings/security', 'Security')] : []),
    ...(ctx.role === 'owner' ? [L('/settings/sso', 'SSO')] : []), // sso
    ...(can(ctx.role, 'apikeys.manage') ? [L('/settings/apikeys', 'API keys')] : []), // apikeys
    ...(can(ctx.role, 'org.delete') ? [L('/settings/danger', 'Export or delete')] : []),
    L('/projects', 'Projects'),
  ];
  const who = [ctx.session.email, guest ? `Guest${agency ? ` · ${agency.agency.name}` : ''}` : (ROLE[ctx.role] ?? ctx.role)];

  return (
    <div className="shell">
      <SideNav
        home={base}
        org={fy ? `${org.name} · ${fy.label}` : org.name}
        main={main}
        settings={settings}
        foot={{ who, links: [{ href: '/onboarding', label: 'Your orgs' }, { href: '/account/security', label: 'Account' }] }}
        clients={guest ? await myOrgs(ctx.userId) : undefined}
        current={ctx.slug}
      />
      <div className="content">{children}</div>
    </div>
  );
}
