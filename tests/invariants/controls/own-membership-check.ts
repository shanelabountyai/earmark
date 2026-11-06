'use server';
// CONTROL (INV-22): does its own membership lookup instead of requireOrg, so MFA is never checked.
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { type ActionSpec } from '@/core/authz/action';
import { requireUser } from '@/core/auth/session';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export const rename = Object.assign(
  async (slug: string) => {
    const s = await requireUser();
    const m = await db.membership.findFirst({ where: { userId: s.userId, org: { slug } } });
    if (!m) notFound();
    await db.org.update({ where: { id: m.orgId }, data: { name: 'renamed' } });
  },
  { spec: { kind: 'org', perm: null, schema: z.object({}) } as ActionSpec },
);
