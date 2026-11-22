import { type Browser, expect, type Page, test } from '@playwright/test';
import { dbSystem } from '../src/core/db/system';
import { asRealOwner } from './real-owner';

// INV-27, flag-on half (the flag-off half is tests/invariants/inv-27-demo.test.ts). playwright.config.ts starts the
// server with DEMO_MODE=1; e2e/global-setup.ts seeds the same database once per sweep.

// D-58 (live gate): an account with one org lands in it; an account with several still picks on Your orgs.
test('demo sign-in lands a seeded owner in their org', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@northwind.demo.test' }).click();
  await expect(page).toHaveURL(/\/o\/northwind$/);
  await expect(page.getByRole('navigation')).toContainText('Northwind');
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toHaveCount(0);
});

test('demo sign-in leaves an account with two orgs on Your orgs to pick one', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'dana@meridian.demo.test' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Northwind' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Contoso' })).toBeVisible();
  await page.getByRole('link', { name: 'Northwind' }).click();
  await expect(page.getByRole('navigation')).toContainText('Northwind');
});

// Demo steps 3–5 (PRD §9): submit, the frozen chain, self-approval refused, approve as Budget Owner, a rule edit that
// changes the next request's chain and leaves the first one's alone.

async function as(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  // D-58: a one-org account is already in Northwind; Dana (two clients) picks it on Your orgs.
  await page.waitForURL(/\/(onboarding|o\/northwind(\/commitments)?)$/);
  if (page.url().endsWith('/onboarding')) await page.getByRole('link', { name: 'Northwind' }).click();
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
  const status = page.locator('main').getByRole('status');
  await expect(status).toContainText('Request submitted');
  // D-64: the notice carries a link to the request it just made.
  const open = await status.getByRole('link', { name: 'Open it' }).getAttribute('href');
  expect(open).toMatch(/^\/o\/northwind\/requests\/[0-9a-f-]{36}$/);
  await page.getByRole('link', { name: what }).click();
  await page.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
  expect(new URL(page.url()).pathname).toBe(open);
  return page.url();
}

// The chain is a list of steps since the design pass (D-44); each step names its seat in a .seat span.
const seats = (page: Page) => page.getByRole('list', { name: 'Approval chain' }).getByRole('listitem').locator('.seat').allInnerTexts();

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
  // D-53: the step moved on to Marketing Ops, which demandgen does not hold, so she sees who it waits on, not a form.
  await expect(owner.locator('main')).toContainText('Step 2 is waiting on Marketing Ops');
  await expect(owner.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(owner.getByRole('table', { name: 'Request audit' })).toContainText('request.step.approved');

  // D-72 (PRD-A): the shared demo admin is refused a rules edit, so the next visitor's chain cannot change under them.
  const demoAdmin = await as(browser, 'admin@northwind.demo.test');
  await demoAdmin.getByRole('link', { name: 'Rules' }).click();
  const demoRules = demoAdmin.getByLabel('Rules JSON');
  await demoRules.fill((await demoRules.inputValue()).replace('"seat": "Marketing Ops",\n      "fromCents": 1000000', '"seat": "Marketing Ops",\n      "fromCents": 1500000'));
  await demoAdmin.getByRole('button', { name: 'Save rules' }).click();
  await expect(demoAdmin.locator('main').getByRole('alert')).toHaveText('This is a shared demo account, so that is switched off here.');

  // The same edit as a real owner (review §1 note: moved to asRealOwner, not weakened).
  const { page: admin } = await asRealOwner(browser, 'northwind');
  await admin.goto('/o/northwind/settings/rules');
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
  await dana.getByRole('table', { name: 'Purchase orders' }).getByRole('row').filter({ hasText: /Open ·/ }).first().getByRole('link').click();
  await dana.waitForURL(/\/o\/northwind\/commitments\/[0-9a-f-]{36}$/);

  await dana.getByLabel('Invoice number').fill(number);
  await dana.getByLabel('Amount (USD)').fill('1,250.00');
  await dana.getByLabel('Invoice date').fill('2026-11-01');
  await dana.getByLabel('Due date').fill('2026-12-01');
  await dana.getByRole('button', { name: 'Submit invoice' }).click();
  await expect(dana.locator('main').getByRole('status')).toHaveText(`Invoice ${number} submitted; it is listed below.`);
  // D-76 (PRD-B B5): the PO page counts the invoice as billed and waiting for a match, never "nothing billed".
  await expect(dana.locator('main dl.metrics')).toContainText('Billed, awaiting match');
  await expect(dana.getByRole('table', { name: 'Invoices on this PO' })).toContainText(number);

  const res = await dana.goto(dana.url().replace('/o/northwind/', '/o/contoso/'));
  expect(res?.status()).toBe(404);
});

