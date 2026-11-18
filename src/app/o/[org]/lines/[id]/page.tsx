import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { explainVariance, publishVarianceNote, setPlanned, submitReallocation } from '@/earmark/actions';
import { earmarkCan, ledgerOf } from '@/earmark/core';
import { Card, day, InvoiceState, Metrics, Money, PageHead, Pill, PoState, RequestState, TableWrap, VarianceState } from '@/earmark/ui/kit';
import { formatUsd } from '@/lib/earmark/money';
import { variance } from '@/lib/earmark/variance';

export const metadata = { title: 'Budget line' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Demo steps 2 and 10 (design: docs/design/Line.dc.html): one line's numbers, its history with the replan marker
// (planned edited after the first commitment, PRD §4), the variance note (AI draft, a person publishes), and its
// requests, POs and invoice matches.
export default async function LinePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (ctx.role === 'guest' || !UUID.test(id)) notFound(); // PRD §1: a guest sees no budget line, same 404 as a missing one
  const base = `/o/${ctx.slug}`;

  const { line, siblings, ledger } = await withOrg(ctx, async (tx) => {
    const line = await tx.budgetLine.findFirst({
      where: { id, ...inOrg(ctx) },
      include: {
        campaign: { select: { name: true, program: { select: { name: true } } } },
        period: { select: { index: true, startsOn: true, fiscalYearId: true, fiscalYear: { select: { label: true, lockedAt: true } } } },
        requests: {
          orderBy: { submittedAt: 'asc' },
          include: {
            agency: { select: { name: true } },
            commitment: { include: { agency: { select: { name: true } }, matches: { orderBy: { matchedAt: 'asc' }, include: { invoice: { select: { id: true, number: true, state: true, approvedForPaymentAt: true } } } } } },
          },
        },
        notes: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!line) notFound();
    const siblings = await tx.budgetLine.findMany({
      where: { ...inOrg(ctx), id: { not: id }, carryForward: false, period: { fiscalYearId: line.period.fiscalYearId } },
      orderBy: [{ period: { index: 'asc' } }, { name: 'asc' }],
      select: { id: true, name: true, period: { select: { index: true } }, campaign: { select: { name: true } } },
    });
    return { line, siblings, ledger: await ledgerOf(tx, ctx, { id }) };
  }, { atomic: false });

  const t = ledger.rollup.lines[0]!;
  const replan = ledger.replan.has(line.id);
  const v = variance({ periodId: line.periodId, lines: [{ lineId: line.id, plannedCents: t.plannedCents, actualCents: t.actualCents }] }).rows[0]!;
  const published = line.notes.find((n) => n.published);
  const draft = line.notes.find((n) => !n.published && (!published || n.createdAt > published.createdAt));
  const pos = line.requests.flatMap((r) => (r.commitment ? [r.commitment] : []));
  const canNote = earmarkCan(ctx.role, 'variance.draft');

  type Event = { at: Date; text: string; replan?: boolean };
  const history: Event[] = [
    ...line.requests.flatMap((r): Event[] => [
      { at: r.submittedAt, text: `Request for ${formatUsd(r.amountCents)} submitted: ${r.description}${r.overBudget ? ' (over budget)' : ''}` },
      ...(r.decidedAt && r.state !== 'submitted' ? [{ at: r.decidedAt, text: `Request for ${formatUsd(r.amountCents)} ${r.state}` }] : []),
    ]),
    ...pos.flatMap((c): Event[] => [
      { at: c.issuedAt, text: `${c.poNumber} issued to ${c.agency.name} for ${formatUsd(c.amountCents)}` },
      ...c.matches.flatMap((m): Event[] => [
        { at: m.matchedAt, text: `Invoice ${m.invoice.number} matched to ${c.poNumber}: ${formatUsd(m.amountCents)}${m.overage ? ' (overage)' : ''}` },
        ...(m.invoice.approvedForPaymentAt ? [{ at: m.invoice.approvedForPaymentAt, text: `Invoice ${m.invoice.number} approved for payment` }] : []),
      ]),
      ...(c.closedAt ? [{ at: c.closedAt, text: `${c.poNumber} closed${c.closeReason ? `: ${c.closeReason}` : ''}` }] : []),
    ]),
    ...(line.plannedEditedAt ? [{ at: line.plannedEditedAt, text: `Planned edited to ${formatUsd(line.plannedCents)}${replan ? ', after the first PO' : ''}`, replan }] : []),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <main className="stack">
      <PageHead
        eyebrow={<><Link href={base}>Budget</Link> · {line.campaign.program.name} / {line.campaign.name} · owner seat {line.ownerSeat}{line.glCode && <> · GL {line.glCode}</>}</>}
        title={<>{line.name}{replan && <> <Pill tone="hold" big>Replan</Pill></>}</>}
        lede={<>{line.period.fiscalYear.label}, period {line.period.index} (from {day(line.period.startsOn)}) · cost center {line.costCenter || '—'}{replan && <>. The plan was edited after money was committed against it. Flagged, not hidden.</>}</>}
        aside={earmarkCan(ctx.role, 'request.create') && !line.carryForward ? <Link className="btn" href={`${base}/requests?line=${line.id}`}>New request on this line</Link> : undefined}
      />

      <Metrics label="Line totals" items={[
        { label: 'Planned', cents: t.plannedCents },
        { label: 'Committed', cents: t.committedCents, sub: t.overCommitted ? <Pill tone="bad">Over committed</Pill> : undefined },
        { label: 'Actual', cents: t.actualCents, sub: <>Variance <span className="money">{formatUsd(v.varianceCents)}</span> <VarianceState status={v.status} /></> },
        { label: 'Available', cents: t.availableCents, sub: t.unmatchedProvisionCents > 0n ? <>after <span className="money">{formatUsd(t.unmatchedProvisionCents)}</span> in unmatched invoices</> : undefined, earmarked: true },
      ]} />

      <div className="row">
        <Card id="hist-h" title="Line history">
          {history.length === 0 ? <p className="note">Nothing has happened on this line yet.</p> : (
            <ol reversed aria-label="Line history" className="ruled history">
              {history.map((e, i) => (
                <li key={i} className={e.replan ? 'replan' : undefined}><time dateTime={e.at.toISOString()}>{day(e.at)}</time><span>{e.replan ? <><strong><span aria-hidden="true">◆ </span>Replan:</strong> {e.text}</> : e.text}</span></li>
              ))}
            </ol>
          )}
        </Card>

        <Card id="var-h" title="Variance note" aside={canNote ? (
          <div className="inline-form">
            <ActionForm action={explainVariance.bind(null, ctx.slug)}>
              <input type="hidden" name="budgetLineId" value={line.id} />
              <button type="submit" className="btn-secondary">Draft with AI</button>
            </ActionForm>
          </div>
        ) : undefined}>
          {published ? (
            <blockquote aria-label="Published note" className="published">
              <Pill tone="good">Published note</Pill>
              <p>{published.published}</p>
            </blockquote>
          ) : <p className="note">No note published. Readers of the variance view see the published one.</p>}
          {canNote && (
            <div className={`draft form-stack`}>
              {draft ? <Pill tone="info">Draft · AI, not published</Pill> : <span className="note">Write the note by hand, or draft one with AI first. Drafting counts against the org’s AI spending limit.</span>}
              <ActionForm action={publishVarianceNote.bind(null, ctx.slug)}>
                <input type="hidden" name="budgetLineId" value={line.id} />
                <label>Note {draft ? '(the latest draft; edit before publishing)' : 'to publish'}
                  {/* keyed by the draft, so a new draft replaces the text instead of the form keeping the old value */}
                  <textarea key={draft?.id ?? 'none'} name="text" rows={4} required maxLength={4000} defaultValue={draft?.draft ?? published?.published ?? ''} />
                </label>
                <button type="submit">Publish note</button>
              </ActionForm>
            </div>
          )}
        </Card>
      </div>

      {earmarkCan(ctx.role, 'budget.plan') && !line.period.fiscalYear.lockedAt && (
        <Card id="plan-h" title="Planned">
          <div className="inline-form">
            <ActionForm action={setPlanned.bind(null, ctx.slug)}>
              <input type="hidden" name="budgetLineId" value={line.id} />
              <label>Planned (USD) <input name="planned" inputMode="decimal" required maxLength={32} defaultValue={formatUsd(line.plannedCents)} autoComplete="off" /></label>
              <button type="submit">Save planned</button>
            </ActionForm>
          </div>
          {pos.length > 0 && <p className="note">A PO exists, so an edit here shows as a replan.</p>}
        </Card>
      )}

      {earmarkCan(ctx.role, 'request.create') && siblings.length > 0 && t.availableCents > 0n && (
        <details className="card">
          <summary>Move planned to another line</summary>
          <div className="form-stack">
            <ActionForm action={submitReallocation.bind(null, ctx.slug)}>
              <input type="hidden" name="fromLineId" value={line.id} />
              <label>To line <select name="toLineId" required>{siblings.map((s) => <option key={s.id} value={s.id}>P{s.period.index} · {s.campaign.name} / {s.name}</option>)}</select></label>
              <label>Amount (USD) <input name="amount" inputMode="decimal" required maxLength={32} autoComplete="off" /></label>
              <label>Why <input name="description" required maxLength={2000} /></label>
              <button type="submit">Submit reallocation</button>
              <p className="note">Routes through the reallocation chain. Up to <Money cents={t.availableCents} /> available; never across fiscal years.</p>
            </ActionForm>
          </div>
        </details>
      )}

      <Card id="req-h" title={`Requests (${line.requests.length})`}>
        {line.requests.length === 0 ? <p className="note">None yet.</p> : (
          <TableWrap label="Requests">
            <table aria-label="Requests">
              <thead><tr><th scope="col">Submitted</th><th scope="col">Request</th><th scope="col">Agency</th><th scope="col" className="num">Amount</th><th scope="col">State</th></tr></thead>
              <tbody>
                {line.requests.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{day(r.submittedAt)}</td>
                    <td><Link href={`${base}/requests/${r.id}`}>{r.description}</Link>{r.overBudget && <> <Pill tone="bad" glyph="▲">Over budget</Pill></>}</td>
                    <td>{r.agency?.name ?? <span className="muted">—</span>}</td>
                    <td className="num"><Money cents={r.amountCents} /></td>
                    <td><RequestState state={r.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <div className="stack">
        <Card id="po-h" title={`Purchase orders (${pos.length})`}>
          {pos.length === 0 ? <p className="note">None yet.</p> : (
            <TableWrap label="Purchase orders on this line">
              <table aria-label="Purchase orders on this line">
                <thead><tr><th scope="col">PO</th><th scope="col">Agency</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Left</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {pos.map((c) => (
                    <tr key={c.id}>
                      <td className="nowrap"><Link href={`${base}/commitments/${c.id}`}>{c.poNumber}</Link></td>
                      <td>{c.agency.name}</td>
                      <td className="num"><Money cents={c.amountCents} /></td>
                      <td className="num"><Money cents={c.remainingCents} /></td>
                      <td><PoState closed={!!c.closedAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
        <Card id="match-h" title="Invoice matches">
          {pos.every((c) => c.matches.length === 0) ? <p className="note">None yet.</p> : (
            <TableWrap label="Invoice matches">
              <table aria-label="Invoice matches">
                <thead><tr><th scope="col">Invoice</th><th scope="col">PO</th><th scope="col" className="num">Amount</th><th scope="col">Invoice</th></tr></thead>
                <tbody>
                  {pos.flatMap((c) => c.matches.map((m) => (
                    <tr key={m.id}>
                      <td className="nowrap"><Link href={`${base}/invoices/${m.invoice.id}`}>{m.invoice.number}</Link>{m.overage && <> <Pill tone="bad">Overage</Pill></>}</td>
                      <td className="nowrap">{c.poNumber}</td>
                      <td className="num"><Money cents={m.amountCents} /></td>
                      <td><InvoiceState state={m.invoice.state} /></td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </main>
  );
}
