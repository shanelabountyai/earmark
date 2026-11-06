import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { demoSignIn } from '@/core/auth/demo';
import { SESSION_COOKIE } from '@/core/auth/session';
import { seedDemo } from '../../scripts/seed-demo';
import { resetAuthTables } from '../helpers/auth';
import { jar } from '../helpers/next';

beforeEach(resetAuthTables);

const post = (userId: string) =>
  new Request('http://localhost/demo/signin', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams({ userId }) });

async function signinRoute(demoMode: string | undefined) {
  vi.resetModules();
  const before = process.env.DEMO_MODE; // env.ts parses process.env at import, so set it around the import
  if (demoMode) process.env.DEMO_MODE = demoMode;
  else delete process.env.DEMO_MODE;
  try {
    return (await import('@/app/(public)/demo/signin/route')).POST;
  } finally {
    if (before === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = before;
  }
}

describe('INV-27 demo sign-in', () => {
  it('flag off: signs nobody in, and the route is a 404, even for a real demo user', async () => {
    await seedDemo();
    const demo = await db.user.findFirstOrThrow({ where: { isDemo: true } });
    expect(await demoSignIn(demo.id, {})).toBeNull();
    expect((await (await signinRoute(undefined))(post(demo.id))).status).toBe(404);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(await db.session.count()).toBe(0);
  });

  it('flag on: signs in a demo user with MFA passed', async () => {
    await seedDemo();
    const demo = await db.user.findFirstOrThrow({ where: { isDemo: true, email: { startsWith: 'owner@' } } });
    const res = await (await signinRoute('1'))(post(demo.id));
    expect(res.status).toBe(303);
    expect(jar.has(SESSION_COOKIE)).toBe(true);
    expect((await db.session.findFirstOrThrow()).mfaAt).not.toBeNull();
  });

  it('flag on: refuses a real (non-demo) user, and an unknown id', async () => {
    const real = await db.user.create({ data: { email: 'real@example.test' } });
    expect(await demoSignIn(real.id, { DEMO_MODE: '1' })).toBeNull();
    const route = await signinRoute('1');
    expect((await route(post(real.id))).status).toBe(404);
    expect((await route(post('00000000-0000-0000-0000-000000000000'))).status).toBe(404);
    expect(await db.session.count()).toBe(0);
  });

  it('the seed marks only its own users, and re-running it adds none', async () => {
    await db.user.create({ data: { email: 'real@example.test' } });
    await seedDemo();
    await seedDemo();
    expect(await db.user.count({ where: { isDemo: true } })).toBe(6);
    expect((await db.user.findUniqueOrThrow({ where: { email: 'real@example.test' } })).isDemo).toBe(false);
    expect(await db.user.count({ where: { isDemo: true, totpEnrolledAt: { not: null } } })).toBe(4);
  });

  it('the seed script refuses a cloud database', () => {
    const rest = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'VERCEL_ENV' && k !== 'ALLOW_CLOUD_DB')) as NodeJS.ProcessEnv;
    const r = spawnSync('npx', ['tsx', 'scripts/seed-demo.ts'], {
      encoding: 'utf8',
      env: { ...rest, DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db', DIRECT_URL: 'postgresql://u:p@ep-x.neon.tech/db' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Refusing a cloud database/);
  });
});
