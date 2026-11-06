import { db } from '@/core/db';
import type { Prisma } from '@/generated/prisma/client';

type Tx = Prisma.TransactionClient;
export type AuditTarget = { targetType?: string; targetId?: string; data?: Prisma.InputJsonValue };

/**
 * Appends one event. Rows can never be changed or deleted (a DB trigger, INV-19), and carry no
 * foreign keys, so they outlive the org and user they name. Pass `tx` to commit with the change.
 */
export async function audit(actor: { orgId?: string | null; userId: string | null }, action: string, target: AuditTarget = {}, tx: Tx = db) {
  // createMany, not create: create's INSERT … RETURNING must pass the SELECT policy, which an event for another
  // org (or none) does not under RLS. Insert is open on AuditEvent; reading it back is scoped (addendum §2).
  await tx.auditEvent.createMany({ data: [{ orgId: actor.orgId ?? null, actorUserId: actor.userId, action, ...target }] });
}

export const AUDIT_PAGE = 50;
const NO_ONE = '00000000-0000-0000-0000-000000000000';

export type AuditFilter = { actorUserId?: string; action?: string; from?: Date; to?: Date };

/**
 * Reads a filter from the viewer's query string: actor by email, action by prefix, a date range by day (UTC, both
 * ends inclusive). An unknown actor matches no event rather than every event.
 */
export async function auditFilter(q: Record<string, string | string[] | undefined>): Promise<AuditFilter> {
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string).trim() : '');
  const day = (v: string, plus = 0) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(Date.parse(`${v}T00:00:00Z`) + plus) : undefined);
  const actor = one('actor').toLowerCase();
  const u = actor ? await db.user.findUnique({ where: { email: actor }, select: { id: true } }) : null;
  return { actorUserId: actor ? (u?.id ?? NO_ONE) : undefined, action: one('action') || undefined, from: day(one('from')), to: day(one('to'), 86_400_000) };
}

/** The org's events, newest first. The viewer (a page of 50), its CSV and the data export all read through here (§4). */
export function auditEvents(tx: Tx, orgId: string, f: AuditFilter = {}, page: { before?: bigint; take?: number } = {}) {
  return tx.auditEvent.findMany({
    where: {
      orgId,
      actorUserId: f.actorUserId,
      action: f.action ? { startsWith: f.action } : undefined,
      at: { gte: f.from, lt: f.to },
      id: page.before ? { lt: page.before } : undefined,
    },
    orderBy: { id: 'desc' },
    take: page.take,
  });
}

/** Emails for the actor ids on a page of events (User has no org policy). Deleted users are absent. */
export async function actorEmails(ids: (string | null)[]): Promise<Map<string, string>> {
  const users = await db.user.findMany({ where: { id: { in: [...new Set(ids.filter((i): i is string => !!i))] } }, select: { id: true, email: true } });
  return new Map(users.map((u) => [u.id, u.email]));
}

/** RFC 4180, and a leading = + - @ is defused so a spreadsheet does not run it as a formula. */
export function toCsv(rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
