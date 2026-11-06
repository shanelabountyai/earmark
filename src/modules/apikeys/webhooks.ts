import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { openSecret, sealSecret } from '@/core/auth/secret-box';
import { assertNotDemo } from '@/core/auth/session';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { asSystem, withOrg } from '@/core/db/rls';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { safeEqual } from '@/core/tokens';
import { EVENT_TYPES } from '@/app/event-types';

// Outbound webhooks (addendum §7, ported from Bookable W-008 to W-011), per org.
// THE LOG IS THE SOURCE: emit() writes OrgEvent in the change's transaction; nothing here is told about it. fanOut reads
// committed events past each active endpoint's cursor and inserts one delivery per (endpoint, event), unique, so two
// sweeps can never make two rows (INV-41: a duplicate is sent once). Because seq is handed out at commit, "everything
// above my cursor" never skips an event that commits late. The claim is UPDATE … FOR UPDATE SKIP LOCKED, so two sweeps
// never send one row. Delivery is at least once: a receiver dedupes on the event id.

export const SIGNATURE_HEADER = 'Webhook-Signature';
/** Wait before attempts 2..6; after the 6th failure the delivery is `dead` (replayable from the settings page). */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** Consecutive failed attempts, across deliveries, that pause an endpoint. A 410 disables it at once. */
export const PAUSE_AFTER = 10;
export const ROTATION_OVERLAP_MS = 24 * 3_600_000;
/** A receiver rejects a signature whose timestamp is further than this from its clock (replay window). */
export const TOLERANCE_S = 300;
const SEND_TIMEOUT_MS = 10_000;
const STALE_SENDING_MS = 15 * 60_000;

/** Tests replace these; everything else uses the network. */
export const transport = { fetch: (url: string, init: RequestInit) => fetch(url, init), lookup: (host: string) => lookup(host, { all: true }) };

// ---- signing

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, one v1 per live secret (two during a rotation). */
export const signatureHeader = (secrets: readonly string[], t: number, body: string) =>
  [`t=${t}`, ...secrets.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`)].join(',');

/** The receiver's half, for a clone's integrators and its own tests: constant-time, and stale timestamps fail. */
export function verifySignature(secret: string, header: string | null, body: string, nowS = Math.floor(now().getTime() / 1000)): boolean {
  const parts = (header ?? '').split(',').map((p) => p.split('=', 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && safeEqual(v ?? '', want));
}

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

// ---- where a webhook may go: https, no credentials, no private address, checked at save AND at send (a name can be
// re-pointed at 169.254.169.254 after it was saved). WEBHOOK_ALLOW_PRIVATE=1 lifts it for a local receiver in tests.

function v4Private(ip: string) {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
export function isPrivateAddress(ip: string) {
  if (isIP(ip) === 4) return v4Private(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return v4Private(mapped[1]!);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * ponytail: resolve-then-fetch leaves a DNS-rebinding window of milliseconds; closing it means pinning the resolved
 * address into the connection (a custom dispatcher), worth it once endpoints point anywhere but the org's own tools.
 */
export async function checkUrl(raw: string, allowPrivate = env.WEBHOOK_ALLOW_PRIVATE === '1'): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Refused('The endpoint must be a URL.');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new Refused('The endpoint must be an https URL.');
  if (url.username || url.password) throw new Refused('The endpoint URL must not carry a user name or password.');
  if (allowPrivate) return url.toString();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = host === 'localhost' ? [{ address: '127.0.0.1' }] : isIP(host) ? [{ address: host }] : await transport.lookup(host).catch(() => []);
  if (!addrs.length) throw new Refused(`${host} does not resolve.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Refused('The endpoint must not point at a private address.');
  return url.toString();
}

// ---- owner controls (settings page). Every change needs apikeys.manage and is audited; secrets are shown once.

function assertManager(ctx: OrgCtx) {
  assertNotDemo(ctx.session);
}

function eventTypesOf(types: string[]) {
  const unknown = types.filter((t) => !(EVENT_TYPES as readonly string[]).includes(t));
  if (unknown.length) throw new Refused(`Not an event type this app publishes: ${unknown.join(', ')}.`);
  return [...new Set(types)];
}

