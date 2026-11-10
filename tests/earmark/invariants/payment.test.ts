// Phase 3 item 5 (D-25): approve-for-payment and the published variance note. Approval is Finance-seat only, needs a
// fully matched invoice, turns its matches into actual and emits the AP event once; a publish keeps the draft beside
// the edited text.
import { beforeEach, expect, it } from 'vitest';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { approveInvoiceForPayment, matchInvoice, publishVarianceNote } from '@/earmark/actions';
import { ledgerOf } from '@/earmark/core';
import { resetAuthTables } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { as, commitmentFor, world } from './world';

beforeEach(resetAuthTables);

it('only Finance approves, only a fully matched invoice, and approval moves actual and emits the event once', async () => {
  const w = await world('acme');
  const c = await commitmentFor(w, w.agency.id, 500_000n, 'PO-1');
  const inv = await db.invoice.create({ data: { orgId: w.orgId, agencyId: w.agency.id, number: 'N-1', poNumber: 'PO-1', amountCents: 200_000n, invoicedOn: new Date('2026-01-10'), dueOn: new Date('2026-02-09'), submittedById: w.requester.id } });
  const approve = (userId: string) => as(userId, () => approveInvoiceForPayment(w.slug, { invoiceId: inv.id }));

  expect(await approve(w.finance.id)).toMatchObject({ error: expect.stringMatching(/match all of it first/) });
  await as(w.ops.id, () => matchInvoice(w.slug, { invoiceId: inv.id, commitmentId: c.id, amount: '1,500.00' }));
  expect(await approve(w.finance.id)).toMatchObject({ error: expect.stringMatching(/match all of it first/) }); // partial
  await as(w.ops.id, () => matchInvoice(w.slug, { invoiceId: inv.id, commitmentId: c.id, amount: '500.00' }));

  expect(await approve(w.admin.id)).toEqual({ error: 'Only a Finance seat holder can approve an invoice for payment.' });
  expect(await approve(w.finance.id)).toEqual({ notice: 'Invoice N-1 approved for payment.' });
  expect(await approve(w.finance.id)).toEqual({ error: 'This invoice is already approved for payment.' });

  expect(await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ state: 'approved', approvedForPaymentAt: expect.any(Date) });
  const events = await db.orgEvent.findMany({ where: { orgId: w.orgId, type: 'invoice.approved_for_payment' } });
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({ invoice: { number: 'N-1', amountCents: '200000', matches: [{ poNumber: 'PO-1', amountCents: '150000' }, { poNumber: 'PO-1', amountCents: '50000' }] } });
  const ctx = await actAs(w.admin.id, w.slug);
  const ledger = await withOrg(ctx, (tx) => ledgerOf(tx, ctx, { id: w.line.id }), { atomic: false });
  expect(ledger.rollup.lines[0]!.actualCents).toBe(200_000n);
});

it('publishing replaces the latest draft and keeps it; with no draft the text is both; members cannot publish', async () => {
  const w = await world('acme');
  const draft = await db.varianceNote.create({ data: { orgId: w.orgId, budgetLineId: w.line.id, periodId: w.period.id, draft: 'AI draft.', createdById: w.admin.id } });
  const publish = (userId: string, text: string) => as(userId, () => publishVarianceNote(w.slug, { budgetLineId: w.line.id, text }));

  expect(await publish(w.requester.id, 'Nope.')).toEqual({ error: 'You do not have access to that.' });
  expect(await publish(w.admin.id, 'Edited note.')).toEqual({ notice: 'Note published.' });
  expect(await db.varianceNote.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ draft: 'AI draft.', published: 'Edited note.', publishedById: w.admin.id });

  await publish(w.owner.id, 'Second note.');
  const notes = await db.varianceNote.findMany({ where: { orgId: w.orgId }, orderBy: { createdAt: 'asc' } });
  expect(notes).toHaveLength(2);
  expect(notes[1]).toMatchObject({ draft: 'Second note.', published: 'Second note.' });
  expect(await db.auditEvent.count({ where: { orgId: w.orgId, action: 'variance.published' } })).toBe(2);
});
