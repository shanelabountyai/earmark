import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReauthRequired } from '@/core/auth/session';
import { sealSecret } from '@/core/auth/secret-box';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { Refused } from '@/core/errors';
import { createShareLink } from '@/core/share/links';
import { buildExport, CORE_EXPORT_TABLES, downloadExport, NOT_EXPORTED, requestExport, runExports } from '@/core/tenancy/export';
import { createInvite } from '@/core/tenancy/invites';
import { hashToken, newToken } from '@/core/tokens';
import { exportSkipped, exportTables } from '@/app/export-hooks';
import { orgTables } from '../../scripts/rls-policies';
import { allTables, enrol, resetAuthTables, signInAs } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

beforeEach(resetAuthTables);

/** Unpacks with the system `unzip`, so the archive is checked by a reader that is not ours. */
function unpack(archive: Uint8Array): Record<string, string> {
  const file = join(mkdtempSync(join(tmpdir(), 'inv34-')), 'export.zip');
  writeFileSync(file, archive);
  execFileSync('unzip', ['-tq', file]); // throws on a bad CRC, offset or directory
  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
  return Object.fromEntries(names.map((n) => [n, execFileSync('unzip', ['-p', file, n], { encoding: 'utf8' })]));
}

/** A fixture org holding one of every secret the template stores, plus a second org whose rows must not appear. */
async function fixture() {
  const org = await makeOrg('acme');
  const owner = await db.user.create({ data: { email: 'owner@acme.test' } });
  await db.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
  const sessionToken = await signInAs(owner.id);
  const { secret, codes } = await enrol(); // sealed TOTP seed + recovery codes
  const ctx = await actAs(owner.id, org.slug);
  await createInvite(ctx, 'new@acme.test', 'member');
  const inviteToken = /invite\/([\w-]+)/.exec((await db.capturedMessage.findFirstOrThrow()).body)![1]!;
  const project = await db.project.create({ data: { orgId: org.id, name: 'Acme roadmap', notes: 'internal' } });
  const shareUrl = await createShareLink(ctx, 'project', project.id, 7);
  const loginToken = newToken();
  await db.loginToken.create({ data: { hash: hashToken(loginToken), purpose: 'login', email: 'owner@acme.test', userId: owner.id, createdAt: new Date(), expiresAt: new Date() } });
  const known = [secret, ...codes, ...codes.map(hashToken), sessionToken, hashToken(sessionToken), inviteToken, hashToken(inviteToken), shareUrl.split('/s/')[1]!, loginToken, hashToken(loginToken)];
  known.push(...(await db.user.findMany({ select: { totpSecretSealed: true } })).flatMap((u) => (u.totpSecretSealed ? [u.totpSecretSealed] : [])));
  known.push(...(await db.recoveryCode.findMany({ select: { hash: true } })).map((r) => r.hash));
  // Module tables, written raw so this file holds when a module is removed (foundation:check-modules).
  const tables = await allTables();
  if (tables.includes('SsoConnection')) {
    const sealed = sealSecret('sso-client-secret-inv34', 'sso');
    await db.$executeRaw`INSERT INTO "SsoConnection" (id, "orgId", issuer, "clientId", "clientSecretSealed", "allowedDomains", "updatedAt") VALUES (gen_random_uuid(), ${org.id}::uuid, 'https://idp.example.test', 'client-inv34', ${sealed}, '{}', now())`;
    await db.$executeRaw`INSERT INTO "SsoState" (hash, "orgId", nonce, "codeVerifier", "createdAt", "expiresAt") VALUES ('state-hash-inv34', ${org.id}::uuid, 'nonce-inv34', 'verifier-inv34', now(), now())`;
    known.push(sealed, 'sso-client-secret-inv34', 'state-hash-inv34', 'nonce-inv34', 'verifier-inv34');
  }
  if (tables.includes('ApiKey')) {
    const key = `api_${newToken()}`;
    const sealed = sealSecret('whsec_inv34', 'webhook');
    await db.$executeRaw`INSERT INTO "ApiKey" (id, "orgId", label, prefix, "keyHash", scopes, "createdById") VALUES (gen_random_uuid(), ${org.id}::uuid, 'crm', 'api_xx', ${hashToken(key)}, '{read}', ${owner.id}::uuid)`;
    await db.$executeRaw`INSERT INTO "WebhookEndpoint" (id, "orgId", url, "secretSealed", "previousSecretSealed", "eventTypes", "updatedAt") VALUES (gen_random_uuid(), ${org.id}::uuid, 'https://hooks.example.test', ${sealed}, ${sealed}, '{}', now())`;
    known.push(key, hashToken(key), sealed, 'whsec_inv34');
  }
  if (tables.includes('Outbox')) {
    const t = newToken();
    await db.$executeRaw`INSERT INTO "Outbox" (id, "orgId", channel, "to", template, data) VALUES (gen_random_uuid(), ${org.id}::uuid, 'email', 'new@acme.test', 'invite', ${JSON.stringify({ url: `https://x.test/onboarding/invite/${t}` })}::jsonb)`;
    known.push(t);
  }
  const other = await makeOrg('globex');
  await db.project.create({ data: { orgId: other.id, name: 'Globex secret plan' } });
  return { org, ctx, known };
}

async function exportOf(ctx: Awaited<ReturnType<typeof fixture>>['ctx']) {
  const id = await requestExport(ctx);
  expect(await buildExport(ctx, id, exportTables)).toBe('ready');
  const row = await db.orgExport.findUniqueOrThrow({ where: { id } });
  return { id, row, files: unpack(row.archive!) };
}

