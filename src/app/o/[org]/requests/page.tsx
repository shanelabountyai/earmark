import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { earmarkCan } from '@/earmark/core';
import { submitRequest } from '@/earmark/actions';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Requests' };

// Demo step 3: submit a request against a line; the chain freezes at submit and the new request lists below.
export default async function Requests({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ line?: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound(); // PRD §1: a guest sees no request
  const { line: preset } = await searchParams;

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
        include: { budgetLine: { select: { name: true } }, agency: { select: { name: true } }, steps: { where: { decision: null }, orderBy: { index: 'asc' }, take: 1, select: { seat: true } } },
      }),
    };
  }, { atomic: false });

  return (
    <main>
      <h1>Requests</h1>
      {earmarkCan(ctx.role, 'request.create') && (
        <>
          <h2>New request</h2>
          <ActionForm action={submitRequest.bind(null, ctx.slug)}>
            <label>Budget line{' '}
              <select name="budgetLineId" defaultValue={preset} required>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.campaign.program.name} / {l.campaign.name} / {l.name}</option>)}
              </select>
            </label>{' '}
            <label>Agency{' '}
              <select name="agencyId" required>
                {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>{' '}
            <label>Amount (USD) <input name="amount" inputMode="decimal" required maxLength={32} placeholder="12,000.00" /></label>{' '}
            <label>What it is for <input name="description" required maxLength={2000} /></label>{' '}
            <button type="submit">Submit request</button>
          </ActionForm>
        </>
      )}

      <h2>Recent requests</h2>
      <table>
        <thead><tr><th>Submitted</th><th>Line</th><th>Description</th><th>Agency</th><th>Amount</th><th>State</th></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>{r.submittedAt.toISOString().slice(0, 10)}</td>
              <td>{r.budgetLine.name}</td>
              <td><Link href={`/o/${ctx.slug}/requests/${r.id}`}>{r.description}</Link>{r.overBudget && <> <mark>Over budget</mark></>}</td>
              <td>{r.agency?.name ?? '—'}</td>
              <td>{formatUsd(r.amountCents)}</td>
              <td>{r.state}{r.state === 'submitted' && r.steps[0] && ` · waiting on ${r.steps[0].seat}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
