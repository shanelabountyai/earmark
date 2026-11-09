// ledgerOf: the rows → rollup-engine mapping behind the dashboard and the line page (Phase 3, item 2). The engine is
// covered by its oracle; this checks what only the loader decides: an invoice reaches a line through its PO, actual
// counts only invoices approved for payment, a PO-less invoice counts once at org level, and the replan marker.
import { beforeEach, expect, it } from 'vitest';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { ledgerOf, lineAvailable } from '@/earmark/core';
import { resetAuthTables } from '../../helpers/auth';
import { actAs } from '../../helpers/org';
import { commitmentFor, world } from './world';

beforeEach(resetAuthTables);

it('maps invoices to lines through their PO, counts approved matches as actual, and marks a replan', async () => {
  const w = await world('ledger', { plannedCents: 10_000_000n });
  const po = await commitmentFor(w, w.agency.id, 1_000_000n, 'PO-1');
  const invoice = (number: string, amountCents: bigint, state: 'submitted' | 'matched' | 'approved', poNumber: string | null = 'PO-1') =>
    db.invoice.create({ data: { orgId: w.orgId, agencyId: w.agency.id, number, poNumber, amountCents, state, invoicedOn: new Date('2026-01-10'), dueOn: new Date('2026-02-09'), submittedById: w.requester.id } });
  for (const [inv, amount] of [[await invoice('PAID', 300_000n, 'approved'), 300_000n], [await invoice('MATCHED', 200_000n, 'matched'), 200_000n]] as const)
    await db.invoiceMatch.create({ data: { orgId: w.orgId, invoiceId: inv.id, commitmentId: po.id, amountCents: amount, matchedById: w.admin.id, variance: 'under' } });
  await invoice('OPEN', 50_000n, 'submitted');
  await invoice('NO-PO', 70_000n, 'submitted', null);
  await db.budgetLine.update({ where: { id: w.line.id }, data: { plannedEditedAt: new Date(po.issuedAt.getTime() + 60_000) } });

  const ctx = await actAs(w.admin.id, w.slug);
  const { org, line, available } = await withOrg(ctx, async (tx) => ({
    org: await ledgerOf(tx, ctx, {}, { orgWide: true }),
    line: await ledgerOf(tx, ctx, { id: w.line.id }),
    available: await lineAvailable(tx, ctx, w.line),
  }), { atomic: false });

  expect(org.rollup.lines[0]).toMatchObject({ committedCents: 1_000_000n, actualCents: 300_000n, unmatchedProvisionCents: 50_000n, availableCents: 8_950_000n });
  expect(org.rollup.unassignedUnmatchedCents).toBe(70_000n);
  expect(org.rollup.orgAvailableCents).toBe(8_880_000n);
  expect(org.rollup.unmatchedInvoices.map((u) => org.invoices.get(u.invoiceId)!.number).sort()).toEqual(['NO-PO', 'OPEN']);
  expect(org.replan.has(w.line.id)).toBe(true);
  expect(line.rollup.unassignedUnmatchedCents).toBe(0n); // a line's ledger ignores invoices naming none of its POs
  expect(available).toBe(8_950_000n);
});
