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

// Demo step 7, and step 8's URL half (D-22): Dana invoices a Meridian PO in Northwind; the same PO id under Contoso's
// slug is a 404. The API half with Contoso's key is Phase 4.
test('steps 7–8: a guest invoices her PO; the same id under another client is a 404', async ({ browser }) => {
  const number = `MER-E2E-${Date.now()}`;
  const dana = await as(browser, 'dana@meridian.demo.test');
  await expect(dana.getByRole('heading', { name: 'Purchase orders' })).toBeVisible(); // a guest's home is her POs
  await expect(dana.getByRole('navigation')).not.toContainText('Requests');
  await dana.getByRole('table', { name: 'Purchase orders' }).getByRole('row').filter({ hasText: /open ·/ }).first().getByRole('link').click();
  await dana.waitForURL(/\/o\/northwind\/commitments\/[0-9a-f-]{36}$/);

  await dana.getByLabel('Invoice number').fill(number);
  await dana.getByLabel('Amount (USD)').fill('1,250.00');
  await dana.getByLabel('Invoice date').fill('2026-11-01');
  await dana.getByLabel('Due date').fill('2026-12-01');
  await dana.getByRole('button', { name: 'Submit invoice' }).click();
  await expect(dana.locator('main').getByRole('status')).toHaveText(`Invoice ${number} submitted; it is listed below.`);
  await expect(dana.getByRole('table', { name: 'Invoices on this PO' })).toContainText(number);

  const res = await dana.goto(dana.url().replace('/o/northwind/', '/o/contoso/'));
  expect(res?.status()).toBe(404);
});
