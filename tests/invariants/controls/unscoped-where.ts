'use server';
// CONTROL (INV-02): guarded, but the write selects by id alone (the Bookable IDOR).
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export const revoke = orgAction('members.manage', z.object({ id: ref('invite') }), async (_ctx, { id }) => {
  await db.invite.updateMany({ where: { id }, data: { revokedAt: new Date() } });
});
