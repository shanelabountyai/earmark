import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ledgerOf } from '@/earmark/core';
import { orgName } from '@/earmark/ui/org-name';
import { Card, day, Money, PageHead, Pill, TableWrap, VarianceState } from '@/earmark/ui/kit';
import { variance } from '@/lib/earmark/variance';
import { titleFor } from '@/earmark/ui/titles';

export const generateMetadata = titleFor('Variance'); // D-79: a guest gets the 404's title

const pct = (bps: bigint | null) => (bps === null ? '—' : `${(Number(bps) / 100).toFixed(1)} %`);

// PRD §4 (design: docs/design/Variance.dc.html): actual − planned per line per period, as cents and as a share of
// planned; zero planned with spend shows "unplanned"; a planned edit after the first commitment shows the replan
// marker; each line's latest published note, earmarked.
export default async function VariancePage({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (ctx.role === 'guest') notFound();
  const base = `/o/${ctx.slug}`;

  const { ledger, lines, notes } = await withOrg(ctx, async (tx) => ({
    ledger: await ledgerOf(tx, ctx, {}),
    lines: await tx.budgetLine.findMany({
      where: inOrg(ctx),
      select: { id: true, name: true, plannedEditedAt: true, periodId: true, campaign: { select: { name: true, program: { select: { name: true } } } }, period: { select: { index: true, startsOn: true, fiscalYear: { select: { label: true, startsOn: true } } } } },
      orderBy: [{ period: { fiscalYear: { startsOn: 'desc' } } }, { period: { index: 'asc' } }, { campaign: { program: { name: 'asc' } } }, { campaign: { name: 'asc' } }, { name: 'asc' }],
    }),
    notes: await tx.varianceNote.findMany({ where: { ...inOrg(ctx), published: { not: null } }, orderBy: { publishedAt: 'asc' }, select: { budgetLineId: true, published: true } }),
  }), { atomic: false });

  const totals = new Map(ledger.rollup.lines.map((l) => [l.lineId, l]));
  const note = new Map(notes.map((n) => [n.budgetLineId, n.published!])); // ascending, so the latest wins
  const periods = [...new Map(lines.map((l) => [l.periodId, l.period])).entries()];

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${await orgName(ctx.orgId)} · Variance`}
        title="Variance"
        lede="Actual minus planned, per line and period. Actual is invoices matched to a PO and approved for payment. A line with nothing planned but money spent shows as unplanned, never as a percentage."
      />
      <p className="pills" aria-label="Legend" role="group">
        <Pill tone="bad" glyph="▲">Over</Pill><Pill tone="info" glyph="▼">Under</Pill><Pill tone="good">On plan</Pill><Pill tone="hold">Unplanned</Pill><Pill tone="hold">Replan</Pill>
        <span className="note">Replan: planned was edited after the first PO.</span>
      </p>
      {periods.length === 0 && <p className="note">No budget lines yet.</p>}
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
          <Card key={periodId} id={`p-${periodId}`} title={<>{label} <span className="note" style={{ fontWeight: 500 }}>from {day(p.startsOn)}</span></>}>
            <TableWrap label={`Variance ${label}`}>
              <table aria-label={`Variance ${label}`}>
                <thead><tr><th scope="col">Line</th><th scope="col" className="num">Planned</th><th scope="col" className="num">Actual</th><th scope="col" className="num">Variance</th><th scope="col" className="num">%</th><th scope="col">Status</th><th scope="col">Published note</th></tr></thead>
                <tbody>
                  {report.rows.map((r) => {
                    const l = name.get(r.lineId)!;
                    return (
                      <tr key={r.lineId}>
                        <th scope="row" style={{ fontWeight: 400 }}><Link href={`${base}/lines/${l.id}`}>{l.campaign.program.name} / {l.campaign.name} / {l.name}</Link>{r.replan && <> <Pill tone="hold">Replan</Pill></>}</th>
                        <td className="num"><Money cents={r.plannedCents} /></td>
                        <td className="num"><Money cents={r.actualCents} /></td>
                        <td className="num"><Money cents={r.varianceCents} /></td>
                        <td className="num">{pct(r.varianceBps)}</td>
                        <td><VarianceState status={r.status} /></td>
                        <td>{note.has(r.lineId) ? <span className="note-chip">{note.get(r.lineId)}</span> : <span className="muted">No note</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr><th scope="row">Total</th><td className="num"><Money cents={report.totals.plannedCents} /></td><td className="num"><Money cents={report.totals.actualCents} /></td><td className="num"><Money cents={report.totals.varianceCents} /></td><td className="num">{pct(report.totals.varianceBps)}</td><td colSpan={2}>{report.totals.overLines} over · {report.totals.unplannedLines} unplanned</td></tr>
                </tfoot>
              </table>
            </TableWrap>
            <p className="note">Variance = actual − planned. The % is of planned. Notes are written on the line page; the newest published one shows here.</p>
          </Card>
        );
      })}
    </main>
  );
}
