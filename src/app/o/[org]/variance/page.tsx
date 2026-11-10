import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ledgerOf } from '@/earmark/core';
import { formatUsd } from '@/lib/earmark/money';
import { variance } from '@/lib/earmark/variance';

export const metadata = { title: 'Variance' };

const pct = (bps: bigint | null) => (bps === null ? '—' : `${(Number(bps) / 100).toFixed(1)} %`);

// PRD §4: actual − planned per line per period, as cents and as a share of planned; zero planned with spend shows
// "unplanned"; a planned edit after the first commitment shows the replan marker; each line's latest published note.
export default async function VariancePage({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  const base = `/o/${ctx.slug}`;

  const { ledger, lines, notes } = await withOrg(ctx, async (tx) => ({
    ledger: await ledgerOf(tx, ctx, {}),
    lines: await tx.budgetLine.findMany({
      where: inOrg(ctx),
      select: { id: true, name: true, plannedEditedAt: true, periodId: true, campaign: { select: { name: true, program: { select: { name: true } } } }, period: { select: { index: true, fiscalYear: { select: { label: true, startsOn: true } } } } },
      orderBy: [{ period: { fiscalYear: { startsOn: 'desc' } } }, { period: { index: 'asc' } }],
    }),
    notes: await tx.varianceNote.findMany({ where: { ...inOrg(ctx), published: { not: null } }, orderBy: { publishedAt: 'asc' }, select: { budgetLineId: true, published: true } }),
  }), { atomic: false });

  const totals = new Map(ledger.rollup.lines.map((l) => [l.lineId, l]));
  const note = new Map(notes.map((n) => [n.budgetLineId, n.published!])); // ascending, so the latest wins
  const periods = [...new Map(lines.map((l) => [l.periodId, l.period])).entries()];

  return (
    <main>
      <h1>Variance</h1>
      {periods.length === 0 && <p>No budget lines yet.</p>}
      {periods.map(([periodId, p]) => {
        const mine = lines.filter((l) => l.periodId === periodId);
        const report = variance({
          periodId,
          lines: mine.map((l) => ({
            lineId: l.id,
            plannedCents: totals.get(l.id)!.plannedCents,
            actualCents: totals.get(l.id)!.actualCents,
            plannedEditedAt: l.plannedEditedAt ? [l.plannedEditedAt.toISOString()] : null,
            firstCommittedAt: ledger.firstCommitted.get(l.id)?.toISOString() ?? null,
          })),
        });
        const name = new Map(mine.map((l) => [l.id, l]));
        const label = `${p.fiscalYear.label}, period ${p.index}`;
        return (
          <section key={periodId}>
            <h2>{label}</h2>
            <table aria-label={`Variance ${label}`}>
              <thead><tr><th>Line</th><th>Planned</th><th>Actual</th><th>Variance</th><th>%</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>
                {report.rows.map((r) => {
                  const l = name.get(r.lineId)!;
                  return (
                    <tr key={r.lineId}>
                      <td><Link href={`${base}/lines/${l.id}`}>{l.campaign.program.name} / {l.campaign.name} / {l.name}</Link>{r.replan && <> <mark>Replan</mark></>}</td>
                      <td>{formatUsd(r.plannedCents)}</td>
                      <td>{formatUsd(r.actualCents)}</td>
                      <td>{formatUsd(r.varianceCents)}</td>
                      <td>{pct(r.varianceBps)}</td>
                      <td>{r.status}</td>
                      <td>{note.get(r.lineId) ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th><td>{formatUsd(report.totals.plannedCents)}</td><td>{formatUsd(report.totals.actualCents)}</td><td>{formatUsd(report.totals.varianceCents)}</td><td>{pct(report.totals.varianceBps)}</td><td>{report.totals.overLines} over · {report.totals.unplannedLines} unplanned</td><td /></tr>
              </tfoot>
            </table>
          </section>
        );
      })}
    </main>
  );
}