describe('INV-34 a data export holds no sealed secret, token hash or recovery code', () => {
  it('scans every file for the fixture\'s known secrets and anything token-shaped', async () => {
    const { ctx, known } = await fixture();
    const { row, files } = await exportOf(ctx);
    const raw = Buffer.from(row.archive!).toString('latin1'); // stored entries: the archive is the files byte for byte
    for (const k of known) expect(raw, `export contains ${k.slice(0, 12)}…`).not.toContain(k);
    for (const [name, text] of Object.entries(files)) {
      if (name === 'manifest.json') continue; // holds the files' own sha256s, by design
      expect(text, name).not.toMatch(/\b[0-9a-f]{64}\b/); // sha256 token hashes
      expect(text, name).not.toMatch(/\b[A-Z2-7]{32,}\b/); // base32 TOTP seeds
      expect(text, name).not.toMatch(/[\w-]{16}\.[\w-]+\.[\w-]{22}/); // sealSecret output: iv.ciphertext.tag
    }
  });

  it('verifies against its manifest: every file listed, sha256 and row count match', async () => {
    const { org, ctx } = await fixture();
    const { row, files } = await exportOf(ctx);
    const manifest = JSON.parse(files['manifest.json']!);
    expect(manifest.org).toMatchObject({ id: org.id, slug: 'acme' });
    expect(row.sha256).toBe(createHash('sha256').update(files['manifest.json']!).digest('hex'));
    expect(Object.keys(files).sort()).toEqual([...manifest.tables.map((t: { file: string }) => t.file), 'manifest.json'].sort());
    for (const t of manifest.tables) {
      const text = files[t.file]!;
      expect(createHash('sha256').update(text).digest('hex'), t.file).toBe(t.sha256);
      expect(text.split('\n').filter(Boolean).length, t.file).toBe(t.rows);
    }
    for (const core of ['Org', 'Membership', 'Invite', 'ShareLink', 'AuditEvent', 'Project']) expect(manifest.tables.map((t: { name: string }) => t.name)).toContain(core);
    expect(files['Project.jsonl']).toContain('Acme roadmap');
    expect(Object.values(files).join('')).not.toContain('Globex secret plan'); // another org's rows never appear
    expect(files['Membership.jsonl']).toContain('owner@acme.test');
  });
});

describe('INV-34 every org-owned table is exported or skipped with a reason', () => {
  it('compares the schema\'s orgId models to the export lists (like INV-30 for policies)', () => {
    const covered = new Set([...CORE_EXPORT_TABLES, ...exportTables].map((t) => t.name).concat(Object.keys(NOT_EXPORTED), Object.keys(exportSkipped)));
    const missing = orgTables().map((t) => t.model).filter((m) => !covered.has(m));
    expect(missing, 'add each to exportTables or exportSkipped in src/app/export-hooks.ts').toEqual([]);
  });
});

describe('export requests and delivery (addendum §5)', () => {
  it('needs a fresh sign-in, allows one at a time and one an hour', async () => {
    const org = await makeOrg('acme');
    const ctx = await actAs((await addMember(org.id, 'owner', 'owner@acme.test')).id, org.slug);
    advanceClock(5 * 60_000 + 1000);
    await expect(requestExport(ctx)).rejects.toBeInstanceOf(ReauthRequired); // INV-26 extended
    advanceClock(0);
    const id = await requestExport(ctx);
    await expect(requestExport(ctx)).rejects.toBeInstanceOf(Refused); // one at a time
    await buildExport(ctx, id, exportTables);
    await expect(requestExport(ctx)).rejects.toThrow(/One export an hour/);
    expect(await db.auditEvent.count({ where: { action: 'export.requested' } })).toBe(1);
  });

  it('emails the requester a page link, not a file URL; downloads are audited with the sha256; expired ones are swept', async () => {
    const org = await makeOrg('acme');
    const ctx = await actAs((await addMember(org.id, 'owner', 'owner@acme.test')).id, org.slug);
    const id = await requestExport(ctx);
    expect(await runExports(exportTables)).toMatchObject({ exportsSwept: 0, exports_ready: 1 }); // the cron backstop builds it
    const mail = await db.capturedMessage.findFirstOrThrow({ where: { to: 'owner@acme.test' } });
    expect(mail.body).toContain(`/o/acme/settings/danger/export/${id}`);
    const got = await downloadExport(ctx, id);
    expect(got?.archive.length).toBeGreaterThan(0);
    const { sha256 } = await db.orgExport.findUniqueOrThrow({ where: { id } });
    expect((await db.auditEvent.findFirstOrThrow({ where: { action: 'export.downloaded' } })).data).toEqual({ sha256 });
    advanceClock(24 * 3_600_000 + 1000);
    expect(await downloadExport(ctx, id)).toBeNull();
    expect(await runExports(exportTables)).toMatchObject({ exportsSwept: 1 });
    expect(await db.orgExport.count()).toBe(0);
  });

  it('stops past the size guard and tells the owner', async () => {
    const org = await makeOrg('acme');
    const ctx = await actAs((await addMember(org.id, 'owner', 'owner@acme.test')).id, org.slug);
    const id = await requestExport(ctx);
    expect(await buildExport(ctx, id, exportTables, 10)).toBe('too_large');
    expect((await db.orgExport.findUniqueOrThrow({ where: { id } })).archive).toBeNull();
    expect((await db.capturedMessage.findFirstOrThrow()).subject).toMatch(/too large/);
  });

  it("another org's owner cannot download it", async () => {
    const a = await makeOrg('acme');
    const ctxA = await actAs((await addMember(a.id, 'owner', 'owner@acme.test')).id, a.slug);
    const id = await requestExport(ctxA);
    await buildExport(ctxA, id, exportTables);
    const b = await makeOrg('globex');
    const ctxB = await actAs((await addMember(b.id, 'owner', 'owner@globex.test')).id, b.slug);
    expect(await downloadExport(ctxB, id)).toBeNull();
  });
});
