import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { withOrg } from '@/core/db/rls';
import { Form as ActionForm } from '@/earmark/ui/form';
import { assignGuestAgency, createAgency, offboardAgency } from '@/earmark/actions';
import { earmarkCan } from '@/earmark/core';
import { Card, day, PageHead, Pill, TableWrap } from '@/earmark/ui/kit';
import { titleFor } from '@/earmark/ui/titles';

export const generateMetadata = titleFor('Agencies', (r) => earmarkCan(r, 'agency.manage')); // D-79

// PRD §5, D-29 (design: docs/design/Agencies.dc.html): the agencies, and every guest with the agency they are tied to.
// Core's invite accept is template-owned, so a new guest arrives here untied and sees nothing (scopeOf fails closed)
// until an admin ties them; the form preselects the agency whose email domain matches theirs.
export default async function AgenciesPage({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!earmarkCan(ctx.role, 'agency.manage')) notFound();
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });

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
    <main className="stack">
      <PageHead
        eyebrow={`${org.name} · Settings · Agencies`}
        title="Agencies"
        lede={`Vendors ${org.name} works with, and the agency guests tied to each. A guest sees only their own agency’s POs, and nothing until they are tied.`}
      />

      <Card id="g-h" title={`Guests (${guests.length})`}>
        {guests.length === 0 ? <p className="note">No guests. Invite one from Members with the guest role, then tie them to an agency here.</p> : (
          <TableWrap label="Guests">
            <table aria-label="Guests">
              <thead><tr><th scope="col">Guest</th><th scope="col">Agency</th></tr></thead>
              <tbody>
                {guests.map((g) => {
                  const suggested = byDomain(g.user.email);
                  return (
                    <tr key={g.userId}>
                      <td>{g.user.name ?? g.user.email}{!g.agencyId && <> <Pill tone="hold">Not tied: sees nothing</Pill></>}</td>
                      <td className="inline-form">
                        <ActionForm action={assignGuestAgency.bind(null, ctx.slug)}>
                          <input type="hidden" name="userId" value={g.userId} />
                          <select name="agencyId" required aria-label={`Agency for ${g.user.email}`} defaultValue={g.agencyId ?? (suggested.length === 1 ? suggested[0] : '')}>
                            <option value="" disabled>Pick an agency</option>
                            {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                          <button type="submit" className={g.agencyId ? 'btn-secondary' : undefined}>{g.agencyId ? 'Change agency' : 'Tie to agency'}</button>
                        </ActionForm>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="note">The agency whose domain matches a guest’s email is picked for you; nothing is tied automatically.</p>
      </Card>

      <div className="stack">
        <Card id="all-h" title="All agencies">
          {agencies.length === 0 ? <p className="note">No agencies yet.</p> : (
            <TableWrap label="Agencies">
              <table aria-label="Agencies">
                <thead><tr><th scope="col">Agency</th><th scope="col">Domains</th><th scope="col" className="num">Guests</th><th scope="col" className="num">Open POs</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {agencies.map((a) => (
                    <tr key={a.id}>
                      <td><strong>{a.name}</strong></td>
                      <td>{a.domains.join(', ') || <span className="muted">—</span>}</td>
                      <td className="num">{a._count.guests}</td>
                      <td className="num">{a._count.commitments}</td>
                      <td>
                        {a.offboardedAt ? <Pill tone="done">Offboarded {day(a.offboardedAt)}</Pill> : (
                          <div className="stack" style={{ gap: 6, alignItems: 'flex-start' }}>
                            <Pill tone="good">Active</Pill>
                            <div className="inline-form">
                              <ActionForm action={offboardAgency.bind(null, ctx.slug)}>
                                <input type="hidden" name="agencyId" value={a.id} />
                                <button type="submit" className="btn-danger" aria-label={`Offboard ${a.name}`} aria-describedby={`off-${a.id}`}>Offboard</button>
                              </ActionForm>
                            </div>
                            <small id={`off-${a.id}`}>Closes its open POs and removes its guests from {org.name} only. Can’t be undone here.</small>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card id="new-ag-h" title="New agency" className="form-stack" >
          <ActionForm action={createAgency.bind(null, ctx.slug)}>
            <label>Name <input name="name" required maxLength={120} /></label>
            <label>Email domains <input name="domains" maxLength={500} placeholder="meridian.example" aria-describedby="dom-hint" /></label>
            <span className="note" id="dom-hint">Comma-separated. Used to suggest the agency for a new guest.</span>
            <button type="submit">Add agency</button>
          </ActionForm>
        </Card>
      </div>
    </main>
  );
}
