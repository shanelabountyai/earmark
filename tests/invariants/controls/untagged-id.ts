'use server';
// Control (FR-08): an id typed z.string(), so the harness cannot scope it.
import { z } from 'zod';
import { orgAction } from '@/core/authz/action';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export const drop = orgAction('members.manage', z.object({ inviteId: z.string() }), async (_ctx, { inviteId }) => {
  await db.invite.delete({ where: { id: inviteId } });
});
