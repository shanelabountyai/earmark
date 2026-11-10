import { sweepSsoStates } from '@/modules/sso/hooks'; // sso
import { cronWebhooks } from '@/modules/apikeys/webhooks'; // apikeys
import { cronAlerts } from '@/earmark/alerts';

// Clone-owned (plan §3.2): /api/cron calls this after its own core sweeps. A clone adds its jobs here,
// and removing the notifications module deletes the lines marked `// notifications`.
export async function cronJobs(): Promise<Record<string, unknown>> {
  const jobs: Record<string, unknown> = {};
  jobs.ssoStates = await sweepSsoStates(); // sso
  jobs.webhooks = await cronWebhooks(); // apikeys
  jobs.alerts = await cronAlerts(); // Earmark (PRD §4, D-30)
  return jobs;
}
