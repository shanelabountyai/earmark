import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import { now } from '@/core/clock';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { log } from '@/core/log';
import { hit } from '@/core/rate-limit';
import { API_SCOPES } from '@/app/api-scopes';
import { type ApiCtx, resolveKey } from './keys';
import { sweepWebhooks } from './webhooks';

// The one shape every /api/v1 route is written in (addendum §7, ported from Bookable W-002/W-004/W-006). On every
// request, in order: the key (401), the scope (403), the per-key rate limit (429 + Retry-After), then the handler.
// Errors are problem+json with one code vocabulary. A route file stays thin: `export const GET = api('read', fn)`.

const STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_SCOPE: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  IDEMPOTENCY_REQUIRED: 400,
  IDEMPOTENCY_MISMATCH: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  REFUSED: 422,
  RATE_LIMITED: 429,
} as const;
export type ProblemCode = keyof typeof STATUS;

/** Throw from a handler to answer with this problem. */
export class ApiProblem extends Error {
  constructor(
    readonly code: ProblemCode,
    detail: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
  }
}

const problemBody = (code: ProblemCode, detail: string) => ({ type: 'about:blank', title: code, status: STATUS[code], code, detail });

export const problem = (code: ProblemCode, detail: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(problemBody(code, detail)), {
    status: STATUS[code],
    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store', ...headers },
  });

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** A refusal a caller should see, or null for a bug (which stays a 500 and is logged by Next). */
function mapped(e: unknown): { code: ProblemCode; detail: string; headers: Record<string, string> } | null {
  if (e instanceof ApiProblem) return { code: e.code, detail: e.message, headers: e.headers };
  if (e instanceof Refused) return { code: 'REFUSED', detail: e.message, headers: {} };
  if ((e as { digest?: string })?.digest?.startsWith('NEXT_HTTP_ERROR_FALLBACK;404') || (e as { code?: string })?.code === 'P2025') {
    return { code: 'NOT_FOUND', detail: 'No such resource.', headers: {} }; // notFound() from shared core code: "not yours" ≡ "not found"
  }
  return null;
}

type RouteContext = { params: Promise<Record<string, string>> };
export type Handler = (ctx: ApiCtx, req: Request, params: Record<string, string>) => Promise<Response>;

/** Key, scope and rate limit for one request, or the problem to answer with. Exported for a clone's own routes (e.g. /ingest). */
export async function requireApiKey(req: Request, scope: string): Promise<ApiCtx | Response> {
  const ctx = await resolveKey(req.headers.get('authorization'));
  if (!ctx) return problem('UNAUTHENTICATED', `Send an API key as "Authorization: Bearer api_…". An owner or admin issues one under Settings → API keys.`, { 'WWW-Authenticate': 'Bearer' });
  if (!ctx.scopes.includes(scope)) return problem('FORBIDDEN_SCOPE', `This key does not have the "${scope}" scope.`);
  const perMinute = (API_SCOPES as Record<string, { perMinute: number }>)[scope]?.perMinute;
  if (!perMinute) throw new Error(`api-scopes.ts has no scope "${scope}"`);
  if (!(await hit(`api:${scope}:${ctx.keyId}`, { limit: perMinute, windowMs: 60_000 }))) {
    return problem('RATE_LIMITED', `Too many ${scope} requests for this key. Wait a minute.`, { 'Retry-After': '60' });
  }
  return ctx;
}

/** A Next route handler for /api/v1: GET needs `read`, anything else the scope given (default `write`). */
export function api(scope: string, handler: Handler) {
  return async (req: Request, rc?: RouteContext): Promise<Response> => {
    const ctx = await requireApiKey(req, scope);
    if (ctx instanceof Response) return ctx;
    try {
      return await handler(ctx, req, (await rc?.params) ?? {});
    } catch (e) {
      const m = mapped(e);
      if (m) return problem(m.code, m.detail, m.headers);
      throw e;
    }
  };
}

/** zod → VALIDATION naming the field. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiProblem('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
  return r.data;
}

export const query = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);

// ---- cursor pagination: a keyset cursor, opaque to the caller, capped at 100 (no offsets: they skip rows under writes)

export const limitField = z.coerce.number().int().min(1).max(100).default(25);

export function decodeCursor<S extends z.ZodType>(schema: S, cursor: string | undefined): z.infer<S> | null {
  if (cursor === undefined) return null;
  try {
    const r = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (r.success) return r.data;
  } catch {
    // fall through
  }
  throw new ApiProblem('VALIDATION', 'cursor: not a cursor this API issued. Start again without it.');
}

/** Fetch limit + 1, return limit: the extra row says whether there is a next page. */
export function page<T>(rows: T[], limit: number, keyOf: (row: T) => object) {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  return { data, nextCursor: Buffer.from(JSON.stringify(keyOf(data[data.length - 1]!))).toString('base64url') };
}

// ---- idempotent writes (Bookable W-006)

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** An in_progress claim older than this is abandoned (its process died): far beyond any live request. */
export const STALE_CLAIM_MS = 10 * 60_000;

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

export type WriteResult = { status: number; body: unknown };
export type WriteHandler = (ctx: ApiCtx, body: unknown, tx: Tx, params: Record<string, string>) => Promise<WriteResult>;

