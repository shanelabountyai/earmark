import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { assignSeat, clearDelegation, createSeat, delegateSeat, endSeat } from '@/earmark/actions';
import { earmarkCan } from '@/earmark/core';

export const metadata = { title: 'Seats' };

const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? '—';

// Approver seats (PRD §1–2, D-27): who holds each seat, from when to when, and who it is delegated to. Owner only:
// a seat is approval authority, so an admin must not be able to hand one to themselves.
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
    <main>
      <h1>Seats</h1>

      <h2>New seat</h2>
      <ActionForm action={createSeat.bind(null, ctx.slug)}>
        <label>Seat name <input name="name" required maxLength={120} placeholder="CFO" /></label>{' '}
        <button type="submit">Create seat</button>
      </ActionForm>

      {seats.length > 0 && <>
        <h2>Seat a member</h2>
        <ActionForm action={assignSeat.bind(null, ctx.slug)}>
          <label>Seat <select name="seatId" required>{seats.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>{' '}
          <label>Member <select name="userId" required>{people}</select></label>{' '}
          <label>Until (optional) <input name="activeTo" type="date" /></label>{' '}
          <button type="submit">Assign seat</button>
        </ActionForm>
      </>}

      {seats.map((s) => (
        <section key={s.id}>
          <h2>{s.name}</h2>
          {s.holders.length === 0 ? <p>No holders: a chain step at this seat is blocked.</p> : (
            <table aria-label={`${s.name} holders`}>
              <thead><tr><th>Holder</th><th>From</th><th>To</th><th>Delegated to</th><th>Change</th></tr></thead>
              <tbody>
                {s.holders.map((h) => (
                  <tr key={h.id}>
                    <td>{who.get(h.userId) ?? h.userId}{!active(h) && ' (inactive)'}</td>
                    <td>{day(h.activeFrom)}</td>
                    <td>{day(h.activeTo)}</td>
                    <td>{h.delegateToId ? who.get(h.delegateToId) ?? h.delegateToId : '—'}</td>
                    <td>
                      {active(h) && <>
                        <ActionForm action={delegateSeat.bind(null, ctx.slug)}>
                          <input type="hidden" name="seatId" value={s.id} />
                          <input type="hidden" name="userId" value={h.userId} />
                          <label>Delegate to <select name="delegateToId" required>{people}</select></label> <button type="submit">Delegate</button>
                        </ActionForm>
                        {h.delegateToId && (
                          <ActionForm action={clearDelegation.bind(null, ctx.slug)}>
                            <input type="hidden" name="seatId" value={s.id} />
                            <input type="hidden" name="userId" value={h.userId} />
                            <button type="submit">Clear delegation</button>
                          </ActionForm>
                        )}
                        <ActionForm action={endSeat.bind(null, ctx.slug)}>
                          <input type="hidden" name="seatId" value={s.id} />
                          <input type="hidden" name="userId" value={h.userId} />
                          <button type="submit">End seat</button>
                        </ActionForm>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}
