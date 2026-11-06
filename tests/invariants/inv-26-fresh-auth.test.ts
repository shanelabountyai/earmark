import { beforeEach, describe, expect, it } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { advanceClock } from '@/core/clock';
import { currentSession, ReauthRequired } from '@/core/auth/session';
import { deleteAccount, deleteOrg } from '@/core/tenancy/delete';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { disableTotp, enrolTotp } from '@/core/auth/totp';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { enrol, makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

// TOTP enrol and disable (M2); org and account deletion (M3).
describe('INV-26 sensitive changes need a sign-in within 5 minutes', () => {
  it('enrolling on a stale session is refused', async () => {
    await signInAs((await makeUser()).id);
    advanceClock(5 * 60_000 + 1000);
    await expect(enrolTotp()).rejects.toBeInstanceOf(ReauthRequired);
  });

  it('disabling on a stale session is refused and changes nothing', async () => {
    const u = await makeUser();
    await signInAs(u.id);
    await enrol();
    advanceClock(5 * 60_000 + 1000);
    await expect(disableTotp()).rejects.toBeInstanceOf(ReauthRequired);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).totpEnrolledAt).not.toBeNull();
  });

  it('deleting an org on a stale session is refused and deletes nothing', async () => {
    const org = await makeOrg();
    const ctx = await actAs((await addMember(org.id, 'owner', 'owner@example.test')).id, org.slug);
    advanceClock(5 * 60_000 + 1000);
    await expect(deleteOrg(ctx, org.slug)).rejects.toBeInstanceOf(ReauthRequired);
    expect(await db.org.count()).toBe(1);
    advanceClock(0);
    await deleteOrg(ctx, org.slug); // fresh again: allowed
    expect(await db.org.count()).toBe(0);
  });

  it('deleting an account on a stale session is refused and deletes nothing', async () => {
    const u = await makeUser();
    await signInAs(u.id);
    advanceClock(5 * 60_000 + 1000);
    await expect(deleteAccount((await currentSession())!, u.email, onMembershipEnded)).rejects.toBeInstanceOf(ReauthRequired);
    expect(await db.user.count()).toBe(1);
  });
});