const endpointOf = async (ctx: OrgCtx, id: string) =>
  (await withOrg(ctx, (tx) => tx.webhookEndpoint.findFirst({ where: { id, ...inOrg(ctx) } }), { atomic: false })) ?? notFound();

/** Starts at the org's current seq: it receives what happens from now on. The past is GET /api/v1/events?since=0. */
export async function createEndpoint(ctx: OrgCtx, input: { url: string; eventTypes: string[] }): Promise<string> {
  assertManager(ctx);
  const url = await checkUrl(input.url);
  const eventTypes = eventTypesOf(input.eventTypes);
  const secret = newSecret();
  await withOrg(ctx, async (tx) => {
    const { eventSeq } = await tx.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { eventSeq: true } });
    const ep = await tx.webhookEndpoint.create({ data: { ...inOrg(ctx), url, eventTypes, secretSealed: sealSecret(secret, 'webhook'), cursorSeq: eventSeq } });
    await audit(ctx, 'webhook.endpoint_created', { targetType: 'webhookEndpoint', targetId: ep.id, data: { url, eventTypes } }, tx);
  });
  return secret;
}

/** A new secret, returned once. The old one keeps signing for 24 hours; rotating again inside that drops the oldest. */
export async function rotateSecret(ctx: OrgCtx, id: string): Promise<string> {
  assertManager(ctx);
  const ep = await endpointOf(ctx, id);
  const secret = newSecret();
  await withOrg(ctx, async (tx) => {
    await tx.webhookEndpoint.update({
      where: { id: ep.id },
      data: { secretSealed: sealSecret(secret, 'webhook'), previousSecretSealed: ep.secretSealed, previousSecretExpiresAt: new Date(now().getTime() + ROTATION_OVERLAP_MS) },
    });
    await audit(ctx, 'webhook.secret_rotated', { targetType: 'webhookEndpoint', targetId: ep.id }, tx);
  });
  return secret;
}

/** `active` resumes (failure count cleared) and gets the backlog its cursor never passed; `disabled` is the owner's off. */
export async function setEndpointStatus(ctx: OrgCtx, id: string, to: 'active' | 'disabled') {
  assertManager(ctx);
  const ep = await endpointOf(ctx, id);
  await withOrg(ctx, async (tx) => {
    await tx.webhookEndpoint.update({
      where: { id: ep.id },
      data: to === 'active' ? { status: 'active', consecutiveFailures: 0, disabledAt: null, disabledReason: null } : { status: 'disabled', disabledAt: now(), disabledReason: 'Switched off by an owner or admin.' },
    });
    await audit(ctx, to === 'active' ? 'webhook.endpoint_resumed' : 'webhook.endpoint_disabled', { targetType: 'webhookEndpoint', targetId: ep.id }, tx);
  });
}

export async function deleteEndpoint(ctx: OrgCtx, id: string) {
  assertManager(ctx);
  const ep = await endpointOf(ctx, id);
  await withOrg(ctx, async (tx) => {
    await tx.webhookEndpoint.deleteMany({ where: { id: ep.id, ...inOrg(ctx) } });
    await audit(ctx, 'webhook.endpoint_deleted', { targetType: 'webhookEndpoint', targetId: ep.id, data: { url: ep.url } }, tx);
  });
}

/**
 * Sends one delivery again: pending now, `replayed: true` in the body, six fresh attempts. The body is the event's
 * stored payload: what was true then, not now. A row mid-send is left alone.
 */
export async function replayDelivery(ctx: OrgCtx, id: string) {
  assertManager(ctx);
  await withOrg(ctx, async (tx) => {
    if (!(await tx.webhookDelivery.count({ where: { id, ...inOrg(ctx) } }))) notFound(); // not yours ≡ not found (INV-04)
    const { count } = await tx.webhookDelivery.updateMany({
      where: { id, ...inOrg(ctx), status: { not: 'sending' } },
      data: { status: 'pending', replayed: true, attempts: 0, nextAttemptAt: null, lastError: null, updatedAt: now() },
    });
    if (count !== 1) throw new Refused('That delivery is being sent right now. Try again in a moment.');
    await audit(ctx, 'webhook.delivery_replayed', { targetType: 'webhookDelivery', targetId: id }, tx);
  });
}

