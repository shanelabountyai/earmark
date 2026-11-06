import { beforeEach, describe, expect, it } from 'vitest';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { PENDING_MFA_MS, sessionFor } from '@/core/auth/session';
import { redeemRecoveryCode, verifyTotp } from '@/core/auth/totp';
import { LIMITS } from '@/core/rate-limit';
import { codeFor, enrol, makeUser, resetAuthTables, signInAs } from '../helpers/auth';

beforeEach(resetAuthTables);

/** Pins the clock 1s into a fresh UTC day, plus `ms`, so the daily window never splits a test. */
const DAY = 86_400_000;
const base = Math.ceil(Date.now() / DAY) * DAY + 1000 - Date.now();
const at = (ms = 0) => advanceClock(base + ms);
beforeEach(() => at());

describe('FR-02 pending-MFA sessions', () => {
  it('a session that has not passed TOTP expires after 10 minutes; a verified one does not', async () => {
    const u = await makeUser();
    const verified = await signInAs(u.id, { mfa: true });
    await enrol();
    const pending = await signInAs(u.id);
    at(PENDING_MFA_MS - 1000);
    expect(await sessionFor(pending)).not.toBeNull();
    at(PENDING_MFA_MS + 1000);
    expect(await sessionFor(pending)).toBeNull();
    expect(await sessionFor(verified)).not.toBeNull();
  });

  it('a user with no TOTP keeps a normal session', async () => {
    const u = await makeUser();
    const t = await signInAs(u.id);
    at(PENDING_MFA_MS * 10);
    expect(await sessionFor(t)).not.toBeNull();
  });

  it('past the daily failure cap even the right code is refused and the session ends; the next day works', async () => {
    const u = await makeUser();
    await signInAs(u.id, { mfa: true });
    const { secret, codes } = await enrol();
    // Spread the guesses over fresh sessions and 5-minute windows, as a patient guesser would.
    for (let i = 0; i < LIMITS.mfaFailPerUserDay.limit; i++) {
      if (i % 4 === 0) {
        at((i / 4) * 6 * 60_000);
        await signInAs(u.id);
      }
      expect(await (i % 2 ? redeemRecoveryCode('ffff-fffff') : verifyTotp('000000'))).toBe(false);
    }
    at(60 * 60_000);
    const t = await signInAs(u.id);
    expect(await verifyTotp(codeFor(secret))).toBe(false);
    expect(await sessionFor(t)).toBeNull();
    const t2 = await signInAs(u.id);
    expect(await redeemRecoveryCode(codes[0]!)).toBe(false);
    expect(await sessionFor(t2)).toBeNull();
    expect(await db.auditEvent.count({ where: { actorUserId: u.id, action: 'auth.mfa_failed' } })).toBe(LIMITS.mfaFailPerUserDay.limit);

    at(DAY);
    const next = await signInAs(u.id);
    expect(await verifyTotp(codeFor(secret))).toBe(true);
    expect((await sessionFor(next))!.mfaAt).not.toBeNull();
  });
});
