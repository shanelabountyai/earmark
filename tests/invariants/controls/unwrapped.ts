'use server';
// CONTROL (INV-01): a plain export. Anyone can call it.
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)

export async function revokeAll() {
  await db.invite.updateMany({ data: { revokedAt: new Date() } });
}