/**
 * A POST that needs an Idempotency-Key. The claim is one statement on the unique (apiKeyId, idemKey) and commits on
 * its own, before the work, so a concurrent retry sees `in_progress` (409) instead of queueing. The work and the
 * outcome commit in one transaction: a crash leaves only the claim, which a thrown failure releases and the stale
 * window reclaims. A refusal (REFUSED, NOT_FOUND, VALIDATION) is stored and replayed like a success, after its
 * savepoint undoes anything the handler wrote; a bug (500) releases the key so a retry runs again.
 * After a write commits, the org's webhooks are sent once the response is out (`after`); the sweep is the fallback.
 */
export function idempotent(scope: string, handler: WriteHandler) {
  return api(scope, async (ctx, req, params) => {
    const idemKey = req.headers.get('idempotency-key');
    if (!idemKey) throw new ApiProblem('IDEMPOTENCY_REQUIRED', 'Every POST needs an Idempotency-Key header: a value you choose, unique per intended write, reused on retries.');
    if (idemKey.trim() === '' || idemKey.length > 255) throw new ApiProblem('VALIDATION', 'Idempotency-Key: 1 to 255 characters.');
    const text = await req.text();
    let body: unknown = {};
    try {
      if (text.trim()) body = JSON.parse(text);
    } catch {
      throw new ApiProblem('VALIDATION', '(body): not JSON.');
    }
    const requestHash = createHash('sha256').update(`${req.method} ${new URL(req.url).pathname}\n${canonical(body)}`).digest('hex');
    const t = now();
    const claimed = await withOrg(ctx, (tx) => claim(tx, ctx, idemKey, requestHash, t));
    if ('existing' in claimed) {
      const row = claimed.existing;
      if (row.requestHash !== requestHash) throw new ApiProblem('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request. Use a new key for a new write.');
      if (row.status !== 'done') throw new ApiProblem('IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running. Retry in a moment.', { 'Retry-After': '1' });
      const nl = row.responseBody!.indexOf('\n');
      return new Response(row.responseBody!.slice(nl + 1), {
        status: row.responseStatus!,
        headers: { 'Content-Type': row.responseBody!.slice(0, nl), 'Cache-Control': 'no-store', 'Idempotent-Replayed': 'true' },
      });
    }

    let out: { status: number; type: string; text: string };
    try {
      out = await withOrg(ctx, async (tx) => {
        let r: typeof out;
        await tx.$executeRawUnsafe('SAVEPOINT api_write');
        try {
          const w = await handler(ctx, body, tx, params);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT api_write');
          r = { status: w.status, type: 'application/json', text: JSON.stringify(w.body) };
        } catch (e) {
          const m = mapped(e);
          if (!m) throw e;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT api_write'); // a refusal is an answer; nothing it wrote survives
          r = { status: STATUS[m.code], type: 'application/problem+json', text: JSON.stringify(problemBody(m.code, m.detail)) };
        }
        const { count } = await tx.idempotencyRecord.updateMany({
          where: { id: claimed.id, status: 'in_progress' },
          data: { status: 'done', responseStatus: r.status, responseBody: `${r.type}\n${r.text}`, updatedAt: now() },
        });
        if (count !== 1) throw new Error(`IdempotencyRecord ${claimed.id} was reclaimed under a live request`);
        return r;
      });
    } catch (e) {
      await withOrg(ctx, (tx) => tx.idempotencyRecord.deleteMany({ where: { id: claimed.id, status: 'in_progress' } }));
      throw e;
    }
    if (out.status < 300) after(() => sweepWebhooks({ orgId: ctx.orgId }).then((r) => log('webhooks.inline', { orgId: ctx.orgId, ...r })));
    return new Response(out.text, { status: out.status, headers: { 'Content-Type': out.type, 'Cache-Control': 'no-store' } });
  });
}

type Existing = { requestHash: string; status: string; responseStatus: number | null; responseBody: string | null };

/** The claim: a fresh key, an expired record (new id), or an abandoned in_progress one with the same request. */
async function claim(tx: Tx, ctx: ApiCtx, idemKey: string, requestHash: string, t: Date): Promise<{ id: string } | { existing: Existing }> {
  const expiresAt = new Date(t.getTime() + IDEMPOTENCY_TTL_MS);
  const staleBefore = new Date(t.getTime() - STALE_CLAIM_MS);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "IdempotencyRecord" ("id", "orgId", "apiKeyId", "idemKey", "requestHash", "status", "expiresAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${ctx.orgId}::uuid, ${ctx.keyId}::uuid, ${idemKey}, ${requestHash}, 'in_progress', ${expiresAt}, ${t}, ${t})
    ON CONFLICT ("apiKeyId", "idemKey") DO UPDATE SET
      "id" = CASE WHEN "IdempotencyRecord"."expiresAt" <= ${t} THEN EXCLUDED."id" ELSE "IdempotencyRecord"."id" END,
      "requestHash" = EXCLUDED."requestHash", "status" = 'in_progress', "responseStatus" = NULL, "responseBody" = NULL,
      "expiresAt" = EXCLUDED."expiresAt", "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
    WHERE "IdempotencyRecord"."expiresAt" <= ${t}
       OR ("IdempotencyRecord"."status" = 'in_progress' AND "IdempotencyRecord"."updatedAt" <= ${staleBefore}
           AND "IdempotencyRecord"."requestHash" = EXCLUDED."requestHash")
    RETURNING "id"`;
  if (rows[0]) return { id: rows[0].id };
  const existing = await tx.idempotencyRecord.findUniqueOrThrow({
    where: { apiKeyId_idemKey: { apiKeyId: ctx.keyId, idemKey } },
    select: { requestHash: true, status: true, responseStatus: true, responseBody: true },
  });
  return { existing };
}
