import { audit } from '@/core/audit';
import { assertNotDemo } from '@/core/auth/session';
import type { OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg, type Tx } from '@/core/db/rls';
import { sendEmail } from '@/core/email/transport';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { log } from '@/core/log';
import { costMicros } from './prices';

// AI spend guards (addendum §6, INV-39). A model call cannot start once the org's calendar-month spend has reached
// its cap. The guard is on cost, not content: prompt injection and output handling stay with each clone.

/** A refused model call. Extends Refused, so an action shows the message instead of failing. */
export class BudgetExceeded extends Refused {}

export type AiUsageReport = { provider: string; model: string; inputTokens: number; outputTokens: number };
type SpendCtx = { orgId: string; userId?: string | null };

/** The first instant of this calendar month, UTC. */
export const monthStart = (d = now()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/** The org's budget row, created with the template default ($25.00, hard stop) on first use. */
export const budgetOf = (tx: Tx, orgId: string) => tx.aiBudget.upsert({ where: { orgId }, create: { orgId }, update: {} });

/** This calendar month's spend in micro-dollars: the sum of the ledger, never a running counter. */
export async function monthSpend(tx: Tx, orgId: string): Promise<bigint> {
  const r = await tx.aiUsage.aggregate({ where: { orgId, createdAt: { gte: monthStart() } }, _sum: { costMicros: true } });
  return r._sum.costMicros ?? 0n;
}

export const HOLD_MS = 15 * 60_000; // longer than any one model call, retries included

/** This month's spend plus the live holds of calls in flight. */
async function committed(tx: Tx, orgId: string): Promise<bigint> {
  const held = await tx.aiHold.aggregate({ where: { orgId, expiresAt: { gt: now() } }, _sum: { costMicros: true } });
  return (await monthSpend(tx, orgId)) + (held._sum.costMicros ?? 0n);
}

/**
 * Runs one model call under the org's budget, as a hard cap (owner decision 2026-11-05, §6 as built). `maxCostMicros`
 * is the call's worst case: its known input tokens plus `max_tokens` of output, priced with `costMicros`. Under a lock
 * on the org's AiBudget row, the call is refused (BudgetExceeded) when AI_ENABLED=0, the org is paused, or, with hard
 * stop on, this month's spend plus every in-flight hold plus this estimate would pass the cap. Otherwise the estimate is
 * held, `fn` runs, and the hold is swapped for the AiUsage row priced from the billed `usage`. A refused call writes no
 * usage row; a throwing `fn` writes none either and releases its hold. A crashed process's hold stops counting after
 * HOLD_MS. The cap holds only if the estimate is a true upper bound: an under-estimate is recorded at its real cost.
 */
export async function withBudget<T extends { usage: AiUsageReport }>(
  ctx: SpendCtx,
  feature: string,
  maxCostMicros: bigint,
  fn: () => Promise<T>,
  e = env,
): Promise<T> {
  if (e.AI_ENABLED === '0') throw new BudgetExceeded('AI features are turned off.');
  const { budget, holdId } = await withOrg(ctx, async (tx) => {
    await budgetOf(tx, ctx.orgId);
    await tx.$queryRaw`SELECT 1 FROM "AiBudget" WHERE "orgId" = ${ctx.orgId}::uuid FOR UPDATE`; // one check at a time per org
    const budget = await tx.aiBudget.findUniqueOrThrow({ where: { orgId: ctx.orgId } }); // read under the lock
    if (budget.pausedAt) throw new BudgetExceeded('AI features are paused for this organization.');
    await tx.aiHold.deleteMany({ where: { orgId: ctx.orgId, expiresAt: { lte: now() } } });
    if (budget.hardStop && (await committed(tx, ctx.orgId)) + maxCostMicros > budget.monthlyCapMicros) {
      throw new BudgetExceeded('This organization has reached its monthly AI spending limit.');
    }
    const hold = await tx.aiHold.create({ data: { orgId: ctx.orgId, costMicros: maxCostMicros, createdAt: now(), expiresAt: new Date(now().getTime() + HOLD_MS) } });
    return { budget, holdId: hold.id };
  });

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await withOrg(ctx, (tx) => tx.aiHold.deleteMany({ where: { id: holdId } }));
    throw err;
  }
  const { provider, model, inputTokens, outputTokens } = result.usage;
  const cost = costMicros(provider, model, inputTokens, outputTokens);
  const total = await withOrg(ctx, async (tx) => {
    await tx.aiHold.deleteMany({ where: { id: holdId } });
    await tx.aiUsage.create({ data: { orgId: ctx.orgId, provider, model, inputTokens, outputTokens, costMicros: cost, feature, actorId: ctx.userId ?? null, createdAt: now() } });
    return monthSpend(tx, ctx.orgId);
  });
  try {
    if (total * 100n >= budget.monthlyCapMicros * BigInt(budget.alertAtPct)) await notifyOnce(ctx.orgId, 'alertedAt', total, budget.monthlyCapMicros);
    if (total >= budget.monthlyCapMicros) await notifyOnce(ctx.orgId, 'cappedAt', total, budget.monthlyCapMicros);
  } catch (err) {
    log('ai.budget.notify_failed', { orgId: ctx.orgId, error: String(err) }); // the call is recorded; an alert must not fail it
  }
  return result;
}

