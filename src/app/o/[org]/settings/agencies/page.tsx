import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { assignGuestAgency, createAgency, offboardAgency } from '@/earmark/actions';
import { earmarkCan } from '@/earmark/core';

export const metadata = { title: 'Agencies' };

// PRD §5, D-29: the agencies, and every guest with the agency they are tied to. Core's invite accept is
// template-owned, so a new guest arrives here untied and sees nothing (scopeOf fails closed) until an admin ties them;
// the form preselects the agency whose email domain matches theirs.
export default async function AgenciesPage({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!earmarkCan(ctx.role, 'agency.manage')) notFound();

  const { agencies, members, ties } = await withOrg(ctx, async (tx) => ({
    agencies: await tx.agency.findMany({
      where: inOrg(ctx),
      orderBy: { name: 'asc' },
      include: { _count: { select: { guests: true, commitments: { where: { closedAt: null } } } } },
    }),
    members: await tx.membership.findMany({ where: { ...inOrg(ctx), role: 'guest' }, select: { userId: true, user: { select: { email: true, name: true } } }, orderBy: { user: { email: 'asc' } } }),
    ties: await tx.guestMembership.findMany({ where: inOrg(ctx), select: { userId: true, agencyId: true } }), // no relation from Membership
  }), { atomic: false });
  const tie = new Map(ties.map((t) => [t.userId, t.agencyId]));
  const guests = members.map((g) => ({ ...g, agencyId: tie.get(g.userId) ?? null }));

  const active = agencies.filter((a) => !a.offboardedAt);
  const byDomain = (email: string) => active.filter((a) => a.domains.includes(email.split('@')[1] ?? '')).map((a) => a.id);

  return (
    <main>
      <h1>Agencies</h1>

      <h2>Guests</h2>
      {guests.length === 0 ? <p>No guests. Invite one from Members with the guest role, then tie them to an agency here.</p> : (
        <table aria-label="Guests">
          <thead><tr><th>Guest</th><th>Agency</th></tr></thead>
          <tbody>
            {guests.map((g) => {
              const suggested = byDomain(g.user.email);
              return (
                <tr key={g.userId}>
                  <td>{g.user.name ?? g.user.email}{!g.agencyId && <> <mark>Not tied: sees nothing</mark></>}</td>
                  <td>
                    <ActionForm action={assignGuestAgency.bind(null, ctx.slug)}>
                      <input type="hidden" name="userId" value={g.userId} />
                      <select name="agencyId" required aria-label={`Agency for ${g.user.email}`} defaultValue={g.agencyId ?? (suggested.length === 1 ? suggested[0] : '')}>
                        <option value="" disabled>Pick an agency</option>
                        {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>{' '}
                      <button type="submit">{g.agencyId ? 'Change agency' : 'Tie to agency'}</button>
                    </ActionForm>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>New agency</h2>
      <ActionForm action={createAgency.bind(null, ctx.slug)}>
        <label>Name <input name="name" required maxLength={120} /></label>{' '}
        <label>Email domains <input name="domains" maxLength={500} placeholder="meridian.com, meridiancreative.com" /></label>{' '}
        <button type="submit">Add agency</button>
      </ActionForm>

      <h2>All agencies</h2>
      <table aria-label="Agencies">
        <thead><tr><th>Agency</th><th>Domains</th><th>Guests</th><th>Open POs</th><th>Status</th></tr></thead>
        <tbody>
          {agencies.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{a.domains.join(', ') || '—'}</td>
              <td>{a._count.guests}</td>
              <td>{a._count.commitments}</td>
              <td>
                {a.offboardedAt ? `offboarded ${a.offboardedAt.toISOString().slice(0, 10)}` : (
                  <ActionForm action={offboardAgency.bind(null, ctx.slug)}>
                    <input type="hidden" name="agencyId" value={a.id} />
                    <button type="submit">Offboard</button> <small>Closes its open POs and removes its guests from this org.</small>
                  </ActionForm>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
