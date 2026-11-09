import { db } from '@/core/db';
import { asSystem } from '@/core/db/rls';
import { env } from '@/core/env';
import { createSession } from './session';

// Demo sign-in (D-8, INV-27). Two locks: the flag, and the row. Only scripts/seed-demo.ts sets `isDemo`,
// so a real account can never be signed in here even with the flag on.
export const demoEnabled = (e: { DEMO_MODE?: string } = env) => e.DEMO_MODE === '1';

// Cross-org (cross-org.ts): every demo user's orgs, before any is chosen.
export const listDemoUsers = () =>
  asSystem((sys) => sys.user.findMany({
    where: { isDemo: true },
    select: { id: true, email: true, memberships: { select: { role: true, org: { select: { id: true, slug: true, name: true } } } } },
    orderBy: { email: 'asc' },
  }));

/** A session with MFA passed for a demo user, or null when the flag is off or the user is not one. */
export async function demoSignIn(userId: string, e: { DEMO_MODE?: string } = env): Promise<string | null> {
  if (!demoEnabled(e)) return null;
  const u = await db.user.findFirst({ where: { id: userId, isDemo: true }, select: { id: true } });
  return u ? createSession(u.id, { mfa: true, method: 'demo' }) : null;
}
