import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { orgTables } from '../../scripts/rls-policies';
import { seedApp } from '../fixtures/app';
import { db } from '@/core/db';
import { CROSS_ORG_FILES } from '@/core/db/cross-org';
import { withOrg } from '@/core/db/rls';
import { dbSystem } from '@/core/db/system';
import { env } from '@/core/env';

// Addendum §2 / §8. INV-31 and INV-32 hold in every mode; INV-29, 30 and 33 need RLS_MODE=enforce, where
// DATABASE_URL is the app role (app_rw) and DATABASE_URL_SYSTEM the owner.
const enforce = env.RLS_MODE === 'enforce';
const tables = orgTables();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'generated' ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
const sources = [...walk('src'), ...walk('scripts')].map((f) => ({ f, text: readFileSync(f, 'utf8') }));

describe('INV-31: only transaction-local org settings', () => {
  it('no SET app.*, and every set_config is transaction-local', () => {
    const bad = sources.flatMap(({ f, text }) => [
      ...[...text.matchAll(/\bSET\s+(SESSION\s+)?app\./gi)].map(() => `${f}: SET app.*`),
      ...[...text.matchAll(/set_config\(([^)]*)\)/g)].filter((m) => !/,\s*true\s*$/.test(m[1]!)).map((m) => `${f}: ${m[0]}`),
    ]);
    expect(bad).toEqual([]);
  });
});

