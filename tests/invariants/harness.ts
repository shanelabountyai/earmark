// INV-01/02/03/04/22 harness, from spike S2. It discovers every 'use server' export by glob, so
// nothing is registered by hand, builds input from each action's zod schema, and attacks it from
// a two-org fixture, checking both the outcome and a snapshot of every table.
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sealSecret } from '@/core/auth/secret-box';
import type { ActionSpec } from '@/core/authz/action';
import { now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { hashToken } from '@/core/tokens';
import { seedApp } from '../fixtures/app';
import { allTables, resetAuthTables, signInAs } from '../helpers/auth';
import { jar, NavSignal } from '../helpers/next';

export type Finding = { inv: 'INV-01' | 'INV-02' | 'INV-03' | 'INV-04' | 'INV-22' | 'HARNESS'; action: string; detail: string };
type Found = { file: string; name: string; fn: unknown };
type Action = ((...args: unknown[]) => Promise<unknown>) & { spec: ActionSpec };

const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use server\1/;
const ROOT = path.resolve(import.meta.dirname, '../..');

const SRC = 'src/**/*.{ts,tsx,js,jsx,mts,mjs}';

/** Every export of every module whose first directive is 'use server'. */
export async function discover(pattern = SRC, cwd = ROOT): Promise<Found[]> {
  const out: Found[] = [];
  for (const rel of globSync(pattern, { cwd }).sort()) {
    const file = path.join(cwd, rel);
    if (!USE_SERVER.test(readFileSync(file, 'utf8'))) continue;
    for (const [name, fn] of Object.entries(await import(file))) out.push({ file: rel, name, fn });
  }
  return out;
}

// FR-07: Next registers an inline 'use server' function as an endpoint too, and discover() cannot
// see it. A directive anywhere but the top of the file is refused; move the action to an actions file.
const DIRECTIVE = /^\s*(['"])use server\1;?\s*$/gm;
export function inlineUseServer(pattern = SRC, cwd = ROOT): string[] {
  return globSync(pattern, { cwd }).sort().filter((rel) => {
    const src = readFileSync(path.join(cwd, rel), 'utf8');
    return (src.match(DIRECTIVE)?.length ?? 0) > (USE_SERVER.test(src) ? 1 : 0);
  });
}

// FR-06 (rule 1): every page, layout, template and route handler guards itself, because a client-side
// navigation re-renders the page without re-running its layout. Each exported handler's first awaited
// call must be a guard, or the file says why it is public with a `// public: <reason>` line.
const GUARDS = ['requireUser', 'requireOrg'];
const HANDLER = /^export\s+(?:default\s+)?(?:async\s+)?function\b|^export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/gm;
export function unguardedEntrypoints(pattern = 'src/app/**/{page,layout,template,default,route}.{ts,tsx,js,jsx}', cwd = ROOT): string[] {
  const out: string[] = [];
  for (const rel of globSync(pattern, { cwd }).sort()) {
    const src = readFileSync(path.join(cwd, rel), 'utf8');
    if (/^\/\/ public: \S/m.test(src)) continue;
    const starts = [...src.matchAll(HANDLER)].map((m) => m.index);
    if (!starts.length) out.push(`${rel}: no exported handler found`);
    starts.forEach((at, i) => {
      const first = src.slice(at, starts[i + 1]).match(/\bawait\s+([\w$.]+)/)?.[1];
      if (!GUARDS.includes(first ?? '')) out.push(`${rel}: first await is ${first ?? 'none'}, not ${GUARDS.join('/')}`);
    });
  }
  return out;
}

// ---- fixture: org A (the attacker's) and org B (the victim's)
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = (k: 'a' | 'b', n: number) => ({
  key: k, org: ID(n), slug: `org-${k}`,
  owner: ID(n + 1), // the actor: owner, TOTP enrolled, MFA passed
  member: ID(n + 2), // ref('member'): a second owner, so leave/demote/remove succeed for the actor
  adminNoMfa: ID(n + 3), // INV-22: an admin who never enrolled
  invite: ID(n + 4), // ref('invite'): pending
  project: ID(n + 5), // ref('project'): the share example resource
  shareLink: ID(n + 6), // ref('shareLink'): live, on that project
  ssoDomain: ID(n + 7), // ref('ssoDomain'): unverified (sso module)
  apiKey: ID(n + 8), // ref('apiKey'): live (apikeys module)
  webhookEndpoint: ID(n + 9), // ref('webhookEndpoint'): active
  webhookDelivery: ID(n + 10), // ref('webhookDelivery'): dead, so a replay changes it
  orgEvent: ID(n + 11),
});
const F = { a: org('a', 100), b: org('b', 200) };
type Org = typeof F.a;
const NONEXISTENT = ID(999);
const refs: Record<'a' | 'b', Record<string, string>> = { a: {}, b: {} };

async function seed() {
  await resetAuthTables();
  const t = now();
  const enrolled = { totpEnrolledAt: t, totpSecretSealed: sealSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'totp') };
  for (const o of [F.a, F.b]) {
    await db.org.create({ data: { id: o.org, slug: o.slug, name: `Org ${o.key}` } });
    for (const [id, role, extra] of [[o.owner, 'owner', enrolled], [o.member, 'owner', enrolled], [o.adminNoMfa, 'admin', {}]] as const) {
      await db.user.create({ data: { id, email: `${role}-${id.slice(-3)}@example.test`, ...extra } });
      await db.membership.create({ data: { orgId: o.org, userId: id, role } });
    }
    await db.invite.create({
      data: { id: o.invite, orgId: o.org, email: `invitee-${o.key}@example.test`, tokenHash: hashToken(`invite-${o.key}`), expiresAt: new Date(t.getTime() + 86_400_000) },
    });
    await db.project.create({ data: { id: o.project, orgId: o.org, name: `Project ${o.key}` } });
    await db.shareLink.create({
      data: { id: o.shareLink, orgId: o.org, resourceType: 'project', resourceId: o.project, tokenHash: hashToken(`share-${o.key}`), expiresAt: new Date(t.getTime() + 86_400_000) },
    });
    refs[o.key] = { member: o.member, invite: o.invite, project: o.project, shareLink: o.shareLink, ...(await seedApp({ orgId: o.org, userId: o.owner }, o.key)) };
    // Module rows only when the module is installed (foundation:check-modules removes it).
    const ssoDomain = (db as unknown as Record<string, { create: (a: unknown) => Promise<{ id: string }> } | undefined>).ssoDomain;
    if (ssoDomain) refs[o.key].ssoDomain = (await ssoDomain.create({ data: { id: o.ssoDomain, orgId: o.org, domain: `${o.slug}.example.test` } })).id;
    type Create = { create: (a: unknown) => Promise<unknown> };
    const m = db as unknown as Record<'apiKey' | 'webhookEndpoint' | 'orgEvent' | 'webhookDelivery', Create | undefined>;
    if (m.apiKey) {
      await m.apiKey.create({ data: { id: o.apiKey, orgId: o.org, label: `key ${o.key}`, prefix: 'api_xxxxxx', keyHash: hashToken(`apikey-${o.key}`), scopes: ['read'], createdById: o.owner } });
      await m.webhookEndpoint!.create({ data: { id: o.webhookEndpoint, orgId: o.org, url: 'https://hooks.example.test/in', secretSealed: sealSecret('whsec_fixture', 'webhook') } });
      await m.orgEvent!.create({ data: { id: o.orgEvent, orgId: o.org, type: 'project.created', payload: {} } });
      await m.webhookDelivery!.create({ data: { id: o.webhookDelivery, orgId: o.org, endpointId: o.webhookEndpoint, eventId: o.orgEvent, seq: 1, status: 'dead', attempts: 6 } });
      Object.assign(refs[o.key], { apiKey: o.apiKey, webhookEndpoint: o.webhookEndpoint, webhookDelivery: o.webhookDelivery });
    }
  }
}

async function snapshot() {
  const tables = (await allTables()).filter((t) => t !== 'RateLimit'); // a counted hit is not a write
  const rows = await Promise.all(
    tables.map((t) => db.$queryRawUnsafe<{ j: string }[]>(`SELECT coalesce(json_agg(x ORDER BY x::text)::text, '[]') AS j FROM "${t}" x`)),
  );
  return rows.map((r, i) => `${tables[i]}:${r[0]!.j}`).join('\n');
}

// Where the guards send a caller they refuse. Any other redirect is an action's success.
const GUARD_REDIRECTS = ['/login', '/login/mfa', '/account/security?mfa=required'];
type Outcome = { kind: 'ok' | 'refused' | 'guard' | 'notFound' | 'error'; detail?: unknown; changed: boolean };

async function call(fn: Action, as: string | null, input: unknown, mfa = true): Promise<Outcome> {
  await seed();
  jar.clear();
  if (as) await signInAs(as, { mfa });
  const before = await snapshot();
  let o: Omit<Outcome, 'changed'>;
  try {
    const r = await (fn.spec.kind === 'org' ? fn(F.a.slug, input) : fn(input));
    o = r && typeof r === 'object' && 'error' in r ? { kind: 'refused', detail: r } : { kind: 'ok', detail: r };
  } catch (e) {
    if (e instanceof NavSignal) o = e.kind === 'notFound' ? { kind: 'notFound' } : { kind: GUARD_REDIRECTS.includes(e.to!) ? 'guard' : 'ok', detail: e.to };
    else o = { kind: 'error', detail: `${(e as Error).name}: ${(e as Error).message}` };
  }
  return { ...o, changed: (await snapshot()) !== before };
}

// ---- input from the schema: each ref('<model>') field gets a fixture id, others a valid value
type J = { type?: string; format?: string; ref?: string; notRef?: boolean; properties?: Record<string, J>; items?: J; enum?: unknown[]; const?: unknown; minLength?: number; minimum?: number; anyOf?: J[] };
type Pick = (ref: string, path: string) => string;
const ID_FORMATS = ['uuid', 'guid', 'cuid', 'cuid2', 'ulid', 'nanoid', 'xid', 'ksuid'];
const ID_NAME = /^ids?$|Ids?$|[sS]lug|[tT]oken/;

export function generate(schema: z.ZodType, pick: Pick): { value: unknown; refPaths: string[] } {
  const refPaths: string[] = [];
  const walk = (j: J, at: string): unknown => {
    if (j.ref) return refPaths.push(at), pick(j.ref, at);
    if (j.const !== undefined) return j.const;
    if (j.enum) return j.enum[0];
    if (j.anyOf) return walk(j.anyOf.find((a) => a.type !== 'null') ?? j.anyOf[0]!, at);
    switch (j.type) {
      case 'object':
        return Object.fromEntries(Object.entries(j.properties ?? {}).map(([k, v]) => [k, walk(v, at ? `${at}.${k}` : k)]));
      case 'array':
        return [walk(j.items ?? {}, `${at}[0]`)];
      case 'string':
        // FR-08: an untagged id would be filled with 'x' and skip INV-02/03/04 silently.
        if (!j.notRef && (ID_FORMATS.includes(j.format ?? '') || ID_NAME.test(at.split('.').pop()!.replace(/\[0\]$/, ''))))
          throw new Error(`untagged id-like field "${at}": use ref('<model>') so the harness can scope it, or notRef() if it is not a row id`);
        if (j.format === 'email') return 'someone@example.test';
        return 'x'.repeat(Math.max(j.minLength ?? 1, 1));
      case 'integer':
      case 'number':
        return Math.max(j.minimum ?? 1, 1);
      case 'boolean':
        return true;
      default:
        throw new Error(`cannot generate "${at}" (${JSON.stringify(j)})`);
    }
  };
  return { value: walk(z.toJSONSchema(schema, { io: 'input' }) as J, ''), refPaths };
}

const idsOf = (o: Org) => (model: string) => {
  const id = refs[o.key][model];
  if (!id) throw new Error(`no fixture row for ref('${model}'): add one to tests/fixtures/app.ts`);
  return id;
};
const refused = (o: Outcome) => o.kind !== 'ok' && o.kind !== 'refused' && !o.changed;

export async function runInvariants(found: Found[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  await seed(); // fills `refs`, which generate() reads
  for (const { file, name, fn } of found) {
    const action = `${file}#${name}`;
    const spec = (fn as Partial<Action>)?.spec;
    // Rule 4 + INV-01: every export is an endpoint; one the harness cannot drive is unguarded until proven otherwise.
    if (typeof fn !== 'function' || !spec) {
      findings.push({ inv: 'INV-01', action, detail: 'export is not built by orgAction/userAction, so it cannot be verified' });
      continue;
    }
    const act = fn as Action;
    let gen: ReturnType<typeof generate>;
    try {
      gen = generate(spec.schema, idsOf(F.a));
    } catch (e) {
      findings.push({ inv: 'HARNESS', action, detail: (e as Error).message });
      continue;
    }
    const f = (inv: Finding['inv'], detail: string, o: Outcome) => findings.push({ inv, action, detail: `${detail}: ${o.kind} ${JSON.stringify(o.detail ?? '')}, rows changed: ${o.changed}` });

    // Sanity: as A's owner on A's rows, the guard lets the call through (a domain refusal is fine).
    const own = await call(act, F.a.owner, gen.value);
    if (own.kind !== 'ok' && own.kind !== 'refused') f('HARNESS', 'own-org call was stopped', own);

    const anon = await call(act, null, gen.value);
    if (!refused(anon)) f('INV-01', 'anonymous call', anon);

    if (spec.kind === 'org') {
      const noMfa = await call(act, F.a.adminNoMfa, gen.value, false);
      if (!(noMfa.kind === 'guard' && !noMfa.changed)) f('INV-22', 'admin without TOTP', noMfa);
    }

    if (!gen.refPaths.length) continue;
    const allB = await call(act, F.a.owner, generate(spec.schema, idsOf(F.b)).value);
    if (!refused(allB)) f('INV-02', 'every id from org B', allB);

    for (const p of gen.refPaths) {
      const swap = (o: Org | null) => generate(spec.schema, (model, at) => (at !== p ? idsOf(F.a)(model) : o ? idsOf(o)(model) : NONEXISTENT)).value;
      const cross = await call(act, F.a.owner, swap(F.b));
      if (gen.refPaths.length > 1 && !refused(cross)) f('INV-03', `"${p}" from org B`, cross);
      const missing = await call(act, F.a.owner, swap(null));
      const [c, m] = [JSON.stringify([cross.kind, cross.detail]), JSON.stringify([missing.kind, missing.detail])];
      if (c !== m) findings.push({ inv: 'INV-04', action, detail: `"${p}": cross-org ${c} ≠ nonexistent ${m}` });
    }
  }
  return findings;
}
