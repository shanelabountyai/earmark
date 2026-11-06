// public: CRON_SECRET via isAuthorizedCron (INV-10/11)
import { isAuthorizedCron } from '@/core/cron';
import { log } from '@/core/log';
import { sweepRateLimits } from '@/core/rate-limit';
import { runExports } from '@/core/tenancy/export';
import { exportTables } from '@/app/export-hooks';
import { cronJobs } from '@/app/cron-jobs';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response(null, { status: 401 }); // no WWW-Authenticate: nothing to challenge
  const rateLimitsDeleted = await sweepRateLimits();
  const exports = await runExports(exportTables); // addendum §5: a core job, so it lives here, not in clone-owned cron-jobs.ts
  const jobs = await cronJobs();
  log('cron.done', { rateLimitsDeleted, ...exports, ...jobs });
  return Response.json({ ok: true, rateLimitsDeleted, ...exports, ...jobs }, { headers: { 'Cache-Control': 'no-store' } });
}
