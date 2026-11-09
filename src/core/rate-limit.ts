import { now } from '@/core/clock';
import { db } from '@/core/db';

// Fixed-window counters in Postgres (INV-09), so a limit survives a cold start and holds
// across every serverless instance. One atomic upsert per hit: no read-then-write race.
// ponytail: fixed window allows up to 2× the limit across a window edge; switch to a sliding
// window if that burst ever matters.
// Old rows are swept hourly by /api/cron via `sweepRateLimits`.
export const LIMITS = {
  linkPerIp: { limit: 10, windowMs: 15 * 60_000 },
  linkPerEmail: { limit: 5, windowMs: 15 * 60_000 },
  // Per user. A 6-digit code is 10^6 wide; with drift ±1 this caps guessing at ~1e-5 per window.
  mfaPerUser: { limit: 8, windowMs: 5 * 60_000 },
  // Wrong TOTP/recovery codes per user per UTC day, across sessions. Past it, MFA is refused
  // until the day turns: bounds a guesser holding the inbox to ~6e-5 a day (FR-02).
  mfaFailPerUserDay: { limit: 20, windowMs: 86_400_000 },
  // Invite mail goes out from the app's domain: cap it per sender, per org and per recipient,
  // so a lure-named org cannot turn the app into a mail cannon (FR-03).
  invitePerUserDay: { limit: 50, windowMs: 86_400_000 },
  invitePerOrgDay: { limit: 100, windowMs: 86_400_000 },
  invitePerEmailDay: { limit: 5, windowMs: 86_400_000 },
  inviteAcceptPerUser: { limit: 10, windowMs: 15 * 60_000 },
  // Anonymous reads of /s/[token]. Generous for a person, tight for a token guesser.
  shareReadPerIp: { limit: 60, windowMs: 15 * 60_000 },
  // Data export (addendum §5): one an hour per org.
  exportPerOrg: { limit: 1, windowMs: 3_600_000 },
} as const;

export type Limit = { limit: number; windowMs: number }; // LIMITS, or a module's own (apikeys: per key and scope)

/** Counts one hit against `key`. True when the hit is within the limit. */
export async function hit(key: string, { limit, windowMs }: Limit): Promise<boolean> {
  const windowStart = new Date(Math.floor(now().getTime() / windowMs) * windowMs);
  const [row] = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count") VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  return row!.count <= limit;
}

/** True when `key` is already past its limit in this window. Counts nothing. */
export async function spent(key: string, { limit, windowMs }: Limit): Promise<boolean> {
  const windowStart = new Date(Math.floor(now().getTime() / windowMs) * windowMs);
  const row = await db.rateLimit.findUnique({ where: { key_windowStart: { key, windowStart } } });
  return !!row && row.count >= limit;
}

/** Deletes counters whose window ended over a day ago; nothing reads them once the window passes. */
export async function sweepRateLimits(): Promise<number> {
  const { count } = await db.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(now().getTime() - 86_400_000) } } });
  return count;
}
