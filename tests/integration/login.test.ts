import { beforeEach, describe, expect, it } from 'vitest';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { redeemLink, requestLink } from '@/core/auth/link';
import { sessionFor } from '@/core/auth/session';
import { isSameOrigin } from '@/core/http';
import { makeUser, resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);

const lastLink = async () => {
  const m = await db.capturedMessage.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  return { subject: m.subject, token: m.body.match(/\/login\/([\w-]+)/)![1]! };
};

describe('magic link (D-10)', () => {
  it('an unknown email gets a sign-up link; redeeming it creates the user and a session', async () => {
    await expect(requestLink('  New@Example.test ', '10.0.0.1')).resolves.toBeUndefined();
    const { subject, token } = await lastLink();
    expect(subject).toBe('Create your account');
    expect(await db.user.count()).toBe(0); // created at redeem, not at request
    const session = await redeemLink(token);
    const s = await sessionFor(session!);
    expect(s!.email).toBe('new@example.test');
    expect(s!.mfaAt).toBeNull();
  });

  it('a known email gets a sign-in link for that user', async () => {
    const u = await makeUser();
    await requestLink('ada@example.test', '10.0.0.1');
    const { subject, token } = await lastLink();
    expect(subject).toBe('Your sign-in link');
    expect((await sessionFor((await redeemLink(token))!))!.userId).toBe(u.id);
  });

  it('a link works once', async () => {
    await requestLink('ada@example.test', '10.0.0.1');
    const { token } = await lastLink();
    expect(await redeemLink(token)).not.toBeNull();
    expect(await redeemLink(token)).toBeNull();
  });

  it('a link expires after 15 minutes', async () => {
    await requestLink('ada@example.test', '10.0.0.1');
    const { token } = await lastLink();
    advanceClock(15 * 60_000 + 1000);
    expect(await redeemLink(token)).toBeNull();
  });

  it('a second request inside the 60-second cooldown sends nothing', async () => {
    await requestLink('ada@example.test', '10.0.0.1');
    await requestLink('ada@example.test', '10.0.0.1');
    expect(await db.capturedMessage.count()).toBe(1);
  });

  it('an email-change token cannot sign anyone in', async () => {
    const u = await makeUser();
    await db.loginToken.create({
      data: { hash: (await import('@/core/tokens')).hashToken('t'), purpose: 'email_change', email: 'x@example.test', userId: u.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await redeemLink('t')).toBeNull();
  });
});

describe('isSameOrigin (login CSRF)', () => {
  const h = (o: Record<string, string>) => new Headers({ host: 'app.example', ...o });
  it.each([
    [{ origin: 'https://app.example' }, true],
    [{ origin: 'https://evil.example' }, false],
    [{ origin: 'null' }, false],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{}, false],
  ])('%o → %s', (headers, ok) => expect(isSameOrigin(h(headers))).toBe(ok));
});
