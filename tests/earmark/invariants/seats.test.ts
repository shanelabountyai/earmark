// Phase 3 item 6, seats (D-27): owner only; a guest never holds or takes a seat; a delegation sends the next request's
// step to the delegate; ending a holding takes the holder out of the next chain.
import { beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { assignSeat, clearDelegation, delegateSeat, endSeat, submitRequest } from '@/earmark/actions';
import { resetAuthTables } from '../../helpers/auth';
import { addGuest, as, world } from './world';

beforeEach(resetAuthTables);

it('owner manages seats; delegation and ending change the next chain', async () => {
  const w = await world('acme');
  const seat = await db.seat.findFirstOrThrow({ where: { orgId: w.orgId, name: 'Budget Owner' } });
  const guest = await db.user.create({ data: { email: 'dana@meridian.test' } });
  await addGuest(w.orgId, w.agency.id, guest.id);
  const s = (userId: string) => ({ seatId: seat.id, userId });
  const steps = async () => {
    const r = (await as(w.requester.id, () => submitRequest(w.slug, { budgetLineId: w.line.id, agencyId: w.agency.id, amount: '500.00', description: 'x' }))) as { id: string };
    return (await db.approvalStep.findFirstOrThrow({ where: { requestId: r.id } })).approverIds;
  };

  expect(await as(w.admin.id, () => assignSeat(w.slug, { ...s(w.ops.id), activeTo: '' }))).toEqual({ error: 'You do not have access to that.' });
  expect(await as(w.owner.id, () => assignSeat(w.slug, { ...s(guest.id), activeTo: '' }))).toEqual({ error: 'A guest cannot hold or take a seat.' });
  expect(await as(w.owner.id, () => endSeat(w.slug, s(w.ops.id)))).toEqual({ error: 'That person does not hold the Budget Owner seat.' });
  expect(await as(w.owner.id, () => delegateSeat(w.slug, { ...s(w.budgetOwner.id), delegateToId: w.budgetOwner.id }))).toEqual({ error: 'A holder cannot delegate to themselves.' });

  expect(await steps()).toEqual([w.budgetOwner.id]); // the requester holds the seat too and is dropped
  await as(w.owner.id, () => delegateSeat(w.slug, { ...s(w.budgetOwner.id), delegateToId: w.ops.id }));
  expect(await steps()).toEqual([w.ops.id]);
  await as(w.owner.id, () => clearDelegation(w.slug, s(w.budgetOwner.id)));
  await as(w.owner.id, () => assignSeat(w.slug, { ...s(w.finance.id), activeTo: '' }));
  expect((await steps()).sort()).toEqual([w.budgetOwner.id, w.finance.id].sort());
  await as(w.owner.id, () => endSeat(w.slug, s(w.finance.id)));
  expect(await steps()).toEqual([w.budgetOwner.id]);
  expect(await db.auditEvent.count({ where: { orgId: w.orgId, action: { startsWith: 'seat.' } } })).toBe(4);
});
