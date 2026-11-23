import Link from 'next/link';
import { notFound } from 'next/navigation';
import { actorEmails } from '@/core/audit';
import { auditDetails } from '@/earmark/audit-details';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Form as ActionForm } from '@/earmark/ui/form';
import { decideStep, withdrawRequest } from '@/earmark/actions';
import { isUuid } from '@/earmark/core';
import { orgName } from '@/earmark/ui/org-name';
import { Card, Money, PageHead, Pill, RequestState, TableWrap } from '@/earmark/ui/kit';
import { formatUsd } from '@/lib/earmark/money';

type P = { params: Promise<{ org: string; id: string }> };
// The tab names the request (2.4.2); a missing or foreign id gets the generic title, like its 404.
export async function generateMetadata({ params }: P) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (ctx.role === 'guest' || !isUuid(id)) notFound(); // D-79
  const r = await withOrg(ctx, (tx) => tx.spendRequest.findFirst({ where: { id, ...inOrg(ctx) }, select: { description: true } }), { atomic: false });
  if (!r) notFound();
  return { title: `Request: ${r.description}` };
}

const when = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
type Skipped = { seat: string; fromCents: string | number };

// Demo steps 3–4 (design: docs/design/Request.dc.html): the chain frozen at submit, each step's decision, the decide
// form and the request's audit rows. The form shows to any staff member while the request is open: decideStep is what
// refuses (self-approval, wrong seat), so the refusal is the action's own words (D-24).
export default async function RequestPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (ctx.role === 'guest' || !isUuid(id)) notFound();
  const base = `/o/${ctx.slug}`;

  const { r, events } = await withOrg(ctx, async (tx) => {
    const r = await tx.spendRequest.findFirst({
      where: { id, ...inOrg(ctx) },
      include: {
        steps: { orderBy: { index: 'asc' } },
        agency: { select: { name: true } },
        commitment: { select: { id: true, poNumber: true, amountCents: true } },
        reallocation: { select: { toLine: { select: { id: true, name: true } } } },
        budgetLine: { select: { id: true, name: true, ownerSeat: true, campaign: { select: { name: true, program: { select: { name: true } } } } } },
      },
    });
    if (!r) notFound();
    const events = await tx.auditEvent.findMany({ where: { ...inOrg(ctx), targetType: 'spendRequest', targetId: id }, orderBy: { id: 'asc' } });
    return { r, events };
  }, { atomic: false });

  const emails = await actorEmails([r.requestedById, ...r.steps.flatMap((s) => [...s.approverIds, s.decidedById]), ...events.map((e) => e.actorUserId)]);
  const who = (u: string | null) => (u ? (emails.get(u) ?? 'former user') : '—');
  const current = r.state === 'submitted' ? r.steps.find((s) => !s.decision) : undefined;
  const rejectedAt = r.steps.find((s) => s.decision === 'reject')?.index;
  const l = r.budgetLine;
  const inChain = new Set(r.steps.map((s) => s.seat));
  const skipped = ((r.chainSnapshot as { skipped?: Skipped[] } | null)?.skipped ?? []).filter((s) => !inChain.has(s.seat));
  // D-53: the decide form shows to the current step's frozen approvers (the requester among them is refused by the
  // action, demo step 4); everyone else sees who the step waits on.
  const mayDecide = !!current && (current.approverIds.includes(ctx.userId) || r.requestedById === ctx.userId);
  const title = r.reallocation
    ? <><Money cents={r.amountCents} /> from {l.name} to {r.reallocation.toLine.name}</>
    : <><Money cents={r.amountCents} /> to {r.agency?.name ?? 'no agency'}</>;

  return (
    <main className="stack">
      <PageHead
        eyebrow={<>{await orgName(ctx.orgId)} · <Link href={`${base}/requests`}>Requests</Link> · {l.campaign.program.name} / {l.campaign.name} / <Link href={`${base}/lines/${l.id}`}>{l.name}</Link></>}
        title={title}
        lede={<>Submitted by {who(r.requestedById)} on {when(r.submittedAt)} UTC · {r.description}</>}
        aside={<p className="pills" style={{ margin: 0 }}><span className="sr-only">State: </span><RequestState state={r.state} big />{r.overBudget && <Pill tone="bad" glyph="▲" big>Over budget</Pill>}</p>}
      />

      {r.commitment && (
        <div className="card" style={{ background: 'var(--good-bg)', borderColor: 'var(--good-bd)', color: 'var(--good-fg)' }}>
          <p style={{ margin: 0 }}><strong><span aria-hidden="true">● </span>Approved. PO issued in the same step:</strong>{' '}
            <Link href={`${base}/commitments/${r.commitment.id}`} style={{ color: 'inherit', fontWeight: 700 }}>{r.commitment.poNumber}</Link> for <Money cents={r.commitment.amountCents} /> to {r.agency?.name}.
            A <code>commitment.issued</code> event goes to the org’s webhooks.</p>
        </div>
      )}
      {r.reallocation && (
        <p className="note">Reallocation: moves <Money cents={r.amountCents} /> of planned from {l.name} to <Link href={`${base}/lines/${r.reallocation.toLine.id}`}>{r.reallocation.toLine.name}</Link> once approved. No PO is issued.</p>
      )}

      <Card id="chain-h" title="Approval chain" aside={<span className="note">Frozen at submit. A later rule change doesn’t alter it.</span>}>
        {r.steps.length === 0 ? <p className="note">No step applied; the request was approved at submit.</p> : (
          <ol className="chain" aria-label="Approval chain">
            {r.steps.map((s) => {
              const now = s === current;
              const dot = s.decision === 'approve' ? 'done' : s.decision === 'reject' ? 'bad' : now ? 'now' : '';
              const pill = s.decision === 'approve' ? <Pill tone="good">Approved</Pill>
                : s.decision === 'reject' ? <Pill tone="bad">Rejected</Pill>
                : now ? (s.blocked ? <Pill tone="bad" glyph="▲">Blocked</Pill> : <Pill tone="hold">Waiting</Pill>)
                : rejectedAt !== undefined && s.index > rejectedAt ? <Pill tone="done">Not reached</Pill>
                : r.state !== 'submitted' ? <Pill tone="done">Not reached</Pill>
                : <Pill tone="info">Not yet</Pill>;
              const holders = s.approverIds.map((u) => (u === r.requestedById ? `${who(u)} (the requester can’t decide)` : who(u)));
              return (
                <li key={s.id} aria-current={now ? 'step' : undefined}>
                  <span aria-hidden="true" className={`dot ${dot}`}>{s.decision === 'approve' ? '✓' : s.decision === 'reject' ? '✕' : s.index + 1}</span>
                  <div className="body">
                    <strong>Step {s.index + 1}: <span className="seat">{s.seat}</span>{s.seat === 'Budget Owner' && <span className="from"> ({l.ownerSeat}, the line’s owner seat)</span>}{' '}
                      <span className="from">· {s.source === 'over-budget' ? 'over budget, note required' : s.thresholdCents === null ? 'always' : `applies from ${formatUsd(s.thresholdCents)}`}{s.source === 'override' && ' (override)'}</span>
                    </strong>
                    <span className="why">
                      {s.decidedById ? `${s.decision === 'approve' ? 'Approved' : 'Rejected'} by ${who(s.decidedById)}, ${when(s.decidedAt!)} UTC` : s.blocked ? 'No one holds this seat, so the step is blocked.' : `${holders.length === 1 ? 'Holder' : 'Holders'}: ${holders.join(', ') || '—'}`}
                      {s.note && <> · “{s.note}”</>}
                    </span>
                  </div>
                  {pill}
                </li>
              );
            })}
          </ol>
        )}
        {skipped.length > 0 && (
          <p className="note">Steps whose threshold is above {formatUsd(r.amountCents)} were skipped: {skipped.map((s) => `${s.seat} (${formatUsd(BigInt(String(s.fromCents)))}+)`).join(', ')}.</p>
        )}
      </Card>

      {current && !mayDecide && (
        <p className="note"><span aria-hidden="true">◆ </span>Step {current.index + 1} is waiting on {current.seat === 'Budget Owner' ? l.ownerSeat : current.seat}: {current.approverIds.map(who).join(', ') || 'no one holds that seat yet'}.</p>
      )}
      {current && mayDecide && (
        <Card id="dec-h" title={`Decide step ${current.index + 1}: ${current.seat}`} className="form-stack">
          <ActionForm action={decideStep.bind(null, ctx.slug)}>
            <input type="hidden" name="requestId" value={r.id} />
            <label style={{ maxWidth: '36rem' }}>Note {current.requiresNote ? '(required)' : '(optional)'}
              <textarea name="note" maxLength={2000} required={current.requiresNote} rows={3} />
            </label>
            <div className="actions">
              <button type="submit" name="decision" value="approve">Approve</button>
              <button type="submit" name="decision" value="reject" className="btn-secondary">Reject</button>
            </div>
          </ActionForm>
        </Card>
      )}
      {r.state === 'submitted' && r.requestedById === ctx.userId && (
        <div className="inline-form">
          <ActionForm action={withdrawRequest.bind(null, ctx.slug)}>
            <input type="hidden" name="requestId" value={r.id} />
            <button type="submit" className="btn-secondary">Withdraw request</button>
          </ActionForm>
        </div>
      )}

      <Card id="aud-h" title="Request audit">
        {events.length === 0 && <p className="note">No audit rows for this request.</p>}
        {events.length > 0 && (
        <TableWrap label="Request audit">
          <table aria-label="Request audit">
            <thead><tr><th scope="col">When (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Details</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id.toString()}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(e.at)}</td>
                  <td>{who(e.actorUserId)}</td>
                  <td><code>{e.action}</code></td>
                  <td>{auditDetails(e.data) || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        )}
      </Card>
    </main>
  );
}
