import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { env, parseEnv } from '@/core/env';
import { sendEmail } from '@/core/email/transport';
import { resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);
afterEach(() => vi.restoreAllMocks());

const msg = { to: 'ada@example.test', subject: 'Your sign-in link', body: 'SECRET-BODY https://x/login/abc' };

describe('INV-13 email transport', () => {
  it('outside production: captures the message and logs neither body nor address', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await sendEmail(msg, { ...env, VERCEL_ENV: undefined, EMAIL_SANDBOX_TO: undefined, EMAIL_ENABLED: undefined });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.capturedMessage.findFirst()).toMatchObject(msg);
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).not.toContain('SECRET-BODY');
    expect(logged).not.toContain(msg.to);
  });

  it('the kill switch sends and captures nothing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendEmail(msg, { ...env, EMAIL_ENABLED: '0' });
    expect(await db.capturedMessage.count()).toBe(0);
  });

  it('the sandbox really sends, but only to EMAIL_SANDBOX_TO', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await sendEmail(msg, { ...env, VERCEL_ENV: 'preview', EMAIL_SANDBOX_TO: 'me@example.test', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).to).toBe('me@example.test');
    expect(fetchSpy.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal); // FR-01: a hung provider times out
  });

  it('production with no provider fails at boot', () => {
    const base = { DATABASE_URL: 'postgresql://u@localhost/x', AUTH_SECRET: 'x'.repeat(32), APP_URL: 'https://a.example', VERCEL_ENV: 'production' };
    expect(() => parseEnv(base)).toThrow(/RESEND_API_KEY/);
    expect(() => parseEnv({ ...base, RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' })).not.toThrow();
  });
});
