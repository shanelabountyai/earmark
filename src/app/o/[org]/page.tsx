import Link from 'next/link';
import { redirect } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ledgerOf } from '@/earmark/core';
import { formatUsd } from '@/lib/earmark/money';
import type { Totals } from '@/lib/earmark/rollup';

export const metadata = { title: 'Budget' };

// Demo step 1: the org's planned, committed, actual and available, the aged unmatched invoices, and the budget tree
// (program → campaign → line) for the current fiscal year. Every number comes from the rollup engine (PRD §2).
export default async function OrgHome({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const base = `/o/${ctx.slug}`;
  if (ctx.role === 'guest') redirect(`${base}/commitments`); // PRD §1: a guest sees no budget, only their POs

  const data = await withOrg(ctx, async (tx) => {
    const fy = await tx.fiscalYear.findFirst({ where: inOrg(ctx), orderBy: { startsOn: 'desc' } });
    if (!fy) return null;
    const programs = await tx.program.findMany({
      where: { ...inOrg(ctx), fiscalYearId: fy.id },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, campaigns: { orderBy: { name: 'asc' }, select: { id: true, name: true, lines: { orderBy: [{ period: { index: 'asc' } }, { name: 'asc' }], select: { id: true, name: true } } } } },
    });
    return { fy, programs, ledger: await ledgerOf(tx, ctx, { campaign: { program: { fiscalYearId: fy.id } } }, { orgWide: true }) };
  }, { atomic: false });

  if (!data) return <main><h1>No budget yet</h1><p>This org has no fiscal year planned.</p></main>;
  const { fy, programs, ledger } = data;
  const r = ledger.rollup;
  const lineRow = new Map(r.lines.map((l) => [l.lineId, l]));
  const campRow = new Map(r.campaigns.map((c) => [c.campaignId, c]));
  const progRow = new Map(r.programs.map((p) => [p.programId, p]));
  const lineName = new Map(programs.flatMap((p) => p.campaigns.flatMap((c) => c.lines.map((l) => [l.id, l.name] as const))));
  const aged = [...r.unmatchedInvoices].sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return (
    <main>
      <h1>{fy.label} budget</h1>
      <dl aria-label="Org totals">
        <dt>Planned</dt><dd>{formatUsd(r.org.plannedCents)}</dd>
        <dt>Committed</dt><dd>{formatUsd(r.org.committedCents)}</dd>
        <dt>Actual</dt><dd>{formatUsd(r.org.actualCents)}</dd>
        <dt>Available</dt><dd>{formatUsd(r.orgAvailableCents)}</dd>
      </dl>

      <h2>Unmatched invoices ({aged.length})</h2>
      {aged.length === 0 ? <p>None. Every submitted invoice is matched to a PO.</p> : (
        <table>
          <thead><tr><th>Invoice</th><th>Agency</th><th>PO</th><th>Line</th><th>Amount</th><th>Age</th></tr></thead>
          <tbody>
            {aged.map((u) => {
              const inv = ledger.invoices.get(u.invoiceId)!;
              return (
                <tr key={u.invoiceId}>
                  <td>{inv.number}</td>
                  <td>{inv.agency.name}</td>
                  <td>{inv.poNumber ?? '—'}</td>
                  <td>{u.lineId ? <Link href={`${base}/lines/${u.lineId}`}>{lineName.get(u.lineId)}</Link> : 'No line'}</td>
                  <td>{formatUsd(u.amountCents)}</td>
                  <td>{u.ageDays} days</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Budget</h2>
      <table>
        <thead><tr><th>Program / campaign / line</th><th>Planned</th><th>Committed</th><th>Actual</th><th>Available</th></tr></thead>
        <tbody>
          {programs.map((p) => [
            <Row key={p.id} level={1} label={p.name} t={progRow.get(p.id)} />,
            ...p.campaigns.map((c) => [
              <Row key={c.id} level={2} label={c.name} t={campRow.get(c.id)} />,
              ...c.lines.map((l) => {
                const t = lineRow.get(l.id);
                return (
                  <Row key={l.id} level={3} t={t} label={<>
                    <Link href={`${base}/lines/${l.id}`}>{l.name}</Link>
                    {ledger.replan.has(l.id) && <> <mark>Replan</mark></>}
                    {t?.overCommitted && <> <mark>Over committed</mark></>}
                  </>} />
                );
              }),
            ]),
          ])}
        </tbody>
      </table>
    </main>
  );
}

function Row({ level, label, t }: { level: 1 | 2 | 3; label: React.ReactNode; t?: Totals }) {
  const Cell = level === 3 ? 'td' : 'th';
  return (
    <tr data-level={level}>
      <Cell scope="row" style={{ paddingLeft: `${(level - 1) * 1.5}em`, textAlign: 'left' }}>{label}</Cell>
      <td>{formatUsd(t?.plannedCents ?? 0n)}</td>
      <td>{formatUsd(t?.committedCents ?? 0n)}</td>
      <td>{formatUsd(t?.actualCents ?? 0n)}</td>
      <td>{formatUsd(t?.availableCents ?? 0n)}</td>
    </tr>
  );
}
