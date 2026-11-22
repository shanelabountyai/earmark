import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { heldSeats } from '@/earmark/core';
import { orgName } from '@/earmark/ui/org-name';
import { Card, day, Money, PageHead, Pill, TableWrap, Today } from '@/earmark/ui/kit';
import { titleFor } from '@/earmark/ui/titles';

export const generateMetadata = titleFor('Approvals'); // D-79: a guest gets the 404's title

// Demo step 4 (design: docs/design/Approvals.dc.html): the open requests whose current step names me among its
// frozen approvers (seats, not roles, PRD §1). A step whose seat I don't hold reached me by delegation.
export default async function Approvals({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();

  const { open, held } = await withOrg(ctx, async (tx) => ({
    open: await tx.spendRequest.findMany({
      where: { ...inOrg(ctx), state: 'submitted', steps: { some: { approverIds: { has: ctx.userId }, decision: null } } },
      orderBy: { submittedAt: 'asc' },
      include: { budgetLine: { select: { id: true, name: true, ownerSeat: true } }, steps: { where: { decision: null }, orderBy: { index: 'asc' } } },
    }),
    held: new Set(await heldSeats(tx, ctx)),
  }), { atomic: false });
  // The filter above finds any undecided step naming me; only the first undecided one is waiting.
  const mine = open.filter((r) => r.steps[0]?.approverIds.includes(ctx.userId));
  const base = `/o/${ctx.slug}`;

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${await orgName(ctx.orgId)} · Approvals`}
        title="Waiting on you"
        lede="Requests whose current step names you, through a seat you hold or one delegated to you. Oldest first. Each request’s chain was frozen when it was submitted."
      />
      <Card id="w-h" title={`Your steps (${mine.length})`}>
        {mine.length === 0 ? <p><Pill tone="good">Nothing is waiting on you</Pill></p> : (
          <TableWrap label="Waiting on you">
            <table aria-label="Waiting on you">
              <thead><tr><th scope="col">Submitted</th><th scope="col">Request</th><th scope="col">Line</th><th scope="col" className="num">Amount</th><th scope="col">Your seat</th></tr></thead>
              <tbody>
                {mine.map((r) => {
                  const step = r.steps[0]!;
                  const seat = step.seat === 'Budget Owner' ? r.budgetLine.ownerSeat : step.seat; // D-18: the line's owner seat
                  return (
                    <tr key={r.id}>
                      <td className="nowrap">{day(r.submittedAt)}</td>
                      <td>
                        <Link href={`${base}/requests/${r.id}`}>{r.description}</Link><Today at={r.submittedAt} />
                        {(r.overBudget || r.requestedById === ctx.userId) && <>{' '}<span className="pills">
                          {r.overBudget && <Pill tone="bad" glyph="▲">Over budget</Pill>}
                          {r.requestedById === ctx.userId && <Pill tone="hold">Your own request</Pill>}
                        </span></>}
                      </td>
                      <td><Link href={`${base}/lines/${r.budgetLine.id}`}>{r.budgetLine.name}</Link></td>
                      <td className="num"><Money cents={r.amountCents} /></td>
                      <td>{seat}{!held.has(seat) && <> <Pill tone="info">Delegated to you</Pill></>}{step.blocked && <> <Pill tone="bad" glyph="▲">Blocked</Pill></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="note">You can’t approve a request you submitted, even when you hold its seat; another holder decides that step.</p>
      </Card>
    </main>
  );
}
