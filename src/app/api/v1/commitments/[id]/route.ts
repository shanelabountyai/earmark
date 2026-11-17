// public: an API key via requireApiKey (apikeys module, INV-40), not a session
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { toGuestCommitment } from '@/earmark/core';
import { api, ApiProblem, json, parse } from '@/modules/apikeys/api';

// PRD §9 step 8: another client's PO id answers exactly like an id that does not exist (INV-04, INV-40). The body is
// the guest projection, an allowlist: no budget line, request or approver reaches an integration either.
export const GET = api('read', async (ctx, _req, params) => {
  const id = parse(z.uuid(), params.id);
  const c = await withOrg(ctx, (tx) => tx.commitment.findFirst({ where: { id, ...inOrg(ctx) }, include: { matches: { select: { invoice: { select: { dueOn: true } } } } } }), { atomic: false });
  if (!c) throw new ApiProblem('NOT_FOUND', 'No such commitment.');
  return json(toGuestCommitment(c));
});
