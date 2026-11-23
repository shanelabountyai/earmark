import Link from 'next/link';
import { redirect } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { alertRules, reaches } from '@/earmark/alerts';
import { earmarkCan, ledgerOf } from '@/earmark/core';
import { orgName } from '@/earmark/ui/org-name';
import { Card, Metrics, Money, PageHead, Pill, TableWrap } from '@/earmark/ui/kit';
import type { Totals } from '@/lib/earmark/rollup';
import { titleFor } from '@/earmark/ui/titles';

export const generateMetadata = titleFor('Dashboard', () => true); // D-79: a non-member gets the 404's title

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pct = (bps: bigint | null) => (bps === null ? null : Number(bps / 100n));

// Demo step 1 (design: docs/design/Main.dc.html): org totals first, then lines at risk (owner call), the aged
// unmatched invoices, and the budget tree (program → campaign → line) for the current fiscal year. Every number
// comes from the rollup engine (PRD §2); lines at risk use the alert thresholds in rules/alerts.json (D-46).
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

  const newRequest = earmarkCan(ctx.role, 'request.create');
  const org = await orgName(ctx.orgId);
  if (!data) {
    return (
      <main className="stack">
        <PageHead eyebrow={`${org} · Dashboard`} title="No budget yet" lede="This org has no fiscal year planned. Budgets, requests and POs start from a plan." />
        {earmarkCan(ctx.role, 'budget.plan')
          ? <p><Link className="btn" href={`${base}/plan`}>Plan a fiscal year</Link></p>
          : <p className="note">An owner or admin plans the fiscal year.</p>}
      </main>
    );
  }
  const { fy, programs, ledger } = data;
  const r = ledger.rollup;
  const lineRow = new Map(r.lines.map((l) => [l.lineId, l]));
  const campRow = new Map(r.campaigns.map((c) => [c.campaignId, c]));
  const progRow = new Map(r.programs.map((p) => [p.programId, p]));
  const lineName = new Map(programs.flatMap((p) => p.campaigns.flatMap((c) => c.lines.map((l) => [l.id, l.name] as const))));
  const aged = [...r.unmatchedInvoices].sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  const rules = alertRules();

  // Lines at risk: over committed first, then actual at the alert threshold, then committed at it.
  const risk = r.lines.flatMap((t) => {
    if (t.plannedCents <= 0n) return [];
    const name = lineName.get(t.lineId) ?? 'Line';
    if (t.overCommitted) return [{ id: t.lineId, name, rank: 0, sort: pct(t.committedBps) ?? 0, pill: <Pill tone="bad">Over committed</Pill> }];
    if (reaches(t.actualCents, t.plannedCents, rules.actualPercent)) return [{ id: t.lineId, name, rank: 1, sort: pct(t.actualBps) ?? 0, pill: <Pill tone="bad" glyph="▲">{pct(t.actualBps)}% actual</Pill> }];
    if (reaches(t.committedCents, t.plannedCents, rules.committedPercent)) return [{ id: t.lineId, name, rank: 2, sort: pct(t.committedBps) ?? 0, pill: <Pill tone="hold">{pct(t.committedBps)}% committed</Pill> }];
    return [];
  }).sort((a, b) => a.rank - b.rank || b.sort - a.sort);

  const start = fy.startsOn.getUTCMonth();
  const span = `${MONTH[start]}–${MONTH[(start + 11) % 12]}`;

  return (
    <main className="stack">
      <PageHead
        eyebrow={`${org} · fiscal year ${span}`}
        title={`${fy.label} budget`}
        lede="Every number here is worked out from requests, POs and invoices when the page loads. Nothing is typed in that could disagree with its rows."
        aside={newRequest ? <Link className="btn" href={`${base}/requests`}>New request</Link> : undefined}
      />

      <Metrics label="Org totals" items={[
        { label: 'Planned', cents: r.org.plannedCents, sub: `${programs.length} program${programs.length === 1 ? '' : 's'} · ${r.org.lineCount} line${r.org.lineCount === 1 ? '' : 's'}` },
        { label: 'Committed', cents: r.org.committedCents, sub: 'POs from approved requests' },
        { label: 'Actual', cents: r.org.actualCents, sub: 'matched invoices approved for payment' },
        { label: 'Available', cents: r.orgAvailableCents, sub: 'planned − committed − unmatched invoices', earmarked: true },
      ]} />

      <div className="row">
        <Card id="risk-h" title={`Lines at risk (${risk.length})`} className="narrow">
          <p className="note">Flagged at {rules.committedPercent}% committed or {rules.actualPercent}% actual. The line’s owner seat gets one alert per period.</p>
          {risk.length === 0 ? <p><Pill tone="good">No line is at risk</Pill></p> : (
            <ul className="ruled" aria-label="Lines at risk">
              {risk.slice(0, 6).map((l) => <li key={l.id}><Link href={`${base}/lines/${l.id}`}><strong>{l.name}</strong></Link>{l.pill}</li>)}
            </ul>
          )}
          {risk.length > 6 && <Link href={`${base}/variance`}>{risk.length - 6} more at risk, in Variance</Link>}
        </Card>

        <Card id="unm-h" title={`Unmatched invoices (${aged.length})`} className="wide">
          <p className="note">Spend with no PO match stays here until someone matches it. It counts against available, never silently against a line. Oldest first; Finance is alerted at {rules.unmatchedDays} days.</p>
          {aged.length === 0 ? <p><Pill tone="good">Every submitted invoice is matched to a PO</Pill></p> : (
            <TableWrap label="Unmatched invoices">
              <table aria-label="Unmatched invoices">
                <thead><tr><th scope="col">Invoice</th><th scope="col">Agency</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Age</th></tr></thead>
                <tbody>
                  {aged.slice(0, 6).map((u) => {
                    const inv = ledger.invoices.get(u.invoiceId)!;
                    const old = (u.ageDays ?? 0) >= rules.unmatchedDays;
                    return (
                      <tr key={u.invoiceId}>
                        <td style={{ whiteSpace: 'nowrap' }}><Link href={`${base}/invoices/${u.invoiceId}`}>{inv.number}</Link></td>
                        <td>{inv.agency.name}</td>
                        <td className="num">{<Money cents={u.amountCents} />}</td>
                        <td className={`num${old ? ' bad-text' : ''}`}>{old && <span aria-hidden="true">✕ </span>}{u.ageDays} days{old && <span className="sr-only"> (past {rules.unmatchedDays})</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
          {aged.length > 0 && <Link href={`${base}/invoices#to-match`}><strong>All {aged.length} unmatched · {aged.map((u) => u.ageDays).sort((a, b) => (a ?? 0) - (b ?? 0)).join(', ')} days old</strong></Link>}
        </Card>
      </div>

      <Card id="tree-h" title="Budget">
        <TableWrap label="Budget">
          <table className="tree" aria-label="Budget">
            <thead><tr><th scope="col">Program / campaign / line</th><th scope="col" className="num">Planned</th><th scope="col" className="num">Committed</th><th scope="col" className="num">Actual</th><th scope="col" className="num">Available</th></tr></thead>
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
                        {(ledger.replan.has(l.id) || t?.overCommitted) && <>{' '}<span className="pills">
                          {ledger.replan.has(l.id) && <Pill tone="hold">Replan</Pill>}
                          {t?.overCommitted && <Pill tone="bad">Over committed</Pill>}
                        </span></>}
                      </>} />
                    );
                  }),
                ]),
              ])}
            </tbody>
          </table>
        </TableWrap>
      </Card>
    </main>
  );
}

// PRD-C C5 (review A3, D-83): the hierarchy is in the words too, not only in indent and bold.
const LEVEL = { 1: 'Program total: ', 2: 'Campaign total: ', 3: 'Line: ' } as const;

function Row({ level, label, t }: { level: 1 | 2 | 3; label: React.ReactNode; t?: Totals }) {
  return (
    <tr data-level={level}>
      <th scope="row"><span className="sr-only">{LEVEL[level]}</span>{label}</th>
      <td className="num"><Money cents={t?.plannedCents ?? 0n} /></td>
      <td className="num"><Money cents={t?.committedCents ?? 0n} /></td>
      <td className="num"><Money cents={t?.actualCents ?? 0n} /></td>
      <td className="num"><Money cents={t?.availableCents ?? 0n} /></td>
    </tr>
  );
}
