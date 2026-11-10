import { type Browser, expect, type Page, test } from '@playwright/test';
import { dbSystem } from '../src/core/db/system';

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
// slug is a 404. The API half with Contoso's key is in enterprise.spec.ts.
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

// Demo step 9 (D-25): Dana invoices a PO; the admin matches it to the top suggestion, which names that PO; Finance
// approves it for payment, and the line's variance view shows it as actual.
test('step 9: match to the ranked suggestion, approve for payment, variance view', async ({ browser }) => {
  const number = `MER-M-${Date.now()}`;
  const dana = await as(browser, 'dana@meridian.demo.test');
  await dana.getByRole('table', { name: 'Purchase orders' }).getByRole('row').filter({ hasText: /open ·/ }).first().getByRole('link').click();
  await dana.waitForURL(/\/commitments\/[0-9a-f-]{36}$/);
  const po = await dana.getByRole('heading', { level: 1 }).innerText();
  await dana.getByLabel('Invoice number').fill(number);
  await dana.getByLabel('Amount (USD)').fill('10.00');
  await dana.getByLabel('Invoice date').fill('2026-11-01');
  await dana.getByLabel('Due date').fill('2026-12-01');
  await dana.getByRole('button', { name: 'Submit invoice' }).click();
  await expect(dana.locator('main').getByRole('status')).toContainText(number);

  const admin = await as(browser, 'admin@northwind.demo.test');
  await admin.getByRole('navigation').getByRole('link', { name: 'Invoices' }).click();
  await admin.getByRole('table', { name: 'To match' }).getByRole('link', { name: number }).click();
  const top = admin.getByRole('table', { name: 'Suggested POs' }).locator('tbody tr').first();
  await expect(top).toContainText(po);
  await expect(top).toContainText('PO number and agency');
  await top.getByRole('button', { name: `Match to ${po}` }).click();
  // Fully matched, the suggestions (and the form's notice) give way to the match row and the approve button.
  await expect(admin.getByRole('table', { name: 'Matches' })).toContainText(`${po}$10.00under`);
  await admin.getByRole('button', { name: 'Approve for payment' }).click();
  await expect(admin.locator('main').getByRole('alert')).toHaveText('Only a Finance seat holder can approve an invoice for payment.');

  const finance = await as(browser, 'finance@northwind.demo.test');
  await finance.goto(admin.url());
  await finance.getByRole('button', { name: 'Approve for payment' }).click();
  await expect(finance.locator('dl[aria-label="Invoice"]')).toContainText('Statusapproved');
  await finance.getByRole('navigation').getByRole('link', { name: 'Variance' }).click();
  await expect(finance.getByRole('heading', { name: 'Variance' })).toBeVisible();
});

// Demo steps 1, 2 and 6. Step 1 here signs in through /demo (D-22); e2e/enterprise.spec.ts runs it through SSO. Step 6
// is for real since Phase 4: the commitment.issued delivery reaches the demo receiver, which verifies its signature.
test('step 1: the dashboard shows the four totals and the aged unmatched invoices', async ({ browser }) => {
  const owner = await as(browser, 'owner@northwind.demo.test');
  for (const t of ['Planned', 'Committed', 'Actual', 'Available']) await expect(owner.locator('main')).toContainText(t);
  await expect(owner.getByRole('heading', { name: /^Unmatched invoices \(\d+\)$/ })).toBeVisible();
});

test('step 2: Demand Gen → Q2 Paid Social shows its history with the replan marker', async ({ browser }) => {
  const owner = await as(browser, 'owner@northwind.demo.test');
  await owner.getByRole('link', { name: 'Q2 Paid Social' }).first().click();
  await expect(owner.getByRole('heading', { level: 1 })).toContainText('Q2 Paid Social');
  await expect(owner.getByRole('heading', { level: 1 }).getByText('Replan')).toBeVisible();
  await expect(owner.getByRole('list', { name: 'Line history' })).toContainText('Planned edited to');
});

test('step 6: the last approval issues a PO, and commitment.issued reaches the demo receiver signed', async ({ browser }) => {
  const what = `Launch PO ${Date.now()}`;
  const member = await as(browser, 'member@northwind.demo.test');
  const url = await submit(member, what);
  // Budget Owner, then Marketing Ops if the chain still has it (steps 3–5 may have raised its threshold this sweep).
  for (const email of ['demandgen@northwind.demo.test', 'admin@northwind.demo.test']) {
    const page = await as(browser, email);
    await page.goto(url);
    if ((await page.locator('main').innerText()).includes('State: approved')) break;
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('table', { name: 'Request audit' })).toContainText(`${email}request.step.approved`);
  }
  await member.goto(url);
  const po = await member.getByRole('link', { name: /^PO-/ }).innerText();
  const event = await dbSystem.orgEvent.findFirst({ where: { type: 'commitment.issued', payload: { path: ['commitment', 'poNumber'], equals: po } } });
  expect(event).not.toBeNull();
  // The approval's after() sweep sends it; the receiver answers 401 to a bad signature, so 200 means verified.
  await expect
    .poll(() => dbSystem.webhookDelivery.findFirst({ where: { eventId: event!.id }, select: { status: true, lastResponseStatus: true, lastResponseExcerpt: true } }), { timeout: 15_000 })
    .toMatchObject({ status: 'succeeded', lastResponseStatus: 200, lastResponseExcerpt: expect.stringContaining('"verified":true') });
});
