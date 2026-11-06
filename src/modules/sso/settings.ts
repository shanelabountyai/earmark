import { createHmac } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { notFound } from 'next/navigation';
import { audit } from '@/core/audit';
import { sealSecret } from '@/core/auth/secret-box';
import { assertNotDemo } from '@/core/auth/session';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import type { Role } from '@/generated/prisma/enums';
import { insecureOk } from './flow';
import { domainVerifiedElsewhere } from './hooks';

// The owner's SSO settings (addendum §3): `org.update` plus the owner role, every change audited, no secret in the log.

/** Tests replace this; everything else reads real DNS. */
export const dns = { resolveTxt: (name: string) => resolveTxt(name) };

export const txtName = (domain: string) => `_foundation-sso.${domain}`;
/** The TXT value is derived, not stored: nothing in a database dump proves a domain, and the page can always show it. */
export const txtValue = (orgId: string, domain: string) =>
  `foundation-sso=${createHmac('sha256', env.AUTH_SECRET).update(`sso-domain/${orgId}/${domain}`).digest('base64url')}`;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function parseDomain(input: string): string {
  const d = input.trim().toLowerCase();
  if (!DOMAIN.test(d)) throw new Refused(`"${input.trim().slice(0, 80)}" is not a domain name.`);
  return d;
}

function assertOwner(ctx: OrgCtx) {
  assertNotDemo(ctx.session);
  if (ctx.role !== 'owner') throw new Refused('Only an owner can change SSO.');
}

const connectionOf = (ctx: OrgCtx) => withOrg(ctx, (tx) => tx.ssoConnection.findUnique({ where: inOrg(ctx) }), { atomic: false });

export type ConnectionInput = { issuer: string; clientId: string; clientSecret: string; allowedDomains: string; defaultRole: Role };

export async function saveConnection(ctx: OrgCtx, i: ConnectionInput) {
  assertOwner(ctx);
  if (i.defaultRole === 'owner') throw new Refused('SSO cannot make anyone an owner. Pick another default role.'); // INV-38
  let issuer: URL;
  try {
    issuer = new URL(i.issuer.trim());
  } catch {
    throw new Refused('The issuer must be a URL.');
  }
  if (issuer.protocol !== 'https:' && !insecureOk(issuer)) throw new Refused('The issuer must be an https URL.');
  const clientId = i.clientId.trim();
  if (!clientId) throw new Refused('Enter the client ID.');
  const allowedDomains = [...new Set(i.allowedDomains.split(/[\s,]+/).filter(Boolean).map(parseDomain))];
  const existing = await connectionOf(ctx);
  const secret = i.clientSecret.trim();
  if (!secret && !existing) throw new Refused('Enter the client secret.');
  const data = { issuer: i.issuer.trim(), clientId, allowedDomains, defaultRole: i.defaultRole, ...(secret && { clientSecretSealed: sealSecret(secret, 'sso') }) };
  await withOrg(ctx, async (tx) => {
    await tx.ssoConnection.upsert({ where: inOrg(ctx), create: { ...data, clientSecretSealed: data.clientSecretSealed!, orgId: ctx.orgId }, update: data });
    await audit(ctx, 'sso.connection_saved', { data: { issuer: data.issuer, clientId, allowedDomains, defaultRole: i.defaultRole, secretChanged: !!secret } }, tx);
  });
}

export async function setEnabled(ctx: OrgCtx, on: boolean) {
  assertOwner(ctx);
  if (!(await connectionOf(ctx))) throw new Refused('Save a connection first.');
  await withOrg(ctx, async (tx) => {
    // Turning SSO off also drops "required", so a broken provider can always be backed out of.
    await tx.ssoConnection.update({ where: inOrg(ctx), data: on ? { enabledAt: now() } : { enabledAt: null, required: false, requiredAt: null, requiredById: null } });
    await audit(ctx, on ? 'sso.enabled' : 'sso.disabled', {}, tx);
  });
}

/** INV-36: the owner who turns this on keeps magic links for 24 hours (src/modules/sso/hooks.ts). */
export async function setRequired(ctx: OrgCtx, on: boolean) {
  assertOwner(ctx);
  const c = await connectionOf(ctx);
  if (!c?.enabledAt) throw new Refused('Turn the connection on first.');
  await withOrg(ctx, async (tx) => {
    await tx.ssoConnection.update({ where: inOrg(ctx), data: on ? { required: true, requiredAt: now(), requiredById: ctx.userId } : { required: false, requiredAt: null, requiredById: null } });
    await audit(ctx, on ? 'sso.required_on' : 'sso.required_off', {}, tx);
  });
}

export async function addDomain(ctx: OrgCtx, input: string) {
  assertOwner(ctx);
  const domain = parseDomain(input);
  try {
    await withOrg(ctx, async (tx) => {
      await tx.ssoDomain.create({ data: { orgId: ctx.orgId, domain } });
      await audit(ctx, 'sso.domain_added', { data: { domain } }, tx);
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new Refused('That domain is already on the list.');
    throw e;
  }
}

const domainOf = async (ctx: OrgCtx, id: string) =>
  (await withOrg(ctx, (tx) => tx.ssoDomain.findFirst({ where: { id, ...inOrg(ctx) } }), { atomic: false })) ?? notFound();

export async function verifyDomain(ctx: OrgCtx, id: string) {
  assertOwner(ctx);
  const d = await domainOf(ctx, id);
  if (d.verifiedAt) return;
  const records = await dns.resolveTxt(txtName(d.domain)).catch(() => [] as string[][]);
  if (!records.some((r) => r.join('') === txtValue(ctx.orgId, d.domain))) {
    throw new Refused(`No matching TXT record at ${txtName(d.domain)} yet. DNS changes can take a while to appear.`);
  }
  if (await domainVerifiedElsewhere(d.domain, ctx.orgId)) throw new Refused('Another org has already verified this domain.');
  await withOrg(ctx, async (tx) => {
    await tx.ssoDomain.update({ where: { id: d.id }, data: { verifiedAt: now() } });
    await audit(ctx, 'sso.domain_verified', { data: { domain: d.domain } }, tx);
  });
}

export async function removeDomain(ctx: OrgCtx, id: string) {
  assertOwner(ctx);
  const d = await domainOf(ctx, id);
  await withOrg(ctx, async (tx) => {
    await tx.ssoDomain.deleteMany({ where: { id: d.id, ...inOrg(ctx) } });
    await audit(ctx, 'sso.domain_removed', { data: { domain: d.domain } }, tx);
  });
}
