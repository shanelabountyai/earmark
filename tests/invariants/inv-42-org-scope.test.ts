import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orgTables } from '../../scripts/rls-policies';
import { GLOBAL_MODELS as CLONE_GLOBALS } from '../fixtures/app';

// INV-42 (v1.7.0, audit A-14): every Prisma model is org-scoped (an orgId column, so INV-29/30 put it under RLS) or is
// named here as global with the reason. A new table without orgId fails until someone decides which it is, instead of
// silently living outside tenancy. Clones name their own global tables in tests/fixtures/app.ts (GLOBAL_MODELS).

/** Core and module models with no orgId, and why. A removed module's entries are simply never seen. */
export const CORE_GLOBALS: Record<string, string> = {
  User: 'a person, who may belong to many orgs',
  LoginToken: 'belongs to a user, before any org is chosen',
  Session: 'belongs to a user; per user, not per org',
  RecoveryCode: 'belongs to a user (MFA)',
  Org: 'the tenant itself',
  RateLimit: 'keyed by IP or user, before an org is known',
  CapturedMessage: 'dev and test mail capture, never in production',
  StripeEvent: 'billing: webhook dedupe by Stripe event id, resolved to an org after',
  SsoSubject: 'sso: an identity at an issuer, linked to a user, not an org',
};

const models = (dir = 'prisma/schema') =>
  readdirSync(dir)
    .filter((n) => n.endsWith('.prisma'))
    .flatMap((f) => [...readFileSync(`${dir}/${f}`, 'utf8').matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!));

/** The models that are neither org-scoped nor named global; and the names on the lists that are org-scoped or absent. */
export function scopeGaps(all: string[], scoped: string[], core: Record<string, string>, clone: readonly string[]): string[] {
  const named = new Set([...Object.keys(core), ...clone]);
  return [
    ...all.filter((m) => !scoped.includes(m) && !named.has(m)).map((m) => `${m}: no orgId and not named global`),
    ...[...named].filter((m) => scoped.includes(m)).map((m) => `${m}: has orgId but is named global`),
    ...clone.filter((m) => !all.includes(m)).map((m) => `${m}: named global in tests/fixtures/app.ts but no such model`),
  ];
}

describe('INV-42: every model is org-scoped or named global', () => {
  it('the schema has no unexplained global table', () => {
    expect(scopeGaps(models(), orgTables().map((t) => t.model), CORE_GLOBALS, CLONE_GLOBALS)).toEqual([]);
  });

  it('negative control: an unnamed global, a global with orgId and a stale clone entry are all caught', () => {
    expect(scopeGaps(['User', 'Widget', 'Project'], ['Project'], { User: 'x', Project: 'x' }, ['Gone'])).toEqual([
      'Widget: no orgId and not named global',
      'Project: has orgId but is named global',
      'Gone: named global in tests/fixtures/app.ts but no such model',
    ]);
  });
});