const dollars = (m: bigint) => `$${(Number(m) / 1e6).toFixed(2)}`;

/** One email per kind per calendar month: the conditional update claims the month, so a race sends it once. */
async function notifyOnce(orgId: string, kind: 'alertedAt' | 'cappedAt', spent: bigint, cap: bigint) {
  const owners = await withOrg({ orgId }, async (tx) => {
    const { count } = await tx.aiBudget.updateMany({ where: { orgId, OR: [{ [kind]: null }, { [kind]: { lt: monthStart() } }] }, data: { [kind]: now() } });
    if (!count) return null;
    await audit({ orgId, userId: null }, kind === 'alertedAt' ? 'ai.budget.alert' : 'ai.budget.capped', { data: { spentMicros: Number(spent), capMicros: Number(cap) } }, tx);
    return tx.membership.findMany({ where: { orgId, role: 'owner' }, select: { user: { select: { email: true } } } });
  });
  for (const o of owners ?? []) {
    await sendEmail({
      to: o.user.email,
      subject: kind === 'alertedAt' ? 'AI spending is nearing this month’s limit' : 'AI spending has reached this month’s limit',
      body: `This month's AI spend is ${dollars(spent)} of a ${dollars(cap)} limit.${kind === 'cappedAt' ? ' New AI requests are refused until next month or until an owner raises the limit.' : ''}`,
    });
  }
}

/** Dollars and cents typed by an owner ("25", "25.5", "25.50") to micro-dollars, without a float. */
export function parseDollars(s: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s.trim());
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(2, '0')) * 10_000n : null;
}

/** Owner control (billing.manage, the caller's guard). Audited with the old and new cap. */
export async function setCap(ctx: OrgCtx, input: string) {
  assertNotDemo(ctx.session); // a /demo visitor must not lift the shared demo org's $1.00 cap
  const cap = parseDollars(input);
  if (cap === null) throw new Refused('Enter the limit in dollars, like 25 or 25.50.');
  await withOrg(ctx, async (tx) => {
    const before = await budgetOf(tx, ctx.orgId);
    await tx.aiBudget.update({ where: { orgId: ctx.orgId }, data: { monthlyCapMicros: cap } });
    await audit(ctx, 'ai.budget.cap', { data: { fromMicros: Number(before.monthlyCapMicros), toMicros: Number(cap) } }, tx);
  });
}

/** Owner control (billing.manage, the caller's guard): pausing refuses every call until it is resumed. */
export async function setPaused(ctx: OrgCtx, paused: boolean) {
  assertNotDemo(ctx.session);
  await withOrg(ctx, async (tx) => {
    await budgetOf(tx, ctx.orgId);
    await tx.aiBudget.update({ where: { orgId: ctx.orgId }, data: { pausedAt: paused ? now() : null } });
    await audit(ctx, paused ? 'ai.budget.pause' : 'ai.budget.resume', {}, tx);
  });
}
