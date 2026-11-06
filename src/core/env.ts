import { z } from 'zod';

// Every key the app reads. `.env.example` must name exactly these (INV-14), and no
// NEXT_PUBLIC_* key may be a secret (INV-20) — the allowlist lives in the invariant test.
// Later milestones add their keys here and to `.env.example` in the same commit.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(), // migrations only; falls back to DATABASE_URL
  // Row-level security (addendum §2). DATABASE_URL is the app role; the system URL is the owner (BYPASSRLS) for the
  // closed list of cross-org paths in src/core/db/cross-org.ts. Unset system URL = asSystem uses DATABASE_URL.
  DATABASE_URL_SYSTEM: z.string().min(1).optional(),
  RLS_MODE: z.enum(['enforce']).optional(), // enforce = the app role must not bypass RLS (INV-33); needs DATABASE_URL_SYSTEM
  AUTH_SECRET: z.string().min(32), // HKDF root for sealed secrets and token hashing
  APP_URL: z.url(),
  CRON_SECRET: z.string().min(16).optional(), // Vercel Cron sends it as a bearer; unset = /api/cron refuses (INV-11)
  ALLOW_CLOUD_DB: z.enum(['1']).optional(), // INV-18 escape hatch
  VERCEL_ENV: z.string().optional(), // set by Vercel; marks a deployed environment
  DEMO_MODE: z.enum(['1']).optional(), // /demo signs in isDemo users; unset = /demo is a 404 (INV-27, D-8)
  // Email (spec §7d). Real sends only in production or with a sandbox address.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(), // "App <no-reply@example.com>"
  EMAIL_SANDBOX_TO: z.email().optional(), // outside production, really send, but only here
  EMAIL_ENABLED: z.enum(['0', '1']).optional(), // '0' = kill switch: nothing is sent or captured
  AI_ENABLED: z.enum(['0', '1']).optional(), // '0' = kill switch: every withBudget call refuses (addendum §6)
  // Notifications module (spec §4, §7d). Same gating as email: real sends only in production or to the sandbox number.
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM: z.string().min(1).optional(),
  SMS_SANDBOX_TO: z.string().min(1).optional(),
  SMS_ENABLED: z.enum(['0', '1']).optional(), // '0' = kill switch
  // Billing module (spec §4). Unset key = the mock provider; unset webhook secret = the webhook refuses (503).
  STRIPE_SECRET_KEY: z.string().min(1).optional(), // billing
  STRIPE_PRICE_ID: z.string().min(1).optional(), // billing
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(), // billing
  // SSO module (addendum §3). Unset = /login never routes to a provider and /login/sso/** is a 404, connections or not.
  SSO_ENABLED: z.enum(['1']).optional(), // sso
  WEBHOOK_ALLOW_PRIVATE: z.enum(['1']).optional(), // apikeys: http and private addresses for a local test receiver; refused in production
  // The two hand-checked test providers (D-26). Read only by seed:demo, which pre-fills a demo org's connection with them.
  SSO_TEST_GOOGLE_CLIENT_ID: z.string().min(1).optional(), // sso
  SSO_TEST_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(), // sso
  SSO_TEST_GOOGLE_DOMAIN: z.string().min(1).optional(), // sso: the Workspace domain, e.g. labintelligence.co
  SSO_TEST_OKTA_ISSUER: z.url().optional(), // sso
  SSO_TEST_OKTA_CLIENT_ID: z.string().min(1).optional(), // sso
  SSO_TEST_OKTA_CLIENT_SECRET: z.string().min(1).optional(), // sso
  SSO_TEST_OKTA_DOMAIN: z.string().min(1).optional(), // sso: the email domain of the Okta test users
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  // An empty `NAME=` line (a key waiting for its value) is unset, not an invalid empty string.
  const result = envSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== '')));
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid environment: ${keys}`); // names only — never echo values
  }
  const e = result.data;
  if (e.RLS_MODE === 'enforce' && !e.DATABASE_URL_SYSTEM) throw new Error('Invalid environment: DATABASE_URL_SYSTEM (required when RLS_MODE=enforce)');
  if (e.WEBHOOK_ALLOW_PRIVATE && e.VERCEL_ENV === 'production') throw new Error('Invalid environment: WEBHOOK_ALLOW_PRIVATE (never in production: it lets webhooks reach private addresses)');
  // INV-13: production with no provider would silently drop every sign-in link.
  if (e.VERCEL_ENV === 'production' && e.EMAIL_ENABLED !== '0' && !(e.RESEND_API_KEY && e.EMAIL_FROM)) {
    throw new Error('Invalid environment: RESEND_API_KEY, EMAIL_FROM (required in production)');
  }
  return e;
}

export const env = parseEnv(process.env);
