// The alerts cron (PRD §4, D-30). Thresholds are data in rules/alerts.json. For each org: a line whose committed
// reaches 80 % of planned, or actual 100 %; an invoice unmatched for 14 days; an agency whose unmatched invoices
// exceed what its open POs have left. Each alert emails the active holders of the line's owner seat (Finance for the
// org-level ones), or the org's owners when that seat has nobody (PRD §10.6), once per period: an `alert.sent` audit
// row keyed by alert, subject and period is both the record and the dedupe.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { audit } from '@/core/audit';
import { now } from '@/core/clock';
import { asSystem, type Tx, withOrg } from '@/core/db/rls';
import { sendEmail } from '@/core/email/transport';
import { FINANCE_SEAT } from '@/lib/earmark/match';
import { formatUsd } from '@/lib/earmark/money';
import { ledgerOf } from './core';

type AlertRules = { committedPercent: number; actualPercent: number; unmatchedDays: number; agencyInvoicesOverOpenCommitments: boolean };
const RULES = () => JSON.parse(readFileSync(path.join(process.cwd(), 'rules/alerts.json'), 'utf8')) as AlertRules;

export type Alert = { key: string; seat: string; subject: string; body: string };

/** Every alert due in one org right now, before dedupe. */
async function alertsIn(tx: Tx, orgId: string, rules: AlertRules): Promise<Alert[]> {
  const ctx = { orgId };
  const month = now().toISOString().slice(0, 7);
  const { rollup, invoices } = await ledgerOf(tx, ctx, {}, { orgWide: true });
  const lines = new Map((await tx.budgetLine.findMany({ where: ctx, select: { id: true, name: true, ownerSeat: true } })).map((l) => [l.id, l]));
  const out: Alert[] = [];
  for (const t of rollup.lines) {
    const l = lines.get(t.lineId)!;
    if (t.plannedCents <= 0n) continue;
    const at = (cents: bigint, pct: number) => cents * 100n >= t.plannedCents * BigInt(pct);
    if (at(t.committedCents, rules.committedPercent))
      out.push({ key: `committed:${l.id}:${t.periodId}`, seat: l.ownerSeat, subject: `${l.name}: ${rules.committedPercent} % committed`, body: `${l.name} has ${formatUsd(t.committedCents)} committed of ${formatUsd(t.plannedCents)} planned.` });
    if (at(t.actualCents, rules.actualPercent))
      out.push({ key: `actual:${l.id}:${t.periodId}`, seat: l.ownerSeat, subject: `${l.name}: actual reached ${rules.actualPercent} % of planned`, body: `${l.name} has ${formatUsd(t.actualCents)} actual of ${formatUsd(t.plannedCents)} planned.` });
  }
  for (const u of rollup.unmatchedInvoices) {
    if ((u.ageDays ?? 0) < rules.unmatchedDays) continue;
    const inv = invoices.get(u.invoiceId)!;
    const line = u.lineId ? lines.get(u.lineId) : null;
    out.push({ key: `unmatched:${u.invoiceId}:${month}`, seat: line?.ownerSeat ?? FINANCE_SEAT, subject: `Invoice ${inv.number} unmatched for ${u.ageDays} days`, body: `${inv.agency.name} invoice ${inv.number} for ${formatUsd(u.amountCents)} has waited ${u.ageDays} days for a match.` });
  }
  if (rules.agencyInvoicesOverOpenCommitments) {
    const agencies = await tx.agency.findMany({
      where: { ...ctx, offboardedAt: null },
      select: { id: true, name: true, commitments: { where: { closedAt: null }, select: { remainingCents: true } }, invoices: { where: { state: 'submitted' }, select: { amountCents: true, matches: { select: { amountCents: true } } } } },
    });
    for (const a of agencies) {
      const open = a.commitments.reduce((s, c) => s + c.remainingCents, 0n);
      const owed = a.invoices.reduce((s, i) => s + i.amountCents - i.matches.reduce((m, x) => m + x.amountCents, 0n), 0n);
      if (owed > open)
        out.push({ key: `agency:${a.id}:${month}`, seat: FINANCE_SEAT, subject: `${a.name}: invoices exceed open POs`, body: `${a.name} has ${formatUsd(owed)} in unmatched invoices against ${formatUsd(open)} left on its open POs.` });
    }
  }
  return out;
}

/** Sends what is due in one org and not yet sent; returns how many went. */
export async function runOrgAlerts(orgId: string, rules = RULES()): Promise<number> {
  const due = await withOrg({ orgId }, async (tx) => {
    const alerts = await alertsIn(tx, orgId, rules);
    const sent = new Set((await tx.auditEvent.findMany({ where: { orgId, action: 'alert.sent', targetId: { in: alerts.map((a) => a.key) } }, select: { targetId: true } })).map((e) => e.targetId));
    const t = now();
    const out: (Alert & { to: string[] })[] = [];
    for (const a of alerts.filter((x) => !sent.has(x.key))) {
      const holders = await tx.seatHolder.findMany({ where: { orgId, seat: { name: a.seat }, activeFrom: { lte: t }, OR: [{ activeTo: null }, { activeTo: { gt: t } }] }, select: { membership: { select: { user: { select: { email: true } } } } } });
      const owners = holders.length ? [] : await tx.membership.findMany({ where: { orgId, role: 'owner' }, select: { user: { select: { email: true } } } });
      const to = [...new Set([...holders.map((h) => h.membership.user.email), ...owners.map((o) => o.user.email)])];
      // ponytail: audit before the send, so a crash mid-loop under-sends rather than repeats; an outbox if alerts must never drop.
      await audit({ orgId, userId: null }, 'alert.sent', { targetType: 'alert', targetId: a.key, data: { seat: a.seat, recipients: to.length } }, tx);
      out.push({ ...a, to });
    }
    return out;
  });
  for (const a of due) for (const to of a.to) await sendEmail({ to, subject: `Earmark: ${a.subject}`, body: a.body });
  return due.length;
}

/** The cron job: every org that has budget lines. */
export async function cronAlerts(): Promise<{ orgs: number; sent: number }> {
  const orgs = await asSystem(async (sys) => (await sys.budgetLine.findMany({ distinct: ['orgId'], select: { orgId: true } })).map((r) => r.orgId));
  const rules = RULES();
  let sent = 0;
  for (const orgId of orgs) sent += await runOrgAlerts(orgId, rules);
  return { orgs: orgs.length, sent };
}
