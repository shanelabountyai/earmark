import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Form as ActionForm } from '@/earmark/ui/form';
import { earmarkCan } from '@/earmark/core';
import { submitRequest } from '@/earmark/actions';
import { orgName } from '@/earmark/ui/org-name';
import { Card, day, Money, PageHead, Pill, RequestState, TableWrap, Today } from '@/earmark/ui/kit';

export const metadata = { title: 'Requests' };

// Demo step 3 (design: docs/design/Requests.dc.html): submit a request against a line; the chain freezes at submit
// and the new request lists beside the form.
export default async function Requests({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ line?: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound(); // PRD §1: a guest sees no request
  const { line: preset } = await searchParams;
  const base = `/o/${ctx.slug}`;

  const { lines, agencies, requests } = await withOrg(ctx, async (tx) => {
    const fy = await tx.fiscalYear.findFirst({ where: inOrg(ctx), orderBy: { startsOn: 'desc' } });
    return {
      lines: await tx.budgetLine.findMany({
        where: { ...inOrg(ctx), carryForward: false, campaign: { program: { fiscalYearId: fy?.id ?? '' } } },
        orderBy: [{ campaign: { program: { name: 'asc' } } }, { campaign: { name: 'asc' } }, { name: 'asc' }],
        select: { id: true, name: true, campaign: { select: { name: true, program: { select: { name: true } } } } },
      }),
      agencies: await tx.agency.findMany({ where: { ...inOrg(ctx), offboardedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      requests: await tx.spendRequest.findMany({
        where: inOrg(ctx),
        orderBy: { submittedAt: 'desc' },
        take: 50,
        include: { budgetLine: { select: { id: true, name: true } }, agency: { select: { name: true } }, steps: { where: { decision: null }, orderBy: { index: 'asc' }, take: 1, select: { seat: true } } },
      }),
    };
  }, { atomic: false });
  const canCreate = earmarkCan(ctx.role, 'request.create');
  const programs = [...new Set(lines.map((l) => l.campaign.program.name))];

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${await orgName(ctx.orgId)} · Requests`}
        title="Requests"
        lede="Ask to commit money against one budget line. The approval chain is worked out from the rules and frozen the moment you submit."
      />
      <div className="stack">
        {canCreate && (
          <Card id="new-h" title="New request" className="form-stack new-request">
            {lines.length === 0 || agencies.length === 0 ? (
              <p className="note">{lines.length === 0 ? 'There is no budget line to request against yet. An owner or admin adds lines on the Plan page.' : 'There is no active agency to request for. An admin adds one under Settings, Agencies.'}</p>
            ) : (
              <ActionForm action={submitRequest.bind(null, ctx.slug)}>
                <label>Budget line
                  <select name="budgetLineId" defaultValue={preset} required>
                    {programs.map((p) => (
                      <optgroup key={p} label={p}>
                        {lines.filter((l) => l.campaign.program.name === p).map((l) => <option key={l.id} value={l.id}>{l.campaign.program.name} / {l.campaign.name} / {l.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label>Agency
                  <select name="agencyId" required>
                    {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
                <label>Amount (USD) <input name="amount" inputMode="decimal" required maxLength={32} placeholder="12,000.00" autoComplete="off" /></label>
                <label>What it is for <input name="description" required maxLength={2000} aria-describedby="desc-hint" /></label>
                <span className="note" id="desc-hint">The agency sees the PO number and amount, not this text or the line.</span>
                <button type="submit">Submit request</button>
                <p className="note">Over the line’s available? It still submits, with an extra Finance step and a required note.</p>
              </ActionForm>
            )}
          </Card>
        )}

        <Card id="list-h" title="Recent requests">
          {requests.length === 0 ? <p className="note">No requests yet.</p> : (
            <TableWrap label="Recent requests">
              <table aria-label="Recent requests">
                <thead><tr><th scope="col">Submitted</th><th scope="col">Request</th><th scope="col">Line</th><th scope="col">Agency</th><th scope="col" className="num">Amount</th><th scope="col">State</th></tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{day(r.submittedAt)}</td>
                      <td><Link href={`${base}/requests/${r.id}`}>{r.description}</Link><Today at={r.submittedAt} />{r.overBudget && <> <Pill tone="bad" glyph="▲">Over budget</Pill></>}{r.kind === 'reallocation' && <> <Pill tone="info">Reallocation</Pill></>}</td>
                      <td><Link href={`${base}/lines/${r.budgetLine.id}`}>{r.budgetLine.name}</Link></td>
                      <td>{r.agency?.name ?? <span className="muted">—</span>}</td>
                      <td className="num"><Money cents={r.amountCents} /></td>
                      <td><RequestState state={r.state} waitingOn={r.state === 'submitted' ? r.steps[0]?.seat : null} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </main>
  );
}
