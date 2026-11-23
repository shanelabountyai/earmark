import { recheckSsoDomains, sweepSsoStates } from '@/modules/sso/hooks'; // sso
import { cronWebhooks } from '@/modules/apikeys/webhooks'; // apikeys
import { cronAlerts } from '@/earmark/alerts';
import { cronDemoReset } from '@/earmark/demo-reset';
import { log } from '@/core/log';

type Job = readonly [name: string, run: () => Promise<unknown>];

/**
 * Runs each job on its own (PRD-A A3, review C8, D-73): a job that throws is logged with its name and the error's
 * name (log lines carry names and counts only) and recorded as failed, and the jobs after it still run.
 */
export async function runJobs(jobs: readonly Job[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, run] of jobs) {
    try {
      out[name] = await run();
    } catch (e) {
      log('cron.job_failed', { job: name, error: e instanceof Error ? e.name : 'unknown' });
      out[name] = { failed: true };
    }
  }
  return out;
}

// Clone-owned (plan §3.2): /api/cron calls this after its own core sweeps. A clone adds its jobs here,
// and removing the notifications module deletes the lines marked `// notifications`.
export async function cronJobs(): Promise<Record<string, unknown>> {
  const jobs: Job[] = [];
  jobs.push(['ssoStates', sweepSsoStates]); // sso
  jobs.push(['ssoDomains', recheckSsoDomains]); // sso
  jobs.push(['webhooks', cronWebhooks]); // apikeys
  jobs.push(['alerts', cronAlerts]); // Earmark (PRD §4, D-30)
  // Last, so the day's webhook deliveries and alerts run on what visitors did before the demo is replanted (D-73).
  jobs.push(['demoReset', () => cronDemoReset()]); // Earmark (PRD-A, D-73): only when DEMO_MODE=1
  return runJobs(jobs);
}
