// public: an API key via requireApiKey (apikeys module), not a session
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { api, decodeCursor, json, limitField, page, parse, query } from '@/modules/apikeys/api';
import { eventBody } from '@/modules/apikeys/webhooks';

// The catch-up door (addendum §7): a receiver that was dark replays from the last seq it saw. Same bodies as the
// webhooks. `since` and a cursor together take the later of the two.
export const GET = api('read', async (ctx, req) => {
  const q = parse(z.object({ since: z.coerce.number().int().min(0).default(0), cursor: z.string().optional(), limit: limitField }).strict(), query(req));
  const after = Math.max(q.since, decodeCursor(z.object({ seq: z.number().int().min(0) }), q.cursor)?.seq ?? 0);
  const rows = await withOrg(ctx, (tx) => tx.orgEvent.findMany({ where: { ...inOrg(ctx), seq: { gt: after } }, orderBy: { seq: 'asc' }, take: q.limit + 1 }), { atomic: false });
  const { data, nextCursor } = page(rows, q.limit, (e) => ({ seq: e.seq! }));
  return json({ data: data.map((e) => eventBody(e)), nextCursor });
});
