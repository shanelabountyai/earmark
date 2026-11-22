// PRD-A A2 (Shane's decisions 1 (c) and 2 (a), D-73): the shared live demo is replanted every night. When DEMO_MODE=1
// the daily /api/cron runs the demo seed's Earmark half (scripts/seed-earmark.ts) for the demo orgs: rules, seats,
// plan, requests, POs, invoices, agencies and Dana's agency tie go back to the seed. The audit log is append-only and
// is not touched, so what visitors did stays as history (D-64). Users, sessions and the AI allowance are not reset.
import { demoEnabled } from '@/core/auth/demo';
import { asSystem } from '@/core/db/rls';
import { env } from '@/core/env';
import { PLANS, seedEarmark } from '../../scripts/seed-earmark';

/** The cron job. Does nothing outside DEMO_MODE, so a real deployment's data is never replanted. */
export async function cronDemoReset(e: { DEMO_MODE?: string } = env): Promise<{ reset: string[] } | { skipped: 'not demo mode' | 'no demo orgs' }> {
  if (!demoEnabled(e)) return { skipped: 'not demo mode' };
  // Cross-org (cross-org.ts): the seed writes both demo orgs, as seed:demo does.
  return asSystem(async (sys) => {
    const present = await sys.org.count({ where: { slug: { in: PLANS.map((p) => p.slug) } } });
    if (present < PLANS.length) return { skipped: 'no demo orgs' as const }; // the seed needs both orgs and their users
    await seedEarmark(sys);
    return { reset: PLANS.map((p) => p.slug) };
  });
}
