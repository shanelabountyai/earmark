import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { audit, auditEvents } from '@/core/audit';
import { assertFresh } from '@/core/auth/session';
import type { OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { asSystem, withOrg, type Tx } from '@/core/db/rls';
import { sendEmail } from '@/core/email/transport';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { log } from '@/core/log';
import { hit, LIMITS } from '@/core/rate-limit';

// Per-org data export (addendum §5). An owner asks; the zip is built right after the request (and by /api/cron as the
// backstop), kept in OrgExport for 24 hours, and downloaded from a page that checks sign-in and the owner role.
// Every read runs through withOrg, so in enforce mode RLS bounds the export too.

/** One file in the archive. `rows` is the allowlist: select only columns that are safe to hand over (INV-34). */
export type ExportTable = { name: string; rows: (tx: Tx, orgId: string) => Promise<object[]> };

export const CORE_EXPORT_TABLES: readonly ExportTable[] = [
  { name: 'Org', rows: (tx, orgId) => tx.org.findMany({ where: { id: orgId }, select: { id: true, slug: true, name: true, createdAt: true, updatedAt: true } }) },
  {
    name: 'Membership',
    rows: (tx, orgId) =>
      tx.membership.findMany({ where: { orgId }, select: { userId: true, role: true, createdAt: true, updatedAt: true, user: { select: { email: true, name: true } } } }),
  },
  {
    name: 'Invite', // never tokenHash
    rows: (tx, orgId) =>
      tx.invite.findMany({ where: { orgId }, select: { id: true, email: true, role: true, invitedById: true, expiresAt: true, acceptedAt: true, revokedAt: true, createdAt: true } }),
  },
  {
    name: 'ShareLink', // never tokenHash
    rows: (tx, orgId) =>
      tx.shareLink.findMany({ where: { orgId }, select: { id: true, resourceType: true, resourceId: true, createdById: true, expiresAt: true, revokedAt: true, createdAt: true } }),
  },
  { name: 'AuditEvent', rows: (tx, orgId) => auditEvents(tx, orgId) },
  {
    name: 'AiUsage',
    rows: (tx, orgId) =>
      tx.aiUsage.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, select: { id: true, provider: true, model: true, inputTokens: true, outputTokens: true, costMicros: true, feature: true, actorId: true, createdAt: true } }),
  },
  {
    name: 'AiBudget',
    rows: (tx, orgId) =>
      tx.aiBudget.findMany({ where: { orgId }, select: { monthlyCapMicros: true, hardStop: true, alertAtPct: true, pausedAt: true, updatedAt: true } }),
  },
  { name: 'OrgEvent', rows: (tx, orgId) => tx.orgEvent.findMany({ where: { orgId }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, type: true, payload: true, key: true, createdAt: true } }) },
  { name: 'Project', rows: (tx, orgId) => tx.project.findMany({ where: { orgId }, select: { id: true, name: true, notes: true, createdAt: true } }) },
];

/** Org-owned models deliberately left out, each with its reason. INV-34 fails on any other orgId model not exported. */
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  OrgExport: 'the archives themselves',
  AiHold: 'in-flight reservations of AI calls, minutes long; the AiUsage ledger is exported',
  IdempotencyRecord: 'a 24-hour replay cache of API responses; the changes they made are in their own tables', // apikeys, harmless when absent
  WebhookDelivery: 'send attempts; the events they carried are exported as OrgEvent', // apikeys, harmless when absent
  SsoState: 'ten-minute sign-in state: a nonce and PKCE verifier, nothing the org owns', // goes with the sso module, harmless when absent
};

const DAY_MS = 86_400_000;
const STALE_BUILD_MS = 3_600_000;
export const MAX_EXPORT_BYTES = 500 * 1024 * 1024; // §5 size guard
const ACTIVE = ['pending', 'building'];

/** Owner only (the caller's guard), fresh sign-in (INV-26), one at a time, one per hour. Returns the export id. */
export async function requestExport(ctx: OrgCtx): Promise<string> {
  assertFresh(ctx.session);
  const active = await withOrg(ctx, (tx) => tx.orgExport.count({ where: { orgId: ctx.orgId, status: { in: ACTIVE } } }), { atomic: false });
  if (active) throw new Refused('An export is already being built. The link arrives by email.');
  if (!(await hit(`export:org:${ctx.orgId}`, LIMITS.exportPerOrg))) throw new Refused('One export an hour. Try again later.');
  const t = now();
  return withOrg(ctx, async (tx) => {
    const { id } = await tx.orgExport.create({
      data: { orgId: ctx.orgId, requestedById: ctx.userId, createdAt: t, expiresAt: new Date(t.getTime() + DAY_MS) },
      select: { id: true },
    });
    await audit(ctx, 'export.requested', { targetType: 'OrgExport', targetId: id }, tx);
    return id;
  });
}

/**
 * Builds one export if it is still waiting (or its build died over an hour ago), stores it, and emails the
 * requester a link to the download page. `tables` is the app's list: module tables plus the clone's export-hooks.
 */
export async function buildExport(ctx: { orgId: string }, id: string, tables: readonly ExportTable[], maxBytes = MAX_EXPORT_BYTES): Promise<string> {
  const stale = new Date(now().getTime() - STALE_BUILD_MS);
  const claimed = await withOrg(ctx, (tx) =>
    tx.orgExport.updateMany({ where: { id, orgId: ctx.orgId, OR: [{ status: 'pending' }, { status: 'building', createdAt: { lt: stale } }] }, data: { status: 'building' } }),
  );
  if (!claimed.count) return 'skipped';
  try {
    const status = await build(ctx, id, [...CORE_EXPORT_TABLES, ...tables], maxBytes);
    await notify(ctx, id, status);
    return status;
  } catch (e) {
    log('export.failed', { id, error: e instanceof Error ? e.message : String(e) });
    await withOrg(ctx, (tx) => tx.orgExport.updateMany({ where: { id, orgId: ctx.orgId }, data: { status: 'failed' } }));
    return 'failed';
  }
}

