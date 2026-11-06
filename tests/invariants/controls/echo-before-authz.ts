'use server';
// CONTROL (INV-04): reads by id first and names the row when it is not ours (storage's rate-change echo).
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export const peek = orgAction('members.manage', z.object({ id: ref('invite') }), async (ctx, { id }) => {
  const invite = await db.invite.findUnique({ where: { id } });
  if (!invite) notFound();
  if (invite.orgId !== ctx.orgId) throw new Error(`${invite.email} was invited to another org`);
  return { ok: true };
});
