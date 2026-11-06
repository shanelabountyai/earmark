// public: an API key via requireApiKey (apikeys module, INV-40), not a session
import { z } from 'zod';
import { audit } from '@/core/audit';
import { inOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { emit } from '@/core/events';
import { api, decodeCursor, idempotent, json, limitField, page, parse, query } from '@/modules/apikeys/api';

// The template's example resource over the API (addendum §7). A clone replaces Project with its own, as on the pages.
const view = (p: { id: string; name: string; createdAt: Date }) => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString() }); // never notes (INV-08)
// Keyset on id: stable under writes. Not createdAt, whose microseconds a millisecond cursor cannot carry.
const cursor = z.object({ id: z.uuid() });

export const GET = api('read', async (ctx, req) => {
  const q = parse(z.object({ limit: limitField, cursor: z.string().optional() }).strict(), query(req));
  const after = decodeCursor(cursor, q.cursor);
  const rows = await withOrg(
    ctx,
    (tx) =>
      tx.project.findMany({
        where: { ...inOrg(ctx), ...(after && { id: { gt: after.id } }) },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
        select: { id: true, name: true, createdAt: true },
      }),
    { atomic: false },
  );
  const { data, nextCursor } = page(rows, q.limit, (p) => ({ id: p.id }));
  return json({ data: data.map(view), nextCursor });
});

export const POST = idempotent('write', async (ctx, body, tx) => {
  const i = parse(z.object({ name: z.string().trim().min(1).max(120), notes: z.string().max(2000).default('') }).strict(), body);
  const p = await tx.project.create({ data: { ...inOrg(ctx), name: i.name, notes: i.notes } });
  await audit(ctx, 'project.created', { targetType: 'project', targetId: p.id, data: { apiKeyId: ctx.keyId } }, tx);
  await emit(ctx, 'project.created', { project: view(p) }, tx);
  return { status: 201, body: view(p) };
});
