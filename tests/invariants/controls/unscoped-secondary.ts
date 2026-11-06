'use server';
// CONTROL (INV-03): the invite is scoped, the member id is not (rental's addLeaseTenant).
import { z } from 'zod';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg } from '@/core/authz/guards';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export const reassign = orgAction('members.manage', z.object({ id: ref('invite'), userId: ref('member') }), async (ctx, { id, userId }) => {
  await db.invite.updateMany({ where: { id, ...inOrg(ctx) }, data: { invitedById: userId } });
});
