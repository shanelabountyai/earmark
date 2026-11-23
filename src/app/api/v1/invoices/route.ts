// public: an API key via requireApiKey (apikeys module, INV-40), not a session
import { z } from 'zod';
import { inOrg } from '@/core/authz/guards';
import { fileInvoice, fileRefSchema } from '@/earmark/core';
import { ApiProblem, idempotent, parse } from '@/modules/apikeys/api';

// PRD §1 `integration`: a finance system posts an invoice under the same rules as the guest form (fileInvoice). The
// key has no user, so the invoice is filed as submitted by the member who created the key, and the audit row's actor
// is null, as for every API write.
const body = z
  .object({
    agencyId: z.uuid(),
    number: z.string().trim().min(1).max(64),
    poNumber: z.string().trim().max(64).default(''),
    amountCents: z.string().max(32), // its shape is checked in fileInvoice, after the agency resolves (D-33, D-41)
    invoicedOn: z.string().max(10),
    dueOn: z.string().max(10),
    fileRef: fileRefSchema, // https only (D-74)
  })
  .strict();

/** Called by fileInvoice once the agency is ours, so a foreign agency id is the 404 whatever the amount (D-41). */
const cents = (v: string) => {
  if (!/^[1-9]\d{0,15}$/.test(v)) throw new ApiProblem('VALIDATION', 'amountCents: a positive whole number of cents, as a string');
  return BigInt(v);
};

export const POST = idempotent('invoices', async (ctx, raw, tx) => {
  const i = parse(body, raw);
  const key = await tx.apiKey.findFirstOrThrow({ where: { id: ctx.keyId, ...inOrg(ctx) }, select: { createdById: true } });
  const inv = await fileInvoice(tx, ctx, {}, { ...i, amountCents: () => cents(i.amountCents) }, key.createdById);
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
