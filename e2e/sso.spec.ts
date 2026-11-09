import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { sealSecret } from '@/core/auth/secret-box';
import { startOidcMock, type OidcMock } from '../tests/helpers/oidc-mock';

// Addendum §3 end to end against the local mock provider: /login routes a verified SSO domain to the provider, the
// callback signs in, and the user lands on /onboarding inside the org (JIT). Needs SSO_ENABLED=1 (playwright.config.ts).
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 }); // fixtures as the owner (RLS enforce)
const slug = `e2e-sso-${randomUUID().slice(0, 8)}`;
const domain = `${slug}.example`;
let mock: OidcMock;

test.beforeAll(async () => {
  mock = await startOidcMock();
  await db.query('DELETE FROM "RateLimit"'); // the server sees every local run as one IP
  const orgId = randomUUID();
  await db.query(`INSERT INTO "Org" (id, slug, name, "updatedAt") VALUES ($1, $2, 'SSO e2e', now())`, [orgId, slug]);
  await db.query(
    `INSERT INTO "SsoConnection" (id, "orgId", issuer, "clientId", "clientSecretSealed", "allowedDomains", "enabledAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [randomUUID(), orgId, mock.issuer, mock.client.id, sealSecret(mock.client.secret, 'sso'), [domain]],
  );
  await db.query(`INSERT INTO "SsoDomain" (id, "orgId", domain, "verifiedAt") VALUES ($1, $2, $3, now())`, [randomUUID(), orgId, domain]);
});
test.afterAll(async () => {
  await db.query('DELETE FROM "Org" WHERE slug = $1', [slug]);
  await db.end();
  await mock.close();
});

test('an email on a verified SSO domain signs in through the provider and joins the org', async ({ page }) => {
  const email = `ada@${domain}`;
  mock.user = { sub: `sub-${slug}`, email, email_verified: true };
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'SSO e2e' })).toBeVisible();

  const { rows } = await db.query('SELECT count(*)::int AS n FROM "LoginToken" WHERE email = $1', [email]);
  expect(rows[0].n).toBe(0); // no magic link was sent
});

test('a callback without the state cookie is a 404 and signs no one in', async ({ request }) => {
  const res = await request.get('/login/sso/callback?code=x&state=y', { maxRedirects: 0 });
  expect(res.status()).toBe(404);
});