export const listEndpoints = (ctx: OrgCtx) =>
  withOrg(
    ctx,
    (tx) =>
      tx.webhookEndpoint.findMany({
        where: inOrg(ctx),
        orderBy: { createdAt: 'asc' },
        select: { id: true, url: true, eventTypes: true, status: true, consecutiveFailures: true, disabledReason: true, cursorSeq: true, previousSecretExpiresAt: true, createdAt: true },
      }),
    { atomic: false },
  );

export const listDeliveries = (ctx: OrgCtx, take = 50) =>
  withOrg(
    ctx,
    (tx) =>
      tx.webhookDelivery.findMany({
        where: inOrg(ctx),
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        take,
        select: { id: true, seq: true, status: true, attempts: true, nextAttemptAt: true, lastResponseStatus: true, lastError: true, replayed: true, createdAt: true, event: { select: { type: true } }, endpoint: { select: { url: true } } },
      }),
    { atomic: false },
  );

// ---- the pipeline. Runs as the system role: the cron sweep crosses orgs, and the inline one is scoped by orgId.

/** The body every delivery of an event sends, and GET /api/v1/events returns. */
export const eventBody = (e: { id: string; type: string; seq: number | null; payload: unknown; createdAt: Date }, replayed = false) => ({
  id: e.id,
  type: e.type,
  seq: e.seq!,
  occurredAt: e.createdAt.toISOString(),
  apiVersion: 'v1',
  data: e.payload,
  replayed,
});

/** Delivery rows for every committed event past each active endpoint's cursor. */
export async function fanOut(orgId?: string): Promise<number> {
  return asSystem(async (sys) => {
    let queued = 0;
    const endpoints = await sys.webhookEndpoint.findMany({ where: { status: 'active', ...(orgId && { orgId }) }, select: { id: true } });
    for (const { id } of endpoints) {
      queued += await sys.$transaction(async (tx) => {
        // SKIP LOCKED: a concurrent sweep is already fanning this endpoint out.
        const [ep] = await tx.$queryRaw<{ orgId: string; cursorSeq: number; eventTypes: string[] }[]>`
          SELECT "orgId", "cursorSeq", "eventTypes" FROM "WebhookEndpoint" WHERE id = ${id}::uuid AND status = 'active' FOR UPDATE SKIP LOCKED`;
        if (!ep) return 0;
        const events = await tx.orgEvent.findMany({ where: { orgId: ep.orgId, seq: { gt: ep.cursorSeq } }, orderBy: { seq: 'asc' }, take: 500, select: { id: true, seq: true, type: true } });
        if (!events.length) return 0;
        const wanted = events.filter((e) => !ep.eventTypes.length || ep.eventTypes.includes(e.type));
        const { count } = await tx.webhookDelivery.createMany({
          data: wanted.map((e) => ({ orgId: ep.orgId, endpointId: id, eventId: e.id, seq: e.seq! })),
          skipDuplicates: true,
        });
        await tx.webhookEndpoint.update({ where: { id }, data: { cursorSeq: events.at(-1)!.seq! } });
        return count;
      });
    }
    return queued;
  });
}

type Claimed = { id: string; endpointId: string; eventId: string; attempts: number; replayed: boolean };

/** One due delivery, claimed (`sending`, attempts + 1), lowest seq first, or null. */
async function claimDelivery(orgId: string | undefined, skip: string[]): Promise<Claimed | null> {
  const t = now();
  const staleBefore = new Date(t.getTime() - STALE_SENDING_MS);
  const rows = await asSystem((sys) => sys.$queryRaw<Claimed[]>`
    UPDATE "WebhookDelivery" AS d SET status = 'sending', attempts = d.attempts + 1, "updatedAt" = ${t}
     WHERE d.id = (
       SELECT c.id FROM "WebhookDelivery" c JOIN "WebhookEndpoint" e ON e.id = c."endpointId"
        WHERE e.status = 'active'
          AND (${orgId ?? null}::uuid IS NULL OR c."orgId" = ${orgId ?? null}::uuid)
          AND NOT (c."endpointId" = ANY(${skip}::uuid[]))
          AND ((c.status IN ('pending', 'failed') AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${t}))
               OR (c.status = 'sending' AND c."updatedAt" < ${staleBefore}))
        ORDER BY c.seq, c.id LIMIT 1
        FOR UPDATE OF c SKIP LOCKED)
    RETURNING d.id, d."endpointId", d."eventId", d.attempts, d.replayed`);
  return rows[0] ?? null;
}

