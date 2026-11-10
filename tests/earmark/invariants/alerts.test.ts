// Phase 3 item 7, alerts (D-30): each threshold of rules/alerts.json fires once per period to the right people; an
// empty seat falls back to the org's owners; a second run sends nothing.
import { beforeEach, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { runOrgAlerts } from '@/earmark/alerts';
import { resetAuthTables } from '../../helpers/auth';
import { commitmentFor, world } from './world';

beforeEach(resetAuthTables);

it('committed 80 %, an aged unmatched invoice and an agency over its POs each alert once', async () => {
  const w = await world('acme', { plannedCents: 1_000_000n });
  await commitmentFor(w, w.agency.id, 800_000n, 'PO-1');
  const old = new Date(Date.now() - 20 * 86_400_000);
  await db.invoice.create({ data: { orgId: w.orgId, agencyId: w.agency.id, number: 'OLD-1', poNumber: 'PO-1', amountCents: 900_000n, invoicedOn: old, dueOn: old, submittedById: w.requester.id, createdAt: old } });
  await db.seatHolder.deleteMany({ where: { orgId: w.orgId, seat: { name: 'Finance' } } }); // nobody holds Finance

  await db.capturedMessage.deleteMany({});
  expect(await runOrgAlerts(w.orgId)).toBe(3);
  const mail = await db.capturedMessage.findMany({ orderBy: [{ subject: 'asc' }, { to: 'asc' }] });
  expect(mail.map((m) => [m.subject, m.to])).toEqual([
    ['Earmark: Invoice OLD-1 unmatched for 20 days', w.budgetOwner.email],
    ['Earmark: Invoice OLD-1 unmatched for 20 days', w.requester.email],
    ['Earmark: Meridian Creative: invoices exceed open POs', w.owner.email], // Finance empty → owners
    ['Earmark: Q1 Paid Social: 80 % committed', w.budgetOwner.email],
    ['Earmark: Q1 Paid Social: 80 % committed', w.requester.email],
  ]);
  expect(await runOrgAlerts(w.orgId)).toBe(0);
  expect(await db.auditEvent.count({ where: { orgId: w.orgId, action: 'alert.sent' } })).toBe(3);
});
