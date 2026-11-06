import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { AiSpendCard } from './ai-spend';
import { SsoSecurityPanel } from '../sso/security-panel'; // sso

export const metadata = { title: 'Org security' };

const METHOD: Record<string, string> = { link: 'email link', sso: 'SSO', demo: 'demo' };
const when = (d: Date | null) => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'never');

// F-02 (addendum §4), owners and admins. Shows and links only: nothing here changes another member's credentials.
export default async function OrgSecurity({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'audit.read');
  const members = await withOrg(
    ctx,
    (tx) =>
      tx.membership.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: 'asc' },
        select: { role: true, user: { select: { id: true, email: true, totpEnrolledAt: true, lastSignInAt: true, lastSignInMethod: true } } },
      }),
    { atomic: false },
  );
  const off = members.filter((m) => !m.user.totpEnrolledAt).length;
  return (
    <main>
      <h1>Org security</h1>
      <p>{off === 0 ? 'Every member has two-factor sign-in on.' : `${off} of ${members.length} members have two-factor sign-in off.`}</p>
      <table>
        <thead>
          <tr><th>Member</th><th>Role</th><th>Two-factor</th><th>Last sign-in</th><th>Method</th></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user.id}>
              <td>{m.user.email}</td>
              <td>{m.role}</td>
              <td>{m.user.totpEnrolledAt ? 'on' : 'off'}</td>
              <td>{when(m.user.lastSignInAt)}</td>
              <td>{m.user.lastSignInMethod ? (METHOD[m.user.lastSignInMethod] ?? m.user.lastSignInMethod) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <AiSpendCard ctx={ctx} />
      <SsoSecurityPanel ctx={ctx} /> {/* sso */}
    </main>
  );
}
