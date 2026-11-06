import { expect, test } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 }); // fixtures as the owner (RLS enforce)
test.afterAll(() => db.end());
test.beforeAll(() => db.query('DELETE FROM "RateLimit"')); // the server sees every local run as one IP

// Spec §9 Onboarding: a new email signs up, creates an org, and lands in it — by way of the
// required TOTP enrolment, because the creator is its owner (INV-22).
test('new email → org created → lands in /o/[slug]', async ({ page }) => {
  const email = `e2e-onboard-${Date.now()}@example.test`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  const { rows } = await db.query('SELECT body FROM "CapturedMessage" WHERE "to" = $1', [email]);
  await page.goto(rows[0].body.match(/https?:\/\/\S+\/login\/[\w-]+/)[0]);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText('You are not in an org yet')).toBeVisible();
  await page.getByLabel('Org name').fill(`Acme ${Date.now()}`);
  await page.getByRole('button', { name: 'Create org' }).click();

  // An owner without TOTP is sent to enrol before the org opens.
  await expect(page).toHaveURL(/\/account\/security\?mfa=required$/);
  await page.getByRole('button', { name: 'Turn on' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())!;
  const code = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate();
  await page.getByLabel('Code from your app').fill(code);
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Save your recovery codes')).toBeVisible();
  await page.getByRole('link', { name: 'Done' }).click();

  await page.getByRole('link', { name: /^Acme / }).click();
  await expect(page).toHaveURL(/\/o\/acme-\d+$/);
  await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
});
