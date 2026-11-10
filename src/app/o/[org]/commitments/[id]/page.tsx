import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { submitInvoice } from '@/earmark/actions';
import { earmarkCan, findCommitment, isUuid, scopeOf, toGuestCommitment } from '@/earmark/core';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Purchase order' };

const day = (d: Date) => d.toISOString().slice(0, 10);

// Demo steps 6–8: the PO an approval issued; a guest submits an invoice against it (step 7); the same id under
// another client's slug is the notFound of a missing row (step 8, E-INV-03). A guest's view is the projection only.
export default async function CommitmentPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const { po, agencyId, staff, invoices } = await withOrg(ctx, async (tx) => {
    const c = await findCommitment(tx, ctx, id);
    return {
      po: toGuestCommitment(c),
      agencyId: c.agencyId,
      staff: ctx.role === 'guest' ? null : await tx.commitment.findFirst({
        where: { id, ...inOrg(ctx) },
        select: { closeReason: true, agency: { select: { name: true } }, request: { select: { id: true, description: true, budgetLine: { select: { id: true, name: true } } } } },
      }),
      // Invoices naming this PO, and any matched to it without naming it.
      invoices: await tx.invoice.findMany({
        where: { ...inOrg(ctx), ...(await scopeOf(tx, ctx)), OR: [{ poNumber: c.poNumber }, { matches: { some: { commitmentId: c.id } } }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, amountCents: true, invoicedOn: true, dueOn: true, state: true },
      }),
    };
  }, { atomic: false });

  return (
    <main>
      <p><Link href={`/o/${ctx.slug}/commitments`}>Purchase orders</Link></p>
      <h1>{po.poNumber}</h1>
      <dl aria-label="Purchase order">
        <dt>Amount</dt><dd>{formatUsd(BigInt(po.amountCents))}</dd>
        <dt>Remaining</dt><dd>{formatUsd(BigInt(po.remainingCents))}</dd>
        <dt>Issued</dt><dd>{po.issuedAt.slice(0, 10)}</dd>
        <dt>Status</dt><dd>{po.closedAt ? `closed ${po.closedAt.slice(0, 10)}${staff?.closeReason ? ` (${staff.closeReason})` : ''}` : 'open'} · {po.matchStatus}</dd>
        {staff && <>
          <dt>Agency</dt><dd>{staff.agency.name}</dd>
          <dt>Request</dt><dd><Link href={`/o/${ctx.slug}/requests/${staff.request.id}`}>{staff.request.description}</Link></dd>
          <dt>Line</dt><dd><Link href={`/o/${ctx.slug}/lines/${staff.request.budgetLine.id}`}>{staff.request.budgetLine.name}</Link></dd>
        </>}
      </dl>

      {!po.closedAt && earmarkCan(ctx.role, 'invoice.submit') && (
        <>
          <h2>Submit an invoice</h2>
          <ActionForm action={submitInvoice.bind(null, ctx.slug)}>
            <input type="hidden" name="agencyId" value={agencyId} />
            <input type="hidden" name="poNumber" value={po.poNumber} />
            <label>Invoice number <input name="number" required maxLength={64} /></label>{' '}
            <label>Amount (USD) <input name="amount" inputMode="decimal" required maxLength={32} placeholder="4,000.00" /></label>{' '}
            <label>Invoice date <input name="invoicedOn" type="date" required /></label>{' '}
            <label>Due date <input name="dueOn" type="date" required /></label>{' '}
            <label>Link to the invoice file <input name="fileRef" type="url" maxLength={2000} /></label>{' '}
            <button type="submit">Submit invoice</button>
          </ActionForm>
        </>
      )}

      <h2>Invoices on this PO</h2>
      <table aria-label="Invoices on this PO">
        <thead><tr><th>Invoice</th><th>Amount</th><th>Invoiced</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}><td>{staff ? <Link href={`/o/${ctx.slug}/invoices/${i.id}`}>{i.number}</Link> : i.number}</td><td>{formatUsd(i.amountCents)}</td><td>{day(i.invoicedOn)}</td><td>{day(i.dueOn)}</td><td>{i.state}</td></tr>
          ))}
        </tbody>
      </table>
      {invoices.length === 0 && <p>None yet.</p>}
    </main>
  );
}
