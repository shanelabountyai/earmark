import Link from 'next/link';
import { notFound } from 'next/navigation';
import { actorEmails } from '@/core/audit';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { decideStep, withdrawRequest } from '@/earmark/actions';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Request' };

const when = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Demo steps 3–4: the chain frozen at submit, each step's decision, the decide form and the request's audit rows.
// The form shows to any staff member while the request is open: decideStep is what refuses (self-approval, wrong seat).
export default async function RequestPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (ctx.role === 'guest' || !UUID.test(id)) notFound();

  const { r, events } = await withOrg(ctx, async (tx) => {
    const r = await tx.spendRequest.findFirst({
      where: { id, ...inOrg(ctx) },
      include: {
        steps: { orderBy: { index: 'asc' } },
        agency: { select: { name: true } },
        commitment: { select: { poNumber: true } },
        budgetLine: { select: { id: true, name: true, campaign: { select: { name: true, program: { select: { name: true } } } } } },
      },
    });
    if (!r) notFound();
    const events = await tx.auditEvent.findMany({ where: { ...inOrg(ctx), targetType: 'spendRequest', targetId: id }, orderBy: { id: 'asc' } });
    return { r, events };
  }, { atomic: false });

  const emails = await actorEmails([r.requestedById, ...r.steps.flatMap((s) => [...s.approverIds, s.decidedById]), ...events.map((e) => e.actorUserId)]);
  const who = (u: string | null) => (u ? (emails.get(u) ?? 'former user') : '—');
  const current = r.state === 'submitted' ? r.steps.find((s) => !s.decision) : undefined;
  const l = r.budgetLine;

  return (
    <main>
      <p><Link href={`/o/${ctx.slug}/requests`}>Requests</Link> / <Link href={`/o/${ctx.slug}/lines/${l.id}`}>{l.campaign.program.name} / {l.campaign.name} / {l.name}</Link></p>
      <h1>{formatUsd(r.amountCents)}: {r.description} {r.overBudget && <mark>Over budget</mark>}</h1>
      <p>State: <strong>{r.state}</strong> · Requested by {who(r.requestedById)} on {when(r.submittedAt)} UTC · Agency: {r.agency?.name ?? '—'}{r.commitment && <> · PO {r.commitment.poNumber}</>}</p>

      <h2>Approval chain (frozen at submit)</h2>
      <table aria-label="Approval chain">
        <thead><tr><th>#</th><th>Seat</th><th>From</th><th>Approvers</th><th>Decision</th><th>By</th><th>Note</th></tr></thead>
        <tbody>
          {r.steps.map((s) => (
            <tr key={s.id} aria-current={s === current ? 'step' : undefined}>
              <td>{s.index + 1}</td>
              <td>{s.seat}{s.source !== 'chain' && ` (${s.source})`}{s.blocked && <> <mark>Blocked</mark></>}</td>
              <td>{s.thresholdCents === null ? '—' : formatUsd(s.thresholdCents)}</td>
              <td>{s.approverIds.map(who).join(', ') || '—'}</td>
              <td>{s.decision ?? (s === current ? 'waiting' : '—')}</td>
              <td>{s.decidedById ? `${who(s.decidedById)}, ${when(s.decidedAt!)}` : '—'}</td>
              <td>{s.note || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.steps.length === 0 && <p>No step applied; the request was approved at submit.</p>}

      {current && (
        <>
          <h2>Decide step {current.index + 1}: {current.seat}</h2>
          <ActionForm action={decideStep.bind(null, ctx.slug)}>
            <input type="hidden" name="requestId" value={r.id} />
            <label>Note{current.requiresNote && ' (required)'} <input name="note" maxLength={2000} required={current.requiresNote} /></label>{' '}
            <button type="submit" name="decision" value="approve">Approve</button>{' '}
            <button type="submit" name="decision" value="reject">Reject</button>
          </ActionForm>
        </>
      )}
      {r.state === 'submitted' && r.requestedById === ctx.userId && (
        <ActionForm action={withdrawRequest.bind(null, ctx.slug)}>
          <input type="hidden" name="requestId" value={r.id} />
          <button type="submit">Withdraw request</button>
        </ActionForm>
      )}

      <h2>Audit</h2>
      <table aria-label="Request audit">
        <thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id.toString()}>
              <td>{when(e.at)}</td>
              <td>{who(e.actorUserId)}</td>
              <td>{e.action}</td>
              <td><code>{e.data ? JSON.stringify(e.data) : ''}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
