import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { createCampaign, createFiscalYear, createLine, createProgram } from '@/earmark/actions';
import { earmarkCan } from '@/earmark/core';
import { Card, day, Money, PageHead, Pill } from '@/earmark/ui/kit';

export const metadata = { title: 'Plan' };

// Planning (PRD §4, D-26; design: docs/design/Plan.dc.html): fiscal years with their twelve periods, programs,
// campaigns and lines. Planned is edited on the line page, where the replan marker shows. Owner and admin only.
export default async function PlanPage({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!earmarkCan(ctx.role, 'budget.plan')) notFound();
  const base = `/o/${ctx.slug}`;

  const { years, seats } = await withOrg(ctx, async (tx) => ({
    years: await tx.fiscalYear.findMany({
      where: inOrg(ctx),
      orderBy: { startsOn: 'desc' },
      include: {
        periods: { orderBy: { index: 'asc' } },
        programs: { orderBy: { name: 'asc' }, include: { campaigns: { orderBy: { name: 'asc' }, include: { lines: { orderBy: [{ period: { index: 'asc' } }, { name: 'asc' }], include: { period: { select: { index: true } } } } } } } },
      },
    }),
    seats: await tx.seat.findMany({ where: inOrg(ctx), orderBy: { name: 'asc' }, select: { name: true } }),
  }), { atomic: false });

  const open = years.filter((y) => !y.lockedAt);
  const programs = open.flatMap((y) => y.programs.map((p) => ({ ...p, year: y.label })));
  const campaigns = programs.flatMap((p) => p.campaigns.map((c) => ({ id: c.id, label: `${p.year} / ${p.name} / ${c.name}` })));
  const periods = open.flatMap((y) => y.periods.map((p) => ({ id: p.id, label: `${y.label} P${p.index} (${day(p.startsOn)})` })));

  return (
    <main className="stack">
      <PageHead
        eyebrow="Plan"
        title="Plan"
        lede="Fiscal years, then programs, campaigns and lines. Only lines hold money. Planned is edited on each line’s page, where an edit after the first PO shows as a replan."
      />
      <div className="row">
        <div className="wide stack">
          {years.length === 0 && <Card id="none-h" title="No fiscal year yet"><p className="note">Create one to start planning. Its twelve periods are created with it.</p></Card>}
          {years.map((y) => {
            const lines = y.programs.flatMap((p) => p.campaigns.flatMap((c) => c.lines));
            const planned = lines.reduce((a, l) => a + l.plannedCents, 0n);
            return (
              <Card key={y.id} id={`fy-${y.id}`} title={<>{y.label} <span className="note" style={{ fontWeight: 500 }}>from {day(y.startsOn)} · {y.periods.length} periods</span></>}>
                <p className="pills" style={{ margin: 0 }}>
                  {y.lockedAt ? <Pill tone="done">Locked</Pill> : <Pill tone="good">Open for planning</Pill>}
                  <span className="note">{y.programs.length} program{y.programs.length === 1 ? '' : 's'} · {lines.length} line{lines.length === 1 ? '' : 's'} · <Money cents={planned} /> planned</span>
                </p>
                {y.programs.length === 0 ? <p className="note">No programs yet.</p> : (
                  <ul className="plan-tree" aria-label={`${y.label} plan`}>
                    {y.programs.map((p) => (
                      <li key={p.id} className="lvl1"><div className="node"><span>{p.name}</span></div>
                        {p.campaigns.length > 0 && <ul>
                          {p.campaigns.map((c) => (
                            <li key={c.id} className="lvl2"><div className="node"><span>{c.name}</span></div>
                              {c.lines.length > 0 && <ul>
                                {c.lines.map((l) => (
                                  <li key={l.id}><div className="node"><Link href={`${base}/lines/${l.id}`}>{l.name}</Link>
                                    <span className="meta"><span>P{l.period.index}</span><Money cents={l.plannedCents} /><span>{l.ownerSeat}</span>{l.carryForward && <Pill tone="info">Carry-forward</Pill>}</span></div></li>
                                ))}
                              </ul>}
                            </li>
                          ))}
                        </ul>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
          <p className="note">Rename and delete aren’t in v0.1: a line with requests or POs can’t be removed safely (D-26). A locked year refuses every plan change.</p>
        </div>

        <div className="narrow stack">
          {campaigns.length > 0 && (
            <Card id="new-line-h" title="New line" className="form-stack">
              <ActionForm action={createLine.bind(null, ctx.slug)}>
                <label>Campaign <select name="campaignId" required>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
                <label>Period <select name="periodId" required>{periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
                <label>Line name <input name="name" required maxLength={120} /></label>
                <label>Planned (USD) <input name="planned" inputMode="decimal" required maxLength={32} placeholder="25,000.00" autoComplete="off" /></label>
                <label>Owner seat <select name="ownerSeat" required aria-describedby="seat-hint">{seats.map((s) => <option key={s.name}>{s.name}</option>)}</select></label>
                <span className="note" id="seat-hint">Its holders approve the first step of every request on this line.</span>
                <div className="pair">
                  <label>Cost center <input name="costCenter" maxLength={64} /></label>
                  <label>GL code <input name="glCode" maxLength={64} /></label>
                </div>
                <button type="submit">Create line</button>
              </ActionForm>
            </Card>
          )}
          {programs.length > 0 && (
            <Card id="new-camp-h" title="New campaign" className="form-stack">
              <ActionForm action={createCampaign.bind(null, ctx.slug)}>
                <label>Program <select name="programId" required>{programs.map((p) => <option key={p.id} value={p.id}>{p.year} / {p.name}</option>)}</select></label>
                <label>Campaign name <input name="name" required maxLength={120} /></label>
                <button type="submit" className="btn-secondary">Create campaign</button>
              </ActionForm>
            </Card>
          )}
          {open.length > 0 && (
            <Card id="new-prog-h" title="New program" className="form-stack">
              <ActionForm action={createProgram.bind(null, ctx.slug)}>
                <label>Fiscal year <select name="fiscalYearId" required>{open.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></label>
                <label>Program name <input name="name" required maxLength={120} /></label>
                <button type="submit" className="btn-secondary">Create program</button>
              </ActionForm>
            </Card>
          )}
          <Card id="new-fy-h" title="New fiscal year" className="form-stack">
            <ActionForm action={createFiscalYear.bind(null, ctx.slug)}>
              <label>Label <input name="label" required maxLength={120} placeholder="FY27" /></label>
              <label>Starts on <input name="startsOn" type="date" required aria-describedby="fy-hint" /></label>
              <span className="note" id="fy-hint">The 1st of a month. Its twelve periods are created with it.</span>
              <button type="submit" className={years.length ? 'btn-secondary' : undefined}>Create fiscal year</button>
            </ActionForm>
          </Card>
        </div>
      </div>
    </main>
  );
}
