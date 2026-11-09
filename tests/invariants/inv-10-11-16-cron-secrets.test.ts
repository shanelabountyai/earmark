import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { isAuthorizedCron } from '@/core/cron';
import { sweepRateLimits } from '@/core/rate-limit';

afterAll(() => db.$disconnect());

const SECRET = 'a-cron-secret-of-16+chars';
const call = (headers: Record<string, string> = {}, url = 'http://localhost/api/cron') =>
  new Request(url, { headers });

function sources(dir = 'src'): { file: string; text: string }[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (p === join('src', 'generated')) return [];
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [{ file: p, text: readFileSync(p, 'utf8') }] : [];
  });
}
const lines = () => sources().flatMap(({ file, text }) => text.split('\n').map((l, i) => ({ at: `${file}:${i + 1}`, l })));

describe('INV-10 secrets are compared in constant time', () => {
  it('no ===/!== against an env secret, and the header check goes through safeEqual', () => {
    const bad = lines().filter(({ l }) => /(===|!==)\s*env\.\w*(SECRET|KEY|TOKEN)|env\.\w*(SECRET|KEY|TOKEN)\w*\s*(===|!==)/.test(l));
    expect(bad).toEqual([]);
    expect(readFileSync('src/core/cron.ts', 'utf8')).toContain('safeEqual(');
  });
});

describe('INV-16 no secret is accepted from a query string', () => {
  it('no source reads a secret-shaped query parameter', () => {
    const bad = lines().filter(({ l }) => /searchParams\.get\(\s*['"`](secret|key|token|api_?key|cron_?secret)['"`]/i.test(l));
    expect(bad).toEqual([]);
  });
  it('a correct secret in the URL does not authorise', () => {
    expect(isAuthorizedCron(call({}, `http://localhost/api/cron?secret=${SECRET}`), SECRET)).toBe(false);
  });
});

describe('INV-11 a secret-gated endpoint fails closed', () => {
  it.each([undefined, ''])('secret %j: nothing authorises, not even an empty bearer', (s) => {
    expect(isAuthorizedCron(call({ authorization: 'Bearer ' }), s)).toBe(false);
    expect(isAuthorizedCron(call({ authorization: `Bearer ${s}` }), s)).toBe(false);
    expect(isAuthorizedCron(call(), s)).toBe(false);
  });
  it('accepts only the exact bearer', () => {
    expect(isAuthorizedCron(call({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe(true);
    for (const h of [SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, 'Bearer nope']) {
      expect(isAuthorizedCron(call({ authorization: h }), SECRET)).toBe(false);
    }
  });
  it('/api/cron is 401 with CRON_SECRET unset', async () => {
    vi.stubEnv('CRON_SECRET', undefined);
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/route');
    const res = await GET(call({ authorization: 'Bearer ' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('/api/cron', () => {
  it('sweeps stale rate-limit rows and keeps current ones', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/route');
    const old = new Date(Date.now() - 2 * 86_400_000);
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'cron-test:' } } });
    await db.rateLimit.createMany({
      data: [
        { key: 'cron-test:old', windowStart: old, count: 1 },
        { key: 'cron-test:new', windowStart: new Date(), count: 1 },
      ],
    });
    const res = await GET(call({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await db.rateLimit.count({ where: { key: 'cron-test:old' } })).toBe(0);
    expect(await db.rateLimit.count({ where: { key: 'cron-test:new' } })).toBe(1);
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'cron-test:' } } });
    vi.unstubAllEnvs();
    expect(typeof sweepRateLimits).toBe('function');
  });
});
