import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceeded, HOLD_MS, parseDollars, setCap, setPaused, withBudget } from '@/core/ai/budget';
import { costMicros } from '@/core/ai/prices';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { env } from '@/core/env';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

beforeEach(resetAuthTables);
afterEach(() => advanceClock(0));

// 1000 Sonnet output tokens = 10_000 micro-dollars = 1¢.
const MAX = 10_000n; // the worst-case estimate each test call declares
const CENT = { usage: { provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 1000 } };

async function org(capMicros = 10_000n) {
  const o = await makeOrg('acme');
  const owner = await addMember(o.id, 'owner', 'owner@acme.test');
  await db.aiBudget.create({ data: { orgId: o.id, monthlyCapMicros: capMicros } });
  return { orgId: o.id, userId: owner.id, slug: o.slug };
}

describe('INV-39 withBudget refuses at the cap and never records a refused call', () => {
  it('cap of 1¢, two calls: the second is refused, its fn never runs, one AiUsage row', async () => {
    const ctx = await org();
    const fn = vi.fn(async () => CENT);
    await withBudget(ctx, 'answer', MAX, fn);
    await expect(withBudget(ctx, 'answer', MAX, fn)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fn).toHaveBeenCalledTimes(1);
    const rows = await db.aiUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: ctx.orgId, feature: 'answer', actorId: ctx.userId, costMicros: 10_000n });
  });

  it('AI_ENABLED=0 refuses everything, even with budget left', async () => {
    const ctx = await org(25_000_000n);
    const fn = vi.fn(async () => CENT);
    await expect(withBudget(ctx, 'answer', MAX, fn, { ...env, AI_ENABLED: '0' })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fn).not.toHaveBeenCalled();
    expect(await db.aiUsage.count()).toBe(0);
  });

  it('a paused org is refused; resuming lets calls through', async () => {
    const ctx = await org(25_000_000n);
    const owner = await actAs(ctx.userId, ctx.slug);
    await setPaused(owner, true);
    await expect(withBudget(ctx, 'answer', MAX, async () => CENT)).rejects.toThrow(/paused/);
    await setPaused(owner, false);
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    expect(await db.aiUsage.count()).toBe(1);
  });

  it('hard cap: a call running holds its estimate, so a concurrent call is refused before the first one finishes', async () => {
    const ctx = await org(15_000n); // room for one 1¢ estimate, not two
    let release!: () => void;
    const first = withBudget(ctx, 'answer', MAX, () => new Promise<typeof CENT>((r) => (release = () => r(CENT))));
    await vi.waitFor(async () => expect(await db.aiHold.count()).toBe(1));
    await expect(withBudget(ctx, 'answer', MAX, async () => CENT)).rejects.toBeInstanceOf(BudgetExceeded);
    release();
    await first;
    expect(await db.aiUsage.count()).toBe(1);
    expect(await db.aiHold.count()).toBe(0); // the hold became the usage row
  });

  it('a call whose estimate would pass the cap is refused even with nothing spent', async () => {
    const ctx = await org(9_999n);
    const fn = vi.fn(async () => CENT);
    await expect(withBudget(ctx, 'answer', MAX, fn)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a hold left by a crashed call stops counting after HOLD_MS', async () => {
    const ctx = await org();
    await db.aiHold.create({ data: { orgId: ctx.orgId, costMicros: MAX, expiresAt: new Date(Date.now() + HOLD_MS) } });
    await expect(withBudget(ctx, 'answer', MAX, async () => CENT)).rejects.toBeInstanceOf(BudgetExceeded);
    advanceClock(HOLD_MS + 1000);
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    expect(await db.aiHold.count()).toBe(0);
  });

  it('hard stop off lets spend pass the cap', async () => {
    const ctx = await org();
    await db.aiBudget.update({ where: { orgId: ctx.orgId }, data: { hardStop: false } });
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    expect(await db.aiUsage.count()).toBe(2);
  });

  it('a new calendar month starts from zero', async () => {
    const ctx = await org();
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    advanceClock(32 * 86_400_000);
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    expect(await db.aiUsage.count()).toBe(2);
  });

  it('a throwing fn writes nothing; a first spend creates the default $25.00 budget', async () => {
    const o = await makeOrg('globex');
    await expect(withBudget({ orgId: o.id }, 'answer', MAX, async () => Promise.reject(new Error('provider down')))).rejects.toThrow('provider down');
    expect(await db.aiUsage.count()).toBe(0);
    expect(await db.aiHold.count()).toBe(0); // and its hold is released
    expect((await db.aiBudget.findUniqueOrThrow({ where: { orgId: o.id } })).monthlyCapMicros).toBe(25_000_000n);
  });
});

describe('AI budget alerts: one email per kind per month to the owners, audited', () => {
  it('80% sends one alert, the cap sends one more, and repeats in the same month send nothing', async () => {
    const ctx = await org(20_000n); // 2¢: the first 1¢ call is 50%, the second 100%
    await db.aiBudget.update({ where: { orgId: ctx.orgId }, data: { hardStop: false } });
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    expect(await db.capturedMessage.count()).toBe(0);
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    await withBudget(ctx, 'answer', MAX, async () => CENT);
    const mail = await db.capturedMessage.findMany({ orderBy: { createdAt: 'asc' } });
    expect(mail.map((m) => [m.to, m.subject])).toEqual([
      ['owner@acme.test', expect.stringMatching(/nearing/)],
      ['owner@acme.test', expect.stringMatching(/reached/)],
    ]);
    const events = await db.auditEvent.findMany({ where: { action: { startsWith: 'ai.budget.' } }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.action)).toEqual(['ai.budget.alert', 'ai.budget.capped']);
  });
});

describe('owner controls and pricing', () => {
  it('setCap stores micro-dollars and audits the change; bad input is refused', async () => {
    const ctx = await org();
    const owner = await actAs(ctx.userId, ctx.slug);
    await setCap(owner, '12.5');
    expect((await db.aiBudget.findUniqueOrThrow({ where: { orgId: ctx.orgId } })).monthlyCapMicros).toBe(12_500_000n);
    await expect(setCap(owner, '1e3')).rejects.toThrow(/dollars/);
    expect(await db.auditEvent.count({ where: { action: 'ai.budget.cap' } })).toBe(1);
  });

  it('parses dollars without floats and prices round up', () => {
    expect([parseDollars('25'), parseDollars('0.07'), parseDollars('3.1'), parseDollars('-1'), parseDollars('1.234')]).toEqual([25_000_000n, 70_000n, 3_100_000n, null, null]);
    expect(costMicros('anthropic', 'claude-haiku-5-5', 1, 0)).toBe(1n); // 0.1 micro-dollar rounds up
    expect(costMicros('anthropic', 'claude-haiku-5-5', 100_000, 0)).toBe(10_000n); // at the threshold: base rate
    expect(costMicros('anthropic', 'claude-haiku-5-5', 100_001, 1000)).toBe(50_001n + 2_500n); // past it: the whole call at the long-prompt rate
    expect(() => costMicros('anthropic', 'no-such-model', 1, 1)).toThrow(/No price/);
  });
});
