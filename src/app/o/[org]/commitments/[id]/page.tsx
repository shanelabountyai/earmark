import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { earmarkCan, findCommitment, isUuid, scopeOf, toGuestCommitment } from '@/earmark/core';
import { InvoiceForm } from '@/earmark/ui/invoice-form';
import { orgName } from '@/earmark/ui/org-name';
import { Card, day, InvoiceState, Metrics, Money, PageHead, PoState, TableWrap } from '@/earmark/ui/kit';

type P = { params: Promise<{ org: string; id: string }> };
// A foreign or other-agency id gets the same generic title as a missing one (E-INV-03).
export async function generateMetadata({ params }: P) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!isUuid(id)) return { title: 'Purchase order' };
  const c = await withOrg(ctx, async (tx) => tx.commitment.findFirst({ where: { id, ...inOrg(ctx), ...(await scopeOf(tx, ctx)) }, select: { poNumber: true } }), { atomic: false });
  return { title: c ? c.poNumber : 'Purchase order' };
}

// Demo steps 6–8 (design: docs/design/Guest.dc.html): the PO an approval issued; a guest submits an invoice against
// it (step 7); the same id under another client's slug is the notFound of a missing row (step 8, E-INV-03), so the
// page gives no hint that the PO exists. A guest's view is the projection only (E-INV-04).
export default async function CommitmentPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const base = `/o/${ctx.slug}`;

  const { po, agencyId, staff, invoices } = await withOrg(ctx, async (tx) => {
    const c = await findCommitment(tx, ctx, id);
    return {
      po: toGuestCommitment(c),
      agencyId: c.agencyId,
      staff: ctx.role === 'guest' ? null : await tx.commitment.findFirst({
        where: { id, ...inOrg(ctx) },
        select: { closeReason: true, agency: { select: { name: true } }, request: { select: { id: true, description: true, budgetLine: { select: { id: true, name: true } } } } },
      }),
      // Invoices of this PO's agency naming it (D-71: another agency's invoice never lists here), and any matched to it.
      invoices: await tx.invoice.findMany({
        where: { ...inOrg(ctx), ...(await scopeOf(tx, ctx)), OR: [{ agencyId: c.agencyId, poNumber: { equals: c.poNumber, mode: 'insensitive' } }, { matches: { some: { commitmentId: c.id } } }] },
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, amountCents: true, invoicedOn: true, dueOn: true, state: true },
      }),
    };
  }, { atomic: false });
  const canBill = !po.closedAt && earmarkCan(ctx.role, 'invoice.submit');

  return (
    <main className="stack">
      <PageHead
        eyebrow={<>{await orgName(ctx.orgId)} · <Link href={`${base}/commitments`}>Purchase orders</Link>{staff && <> · {staff.agency.name}</>}</>}
        title={po.poNumber}
        lede={<>Issued {po.issuedAt.slice(0, 10)}{po.closedAt && <> · closed {po.closedAt.slice(0, 10)}{staff?.closeReason ? ` (${staff.closeReason})` : ''}</>}</>}
        aside={<p style={{ margin: 0 }}><span className="sr-only">Status: </span><PoState closed={!!po.closedAt} matchStatus={po.matchStatus} /></p>}
      />
      <Metrics label="Purchase order" items={[
        { label: 'PO amount', cents: BigInt(po.amountCents) },
        { label: 'Left to bill', cents: BigInt(po.remainingCents) },
      ]} />

      {staff && (
        <Card id="from-h" title="Where it came from">
          <dl className="facts">
            <dt>Agency</dt><dd>{staff.agency.name}</dd>
            <dt>Request</dt><dd><Link href={`${base}/requests/${staff.request.id}`}>{staff.request.description}</Link></dd>
            <dt>Line</dt><dd><Link href={`${base}/lines/${staff.request.budgetLine.id}`}>{staff.request.budgetLine.name}</Link></dd>
          </dl>
        </Card>
      )}

      <div className="row">
        <Card id="inv-list-h" title="Invoices on this PO" className="wide">
          {invoices.length === 0 ? <p className="note">None yet.</p> : (
            <TableWrap label="Invoices on this PO">
              <table aria-label="Invoices on this PO">
                <thead><tr><th scope="col">Invoice</th><th scope="col" className="num">Amount</th><th scope="col">Invoiced</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}><td>{staff ? <Link href={`${base}/invoices/${i.id}`}>{i.number}</Link> : i.number}</td><td className="num"><Money cents={i.amountCents} /></td><td className="nowrap">{day(i.invoicedOn)}</td><td className="nowrap">{day(i.dueOn)}</td><td><InvoiceState state={i.state} /></td></tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        {canBill && (
          <Card id="bill-h" title="Submit an invoice" className="narrow form-stack">
            <InvoiceForm slug={ctx.slug} agencyId={agencyId} pos={[{ poNumber: po.poNumber, remainingCents: po.remainingCents }]} />
          </Card>
        )}
      </div>
    </main>
  );
}
