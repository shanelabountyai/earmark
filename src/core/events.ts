import type { Prisma } from '@/generated/prisma/client';
import type { Tx } from '@/core/db/rls';

/**
 * Publishes one event to the org's log (addendum §7, D-28), in the caller's transaction, so a change, its audit line
 * and its event commit together or not at all. Pass the `tx` you passed to audit(). The payload is stored once and is
 * what every webhook delivery and replay of this event sends, so put in it what a receiver needs, and no secret.
 * `key` dedupes: a second emit with the same key in the same org writes nothing (INV-41). `seq` is set at commit.
 * Name types in src/app/event-types.ts. The apikeys module fans the log out to webhook endpoints; without it, the log
 * is still written and exported, and nothing sends it.
 */
export async function emit(ctx: { orgId: string }, type: string, payload: Prisma.InputJsonValue, tx: Tx, opts: { key?: string } = {}) {
  // createMany: ON CONFLICT DO NOTHING on (orgId, key) for the dedupe, and no RETURNING to pass under RLS.
  await tx.orgEvent.createMany({ data: [{ orgId: ctx.orgId, type, payload, key: opts.key ?? null }], skipDuplicates: true });
}
