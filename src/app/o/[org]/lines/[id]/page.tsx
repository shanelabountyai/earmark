import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { earmarkCan, ledgerOf } from '@/earmark/core';
import { formatUsd } from '@/lib/earmark/money';
import { variance } from '@/lib/earmark/variance';

export const metadata = { title: 'Budget line' };

const day = (d: Date) => d.toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Demo step 2: one line's numbers, its requests, POs and invoice matches, and its history with the replan marker
// (planned edited after the first commitment, PRD §4).
export default async function LinePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  if (ctx.role === 'guest' || !UUID.test(id)) notFound(); // PRD §1: a guest sees no budget line, same 404 as a missing one

  const { line, ledger } = await withOrg(ctx, async (tx) => {
    const line = await tx.budgetLine.findFirst({
      where: { id, ...inOrg(ctx) },
      include: {
        campaign: { select: { name: true, program: { select: { name: true } } } },
        period: { select: { index: true, startsOn: true, fiscalYear: { select: { label: true } } } },
        requests: {
          orderBy: { submittedAt: 'asc' },
          include: {
            agency: { select: { name: true } },
            commitment: { include: { agency: { select: { name: true } }, matches: { orderBy: { matchedAt: 'asc' }, include: { invoice: { select: { number: true, state: true, approvedForPaymentAt: true } } } } } },
          },
        },
      },
    });
    if (!line) notFound();
    return { line, ledger: await ledgerOf(tx, ctx, { id }) };
  }, { atomic: false });

  const t = ledger.rollup.lines[0]!;
  const replan = ledger.replan.has(line.id);
  const v = variance({ periodId: line.periodId, lines: [{ lineId: line.id, plannedCents: t.plannedCents, actualCents: t.actualCents }] }).rows[0]!;
  const pos = line.requests.flatMap((r) => (r.commitment ? [r.commitment] : []));

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
    ...(line.plannedEditedAt ? [{ at: line.plannedEditedAt, text: `Planned edited to ${formatUsd(line.plannedCents)}`, replan }] : []),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <main>
      <p><Link href={`/o/${ctx.slug}`}>Budget</Link> / {line.campaign.program.name} / {line.campaign.name}</p>
      <h1>{line.name} {replan && <mark>Replan</mark>}</h1>
      <p>{line.period.fiscalYear.label}, period {line.period.index} (from {day(line.period.startsOn)}) · Owner: {line.ownerSeat} · Cost center: {line.costCenter || '—'} · GL: {line.glCode || '—'}</p>

      <dl aria-label="Line totals">
        <dt>Planned</dt><dd>{formatUsd(t.plannedCents)}</dd>
        <dt>Committed</dt><dd>{formatUsd(t.committedCents)}</dd>
        <dt>Actual</dt><dd>{formatUsd(t.actualCents)}</dd>
        <dt>Unmatched invoices</dt><dd>{formatUsd(t.unmatchedProvisionCents)}</dd>
        <dt>Available</dt><dd>{formatUsd(t.availableCents)}{t.overCommitted && <> <mark>Over committed</mark></>}</dd>
        <dt>Variance</dt><dd>{formatUsd(v.varianceCents)} ({v.status})</dd>
      </dl>

      <h2>Requests ({line.requests.length})</h2>
      {earmarkCan(ctx.role, 'request.create') && !line.carryForward && <p><Link href={`/o/${ctx.slug}/requests?line=${line.id}`}>New request on this line</Link></p>}
      <table>
        <thead><tr><th>Submitted</th><th>Description</th><th>Agency</th><th>Amount</th><th>State</th></tr></thead>
        <tbody>
          {line.requests.map((r) => (
            <tr key={r.id}>
              <td>{day(r.submittedAt)}</td>
              <td><Link href={`/o/${ctx.slug}/requests/${r.id}`}>{r.description}</Link>{r.overBudget && <> <mark>Over budget</mark></>}</td>
              <td>{r.agency?.name ?? '—'}</td>
              <td>{formatUsd(r.amountCents)}</td>
              <td>{r.state}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Purchase orders ({pos.length})</h2>
      <table>
        <thead><tr><th>PO</th><th>Agency</th><th>Amount</th><th>Remaining</th><th>Issued</th><th>Status</th></tr></thead>
        <tbody>
          {pos.map((c) => (
            <tr key={c.id}>
              <td>{c.poNumber}</td>
              <td>{c.agency.name}</td>
              <td>{formatUsd(c.amountCents)}</td>
              <td>{formatUsd(c.remainingCents)}</td>
              <td>{day(c.issuedAt)}</td>
              <td>{c.closedAt ? `closed ${day(c.closedAt)}` : 'open'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Invoice matches</h2>
      <table>
        <thead><tr><th>Invoice</th><th>PO</th><th>Amount</th><th>Match</th><th>Invoice state</th><th>Matched</th></tr></thead>
        <tbody>
          {pos.flatMap((c) => c.matches.map((m) => (
            <tr key={m.id}>
              <td>{m.invoice.number}</td>
              <td>{c.poNumber}</td>
              <td>{formatUsd(m.amountCents)}</td>
              <td>{m.variance}{m.overage && <> <mark>Overage</mark></>}</td>
              <td>{m.invoice.state}</td>
              <td>{day(m.matchedAt)}</td>
            </tr>
          )))}
        </tbody>
      </table>

      <h2>History</h2>
      <ol reversed aria-label="Line history">
        {history.map((e, i) => (
          <li key={i}><time dateTime={e.at.toISOString()}>{day(e.at)}</time> {e.text}{e.replan && <> <mark>Replan</mark></>}</li>
        ))}
      </ol>
    </main>
  );
}
