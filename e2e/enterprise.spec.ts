import { expect, test } from '@playwright/test';
import { sealSecret } from '../src/core/auth/secret-box';
import { hashToken, newToken } from '../src/core/tokens';
import { dbSystem as db } from '../src/core/db/system';
import { startOidcMock, type OidcMock } from '../tests/helpers/oidc-mock';

// Phase 4 demo steps (PRD §9, D-31). Step 1 for real (D-22): Northwind's IdP here is the local OIDC mock standing in for
// Google (the real Google and Okta sign-ins are recorded by hand in docs/DEMO.md, §7's gate). Require SSO is on, as
// seed:demo sets it when the provider keys are present.
const DOMAIN = 'northwind.demo.test';
const STAFF = `sso@${DOMAIN}`; // only this spec signs in as this user, so its sign-in method cannot race demo.spec's
let mock: OidcMock;
test.describe.configure({ mode: 'serial' }); // step 12 reads step 1's sign-in
let orgId: string;

const dropSso = () => Promise.all([db.ssoConnection.deleteMany({ where: { orgId } }), db.ssoDomain.deleteMany({ where: { orgId } })]);

test.beforeAll(async () => {
  mock = await startOidcMock();
  ({ id: orgId } = await db.org.findUniqueOrThrow({ where: { slug: 'northwind' }, select: { id: true } }));
  await dropSso();
  await db.ssoConnection.create({
    data: { orgId, issuer: mock.issuer, clientId: mock.client.id, clientSecretSealed: sealSecret(mock.client.secret, 'sso'), allowedDomains: [DOMAIN], enabledAt: new Date(), required: true, requiredAt: new Date() },
  });
  await db.ssoDomain.create({ data: { orgId, domain: DOMAIN, verifiedAt: new Date() } });
  await db.rateLimit.deleteMany(); // the server sees every local run as one IP
});
test.afterAll(async () => {
  await dropSso();
  await db.$disconnect();
  await mock.close();
});

test('step 1: Northwind staff sign in through the provider and land on the dashboard', async ({ page }) => {
  mock.user = { sub: 'sub-northwind-sso', email: STAFF, email_verified: true };
  await page.goto('/login');
  await page.getByLabel('Email').fill(STAFF);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('link', { name: 'Northwind' }).click();
  for (const t of ['Planned', 'Committed', 'Actual', 'Available']) await expect(page.locator('main')).toContainText(t);
  await expect(page.getByRole('heading', { name: /^Unmatched invoices \(\d+\)$/ })).toBeVisible();
});

test('step 7 (link half): with Require SSO on, Dana the guest still gets a magic link', async ({ page }) => {
  const email = 'dana@meridian.demo.test';
  await db.loginToken.deleteMany({ where: { email } }); // link.ts's 60s per-address cooldown would swallow a rerun's request
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(() => db.loginToken.count({ where: { email } })).toBe(1);
});

test('step 12: the security page shows who signs in by SSO and that SSO is required', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@northwind.demo.test' }).click();
  await page.goto('/o/northwind/settings/security');
  await expect(page.getByRole('row', { name: new RegExp(STAFF) })).toContainText('SSO');
  await expect(page.locator('main')).toContainText('On. Required: yes.');
});

// Step 8's API half (D-22, D-31): Northwind's PO id through Contoso's read key gets the same 404 body as an id that does
// not exist. The key is planted, as the SSO rows are: the shared demo account cannot mint keys (keys.ts assertNotDemo).
test("step 8 (API half): Contoso's key on a Northwind PO id gets the same 404 body as a missing id", async ({ request }) => {
  const po = await db.commitment.findFirstOrThrow({ where: { orgId }, select: { id: true } });
  const contoso = await db.org.findUniqueOrThrow({ where: { slug: 'contoso' }, select: { id: true } });
  const owner = await db.user.findUniqueOrThrow({ where: { email: 'owner@contoso.demo.test' }, select: { id: true } });
  const key = `api_${newToken()}`; // keys.ts KEY_PREFIX
  const k = await db.apiKey.create({ data: { orgId: contoso.id, label: 'e2e step 8', scopes: ['read'], prefix: key.slice(0, 10), keyHash: hashToken(key), createdById: owner.id } });
  try {
    const get = (id: string) => request.get(`/api/v1/commitments/${id}`, { headers: { authorization: `Bearer ${key}` } });
    const foreign = await get(po.id);
    const missing = await get(crypto.randomUUID());
    expect(foreign.status()).toBe(404);
    expect([missing.status(), await missing.text()]).toEqual([foreign.status(), await foreign.text()]);
  } finally {
    await db.apiKey.delete({ where: { id: k.id } });
  }
});
