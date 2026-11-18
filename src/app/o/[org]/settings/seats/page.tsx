import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { Form as ActionForm } from '@/earmark/ui/form';
import { assignSeat, clearDelegation, createSeat, delegateSeat, endSeat } from '@/earmark/actions';
import { earmarkCan } from '@/earmark/core';
import { orgName } from '@/earmark/ui/org-name';
import { Card, day, PageHead, Pill, TableWrap } from '@/earmark/ui/kit';

export const metadata = { title: 'Seats' };

// Approver seats (PRD §1–2, D-27; design: docs/design/Seats.dc.html): who holds each seat, from when to when, and who
// it is delegated to. Owner only: a seat is approval authority, so an admin must not be able to hand one to themselves.
export default async function SeatsPage({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!earmarkCan(ctx.role, 'seats.manage')) notFound();

  const { seats, staff } = await withOrg(ctx, async (tx) => ({
    seats: await tx.seat.findMany({ where: inOrg(ctx), orderBy: { name: 'asc' }, include: { holders: { where: inOrg(ctx), orderBy: { activeFrom: 'asc' } } } }),
    staff: await tx.membership.findMany({ where: { ...inOrg(ctx), role: { not: 'guest' } }, select: { userId: true, user: { select: { email: true, name: true } } }, orderBy: { user: { email: 'asc' } } }),
  }), { atomic: false });
  const who = new Map(staff.map((m) => [m.userId, m.user.name ?? m.user.email]));
  const t = now();
  const active = (h: { activeFrom: Date; activeTo: Date | null }) => h.activeFrom <= t && (!h.activeTo || h.activeTo > t);
  const people = staff.map((m) => <option key={m.userId} value={m.userId}>{m.user.name ?? m.user.email}</option>);

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${await orgName(ctx.orgId)} · Settings · Seats`}
        title="Seats"
        lede="A seat is a named approver position. Chain steps name seats; whoever holds the seat when a request is submitted is frozen into its chain. Only the owner hands seats out."
      />
      <div className="row">
          {seats.length > 0 && (
            <Card id="assign-h" title="Seat a member" className="form-stack">
              <ActionForm action={assignSeat.bind(null, ctx.slug)}>
                <label>Seat <select name="seatId" required>{seats.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label>Member <select name="userId" required>{people}</select></label>
                <label>Until (optional) <input name="activeTo" type="date" aria-describedby="until-hint" /></label>
                <span className="note" id="until-hint">Leave empty to hold it until ended. Starts now.</span>
                <button type="submit">Assign seat</button>
              </ActionForm>
            </Card>
          )}
          <Card id="new-seat-h" title="New seat" className="form-stack">
            <ActionForm action={createSeat.bind(null, ctx.slug)}>
              <label>Seat name <input name="name" required maxLength={120} placeholder="CFO" /></label>
              <button type="submit" className={seats.length ? 'btn-secondary' : undefined}>Create seat</button>
            </ActionForm>
          </Card>
        </div>
        <div className="stack">
          {seats.length === 0 && <Card id="none-h" title="No seats yet"><p className="note">Create the seats your approval rules name.</p></Card>}
          {seats.map((s) => {
            const live = s.holders.filter(active);
            return (
              <Card key={s.id} id={`seat-${s.id}`} title={<>{s.name} <span className="note" style={{ fontWeight: 500 }}>{live.length} active holder{live.length === 1 ? '' : 's'}</span></>}>
                {live.length === 0 && <p style={{ margin: 0 }}><Pill tone="hold">No active holder</Pill> A chain step at this seat is blocked until someone holds it, and the org’s owners are alerted.</p>}
                {s.holders.length > 0 && (
                  <TableWrap label={`${s.name} holders`}>
                    <table aria-label={`${s.name} holders`}>
                      <thead><tr><th scope="col">Holder</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Delegated to</th><th scope="col">Change</th></tr></thead>
                      <tbody>
                        {s.holders.map((h) => {
                          const name = who.get(h.userId) ?? 'former member';
                          return (
                            <tr key={h.id}>
                              <td>{name}{!active(h) && <> <Pill tone="done">Inactive</Pill></>}</td>
                              <td className="nowrap">{day(h.activeFrom)}</td>
                              <td className="nowrap">{h.activeTo ? day(h.activeTo) : '—'}</td>
                              <td>{h.delegateToId ? who.get(h.delegateToId) ?? 'former member' : '—'}</td>
                              <td>
                                {active(h) ? (
                                  <div className="actions">
                                    <div className="inline-form">
                                      <ActionForm action={delegateSeat.bind(null, ctx.slug)}>
                                        <input type="hidden" name="seatId" value={s.id} />
                                        <input type="hidden" name="userId" value={h.userId} />
                                        <label>Delegate to<span className="sr-only"> (for {name}’s {s.name} seat)</span> <select name="delegateToId" required>{people}</select></label>
                                        <button type="submit" className="btn-secondary" aria-label={`Delegate ${name}’s ${s.name} seat`}>Delegate</button>
                                      </ActionForm>
                                    </div>
                                    {h.delegateToId && (
                                      <div className="inline-form">
                                        <ActionForm action={clearDelegation.bind(null, ctx.slug)}>
                                          <input type="hidden" name="seatId" value={s.id} />
                                          <input type="hidden" name="userId" value={h.userId} />
                                          <button type="submit" className="btn-secondary" aria-label={`Clear delegation of ${name}’s ${s.name} seat`}>Clear delegation</button>
                                        </ActionForm>
                                      </div>
                                    )}
                                    <div className="inline-form">
                                      <ActionForm action={endSeat.bind(null, ctx.slug)}>
                                        <input type="hidden" name="seatId" value={s.id} />
                                        <input type="hidden" name="userId" value={h.userId} />
                                        <button type="submit" className="btn-danger" aria-label={`End ${name}’s ${s.name} seat`}>End seat</button>
                                      </ActionForm>
                                    </div>
                                  </div>
                                ) : <span className="muted">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>
            );
          })}
          <p className="note">A delegation runs until it’s cleared or the holding ends. Agency guests never hold a seat. Seats aren’t deleted: frozen chains name them.</p>
        </div>
    </main>
  );
}
