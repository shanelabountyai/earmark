// Phase 4 item 1 (D-32): Require SSO refuses magic links to staff, never to a guest. Dana is a guest in an
// SSO-required org and still gets her link; staff of the same org do not; staff anywhere SSO-required still loses it.
import { randomUUID } from 'node:crypto';
import '@/app/modules'; // registers the sso hooks, as the sign-in routes do
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { requestLink } from '@/core/auth/link';
import { now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system';
import { env } from '@/core/env';
import { resetAuthTables } from '../../helpers/auth';
import { addMember, makeOrg } from '../../helpers/org';

beforeAll(() => {
  env.SSO_ENABLED = '1';
});
afterAll(() => {
  env.SSO_ENABLED = undefined;
});
beforeEach(resetAuthTables);

const linkCount = (email: string) => db.loginToken.count({ where: { email } });
async function requireSso(orgId: string) {
  await db.ssoConnection.create({
    data: { orgId, issuer: 'https://idp.example', clientId: 'x', clientSecretSealed: 'x', allowedDomains: ['staff.example'], enabledAt: now(), required: true, requiredAt: now() },
  });
}

it('a guest in an SSO-required org gets a magic link; a member does not', async () => {
  const org = await makeOrg('sso-guest');
  await requireSso(org.id);
  const guest = await addMember(org.id, 'guest', 'dana@agency.example');
  const member = await addMember(org.id, 'member', 'pat@staff.example');

  await requestLink(guest.email, randomUUID());
  await requestLink(member.email, randomUUID());
  expect(await linkCount(guest.email)).toBe(1);
  expect(await linkCount(member.email)).toBe(0);
});

it('a guest here who is staff in another SSO-required org gets no link', async () => {
  const a = await makeOrg('sso-guest-a');
  const b = await makeOrg('sso-guest-b');
  await requireSso(b.id);
  const user = await addMember(a.id, 'guest', 'lee@agency.example');
  await db.membership.create({ data: { orgId: b.id, userId: user.id, role: 'member' } });

  await requestLink(user.email, randomUUID());
  expect(await linkCount(user.email)).toBe(0);
});
