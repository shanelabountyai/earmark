import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { env } from '@/core/env';
import { db } from './index';
import { dbSystem } from './system';

export type Tx = Prisma.TransactionClient;

/**
 * Every org-scoped read and write (addendum §2). One transaction with `app.org_id` set transaction-local
 * (`true`), so the setting dies with the transaction and never reaches the pooled connection's next borrower
 * (S4a). Cost in enforce mode: BEGIN + set_config + COMMIT around `fn`, three extra round trips (S4c, CHANGELOG).
 * RLS off (owner decision D-31, 2026-11-05): no set_config, and `{ atomic: false }` reads run on the plain client,
 * so a clone that keeps RLS off pays nothing. Writes keep their transaction (the default) in both modes.
 */
export function withOrg<T>(ctx: { orgId: string }, fn: (tx: Tx) => Promise<T>, opts: { atomic?: boolean } = {}): Promise<T> {
  if (env.RLS_MODE !== 'enforce') return opts.atomic === false ? fn(db) : db.$transaction(fn);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${ctx.orgId}, true)`;
    return fn(tx);
  });
}

/**
 * Cross-org work as the owner role, which bypasses RLS. Only the files in `cross-org.ts` may call it (INV-32):
 * paths that run before an org is known (sign-in, invite and share-link redemption) or across orgs (cron, webhooks).
 */
export function asSystem<T>(fn: (sys: PrismaClient) => Promise<T>): Promise<T> {
  return fn(dbSystem);
}