type Outcome = { ok: boolean; status: number | null; excerpt: string | null; error: string | null };

async function send(url: string, headers: Record<string, string>, body: string): Promise<Outcome> {
  try {
    await checkUrl(url); // again at send time: DNS may have moved
    const res = await transport.fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    const excerpt = (await res.text().catch(() => '')).slice(0, 1024);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, excerpt, error: ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, excerpt: null, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : 'unknown error' };
  }
}

/** Sends one claimed delivery and records the outcome on it and on its endpoint. */
async function deliver(c: Claimed): Promise<'succeeded' | 'failed' | 'dead'> {
  return asSystem(async (sys) => {
    const t = now();
    const ep = await sys.webhookEndpoint.findUniqueOrThrow({ where: { id: c.endpointId } });
    const event = await sys.orgEvent.findUniqueOrThrow({ where: { id: c.eventId } });
    const body = JSON.stringify(eventBody(event, c.replayed));
    const secrets = [openSecret(ep.secretSealed, 'webhook')];
    if (ep.previousSecretSealed && ep.previousSecretExpiresAt && ep.previousSecretExpiresAt > t) secrets.push(openSecret(ep.previousSecretSealed, 'webhook'));
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Foundation-Webhooks/1',
      [SIGNATURE_HEADER]: signatureHeader(secrets.filter((s): s is string => !!s), Math.floor(t.getTime() / 1000), body),
      'Webhook-Event-Id': event.id,
      'Webhook-Event-Type': event.type,
      'Webhook-Delivery-Id': c.id,
      'Webhook-Attempt': String(c.attempts),
    };
    const o = await send(ep.url, headers, body);
    const last = { lastResponseStatus: o.status, lastResponseExcerpt: o.excerpt, lastError: o.error, updatedAt: now() };
    if (o.ok) {
      await sys.$transaction([
        sys.webhookDelivery.update({ where: { id: c.id }, data: { status: 'succeeded', succeededAt: t, nextAttemptAt: null, ...last } }),
        sys.webhookEndpoint.update({ where: { id: ep.id }, data: { consecutiveFailures: 0 } }),
      ]);
      return 'succeeded';
    }
    const dead = c.attempts >= MAX_ATTEMPTS;
    const failures = ep.consecutiveFailures + 1;
    const patch =
      o.status === 410
        ? { status: 'disabled', disabledAt: t, disabledReason: 'The receiver answered 410 Gone.' }
        : failures >= PAUSE_AFTER
          ? { status: 'paused', disabledAt: t, disabledReason: `${failures} deliveries in a row failed; last: ${o.error}.` }
          : {};
    await sys.$transaction([
      sys.webhookDelivery.update({ where: { id: c.id }, data: { status: dead ? 'dead' : 'failed', nextAttemptAt: dead ? null : new Date(t.getTime() + BACKOFF_MS[c.attempts - 1]!), ...last } }),
      sys.webhookEndpoint.update({ where: { id: ep.id }, data: { consecutiveFailures: failures, ...patch } }),
    ]);
    return dead ? 'dead' : 'failed';
  });
}

/**
 * Fan out, then send what is due, lowest seq first. An endpoint that fails once is skipped for the rest of the sweep:
 * its backoff has started, and a dead receiver must not cost ten seconds per queued row. Runs inline after an API
 * write (scoped to that org) and from /api/cron (every org); the cron run also prunes expired idempotency records.
 */
export async function sweepWebhooks(opts: { orgId?: string; maxSends?: number } = {}) {
  const r = { queued: await fanOut(opts.orgId), succeeded: 0, failed: 0, dead: 0 };
  const skip: string[] = [];
  for (let i = 0; i < (opts.maxSends ?? 50); i++) {
    const c = await claimDelivery(opts.orgId, skip);
    if (!c) break;
    const outcome = await deliver(c);
    r[outcome]++;
    if (outcome !== 'succeeded') skip.push(c.endpointId);
  }
  return r;
}

/** /api/cron: every org's webhooks, then the idempotency records past their 24 hours. */
export async function cronWebhooks() {
  return { ...(await sweepWebhooks()), idempotencyPruned: (await asSystem((sys) => sys.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: now() } } }))).count };
}
