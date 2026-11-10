import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Invoices' };

const day = (d: Date) => d.toISOString().slice(0, 10);

// The two queues of PRD §4: invoices to match to a PO, and fully matched ones waiting on Finance to approve them for
// payment (D-25). Staff only; a guest's invoices are on her PO pages.
export default async function Invoices({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  const base = `/o/${ctx.slug}`;

  const rows = await withOrg(ctx, (tx) => tx.invoice.findMany({
    where: { ...inOrg(ctx), state: { in: ['submitted', 'matched'] } },
    orderBy: { dueOn: 'asc' },
    take: 200,
    select: { id: true, number: true, poNumber: true, amountCents: true, dueOn: true, state: true, agency: { select: { name: true } }, matches: { select: { amountCents: true } } },
  }), { atomic: false });

  const table = (label: string, list: typeof rows) => (
    <table aria-label={label}>
      <thead><tr><th>Invoice</th><th>Agency</th><th>PO on invoice</th><th>Amount</th><th>Unmatched</th><th>Due</th></tr></thead>
      <tbody>
        {list.map((i) => (
          <tr key={i.id}>
            <td><Link href={`${base}/invoices/${i.id}`}>{i.number}</Link></td>
            <td>{i.agency.name}</td>
            <td>{i.poNumber ?? '—'}</td>
            <td>{formatUsd(i.amountCents)}</td>
            <td>{formatUsd(i.amountCents - i.matches.reduce((a, m) => a + m.amountCents, 0n))}</td>
            <td>{day(i.dueOn)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const toMatch = rows.filter((i) => i.state === 'submitted');
  const toApprove = rows.filter((i) => i.state === 'matched');

  return (
    <main>
      <h1>Invoices</h1>
      <h2>To match ({toMatch.length})</h2>
      {toMatch.length ? table('To match', toMatch) : <p>None.</p>}
      <h2>To approve for payment ({toApprove.length})</h2>
      {toApprove.length ? table('To approve for payment', toApprove) : <p>None.</p>}
    </main>
  );
}