const SYSTEM_USE = /\basSystem\s*\(|['"]@\/core\/db\/system['"]|from ['"]\.\/system['"]/;
const unlistedSystemUse = (files: { f: string; text: string }[]) => {
  const allowed = new Set([...Object.keys(CROSS_ORG_FILES), 'src/core/db/rls.ts', 'src/core/db/system.ts']);
  return files.filter(({ f, text }) => SYSTEM_USE.test(text) && !allowed.has(f)).map(({ f }) => f);
};

describe('INV-32: cross-org access only through asSystem, only from cross-org.ts files', () => {
  it('no file outside the list calls asSystem or imports the system client', () => {
    expect(unlistedSystemUse(sources)).toEqual([]);
  });

  it('every listed file exists and still uses asSystem (no stale entries)', () => {
    const stale = Object.keys(CROSS_ORG_FILES).filter((f) => !sources.some((s) => s.f === f && /\basSystem\s*\(/.test(s.text)));
    expect(stale).toEqual([]);
  });

  it('negative control: an unlisted caller and an unlisted system import are both caught', () => {
    const planted = [
      { f: 'src/app/o/[org]/projects/page.tsx', text: 'await asSystem((sys) => sys.project.findMany())' },
      { f: 'src/core/share/project.ts', text: "import { dbSystem } from '@/core/db/system';" },
    ];
    expect(unlistedSystemUse(planted)).toEqual(planted.map((p) => p.f));
  });
});

// The mirror of INV-33. Policies are always on, and off mode sets no org (D-31), so with RLS off the app role must be one
// that bypasses them; app_rw here would make every org page a 404 and refuse every org-owned insert.
describe.skipIf(enforce)('RLS off: the runtime role bypasses RLS', () => {
  it('DATABASE_URL role has BYPASSRLS or SUPERUSER (else set RLS_MODE=enforce)', async () => {
    const [r] = await db.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(r!.rolbypassrls || r!.rolsuper).toBe(true);
  });
});

describe.skipIf(!enforce)('INV-33: the runtime role cannot bypass RLS', () => {
  it('DATABASE_URL role has neither BYPASSRLS nor SUPERUSER', async () => {
    const [r] = await db.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe.skipIf(!enforce)('INV-30: every orgId model has RLS enabled, forced, and a policy', () => {
  it('pg_class and pg_policies match the schema', async () => {
    const rows = await dbSystem.$queryRaw<{ t: string; on: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS t, c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    const byName = new Map(rows.map((r) => [r.t, r]));
    const missing = tables.filter((t) => {
      const r = byName.get(t.table);
      return !r || !r.on || !r.forced || r.policies < 1;
    });
    expect(missing.map((t) => t.table)).toEqual([]);
    expect(tables.length).toBeGreaterThanOrEqual(5); // the parser found the core tables at all
  });
});

describe.skipIf(!enforce)('INV-29: no org set, no rows; org A set, only A rows', () => {
  const [a, b] = [randomUUID(), randomUUID()];
  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8);
    for (const [orgId, n] of [[a, 'a'], [b, 'b']] as const) {
      const exp = new Date(Date.now() + 86_400_000);
      const user = await dbSystem.user.create({ data: { email: `inv29-${n}-${tag}@example.test` } });
      await dbSystem.org.create({ data: { id: orgId, slug: `inv29-${n}-${tag}`, name: n } });
      await dbSystem.membership.create({ data: { orgId, userId: user.id, role: 'owner' } });
      const p = await dbSystem.project.create({ data: { orgId, name: n } });
      await dbSystem.invite.create({ data: { orgId, email: `x-${n}-${tag}@example.test`, tokenHash: `inv29-${n}-${tag}`, expiresAt: exp } });
      await dbSystem.shareLink.create({ data: { orgId, resourceType: 'project', resourceId: p.id, tokenHash: `inv29s-${n}-${tag}`, expiresAt: exp } });
      await dbSystem.auditEvent.createMany({ data: [{ orgId, action: 'inv29' }] });
      await dbSystem.orgExport.create({ data: { orgId, requestedById: user.id, expiresAt: exp } });
      await dbSystem.aiUsage.create({ data: { orgId, provider: 'anthropic', model: 'inv29', inputTokens: 1, outputTokens: 1, costMicros: 1n, feature: 'inv29' } });
      await dbSystem.aiBudget.create({ data: { orgId } });
      await dbSystem.aiHold.create({ data: { orgId, costMicros: 1n, expiresAt: exp } });
      await seedApp({ orgId, userId: user.id }, n); // the clone's own org tables: the same fixture the action harness uses
      const ev = await dbSystem.orgEvent.create({ data: { orgId, type: 'inv29', payload: {} } });
      // module tables only when the module is installed (check-modules removes them)
      const model = (m: string) => (dbSystem as unknown as Record<string, { create: (a: unknown) => Promise<unknown> } | undefined>)[m];
      await model('billingAccount')?.create({ data: { orgId } });
      await model('outbox')?.create({ data: { orgId, channel: 'email', to: 'x@example.test', template: 'inv29', data: {} } });
      await model('ssoConnection')?.create({ data: { orgId, issuer: 'https://idp.example', clientId: 'x', clientSecretSealed: 'x', allowedDomains: [] } });
      await model('ssoDomain')?.create({ data: { orgId, domain: `inv29-${n}-${tag}.example` } });
      await model('ssoState')?.create({ data: { hash: `inv29-${n}-${tag}`, orgId, nonce: 'x', codeVerifier: 'x', createdAt: new Date(), expiresAt: exp } });
      const key = (await model('apiKey')?.create({ data: { orgId, label: 'inv29', prefix: 'api_x', keyHash: `inv29-${n}-${tag}`, scopes: ['read'], createdById: user.id } })) as { id: string } | undefined;
      if (key) {
        await model('idempotencyRecord')!.create({ data: { orgId, apiKeyId: key.id, idemKey: 'k', requestHash: 'h', status: 'done', expiresAt: exp, createdAt: new Date(), updatedAt: new Date() } });
        const ep = (await model('webhookEndpoint')!.create({ data: { orgId, url: 'https://hooks.example', secretSealed: 'x' } })) as { id: string };
        await model('webhookDelivery')!.create({ data: { orgId, endpointId: ep.id, eventId: ev.id, seq: 1 } });
      }
    }
  });

  it.each(tables.map((t) => [t.table, t]))('%s', async (_, t) => {
    const q = (where = '') => `SELECT count(*)::int AS n FROM "${t.table}"${where}`;
    const count = async (c: { $queryRawUnsafe: typeof db.$queryRawUnsafe }, sql: string) => (await c.$queryRawUnsafe<{ n: number }[]>(sql))[0]!.n;
    expect(await count(db, q())).toBe(0); // unscoped: nothing, not everything
    const [mine, others] = await withOrg({ orgId: a }, (tx) => Promise.all([count(tx, q(` WHERE "${t.column}" = '${a}'`)), count(tx, q(` WHERE "${t.column}" IS DISTINCT FROM '${a}'`))]));
    expect(mine).toBeGreaterThan(0);
    expect(others).toBe(0);
    // A write into B while A is set is refused (append-style tables accept inserts by design; their reads stay scoped).
    if (!t.nullable) {
      await expect(withOrg({ orgId: a }, (tx) => tx.$executeRawUnsafe(`UPDATE "${t.table}" SET "${t.column}" = "${t.column}" WHERE "${t.column}" = '${b}'`))).resolves.toBe(0);
    }
  });
});
