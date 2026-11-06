// The removable modules (spec §4): everything a module owns, first entry being its directory.
// Removing one also empties the lines marked `// <module>` in core.prisma and src/app/cron-jobs.ts.
export const MODULES: Record<string, string[]> = {
  billing: [
    'src/modules/billing',
    'prisma/schema/billing.prisma',
    'src/app/api/webhooks/stripe',
    'src/app/o/[org]/settings/billing',
    'tests/invariants/inv-12-webhooks.test.ts',
    'e2e/billing.spec.ts',
  ],
  notifications: ['src/modules/notifications', 'prisma/schema/notifications.prisma', 'tests/integration/outbox.test.ts'],
  sso: [
    'src/modules/sso',
    'prisma/schema/sso.prisma',
    'src/app/(public)/login/sso',
    'src/app/o/[org]/settings/sso',
    'tests/invariants/inv-35-38-sso.test.ts',
    'tests/helpers/oidc-mock.ts',
    'e2e/sso.spec.ts',
  ],
  apikeys: [
    'src/modules/apikeys',
    'prisma/schema/apikeys.prisma',
    'src/app/api/v1',
    'src/app/o/[org]/settings/apikeys',
    'tests/invariants/inv-40-41-apikeys.test.ts',
  ],
};
// Files whose `// <module>` (or, in a .tsx file, `{/* <module> */}`) lines go with the module.
export const MARKED_FILES = ['prisma/schema/core.prisma', 'src/app/cron-jobs.ts', 'src/app/org-hooks.ts', 'src/app/o/[org]/layout.tsx', 'src/app/modules.ts', 'src/core/db/cross-org.ts', 'src/app/o/[org]/settings/security/page.tsx'];

// F-03: a clone can use a module outside the marked lines (src/app/required-modules.ts), so
// check-modules must leave that module in place rather than deleting it and failing tsc.
export function modulesToRemove(required: readonly string[]): [string, string[]][] {
  for (const m of required) if (!(m in MODULES)) throw new Error(`required-modules.ts: unknown module "${m}"`);
  return Object.entries(MODULES).filter(([name]) => !required.includes(name));
}