// Demo step 9 (D-25): Dana invoices a PO; the admin matches it to the top suggestion, which names that PO; Finance
// approves it for payment, and the line's variance view shows it as actual.
test('step 9: match to the ranked suggestion, approve for payment, variance view', async ({ browser }) => {
  const number = `MER-M-${Date.now()}`;
  const dana = await as(browser, 'dana@meridian.demo.test');
  await dana.getByRole('table', { name: 'Purchase orders' }).getByRole('row').filter({ hasText: /Open ·/ }).first().getByRole('link').click();
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
  await expect(admin.getByRole('table', { name: 'Matches' })).toContainText(new RegExp(`${po}\\$10\\.00\\W*Under`));
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
    if (/State:\s*\W*Approved/.test(await page.locator('main').innerText())) break;
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

test('step 10: the explainer drafts, a person publishes, and the fourth draft is refused by the spend guard', async ({ browser }) => {
  const owner = await as(browser, 'owner@northwind.demo.test');
  await owner.getByRole('link', { name: 'Q2 Paid Social' }).first().click();
  const draft = owner.getByRole('button', { name: 'Draft with AI' });
  const note = owner.getByLabel(/^Note/);
  // The seed planted this month's spend so three stub drafts fit under the $1.00 cap (scripts/seed-demo.ts).
  await draft.click();
  await expect(note).toHaveValue(/^Draft \(no model configured\): Planned /);
  await note.fill(`Paid social ran ahead of plan ${Date.now()}.`);
  await owner.getByRole('button', { name: 'Publish note' }).click();
  await expect(owner.getByRole('blockquote', { name: 'Published note' })).toContainText('Paid social ran ahead of plan');
  for (let k = 2; k <= 3; k++) {
    await draft.click();
    await expect(owner.locator('main').getByRole('status').first()).toContainText('Draft ready');
  }
  await draft.click();
  await expect(owner.locator('main').getByRole('alert')).toContainText('monthly AI spending limit');
  // Three billed drafts this sweep, the refused fourth wrote none (E-INV-08); the seed reset the ledger.
  expect(await dbSystem.aiUsage.count({ where: { org: { slug: 'northwind' }, feature: 'variance-explainer' } })).toBe(3);
});

// Design pass (D-44–D-48): the shell's sidebar marks the current page, folds behind a Menu button on a phone, and gives
// a guest with two clients a switcher that only navigates (the other client checks membership itself). Before step 13,
// which removes Dana from Contoso.
test('design: the sidebar marks the current page and the dashboard leads with totals, then lines at risk', async ({ browser }) => {
  const owner = await as(browser, 'owner@northwind.demo.test');
  const nav = owner.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  await expect(owner.locator('dl[aria-label="Org totals"]')).toContainText('Available');
  await expect(owner.getByRole('heading', { name: /^Lines at risk \(\d+\)$/ })).toBeVisible();
  await nav.getByRole('link', { name: 'Rules' }).click();
  await expect(nav.getByRole('link', { name: 'Rules' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current', 'page');
});

test('design: on a phone the sidebar links fold behind a Menu button', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@northwind.demo.test' }).click();
  await page.waitForURL(/\/o\/northwind$/); // D-58: a one-org account lands in its org
  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Requests' })).toBeHidden();
  await menu.click();
  await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation').getByRole('link', { name: 'Requests' }).click();
  await page.waitForURL(/\/requests$/);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Requests' })).toBeHidden(); // closed again
});

test('design: a guest in two clients switches between them; each is her own agency only', async ({ browser }) => {
  const dana = await as(browser, 'dana@meridian.demo.test');
  const client = dana.getByRole('navigation').getByLabel('Client');
  await expect(client).toHaveValue('northwind');
  await expect(client.locator('option')).toHaveCount(2);
  await expect(client).toContainText('Contoso');
  await client.selectOption('contoso');
  await expect(dana).toHaveURL(/\/o\/northwind/); // choosing alone never navigates (WCAG 3.2.2)
  await dana.getByRole('navigation').getByRole('button', { name: 'Switch' }).click();
  await dana.waitForURL(/\/o\/contoso\/commitments$/);
  await expect(dana.getByRole('heading', { level: 1 })).toHaveText('Purchase orders');
  await expect(dana.locator('main')).toContainText('Meridian Creative in Contoso');
});

// Demo step 13 (E-INV-07), last in this file: it removes Dana from Contoso, which steps 7–8 above need. The seed
// recreates the agency and her membership each sweep. Her Contoso access is gone on refresh; Northwind is intact.
test('step 13: offboarding Meridian in Contoso ends Dana’s Contoso access and leaves Northwind', async ({ browser }) => {
  const dana = await as(browser, 'dana@meridian.demo.test');
  expect((await dana.goto('/o/contoso'))?.status()).toBe(200);

  const { page: owner } = await asRealOwner(browser, 'contoso'); // the demo owner is refused member removal
  await owner.goto('/o/contoso/settings/agencies');
  const row = owner.getByRole('table', { name: 'Agencies' }).getByRole('row').filter({ hasText: 'Meridian Creative' });
  await row.getByRole('button', { name: 'Offboard' }).click();
  await expect(row).toContainText('Offboarded'); // the form leaves the page with its notice (NEXT.md UI pattern)

  expect((await dana.reload())?.status()).toBe(404);
  await dana.goto('/o/northwind');
  await expect(dana.getByRole('heading', { name: 'Purchase orders' })).toBeVisible();
  await expect(dana.getByRole('table', { name: 'Purchase orders' })).toContainText('Open ·');
});
