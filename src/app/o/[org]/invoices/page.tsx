import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { alertRules } from '@/earmark/alerts';
import { orgName } from '@/earmark/ui/org-name';
import { Card, day, Money, PageHead, TableWrap, Today } from '@/earmark/ui/kit';
import { ageDays } from '@/lib/earmark/rollup';
import { titleFor } from '@/earmark/ui/titles';

export const generateMetadata = titleFor('Invoices'); // D-79: a guest gets the 404's title

type Row = { id: string; number: string; poNumber: string | null; amountCents: bigint; dueOn: Date; createdAt: Date; approvedForPaymentAt: Date | null; agency: { name: string }; matches: { amountCents: bigint }[] };

// The queues of PRD §4 (design: docs/design/Invoices.dc.html): invoices to match to a PO, fully matched ones waiting
// on Finance to approve them for payment (D-25), and the most recently approved. Staff only; a guest's invoices are
// on her PO pages.
export default async function Invoices({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  const base = `/o/${ctx.slug}`;

  const select = { id: true, number: true, poNumber: true, amountCents: true, dueOn: true, createdAt: true, approvedForPaymentAt: true, agency: { select: { name: true } }, matches: { select: { amountCents: true } } } as const;
  const { toMatch, toApprove, approved, approvedCount } = await withOrg(ctx, async (tx) => ({
    toMatch: await tx.invoice.findMany({ where: { ...inOrg(ctx), state: 'submitted' }, orderBy: { createdAt: 'asc' }, take: 200, select }),
    toApprove: await tx.invoice.findMany({ where: { ...inOrg(ctx), state: 'matched' }, orderBy: { createdAt: 'desc' }, take: 200, select }), // newest first (D-78)
    approved: await tx.invoice.findMany({ where: { ...inOrg(ctx), state: 'approved' }, orderBy: { approvedForPaymentAt: 'desc' }, take: 20, select }),
    approvedCount: await tx.invoice.count({ where: { ...inOrg(ctx), state: 'approved' } }),
  }), { atomic: false });
  const t = now().toISOString();
  const { unmatchedDays } = alertRules();
  const unmatched = (i: Row) => i.amountCents - i.matches.reduce((a, m) => a + m.amountCents, 0n);

  const table = (label: string, list: Row[], age: boolean) => (
    <TableWrap label={label}>
      <table aria-label={label}>
        <thead><tr><th scope="col">Invoice</th><th scope="col">Agency</th><th scope="col">PO on invoice</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Unmatched</th><th scope="col">Due</th>{age && <th scope="col" className="num">Age</th>}</tr></thead>
        <tbody>
          {list.map((i) => {
            const days = ageDays(i.createdAt.toISOString(), t) ?? 0;
            const old = days >= unmatchedDays;
            return (
              <tr key={i.id}>
                <td className="nowrap"><Link href={`${base}/invoices/${i.id}`}>{i.number}</Link><Today at={i.createdAt} /></td>
                <td>{i.agency.name}</td>
                <td>{i.poNumber ?? <span className="muted">—</span>}</td>
                <td className="num"><Money cents={i.amountCents} /></td>
                <td className="num"><Money cents={unmatched(i)} /></td>
                <td className="nowrap">{day(i.dueOn)}</td>
                {age && <td className={`num${old ? ' bad-text' : ''}`}>{old && <span aria-hidden="true">✕ </span>}{days} days{old && <span className="sr-only"> (past {unmatchedDays})</span>}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${await orgName(ctx.orgId)} · Invoices`}
        title="Invoices"
        lede="Agencies bill against POs. Someone matches each invoice to a PO, then a Finance seat holder approves it for payment. Approved invoices count as actual."
      />
      <div className="queues" role="group" aria-label="Queues">
        <a href="#to-match"><span aria-hidden="true">◆</span> To match <span className="money">{toMatch.length}</span></a>
        <a href="#to-approve"><span aria-hidden="true">●</span> To approve <span className="money">{toApprove.length}</span></a>
        <a href="#approved"><span aria-hidden="true">✓</span> Approved <span className="money">{approvedCount}</span></a>
      </div>
      <Card id="to-match" title={`To match (${toMatch.length})`}>
        {toMatch.length ? table('To match', toMatch, true) : <p className="note">None. Every submitted invoice is matched.</p>}
        <p className="note">Oldest first. An unmatched invoice counts against available until it’s matched; Finance is alerted at {unmatchedDays} days.</p>
      </Card>
      <Card id="to-approve" title={`To approve for payment (${toApprove.length})`}>
        {toApprove.length ? table('To approve for payment', toApprove, false) : <p className="note">None.</p>}
        <p className="note">Newest first. Fully matched. Only a Finance seat holder can approve one for payment.</p>
      </Card>
      <Card id="approved" title={`Approved for payment (${approvedCount})`}>
        {approved.length === 0 ? <p className="note">None yet.</p> : (
          <TableWrap label="Approved for payment">
            <table aria-label="Approved for payment">
              <thead><tr><th scope="col">Invoice</th><th scope="col">Agency</th><th scope="col" className="num">Amount</th><th scope="col">Approved</th></tr></thead>
              <tbody>
                {approved.map((i) => <tr key={i.id}><td className="nowrap"><Link href={`${base}/invoices/${i.id}`}>{i.number}</Link></td><td>{i.agency.name}</td><td className="num"><Money cents={i.amountCents} /></td><td>{i.approvedForPaymentAt ? day(i.approvedForPaymentAt) : '—'}</td></tr>)}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="note">Earmark stops here and sends the event; it doesn’t move money.</p>
      </Card>
    </main>
  );
}
