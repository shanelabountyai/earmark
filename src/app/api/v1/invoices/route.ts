// public: an API key via requireApiKey (apikeys module, INV-40), not a session
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { fileInvoice } from '@/earmark/core';
import { idempotent, parse } from '@/modules/apikeys/api';

// PRD §1 `integration`: a finance system posts an invoice under the same rules as the guest form (fileInvoice). The
// key has no user, so the invoice is filed as submitted by the member who created the key, and the audit row's actor
// is null, as for every API write.
const body = z
  .object({
    agencyId: z.uuid(),
    number: z.string().trim().min(1).max(64),
    poNumber: z.string().trim().max(64).default(''),
    amountCents: z.string().regex(/^[1-9]\d{0,15}$/, 'a positive whole number of cents, as a string'),
    invoicedOn: z.string().max(10),
    dueOn: z.string().max(10),
    fileRef: z.union([z.literal(''), z.url().max(2000)]).default(''),
  })
  .strict();

export const POST = idempotent('invoices', async (ctx, raw, tx) => {
  const i = parse(body, raw);
  const key = await tx.apiKey.findFirstOrThrow({ where: { id: ctx.keyId, ...inOrg(ctx) }, select: { createdById: true } });
  const inv = await fileInvoice(tx, ctx, {}, { ...i, amountCents: () => BigInt(i.amountCents) }, key.createdById);
  return {
    status: 201,
    body: {
      id: inv.id,
      agencyId: inv.agencyId,
      number: inv.number,
      poNumber: inv.poNumber,
      amountCents: inv.amountCents.toString(),
      invoicedOn: inv.invoicedOn.toISOString().slice(0, 10),
      dueOn: inv.dueOn.toISOString().slice(0, 10),
      state: inv.state,
    },
  };
});
