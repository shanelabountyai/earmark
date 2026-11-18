import { createHmac } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { env } from '@/core/env';

// The domain-ownership TXT record (addendum §3). Its own file so settings.ts (verify) and hooks.ts (the cron re-check,
// v1.7.0) share it without importing each other.

/** Tests replace this; everything else reads real DNS. */
export const dns = { resolveTxt: (name: string) => resolveTxt(name) };

export const txtName = (domain: string) => `_foundation-sso.${domain}`;
/**
 * The TXT value is derived, not stored: nothing in a database dump proves a domain, and the page can always show it.
 * Rotating AUTH_SECRET changes every value, so from v1.7.0 every verified domain lapses after the re-check's grace
 * period unless its TXT record is updated.
 */
export const txtValue = (orgId: string, domain: string) =>
  `foundation-sso=${createHmac('sha256', env.AUTH_SECRET).update(`sso-domain/${orgId}/${domain}`).digest('base64url')}`;

/** True when the record is there now. A lookup error (NXDOMAIN, timeout) counts as absent. */
export const txtPresent = async (orgId: string, domain: string) =>
  (await dns.resolveTxt(txtName(domain)).catch(() => [] as string[][])).some((r) => r.join('') === txtValue(orgId, domain));
