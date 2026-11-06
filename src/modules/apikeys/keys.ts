import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { assertNotDemo } from '@/core/auth/session';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { asSystem, withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { hashToken, newToken } from '@/core/tokens';
import { API_SCOPES } from '@/app/api-scopes';

// API keys (addendum §7, ported from Bookable W-001): one per integration, shown once, stored as its sha256 (INV-07),
// scoped, revocable. The key alone names its org: no endpoint takes an org id, so a key cannot reach another org (INV-40).

export const KEY_PREFIX = 'api_';

/** What a resolved key may do. `userId` is null: an integration is not a person, and audit lines say which key acted. */
export type ApiCtx = { orgId: string; keyId: string; label: string; scopes: string[]; role: 'integration'; userId: null };

function assertManager(ctx: OrgCtx) {
  assertNotDemo(ctx.session); // the shared demo account must not mint working credentials
}

export async function createKey(ctx: OrgCtx, input: { label: string; scopes: string[] }): Promise<string> {
  assertManager(ctx);
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Refused('Give the key a label of 1 to 80 characters, e.g. "CRM sync".');
  const scopes = Object.keys(API_SCOPES).filter((s) => input.scopes.includes(s));
  if (scopes.length !== new Set(input.scopes).size) throw new Refused('Unknown scope.');
  if (!scopes.length) throw new Refused('Pick at least one scope: a key with none can do nothing.');
  const key = KEY_PREFIX + newToken();
  await withOrg(ctx, async (tx) => {
    const k = await tx.apiKey.create({ data: { ...inOrg(ctx), label, scopes, prefix: key.slice(0, KEY_PREFIX.length + 6), keyHash: hashToken(key), createdById: ctx.userId } });
    await audit(ctx, 'apikey.created', { targetType: 'apiKey', targetId: k.id, data: { label, scopes } }, tx);
  });
  return key;
}

/** Takes effect on the key's next request: resolution reads the row every time. */
export async function revokeKey(ctx: OrgCtx, id: string) {
  assertManager(ctx);
  await withOrg(ctx, async (tx) => {
    const k = (await tx.apiKey.findFirst({ where: { id, ...inOrg(ctx) }, select: { id: true, revokedAt: true } })) ?? notFound();
    if (k.revokedAt) return;
    await tx.apiKey.update({ where: { id: k.id }, data: { revokedAt: now() } });
    await audit(ctx, 'apikey.revoked', { targetType: 'apiKey', targetId: k.id }, tx);
  });
}

/** A member's keys die with their membership (org-hooks.ts onMembershipEnded): a copied key must not outlive access. */
export async function revokeKeysCreatedBy(tx: Tx, orgId: string, userId: string) {
  const { count } = await tx.apiKey.updateMany({ where: { orgId, createdById: userId, revokedAt: null }, data: { revokedAt: now() } });
  if (count) await audit({ orgId, userId: null }, 'apikey.revoked_with_member', { targetType: 'user', targetId: userId, data: { count } }, tx);
}

export const listKeys = (ctx: OrgCtx) =>
  withOrg(
    ctx,
    (tx) =>
      tx.apiKey.findMany({
        where: inOrg(ctx),
        orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
        select: { id: true, label: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      }),
    { atomic: false },
  );

/**
 * Bearer → the key's org and scopes, or null for missing, malformed, unknown or revoked: one answer for all four.
 * The lookup runs before any org is known, so it is a cross-org read (cross-org.ts). lastUsedAt is written at most
 * once a minute, so a busy key does not turn every read into a write.
 */
export async function resolveKey(authorization: string | null): Promise<ApiCtx | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m?.[1]?.startsWith(KEY_PREFIX)) return null;
  const row = await asSystem((sys) =>
    sys.apiKey.findUnique({ where: { keyHash: hashToken(m[1]!) }, select: { id: true, orgId: true, label: true, scopes: true, revokedAt: true, lastUsedAt: true } }),
  );
  if (!row || row.revokedAt) return null;
  const t = now();
  if (!row.lastUsedAt || t.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await asSystem((sys) => sys.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: t } }));
  }
  return { orgId: row.orgId, keyId: row.id, label: row.label, scopes: row.scopes, role: 'integration', userId: null };
}
