import { env } from '@/core/env';

// Core's one seam for the optional `sso` module (addendum §3, D-24). Core never imports a module (spec §4), so the module
// registers itself from the clone-owned src/app/modules.ts, which the sign-in routes import (INV-36 checks they do).
// With the module removed, or SSO_ENABLED unset, both calls answer "no SSO" and /login behaves as before v1.6.0.
export type SsoHooks = {
  /** The slug of the org whose enabled connection owns this email's verified domain, or null. */
  resolve(email: string): Promise<string | null>;
  /** True when an SSO-required org this user belongs to refuses them a magic link (INV-36). */
  refusesLink(userId: string): Promise<boolean>;
  /**
   * True when this org requires SSO and does not admit this session (v1.6.5, audit A-05 guard half and A-06): only a
   * session made through SSO gets in, apart from the owner inside their 24-hour exemption. requireOrg asks it.
   */
  refusesSession(orgId: string, userId: string, method: string): Promise<boolean>;
};

let registered: SsoHooks | undefined;
export const registerSsoHooks = (h: SsoHooks) => void (registered = h);

const hooks = () => (env.SSO_ENABLED === '1' ? registered : undefined);
export const resolveSso = async (email: string) => (await hooks()?.resolve(email)) ?? null;
export const ssoRefusesLink = async (userId: string) => (await hooks()?.refusesLink(userId)) ?? false;
export const ssoRefusesSession = async (orgId: string, userId: string, method: string) => (await hooks()?.refusesSession(orgId, userId, method)) ?? false;
