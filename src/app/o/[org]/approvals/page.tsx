import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Approvals' };

// Demo step 4: the open requests whose current step names me among its frozen approvers (seats, not roles, PRD §1).
export default async function Approvals({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();

  const open = await withOrg(ctx, (tx) => tx.spendRequest.findMany({
    where: { ...inOrg(ctx), state: 'submitted', steps: { some: { approverIds: { has: ctx.userId }, decision: null } } },
    orderBy: { submittedAt: 'asc' },
    include: { budgetLine: { select: { name: true } }, steps: { where: { decision: null }, orderBy: { index: 'asc' } } },
  }), { atomic: false });
  // The filter above finds any undecided step naming me; only the first undecided one is waiting.
  const mine = open.filter((r) => r.steps[0]?.approverIds.includes(ctx.userId));

  return (
    <main>
      <h1>Approvals</h1>
      {mine.length === 0 ? <p>Nothing is waiting on you.</p> : (
        <table>
          <thead><tr><th>Submitted</th><th>Line</th><th>Request</th><th>Amount</th><th>Your seat</th></tr></thead>
          <tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td>{r.submittedAt.toISOString().slice(0, 10)}</td>
                <td>{r.budgetLine.name}</td>
                <td><Link href={`/o/${ctx.slug}/requests/${r.id}`}>{r.description}</Link>{r.overBudget && <> <mark>Over budget</mark></>}{r.requestedById === ctx.userId && <> <mark>Your own request</mark></>}</td>
                <td>{formatUsd(r.amountCents)}</td>
                <td>{r.steps[0]!.seat}{r.steps[0]!.blocked && <> <mark>Blocked</mark></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
