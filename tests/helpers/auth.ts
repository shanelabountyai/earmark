import { afterAll, afterEach } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { advanceClock, now } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { createSession, SESSION_COOKIE } from '@/core/auth/session';
import { confirmTotp, enrolTotp } from '@/core/auth/totp';
import { jar } from './next';

afterEach(() => advanceClock(0));
afterAll(() => db.$disconnect());

let tables: string[] | undefined;
/** Every table but Prisma's own, so a clone's tables are covered with no registration. */
export const allTables = async () =>
  (tables ??= (
    await db.$queryRaw<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations' ORDER BY 1`
  ).map((r) => r.t));

/** Empties every table. TRUNCATE skips AuditEvent's append-only row trigger (INV-19). */
export async function resetAuthTables() {
  await db.$executeRawUnsafe(`TRUNCATE ${(await allTables()).map((t) => `"${t}"`).join(', ')} CASCADE`);
}

export const makeUser = (email = 'ada@example.test') => db.user.create({ data: { email } });

/** Signs the jar in as `userId` with a fresh session; returns the raw session token. */
export async function signInAs(userId: string, opts: { mfa?: boolean } = {}) {
  const token = await createSession(userId, opts);
  jar.set(SESSION_COOKIE, token);
  return token;
}

export const codeFor = (secret: string) =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: now().getTime() });

/** Enrols the signed-in user in TOTP; returns the secret and the recovery codes. */
export async function enrol() {
  const { secret } = await enrolTotp();
  const codes = await confirmTotp(codeFor(secret));
  if (!codes) throw new Error('enrolment failed');
  return { secret, codes };
}
