import { inOrg, requireOrg } from '@/core/authz/guards';
import { can, mayAssign } from '@/core/authz/permissions';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { Role } from '@/generated/prisma/enums';
import { cancelInvite, inviteMember, leaveOrg, removeFromOrg, setRole } from './actions';

export const metadata = { title: 'Members' };

// Controls are hidden when the rules would refuse them; core/tenancy enforces the rules either way.
export default async function Members({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const manage = can(ctx.role, 'members.manage');
  const [members, invites] = await withOrg(ctx, (tx) => Promise.all([
    tx.membership.findMany({ where: inOrg(ctx), select: { userId: true, role: true, user: { select: { email: true } } }, orderBy: { createdAt: 'asc' } }),
    manage ? tx.invite.findMany({ where: { ...inOrg(ctx), acceptedAt: null, revokedAt: null, expiresAt: { gt: now() } }, orderBy: { createdAt: 'asc' } }) : [],
  ]), { atomic: false });
  const roles = Object.values(Role);
  const bind = <A extends unknown[], R>(fn: (slug: string, ...a: A) => R) => fn.bind(null, ctx.slug);

  return (
    <main>
      <h1>Members</h1>
      <table>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.user.email}</td>
              <td>{m.role}</td>
              <td>
                {m.userId === ctx.userId ? (
                  <ActionForm action={bind(leaveOrg)}><button type="submit">Leave org</button></ActionForm>
                ) : (
                  mayAssign(ctx.role, m.role, null) && (
                    <>
                      <ActionForm action={bind(setRole)}>
                        <input type="hidden" name="userId" value={m.userId} />
                        <select name="role" defaultValue={m.role} aria-label={`Role for ${m.user.email}`}>
                          {roles.filter((r) => mayAssign(ctx.role, m.role, r)).map((r) => <option key={r}>{r}</option>)}
                        </select>
                        <button type="submit">Change role</button>
                      </ActionForm>
                      <ActionForm action={bind(removeFromOrg)}>
                        <input type="hidden" name="userId" value={m.userId} />
                        <button type="submit">Remove</button>
                      </ActionForm>
                    </>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {manage && (
        <>
          <h2>Invite someone</h2>
          <ActionForm action={bind(inviteMember)}>
            <label>Email <input name="email" type="email" required /></label>
            <select name="role" defaultValue="member" aria-label="Role">
              {roles.filter((r) => mayAssign(ctx.role, null, r)).map((r) => <option key={r}>{r}</option>)}
            </select>
            <button type="submit">Send invite</button>
          </ActionForm>
          {invites.length > 0 && (
            <>
              <h2>Pending invites</h2>
              <ul>
                {invites.map((i) => (
                  <li key={i.id}>
                    {i.email} ({i.role})
                    <ActionForm action={bind(cancelInvite)}>
                      <input type="hidden" name="id" value={i.id} />
                      <button type="submit">Revoke</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </main>
  );
}