async function build(ctx: { orgId: string }, id: string, tables: ExportTable[], maxBytes: number) {
  const files: ZipFile[] = [];
  const listed: { name: string; file: string; rows: number; sha256: string }[] = [];
  let total = 0;
  // ponytail: each table is read whole into memory, and tables are read one by one (no cross-table snapshot);
  // page with a cursor and use one REPEATABLE READ transaction if a clone's export grows large.
  for (const t of tables) {
    const rows = await withOrg(ctx, (tx) => t.rows(tx, ctx.orgId), { atomic: false });
    const data = Buffer.from(rows.map((r) => `${JSON.stringify(r, bigints)}\n`).join(''));
    total += data.length;
    if (total > maxBytes) {
      await withOrg(ctx, (tx) => tx.orgExport.updateMany({ where: { id, orgId: ctx.orgId }, data: { status: 'too_large' } }));
      return 'too_large';
    }
    const file = `${t.name}.jsonl`;
    files.push({ name: file, data });
    listed.push({ name: t.name, file, rows: rows.length, sha256: sha256(data) });
  }
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { id: true, slug: true, name: true } });
  const manifest = Buffer.from(
    JSON.stringify({ org, exportId: id, createdAt: now(), schemaVersion: await schemaVersion(), foundationVersion: foundationVersion(), tables: listed }, null, 2),
  );
  const archive = zip([...files, { name: 'manifest.json', data: manifest }]);
  const sha = sha256(manifest);
  await withOrg(ctx, async (tx) => {
    await tx.orgExport.updateMany({
      where: { id, orgId: ctx.orgId },
      data: { status: 'ready', archive: new Uint8Array(archive), bytes: archive.length, sha256: sha, readyAt: now() },
    });
    await audit({ orgId: ctx.orgId, userId: null }, 'export.ready', { targetType: 'OrgExport', targetId: id, data: { sha256: sha } }, tx);
  });
  return 'ready';
}

async function notify(ctx: { orgId: string }, id: string, status: string) {
  const e = await withOrg(ctx, (tx) => tx.orgExport.findFirstOrThrow({ where: { id, orgId: ctx.orgId }, select: { requestedById: true } }), { atomic: false });
  const [user, org] = await Promise.all([
    db.user.findUnique({ where: { id: e.requestedById }, select: { email: true } }),
    db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { slug: true, name: true } }),
  ]);
  if (!user) return;
  const page = `${env.APP_URL}/o/${org.slug}/settings/danger/export/${id}`;
  await sendEmail(
    status === 'ready'
      ? { to: user.email, subject: `Your ${org.name} export is ready`, body: `Sign in to download it within 24 hours: ${page}` }
      : { to: user.email, subject: `Your ${org.name} export is too large`, body: `The export is over 500 MB, so it was stopped. Contact support for a full copy.` },
  );
}

/** The ready archive, or null; writes `export.downloaded` with the manifest's sha256. The caller's guard is owner-only. */
export async function downloadExport(ctx: OrgCtx, id: string) {
  return withOrg(ctx, async (tx) => {
    const e = await tx.orgExport.findFirst({ where: { id, orgId: ctx.orgId }, select: { status: true, archive: true, sha256: true, expiresAt: true, createdAt: true } });
    if (!e?.archive || e.status !== 'ready' || e.expiresAt <= now()) return null;
    await audit(ctx, 'export.downloaded', { targetType: 'OrgExport', targetId: id, data: { sha256: e.sha256 } }, tx);
    return { archive: e.archive, createdAt: e.createdAt };
  });
}

/** /api/cron: deletes expired exports and builds any still waiting, in every org. */
export async function runExports(tables: readonly ExportTable[]) {
  const t = now();
  const { swept, waiting } = await asSystem(async (sys) => ({
    swept: (await sys.orgExport.deleteMany({ where: { expiresAt: { lte: t } } })).count,
    waiting: await sys.orgExport.findMany({ where: { status: { in: ACTIVE } }, select: { id: true, orgId: true } }),
  }));
  const out: Record<string, number> = { exportsSwept: swept };
  for (const w of waiting) {
    const key = `exports_${await buildExport({ orgId: w.orgId }, w.id, tables)}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

const bigints = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const schemaVersion = () =>
  asSystem(async (sys) => (await sys.$queryRaw<{ m: string }[]>`SELECT max(migration_name) AS m FROM _prisma_migrations WHERE finished_at IS NOT NULL`)[0]?.m ?? null);

function foundationVersion(): string | null {
  try {
    return readFileSync(join(process.cwd(), 'FOUNDATION_VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

type ZipFile = { name: string; data: Buffer };

/**
 * A plain zip: every entry stored (method 0), so the archive is the JSON Lines byte for byte and INV-34 can scan it
 * directly. ponytail: no compression and zip32 only (4 GB), both far past the 500 MB guard; deflate if size matters.
 */
export function zip(files: ZipFile[]): Buffer {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01: no clock in the bytes, so one export's archive is reproducible
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(f.data.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, f.data);
    central.push(entry, name);
    offset += 30 + name.length + f.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
