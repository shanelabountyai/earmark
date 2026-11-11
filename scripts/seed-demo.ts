import { pathToFileURL } from 'node:url';
import { now } from '@/core/clock';
import { sealSecret } from '@/core/auth/secret-box';
import { db } from '@/core/db'; // importing it is what refuses a cloud database (INV-18, INV-27)
import { asSystem } from '@/core/db/rls';
import { env } from '@/core/env';
import { costMicros } from '@/core/ai/prices';
import { STUB_USAGE } from '@/lib/earmark/explainer-usage';
import type { Role } from '@/generated/prisma/enums';
import { seedEarmark } from './seed-earmark';

// Demo data (spec §7, D-8): two orgs, an owner, admin and member in each. Only this script sets `isDemo`,
// and the cloud guard in `@/core/db` refuses a non-local database unless ALLOW_CLOUD_DB=1.
// The TOTP secret is a fixed, public demo value. That is safe only because of two rules in core/auth/session.ts:
// an `isDemo` user's session resolves only while DEMO_MODE=1, and a demo session cannot change its email or TOTP.
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

// Earmark (PRD §9): the two client orgs. Their seat holders, Dana the agency guest and the ledger are in seed-earmark.ts.
const ORGS = [
  { slug: 'northwind', name: 'Northwind', domain: 'northwind.demo.test' },
  { slug: 'contoso', name: 'Contoso', domain: 'contoso.demo.test' },
] as const;
const ROLES: Role[] = ['owner', 'admin', 'member'];

// Cross-org (cross-org.ts): writes several orgs, so it runs as the system role.
export const seedDemo = () => asSystem((sys) => seedWith(sys));

async function seedWith(db: Parameters<Parameters<typeof asSystem>[0]>[0]) {
  const printed: string[] = [];
  for (const o of ORGS) {
    const org = await db.org.upsert({ where: { slug: o.slug }, create: { slug: o.slug, name: o.name }, update: { name: o.name } }); // a vitest run on the same DB leaves its own 'northwind' org
    for (const role of ROLES) {
      const email = `${role}@${o.domain}`;
      const mfa = role !== 'member'; // owners and admins are TOTP-enrolled, as the guard requires
      const data = {
        isDemo: true,
        name: `${role[0]!.toUpperCase()}${role.slice(1)} (${o.name})`,
        ...(mfa && { totpSecretSealed: sealSecret(DEMO_TOTP_SECRET, 'totp'), totpEnrolledAt: now(), totpLastStep: null }),
      };
      const user = await db.user.upsert({ where: { email }, create: { email, ...data }, update: data });
      await db.membership.upsert({
        where: { orgId_userId: { orgId: org.id, userId: user.id } },
        create: { orgId: org.id, userId: user.id, role },
        update: { role },
      });
      printed.push(`${email}  ${role} of ${o.name}${mfa ? '  (TOTP)' : ''}`);
    }
    // §10.5: demo orgs cap AI spend at $1.00, so the refusal path is reachable in a demo.
    await db.aiBudget.upsert({ where: { orgId: org.id }, create: { orgId: org.id, monthlyCapMicros: 1_000_000n }, update: { monthlyCapMicros: 1_000_000n, pausedAt: null } });
    // PRD §9 step 10: this month's spend is planted so three stub drafts fit and the fourth is refused. With a draft
    // costing `a` and its worst-case check `w` (a/2 < w <= 1.5a for any prompt under ~9,000 characters): 3.5a planted below the cap passes three
    // checks and fails the fourth. Reset on every seed, so each e2e sweep starts from the same spend.
    const a = costMicros(STUB_USAGE.provider, STUB_USAGE.model, STUB_USAGE.inputTokens, STUB_USAGE.outputTokens);
    await db.aiHold.deleteMany({ where: { orgId: org.id } });
    await db.aiUsage.deleteMany({ where: { orgId: org.id } });
    await db.aiUsage.create({ data: { orgId: org.id, provider: STUB_USAGE.provider, model: STUB_USAGE.model, inputTokens: 0, outputTokens: 0, costMicros: 1_000_000n - 3n * a - a / 2n, feature: 'seed', createdAt: now() } });
  }
  printed.push(...(await seedEarmark(db)));
  printed.push(...(await seedSso(db)));
  return printed;
}

// D-26: the two hand-checked SSO providers, pre-filled from .env.local when their keys are set, Google on northwind and Okta
// on contoso. The domain is seeded verified (no DNS for a demo). Reached by name so the script still compiles once
// foundation:check-modules has removed the sso module; then it seeds nothing.
type Upserter = { upsert: (a: unknown) => Promise<unknown> };
async function seedSso(db: Parameters<Parameters<typeof asSystem>[0]>[0]): Promise<string[]> {
  const m = db as unknown as Record<string, Upserter | undefined>;
  const [conn, dom] = [m.ssoConnection, m.ssoDomain];
  if (!conn || !dom) return [];
  const providers = [
    { name: 'Google Workspace', slug: 'northwind', issuer: 'https://accounts.google.com', id: env.SSO_TEST_GOOGLE_CLIENT_ID, secret: env.SSO_TEST_GOOGLE_CLIENT_SECRET, domain: env.SSO_TEST_GOOGLE_DOMAIN },
    { name: 'Okta', slug: 'contoso', issuer: env.SSO_TEST_OKTA_ISSUER, id: env.SSO_TEST_OKTA_CLIENT_ID, secret: env.SSO_TEST_OKTA_CLIENT_SECRET, domain: env.SSO_TEST_OKTA_DOMAIN },
  ];
  const out: string[] = [];
  const used = new Set<string>();
  for (const p of providers) {
    if (!p.issuer || !p.id || !p.secret || !p.domain) continue;
    const domain = p.domain.toLowerCase();
    if (used.has(domain)) {
      out.push(`skipped ${p.name} SSO: @${domain} is already another demo org's domain (one org per domain)`);
      continue;
    }
    used.add(domain);
    const { id: orgId } = await db.org.findUniqueOrThrow({ where: { slug: p.slug }, select: { id: true } });
    // PRD §6: Require SSO on both demo orgs; guests (Dana) keep magic links (D-32).
    const data = { issuer: p.issuer, clientId: p.id, clientSecretSealed: sealSecret(p.secret, 'sso'), allowedDomains: [domain], enabledAt: now(), required: true, requiredAt: now() };
    await conn.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
    await dom.upsert({ where: { orgId_domain: { orgId, domain } }, create: { orgId, domain, verifiedAt: now() }, update: { verifiedAt: now() } });
    out.push(`@${domain} signs in to ${p.slug} through ${p.name} (SSO_ENABLED=1)`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = await seedDemo();
  console.log(`Seeded demo accounts. Sign in at /demo (DEMO_MODE=1):\n  ${lines.join('\n  ')}`);
  console.log(`TOTP secret for the (TOTP) accounts, for an authenticator app: ${DEMO_TOTP_SECRET}`);
  await db.$disconnect();
}
