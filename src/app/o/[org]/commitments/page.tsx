import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { withOrg } from '@/core/db/rls';
import { scopeOf, toGuestCommitment } from '@/earmark/core';
import { InvoiceForm } from '@/earmark/ui/invoice-form';
import { Card, day, InvoiceState, Money, PageHead, PoState, TableWrap } from '@/earmark/ui/kit';

export const metadata = { title: 'Purchase orders' };

// Demo step 7's start (designs: docs/design/Guest.dc.html, Commitments.dc.html): a guest lands here (her agency's POs
// and invoices only, E-INV-03) and can bill an open PO from this page; staff see every PO with its agency and line.
// Every guest PO row renders from toGuestCommitment, so the guest table cannot show a budget field (E-INV-04): the
// design's "For" column (the line's name) is left out for guests (D-47).
export default async function Commitments({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  const guest = ctx.role === 'guest';
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });

  const { pos, invoices, agency } = await withOrg(ctx, async (tx) => {
    const scope = await scopeOf(tx, ctx);
    const rows = await tx.commitment.findMany({
      where: { ...inOrg(ctx), ...scope },
      orderBy: { issuedAt: 'desc' },
      take: 100,
      include: { agency: { select: { name: true } }, matches: { select: { invoice: { select: { dueOn: true } } } }, request: { select: { budgetLine: { select: { id: true, name: true } } } } },
    });
    return {
      pos: rows.map((c) => ({ ...toGuestCommitment(c), agencyId: c.agencyId, agency: guest ? null : c.agency.name, line: guest ? null : c.request.budgetLine })),
      invoices: guest
        ? await tx.invoice.findMany({ where: { ...inOrg(ctx), ...scope }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, number: true, poNumber: true, amountCents: true, invoicedOn: true, dueOn: true, state: true } })
        : [],
      agency: guest && scope.agencyId ? await tx.agency.findFirst({ where: { ...inOrg(ctx), id: scope.agencyId }, select: { id: true, name: true } }) : null,
    };
  }, { atomic: false });
  const open = pos.filter((p) => !p.closedAt);

  return (
    <main className="stack">
      <PageHead
        eyebrow={guest ? `${agency?.name ?? 'Your agency'} in ${org.name}` : 'Purchase orders'}
        title="Purchase orders"
        lede={guest
          ? `The POs ${org.name} has issued to ${agency?.name ?? 'your agency'}. Bill against a PO, and ${org.name}’s team matches your invoice to it.`
          : 'Every PO here was issued by the last approval on a request, in the same step. Left to bill is the PO amount less what has been matched to it.'}
      />
      <div className="row">
        <Card id="po-h" title={guest ? 'Your POs' : 'All POs'} className="wide">
          {pos.length === 0 ? <p className="note">No purchase orders yet.</p> : (
            <TableWrap label="Purchase orders">
              <table aria-label="Purchase orders">
                <thead><tr><th scope="col">PO</th>{!guest && <><th scope="col">Agency</th><th scope="col">Line</th></>}<th scope="col">Issued</th><th scope="col" className="num">PO amount</th><th scope="col" className="num">Left to bill</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {pos.map((c) => (
                    <tr key={c.id}>
                      <td className="nowrap"><Link href={`${base}/commitments/${c.id}`}><strong>{c.poNumber}</strong></Link></td>
                      {!guest && <><td>{c.agency}</td><td>{c.line && <Link href={`${base}/lines/${c.line.id}`}>{c.line.name}</Link>}</td></>}
                      <td className="nowrap">{c.issuedAt.slice(0, 10)}</td>
                      <td className="num"><Money cents={BigInt(c.amountCents)} /></td>
                      <td className="num"><Money cents={BigInt(c.remainingCents)} /></td>
                      <td><PoState closed={!!c.closedAt} matchStatus={c.matchStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {guest && <p className="note">You see each PO’s amount and what’s left to bill on it. Budgets, other agencies and other clients’ POs aren’t shown.</p>}
        </Card>

        {guest && agency && (
          <Card id="inv-h" title="Submit an invoice" className="narrow form-stack">
            {open.length === 0 ? <p className="note">No open PO to bill against.</p> : (
              <InvoiceForm slug={ctx.slug} agencyId={agency.id} pos={open.map((p) => ({ poNumber: p.poNumber, remainingCents: p.remainingCents }))} />
            )}
          </Card>
        )}
      </div>

      {guest && (
        <Card id="yours-h" title="Your invoices">
          {invoices.length === 0 ? <p className="note">None yet.</p> : (
            <TableWrap label="Your invoices">
              <table aria-label="Your invoices">
                <thead><tr><th scope="col">Invoice</th><th scope="col">PO</th><th scope="col" className="num">Amount</th><th scope="col">Invoiced</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}><td>{i.number}</td><td>{i.poNumber ?? '—'}</td><td className="num"><Money cents={i.amountCents} /></td><td className="nowrap">{day(i.invoicedOn)}</td><td className="nowrap">{day(i.dueOn)}</td><td><InvoiceState state={i.state} /></td></tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}
    </main>
  );
}
