import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';

// The e2e process reads the same local database as the server (.env.test).
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 }); // fixtures as the owner (RLS enforce)
test.afterAll(() => db.end());
test.beforeAll(() => db.query('DELETE FROM "RateLimit"')); // the server sees every local run as one IP

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

test('INV-17 GETting the link twice spends nothing; the button signs in once', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');

  const { rows } = await db.query('SELECT body FROM "CapturedMessage" WHERE "to" = $1', [email]);
  const link = rows[0].body.match(/https?:\/\/\S+\/login\/[\w-]+/)[0] as string;
  const token = link.split('/').pop()!;

  await page.goto(link);
  await page.goto(link);
  const spent = await db.query('SELECT "usedAt" FROM "LoginToken" WHERE hash = $1', [sha(token)]);
  expect(spent.rows[0].usedAt).toBeNull();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/onboarding$/); // a user with no org lands here (M3)
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();

  // INV-15, signed-in route: the global headers are on it too.
  const h = (await page.request.get('/account/security')).headers();
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['strict-transport-security']).toContain('max-age=');
  expect(h['x-content-type-options']).toBe('nosniff');

  // The link is spent now.
  await page.goto(link);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/login\?expired=1$/);
});

test('a cross-site POST cannot redeem a link (login CSRF)', async ({ request }) => {
  const res = await request.post('/login/redeem', { form: { token: 'x' }, headers: { origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(res.status()).toBe(403);
});
