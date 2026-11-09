import { expect, test } from '@playwright/test';
import { seedDemo } from '../scripts/seed-demo';

// INV-27, flag-on half (the flag-off half is tests/invariants/inv-27-demo.test.ts). playwright.config.ts starts the
// server with DEMO_MODE=1; this spec seeds the same database itself.
test.beforeAll(async () => { await seedDemo(); });

test('demo sign-in lands a seeded owner in their org', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@northwind.demo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  await page.getByRole('link', { name: 'Northwind' }).click();
  await expect(page.getByRole('navigation')).toContainText('Northwind');
});
