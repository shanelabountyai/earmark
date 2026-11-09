// public: an API key via requireApiKey (apikeys module, INV-40), not a session
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { api, ApiProblem, json, parse } from '@/modules/apikeys/api';

// Another org's id answers exactly like an id that does not exist (INV-04 shape, INV-40).
export const GET = api('read', async (ctx, _req, params) => {
  const id = parse(z.uuid(), params.id);
  const p = await withOrg(ctx, (tx) => tx.project.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, name: true, createdAt: true } }), { atomic: false });
  if (!p) throw new ApiProblem('NOT_FOUND', 'No such project.');
  return json({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString() });
});
