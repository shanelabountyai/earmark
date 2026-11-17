import { type Browser, type Page, test } from '@playwright/test';
import { dbSystem as db } from '../src/core/db/system';
import { hashToken, newToken } from '../src/core/tokens';

const SESSION_COOKIE_NAME = '__Host-session'; // src/core/auth/session.ts SESSION_COOKIE (that module needs next/headers)

// The shared /demo accounts are refused exports and member removal (assertNotDemo), so demo steps 13 and 14 act as a
// non-demo owner with a planted session, as enterprise.spec plants the SSO rows and the API key. Not on /demo's list.
// The session carries MFA from the org's IdP (guards.ts accepts it for that org only). The cookie is set for https:
// CDP refuses a secure cookie on an http URL, and Chrome still sends it to http://localhost.
export async function asRealOwner(browser: Browser, slug: string): Promise<{ page: Page; email: string }> {
  const email = `ops@${slug}.demo.test`;
  const { id: orgId } = await db.org.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const { id: userId } = await db.user.upsert({ where: { email }, create: { email, name: `${slug} ops (e2e)` }, update: {} });
  await db.membership.upsert({ where: { orgId_userId: { orgId, userId } }, create: { orgId, userId, role: 'owner' }, update: { role: 'owner' } });
  const token = newToken();
  const t = new Date();
  await db.session.create({ data: { hash: hashToken(token), userId, authAt: t, createdAt: t, lastSeenAt: t, method: 'sso', mfaAt: t, mfaOrgId: orgId, expiresAt: new Date(t.getTime() + 3600_000) } });
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: test.info().project.use.baseURL!.replace(/^http:/, 'https:'), secure: true, httpOnly: true, sameSite: 'Lax' }]);
  return { page: await context.newPage(), email };
}
