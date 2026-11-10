import { type Browser, expect, type Page, test } from '@playwright/test';

// INV-27, flag-on half (the flag-off half is tests/invariants/inv-27-demo.test.ts). playwright.config.ts starts the
// server with DEMO_MODE=1; e2e/global-setup.ts seeds the same database once per sweep.

test('demo sign-in lands a seeded owner in their org', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@northwind.demo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  await page.getByRole('link', { name: 'Northwind' }).click();
  await expect(page.getByRole('navigation')).toContainText('Northwind');
});

// Demo steps 3–5 (PRD §9): submit, the frozen chain, self-approval refused, approve as Budget Owner, a rule edit that
// changes the next request's chain and leaves the first one's alone.

async function as(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await page.getByRole('link', { name: 'Northwind' }).click();
  await expect(page.getByRole('navigation')).toContainText('Northwind');
  return page;
}

async function submit(page: Page, what: string) {
  await page.getByRole('navigation').getByRole('link', { name: 'Requests' }).click();
  await page.getByLabel('Budget line').selectOption({ label: 'Demand Gen / Paid Social / Q2 Paid Social' });
  await page.getByLabel('Agency').selectOption({ label: 'Meridian Creative' });
  await page.getByLabel('Amount (USD)').fill('12,000.00');
  await page.getByLabel('What it is for').fill(what);
  await page.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.locator('main').getByRole('status')).toContainText('Request submitted');
  await page.getByRole('link', { name: what }).click();
  await page.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
  return page.url();
}

const seats = (page: Page) => page.getByRole('table', { name: 'Approval chain' }).locator('tbody tr td:nth-child(2)').allInnerTexts();

test('steps 3–5: frozen chain, self-approval refused, rule edit applies only to the next request', async ({ browser }) => {
  const stamp = Date.now();
  const member = await as(browser, 'member@northwind.demo.test');
  const first = await submit(member, `Launch ads ${stamp}`);
  expect(await seats(member)).toEqual(['Budget Owner', 'Marketing Ops']);

  await member.getByRole('button', { name: 'Approve' }).click();
  await expect(member.locator('main').getByRole('alert')).toHaveText('You cannot approve your own request.');

  const owner = await as(browser, 'demandgen@northwind.demo.test');
  await owner.getByRole('link', { name: 'Approvals' }).click();
  await owner.getByRole('link', { name: `Launch ads ${stamp}` }).click();
  await owner.getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByRole('heading', { name: 'Decide step 2: Marketing Ops' })).toBeVisible();
  await expect(owner.getByRole('table', { name: 'Request audit' })).toContainText('request.step.approved');

  const admin = await as(browser, 'admin@northwind.demo.test');
  await admin.getByRole('link', { name: 'Rules' }).click();
  const rules = admin.getByLabel('Rules JSON');
  await rules.fill((await rules.inputValue()).replace('"seat": "Marketing Ops",\n      "fromCents": 1000000', '"seat": "Marketing Ops",\n      "fromCents": 1500000'));
  await admin.getByRole('button', { name: 'Save rules' }).click();
  await expect(admin.locator('main').getByRole('status')).toHaveText('Saved 1 change.');
  await expect(admin.getByRole('table', { name: 'Rule edits' })).toContainText('Marketing Ops');

  await submit(member, `Retargeting ${stamp}`);
  expect(await seats(member)).toEqual(['Budget Owner']);
  await member.goto(first);
  expect(await seats(member)).toEqual(['Budget Owner', 'Marketing Ops']);
});
