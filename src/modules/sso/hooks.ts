import type { SsoHooks } from '@/core/auth/sso-hook';
import { now } from '@/core/clock';
import { asSystem } from '@/core/db/rls';

// Cross-org (cross-org.ts): /login, the link checks and the cron sweep all run before an org is known, or across orgs.
const EXEMPT_MS = 24 * 3600_000; // the owner who turned "Require SSO" on keeps magic links this long (INV-36)

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1);

/** The owner who turned "Require SSO" on keeps magic links and link sessions for 24 hours (INV-36). */
const exempt = (c: { requiredAt: Date | null; requiredById: string | null }, userId: string) =>
  c.requiredById === userId && !!c.requiredAt && now().getTime() - c.requiredAt.getTime() < EXEMPT_MS;

export const ssoHooks: SsoHooks = {
  resolve: (email) =>
    asSystem(async (sys) => {
      const d = await sys.ssoDomain.findFirst({
        where: { domain: emailDomain(email), verifiedAt: { not: null }, org: { ssoConnection: { enabledAt: { not: null } } } },
        select: { org: { select: { slug: true } } },
      });
      return d?.org.slug ?? null;
    }),

  // v1.6.5 (audit A-06, owner decision 2026-11-17): the link is refused only to a user whose email is on one of the
  // requiring org's verified domains, the people its provider can sign in. An off-domain member (a contractor with their
  // own org) keeps links for everything else, and is kept out of the SSO-required org by refusesSession below.
  refusesLink: (userId) =>
    asSystem(async (sys) => {
      const user = await sys.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user) return false;
      const domain = emailDomain(user.email);
      const required = await sys.ssoConnection.findMany({
        // earmark D-32: a guest is outside staff, never on the org's IdP; v1.6.5 A-06: only on-domain members are refused
        where: { required: true, enabledAt: { not: null }, org: { memberships: { some: { userId, role: { not: 'guest' } } }, ssoDomains: { some: { domain, verifiedAt: { not: null } } } } },
        select: { requiredAt: true, requiredById: true },
      });
      return required.some((c) => !exempt(c, userId));
    }),

  refusesSession: (orgId, userId, method) =>
    asSystem(async (sys) => {
      if (method === 'sso') return false; // ponytail: any org's SSO counts; sessions do not record which provider made them
      // v1.6.6 (owner decision 2026-11-17): a /demo session is a shared synthetic account that exists only while DEMO_MODE
      // is on (INV-27) and is never on any provider, so Require SSO does not apply to it; a demo org may show it switched on.
      if (method === 'demo') return false;
      // earmark D-32: a guest (agency) member is outside staff and never on the org's IdP, so Require SSO does not apply
      const m = await sys.membership.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { role: true } });
      if (m?.role === 'guest') return false;
      const c = await sys.ssoConnection.findFirst({ where: { orgId, required: true, enabledAt: { not: null } }, select: { requiredAt: true, requiredById: true } });
      return !!c && !exempt(c, userId);
    }),
};

/** A domain belongs to at most one org: verifying it is refused while another org holds it verified. */
export const domainVerifiedElsewhere = (domain: string, orgId: string) =>
  asSystem(async (sys) => !!(await sys.ssoDomain.findFirst({ where: { domain, verifiedAt: { not: null }, orgId: { not: orgId } }, select: { id: true } })));

/** Cron: expired sign-in states (10-minute TTL) across every org. */
export const sweepSsoStates = () => asSystem(async (sys) => (await sys.ssoState.deleteMany({ where: { expiresAt: { lt: now() } } })).count);
