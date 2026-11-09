import { beforeEach, describe, expect, it } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { sessionFor, signOutEverywhere } from '@/core/auth/session';
import { requireOrg } from '@/core/authz/guards';
import { removeMember } from '@/core/tenancy/orgs';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

beforeEach(resetAuthTables);

describe('INV-05 sign-out-everywhere (M2 scope)', () => {
  it('ends every session on the next request', async () => {
    const u = await makeUser();
    const a = await signInAs(u.id);
    const b = await signInAs(u.id);
    const other = await signInAs((await makeUser('bob@example.test')).id);
    await signOutEverywhere(u.id);
    expect(await sessionFor(a)).toBeNull();
    expect(await sessionFor(b)).toBeNull();
    expect(await sessionFor(other)).not.toBeNull();
  });
});

describe('INV-05 membership removal (M3 scope)', () => {
  it('a removed member is refused on their next request', async () => {
    const org = await makeOrg();
    const owner = await addMember(org.id, 'owner', 'owner@example.test');
    const bob = await addMember(org.id, 'member', 'bob@example.test');
    await actAs(bob.id, org.slug); // admitted now
    await removeMember(await actAs(owner.id, org.slug), bob.id, onMembershipEnded);
    await signInAs(bob.id, { mfa: true });
    await expect(requireOrg(org.slug)).rejects.toMatchObject({ kind: 'notFound' });
  });
});
