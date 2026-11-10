import Link from 'next/link';
import { notFound } from 'next/navigation';
import { inOrg, requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { ActionForm } from '@/core/ui/action-form';
import { createCampaign, createFiscalYear, createLine, createProgram } from '@/earmark/actions';
import { earmarkCan } from '@/earmark/core';
import { formatUsd } from '@/lib/earmark/money';

export const metadata = { title: 'Plan' };

const day = (d: Date) => d.toISOString().slice(0, 10);

// Planning (PRD §4, D-26): fiscal years with their twelve periods, programs, campaigns and lines. Planned is edited
// on the line page, where the replan marker shows. Owner and admin only.
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

  const programs = years.flatMap((y) => y.programs.map((p) => ({ ...p, year: y.label })));
  const campaigns = programs.flatMap((p) => p.campaigns.map((c) => ({ id: c.id, label: `${p.year} / ${p.name} / ${c.name}` })));
  const periods = years.flatMap((y) => y.periods.map((p) => ({ id: p.id, label: `${y.label} P${p.index} (${day(p.startsOn)})` })));

  return (
    <main>
      <h1>Plan</h1>

      <h2>New fiscal year</h2>
      <ActionForm action={createFiscalYear.bind(null, ctx.slug)}>
        <label>Label <input name="label" required maxLength={120} placeholder="FY27" /></label>{' '}
        <label>Starts on <input name="startsOn" type="date" required /></label>{' '}
        <button type="submit">Create fiscal year</button>
      </ActionForm>

      {years.length > 0 && <>
        <h2>New program</h2>
        <ActionForm action={createProgram.bind(null, ctx.slug)}>
          <label>Fiscal year <select name="fiscalYearId" required>{years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></label>{' '}
          <label>Program name <input name="name" required maxLength={120} /></label>{' '}
          <button type="submit">Create program</button>
        </ActionForm>
      </>}

      {programs.length > 0 && <>
        <h2>New campaign</h2>
        <ActionForm action={createCampaign.bind(null, ctx.slug)}>
          <label>Program <select name="programId" required>{programs.map((p) => <option key={p.id} value={p.id}>{p.year} / {p.name}</option>)}</select></label>{' '}
          <label>Campaign name <input name="name" required maxLength={120} /></label>{' '}
          <button type="submit">Create campaign</button>
        </ActionForm>
      </>}

      {campaigns.length > 0 && <>
        <h2>New line</h2>
        <ActionForm action={createLine.bind(null, ctx.slug)}>
          <label>Campaign <select name="campaignId" required>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>{' '}
          <label>Period <select name="periodId" required>{periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>{' '}
          <label>Line name <input name="name" required maxLength={120} /></label>{' '}
          <label>Planned (USD) <input name="planned" inputMode="decimal" required maxLength={32} /></label>{' '}
          <label>Owner seat <select name="ownerSeat" required>{seats.map((s) => <option key={s.name}>{s.name}</option>)}</select></label>{' '}
          <label>Cost center <input name="costCenter" maxLength={64} /></label>{' '}
          <label>GL code <input name="glCode" maxLength={64} /></label>{' '}
          <button type="submit">Create line</button>
        </ActionForm>
      </>}

      {years.map((y) => (
        <section key={y.id}>
          <h2>{y.label} <small>from {day(y.startsOn)}{y.lockedAt && ' · locked'}</small></h2>
          <ul>
            {y.programs.map((p) => (
              <li key={p.id}>{p.name}
                <ul>
                  {p.campaigns.map((c) => (
                    <li key={c.id}>{c.name}
                      <ul>
                        {c.lines.map((l) => <li key={l.id}><Link href={`${base}/lines/${l.id}`}>{l.name}</Link> · P{l.period.index} · {formatUsd(l.plannedCents)} · {l.ownerSeat}</li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
