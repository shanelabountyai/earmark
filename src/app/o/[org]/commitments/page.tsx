import Link from 'next/link';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { scopeOf, toGuestCommitment } from '@/earmark/core';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Purchase orders' };

const day = (d: Date) => d.toISOString().slice(0, 10);

// Demo step 7's start: a guest lands here (their agency's POs and invoices only, E-INV-03); staff see every PO.
// Every PO row renders from toGuestCommitment, so the guest table cannot show a budget field (E-INV-04).
export default async function Commitments({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  const guest = ctx.role === 'guest';

  const { pos, invoices } = await withOrg(ctx, async (tx) => {
    const scope = await scopeOf(tx, ctx);
    const rows = await tx.commitment.findMany({
      where: { ...inOrg(ctx), ...scope },
      orderBy: { issuedAt: 'desc' },
      take: 100,
      include: { agency: { select: { name: true } }, matches: { select: { invoice: { select: { dueOn: true } } } } },
    });
    return {
      pos: rows.map((c) => ({ ...toGuestCommitment(c), agency: guest ? null : c.agency.name })),
      invoices: guest
        ? await tx.invoice.findMany({ where: { ...inOrg(ctx), ...scope }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, number: true, poNumber: true, amountCents: true, invoicedOn: true, dueOn: true, state: true } })
        : [],
    };
  }, { atomic: false });

  return (
    <main>
      <h1>Purchase orders</h1>
      <table aria-label="Purchase orders">
        <thead><tr><th>PO</th>{!guest && <th>Agency</th>}<th>Issued</th><th>Amount</th><th>Remaining</th><th>Status</th></tr></thead>
        <tbody>
          {pos.map((c) => (
            <tr key={c.id}>
              <td><Link href={`${base}/commitments/${c.id}`}>{c.poNumber}</Link></td>
              {!guest && <td>{c.agency}</td>}
              <td>{c.issuedAt.slice(0, 10)}</td>
              <td>{formatUsd(BigInt(c.amountCents))}</td>
              <td>{formatUsd(BigInt(c.remainingCents))}</td>
              <td>{c.closedAt ? 'closed' : 'open'} · {c.matchStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pos.length === 0 && <p>No purchase orders yet.</p>}

      {guest && (
        <>
          <h2>Your invoices</h2>
          <table aria-label="Your invoices">
            <thead><tr><th>Invoice</th><th>PO</th><th>Amount</th><th>Invoiced</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}><td>{i.number}</td><td>{i.poNumber ?? '—'}</td><td>{formatUsd(i.amountCents)}</td><td>{day(i.invoicedOn)}</td><td>{day(i.dueOn)}</td><td>{i.state}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
