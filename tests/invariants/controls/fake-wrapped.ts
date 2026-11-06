'use server';
// CONTROL (INV-01): carries a spec, so it looks wrapped, but never calls the guard.
import { z } from 'zod';
import { ref, type ActionSpec } from '@/core/authz/action';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

const schema = z.object({ id: ref('invite') });
export const revoke = Object.assign(
  async (_slug: string, input: unknown) => {
    await db.invite.updateMany({ where: { id: schema.parse(input).id }, data: { revokedAt: new Date() } });
  },
  { spec: { kind: 'org', perm: null, schema } as ActionSpec },
);
