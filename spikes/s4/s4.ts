// Spike S4 (addendum §2, kickoff M9). Reads OWNER_URL (BYPASSRLS, migrated) and APP_URL (app_rw, NOBYPASSRLS).
// Prints results only; never a URL. Timing numbers are integer microseconds.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.OWNER_URL!, max: 1 }) });
// max: 1 so every transaction below borrows the SAME client connection (S4a's leak test).
const app = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.APP_URL!, max: 1 }) });
type Tx = Parameters<Parameters<typeof app.$transaction>[0]>[0];
const withOrg = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) =>
  app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });
const ok = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!pass) process.exitCode = 1;
};
const pctl = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

// Fixture: two orgs, one project each.
const [a, b] = await Promise.all(
  ['s4-a', 's4-b'].map((slug) => owner.org.upsert({ where: { slug }, update: {}, create: { slug, name: slug } })),
);
for (const o of [a, b]) {
  if (!(await owner.project.count({ where: { orgId: o.id } }))) await owner.project.create({ data: { orgId: o.id, name: `p-${o.slug}` } });
}
const pA = (await owner.project.findFirst({ where: { orgId: a.id } }))!;

// --- S4a: set_config(..., true) does not outlive its transaction on the same pooled connection.
type Probe = { v: string | null; pid: number };
const probe = (c: Tx | PrismaClient) => c.$queryRaw<Probe[]>`SELECT current_setting('app.org_id', true) AS v, pg_backend_pid() AS pid`;
const [t1] = await withOrg(a.id, (tx) => probe(tx));
const [t2] = await app.$transaction((tx) => probe(tx));
const [t3] = await probe(app);
ok('S4a tx1 sees its own setting', t1.v === a.id);
ok('S4a tx2 on the same pool does not see it', !t2.v, `value=${JSON.stringify(t2.v)} samePid=${t1.pid === t2.pid}`);
ok('S4a outside any tx does not see it', !t3.v, `value=${JSON.stringify(t3.v)} samePid=${t1.pid === t3.pid}`);
// After a local set, the GUC exists with value '' (not NULL) on that session: a bare ::uuid cast throws.
let bareCast = 'no error';
try {
  await app.$queryRaw`SELECT current_setting('app.org_id', true)::uuid`;
} catch (e) {
  bareCast = String((e as Error).message).includes('uuid') ? 'throws invalid uuid' : 'throws other';
}
console.log(`INFO S4a bare current_setting(...)::uuid after a reset: ${bareCast} -> policies use nullif(..., '')::uuid`);

// --- S4b: migrations ran as owner; app_rw sees nothing unscoped, only A with A set, cannot write into B.
const none = await app.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Project"`;
ok('S4b no setting -> 0 rows', Number(none[0].n) === 0);
const onlyA = await withOrg(a.id, (tx) => tx.project.findMany());
ok('S4b A set -> only A rows', onlyA.length > 0 && onlyA.every((p) => p.orgId === a.id), `rows=${onlyA.length}`);
let crossWrite = 'allowed';
try {
  await withOrg(a.id, (tx) => tx.project.create({ data: { orgId: b.id, name: 'leak' } }));
} catch {
  crossWrite = 'refused';
}
ok('S4b insert into B with A set is refused', crossWrite === 'refused');
const role = await app.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
ok('S4b app role has neither BYPASSRLS nor SUPERUSER', !role[0].rolbypassrls && !role[0].rolsuper);
const orole = await owner.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
console.log(`INFO S4b owner role bypassrls=${orole[0].rolbypassrls} super=${orole[0].rolsuper}`);
const ownerSees = await owner.project.count();
ok('S4b owner (bypass) still sees every org', ownerSees >= 2, `rows=${ownerSees}`);

// --- S4c: round-trip cost of one Project read, plain vs withOrg. 20 warm-up, 200 measured each.
const N = Number(process.env.S4C_N ?? 200);
const time = async (fn: () => Promise<unknown>) => {
  for (let i = 0; i < 20; i++) await fn();
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    await fn();
    xs.push(Number((process.hrtime.bigint() - t) / 1000n));
  }
  return { p50: pctl(xs, 50), p95: pctl(xs, 95) };
};
const plain = await time(() => owner.project.findUnique({ where: { id: pA.id } }));
const scoped = await time(() => withOrg(a.id, (tx) => tx.project.findUnique({ where: { id: pA.id } })));
console.log(`S4C ${process.env.S4_TARGET ?? 'local'} plain p50=${plain.p50}us p95=${plain.p95}us | withOrg p50=${scoped.p50}us p95=${scoped.p95}us`);

await Promise.all([owner.$disconnect(), app.$disconnect()]);
