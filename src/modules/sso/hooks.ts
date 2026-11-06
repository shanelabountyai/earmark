import type { SsoHooks } from '@/core/auth/sso-hook';
import { now } from '@/core/clock';
import { asSystem } from '@/core/db/rls';

// Cross-org (cross-org.ts): /login, the link checks and the cron sweep all run before an org is known, or across orgs.
const EXEMPT_MS = 24 * 3600_000; // the owner who turned "Require SSO" on keeps magic links this long (INV-36)

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1);

export const ssoHooks: SsoHooks = {
  resolve: (email) =>
    asSystem(async (sys) => {
      const d = await sys.ssoDomain.findFirst({
        where: { domain: emailDomain(email), verifiedAt: { not: null }, org: { ssoConnection: { enabledAt: { not: null } } } },
        select: { org: { select: { slug: true } } },
      });
      return d?.org.slug ?? null;
    }),

  refusesLink: (userId) =>
    asSystem(async (sys) => {
      const required = await sys.ssoConnection.findMany({
        where: { required: true, enabledAt: { not: null }, org: { memberships: { some: { userId } } } },
        select: { requiredAt: true, requiredById: true },
      });
      const t = now().getTime();
      return required.some((c) => !(c.requiredById === userId && c.requiredAt && t - c.requiredAt.getTime() < EXEMPT_MS));
    }),
};

/** A domain belongs to at most one org: verifying it is refused while another org holds it verified. */
export const domainVerifiedElsewhere = (domain: string, orgId: string) =>
  asSystem(async (sys) => !!(await sys.ssoDomain.findFirst({ where: { domain, verifiedAt: { not: null }, orgId: { not: orgId } }, select: { id: true } })));

/** Cron: expired sign-in states (10-minute TTL) across every org. */
export const sweepSsoStates = () => asSystem(async (sys) => (await sys.ssoState.deleteMany({ where: { expiresAt: { lt: now() } } })).count);
