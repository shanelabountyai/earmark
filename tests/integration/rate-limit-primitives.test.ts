import { beforeEach, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { advanceClock } from '@/core/clock';
import { hit, spent, sweepRateLimits, type Limit } from '@/core/rate-limit';

// advanceClock sets an absolute offset from real time. Pin 1s into a fresh 60s window, plus `ms`.
const base = Math.ceil(Date.now() / 60_000) * 60_000 + 1000 - Date.now();
const at = (ms = 0) => advanceClock(base + ms);

// Limit is narrowed to the LIMITS literals; a small test-only limit needs a cast.
const L = { limit: 3, windowMs: 60_000 } as unknown as Limit;

beforeEach(async () => {
  await db.rateLimit.deleteMany();
  at();
});

describe('rate-limit primitives', () => {
  it('hit allows exactly `limit` hits, then refuses', async () => {
    expect([await hit('k', L), await hit('k', L), await hit('k', L)]).toEqual([true, true, true]);
    expect(await hit('k', L)).toBe(false);
    expect(await hit('k', L)).toBe(false);
  });
  it('keys are independent', async () => {
    for (let i = 0; i < 4; i++) await hit('a', L);
    expect(await hit('b', L)).toBe(true);
  });
  it('the counter resets when the window turns', async () => {
    for (let i = 0; i < 4; i++) await hit('k', L);
    expect(await hit('k', L)).toBe(false);
    at(L.windowMs);
    expect(await hit('k', L)).toBe(true);
  });
  it('concurrent hits are counted atomically: never more than `limit` get through', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => hit('race', L)));
    expect(results.filter(Boolean)).toHaveLength(L.limit);
    expect((await db.rateLimit.findFirstOrThrow({ where: { key: 'race' } })).count).toBe(10);
  });
  it('spent counts nothing and reports true only once the limit is reached', async () => {
    expect(await spent('s', L)).toBe(false);
    await hit('s', L);
    await hit('s', L);
    expect(await spent('s', L)).toBe(false);
    await hit('s', L);
    expect(await spent('s', L)).toBe(true);
    expect((await db.rateLimit.findFirstOrThrow({ where: { key: 's' } })).count).toBe(3);
    expect(await spent('never-hit', L)).toBe(false);
  });
  it('sweepRateLimits deletes only windows that ended over a day ago', async () => {
    await hit('old', L);
    at(2 * 86_400_000);
    await hit('new', L);
    expect(await sweepRateLimits()).toBe(1);
    const keys = (await db.rateLimit.findMany()).map((r) => r.key);
    expect(keys).toEqual(['new']);
  });
});
