// The closed list of files allowed to call `asSystem` (addendum §2, INV-32). Adding a file here is a reviewed
// decision: every entry is a path that runs before an org is known, or across orgs, and so cannot use `withOrg`.
// A clone adds its own entries below the marker line, each with its reason.
export const CROSS_ORG_FILES: Readonly<Record<string, string>> = {
  'src/core/tenancy/invites.ts': 'invite redemption by token, and pending invites by email for /onboarding',
  'src/app/onboarding/page.tsx': "/onboarding lists the user's orgs before one is chosen",
  'src/core/tenancy/delete.ts': 'account deletion checks every org the user owns (deviation: not in the kickoff list)',
  'src/core/auth/totp.ts': 'turning TOTP off checks the user is owner/admin nowhere (deviation: not in the kickoff list)',
  'src/core/share/links.ts': 'share-link read by token before its org is known (deviation: not in the kickoff list)',
  'src/core/auth/link.ts': 'email change revokes invites to the old address in every org (deviation: not in the kickoff list)',
  'src/core/tenancy/export.ts': 'cron builds and sweeps exports in every org; the manifest reads _prisma_migrations',
  'src/core/auth/demo.ts': "demo sign-in lists every demo user's orgs (sign-in)",
  'src/modules/billing/webhook.ts': 'Stripe webhook: the event names the org',
  'src/modules/notifications/outbox.ts': 'cron drain and sweep across every org',
  'scripts/seed-demo.ts': 'seed:demo writes several orgs',
  'src/modules/sso/hooks.ts': '/login routing by email domain, the SSO-required link check, domain uniqueness, cron sweep', // sso
  'src/modules/sso/flow.ts': 'the SSO callback: the state row names the org only once it is read', // sso
  'src/modules/apikeys/keys.ts': 'an API key names its org: the hashed-key lookup runs before any org is known', // apikeys
  'src/modules/apikeys/webhooks.ts': 'webhook fan-out and delivery: the cron sweep crosses every org', // apikeys
  // clone entries below
};
