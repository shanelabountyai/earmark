// PROVEN-DEFECT TESTS — audit 2026-11-17 (docs/audits/AUDIT-2026-11-17.md). NON-GATING ON PURPOSE.
//
// Every test here states the CORRECT behaviour and FAILS against the code as it stands on v1.6.3: each failure is the
// evidence for one finding (the id in the test name). vitest.config.ts includes only tests/**/*.test.ts, so this file
// is not part of `npm test` or CI's required checks. Run it with:
//
//   npx dotenv -e .env.test -e .env.local -- vitest run --config vitest.defects.config.ts
//
// When a finding is fixed its test goes green; move it into tests/invariants/ then, and delete it from here.
// v1.6.4 fixed and moved A-01, A-02, A-03, A-05 (session half), A-07 and A-09. Left here: A-04, A-06, A-08.
// Nothing in this file changes production code, and no existing test was skipped, deleted or weakened for it.
import { randomUUID } from 'node:crypto';
import '@/app/modules'; // registers the sso hooks, as the sign-in routes do
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { requestLink } from '@/core/auth/link';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { env } from '@/core/env';
import { emit } from '@/core/events';
import { Refused } from '@/core/errors';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { createKey, resolveKey } from '@/modules/apikeys/keys';
import { createEndpoint, sweepWebhooks, transport } from '@/modules/apikeys/webhooks';
import { setRequired } from '@/modules/sso/settings';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

const realTransport = { ...transport };
beforeEach(async () => {
  await resetAuthTables();
  transport.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
});
afterEach(() => {
  Object.assign(transport, realTransport);
  advanceClock(0);
});

async function orgWithOwner(slug: string) {
  const o = await makeOrg(slug);
  const owner = await addMember(o.id, 'owner', `owner@${slug}.test`);
  return { orgId: o.id, slug, ownerId: owner.id, owner: await actAs(owner.id, slug) };
}

// A-01, A-02, A-03, A-09: fixed in v1.6.4; their tests moved to tests/invariants/inv-40-41-apikeys.test.ts,
// inv-35-38-sso.test.ts and inv-39-ai-budget.test.ts.

// ---------------------------------------------------------------------------------------------------------------
// A-04 (medium): what a person set up outlives their access. INV-40 revokes the API keys a removed member created;
// the webhook endpoint they pointed at their own server keeps receiving every event, signed with a secret they hold.
// ---------------------------------------------------------------------------------------------------------------
describe('A-04 a webhook endpoint does not outlive the membership of the person who created it', () => {
  it('after the admin is removed, the org publishes an event: nothing is sent to their endpoint', async () => {
    const a = await orgWithOwner('acme');
    const admin = await addMember(a.orgId, 'admin', 'leaver@acme.test');
    await createEndpoint(await actAs(admin.id, 'acme'), { url: 'https://leaver-controlled.example.test/collect', eventTypes: [] });
    await removeMember(await actAs(a.ownerId, 'acme'), admin.id, onMembershipEnded);

    const sent: string[] = [];
    transport.fetch = vi.fn(async (url: string) => (sent.push(url), new Response('ok')));
    await withOrg(a, (tx) => emit(a, 'project.created', { project: { name: 'After they left' } }, tx));
    await sweepWebhooks();
    expect(sent).toEqual([]);
  });
});

// A-08 (low): the same rule for a demotion. An admin made a key, then lost apikeys.manage; the key still works.
describe('A-08 an API key does not outlive its creator’s right to manage keys', () => {
  it('admin → member: the key that admin created no longer resolves', async () => {
    const a = await orgWithOwner('acme');
    const admin = await addMember(a.orgId, 'admin', 'demoted@acme.test');
    const key = await createKey(await actAs(admin.id, 'acme'), { label: 'crm', scopes: ['read', 'write'] });
    await changeRole(await actAs(a.ownerId, 'acme'), admin.id, 'member');
    expect(await resolveKey(`Bearer ${key}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A-05 / A-06 / A-07: "Require SSO" (INV-36) is enforced only where a magic link is requested or redeemed.
// ---------------------------------------------------------------------------------------------------------------
describe('Require SSO', () => {
  const DOMAIN = 'corp.example';
  beforeAll(() => void (env.SSO_ENABLED = '1'));
  afterAll(() => void (env.SSO_ENABLED = undefined));

  async function ssoOrg(slug = 'corp') {
    const a = await orgWithOwner(slug);
    await db.ssoConnection.create({ data: { orgId: a.orgId, issuer: 'https://idp.corp.example', clientId: 'c', clientSecretSealed: 'x', allowedDomains: [DOMAIN], enabledAt: now() } });
    await db.ssoDomain.create({ data: { orgId: a.orgId, domain: DOMAIN, verifiedAt: now() } });
    return a;
  }
  const links = (email: string) => db.loginToken.count({ where: { email } });

  // A-05 (session half) and A-07: fixed in v1.6.4; moved to tests/invariants/inv-35-38-sso.test.ts. The guard half of
  // A-05 (requireOrg asking how the session was made) is v1.7.0.

  // A-06 (medium): the rule is per USER, not per org, and takes no account of whether the user can use SSO at all.
  it('A-06 a member whose address is not on the org’s domain can still sign in to their OWN org', async () => {
    const a = await ssoOrg();
    const contractor = await addMember(a.orgId, 'member', 'pat@freelance.example'); // invited; cannot use corp's IdP
    const own = await makeOrg('pats-studio');
    await db.membership.create({ data: { orgId: own.id, userId: contractor.id, role: 'owner' } });

    await setRequired(await actAs(a.ownerId, a.slug), true);
    await requestLink(contractor.email, randomUUID());
    expect(await links(contractor.email), 'sign-in links for the owner of pats-studio').toBe(1);
  });

  it('A-06 an org whose only owner is off-domain is not locked out for good once the 24 h exemption lapses', async () => {
    const a = await ssoOrg(); // owner@corp.test: not on corp.example, so the IdP can never sign them in (INV-35)
    const on = await setRequired(a.owner, true).then(() => true, (e) => (e instanceof Refused ? false : Promise.reject(e)));
    if (!on) return; // fixed by refusing the switch: also fine
    advanceClock(24 * 3600_000 + 60_000);
    await requestLink(a.owner.session.email, randomUUID());
    expect(await links(a.owner.session.email), 'ways left for the only owner to sign in and turn it off').toBeGreaterThan(0);
  });

});
