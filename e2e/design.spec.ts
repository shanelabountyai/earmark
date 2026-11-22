import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Browser, expect, type Page, test } from '@playwright/test';

// Design pass, Step 4 (prd-earmark.md §11, D-55): WCAG 2.1 AA checks with axe on every Earmark page, light and dark,
// desktop and phone; the review findings that are testable in a browser. axe-core is the copy eslint-config-next
// already installs (no new dependency); it is injected into the page, as @axe-core/playwright does.
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function signIn(browser: Browser, email: string, opts: { scheme?: 'light' | 'dark'; width?: number } = {}): Promise<Page> {
  const page = await (await browser.newContext({ colorScheme: opts.scheme ?? 'light', viewport: { width: opts.width ?? 1280, height: 900 } })).newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/(onboarding|o\/[a-z]+(\/commitments)?)$/); // signed in: Your orgs, or the one org (D-58)
  return page;
}

async function axe(page: Page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }> } }).axe
      .run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} ×${v.nodes.length}: ${JSON.stringify(v.nodes[0]?.target)}`);
  });
}

/** The first link under `list` whose href contains `part`, so detail pages are covered without fixed ids. */
async function firstHref(page: Page, list: string, part: string) {
  await page.goto(list);
  return (await page.locator(`main a[href*="${part}"]`).first().getAttribute('href'))!;
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`axe: no WCAG 2.1 AA violation on any staff page (${scheme}, ${width}px)`, async ({ browser }) => {
      const page = await signIn(browser, 'owner@northwind.demo.test', { scheme, width });
      const o = '/o/northwind';
      const pages = [o, `${o}/plan`, `${o}/requests`, `${o}/approvals`, `${o}/commitments`, `${o}/invoices`, `${o}/variance`, `${o}/settings/rules`, `${o}/settings/seats`, `${o}/settings/agencies`,
        // the template's settings pages, styled from globals.css in the live gate (D-59)
        `${o}/settings/members`, `${o}/settings/audit`, `${o}/settings/security`, `${o}/settings/sso`, `${o}/settings/apikeys`, `${o}/settings/danger`,
        await firstHref(page, `${o}/requests`, '/requests/'), await firstHref(page, `${o}/commitments`, '/commitments/'),
        await firstHref(page, `${o}/invoices`, '/invoices/'), await firstHref(page, o, '/lines/')];
      for (const url of pages) {
        await page.goto(url);
        expect.soft(await axe(page), url).toEqual([]);
        // 1.4.10: nothing scrolls the page sideways; wide tables scroll inside their own box.
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), `${url} width`).toBeLessThanOrEqual(width);
      }
    });
  }
}

// PRD-B (D-75): the first two screens a visitor sees, signed out, light and dark, desktop and phone.
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`axe: the landing and /demo pass (${scheme}, ${width}px)`, async ({ browser }) => {
      const page = await (await browser.newContext({ colorScheme: scheme, viewport: { width, height: 900 } })).newPage();
      for (const url of ['/', '/demo']) {
        await page.goto(url);
        if (url === '/demo') await page.getByText(/^Every other seeded account/).click(); // the fold, open
        expect.soft(await axe(page), url).toEqual([]);
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), `${url} width`).toBeLessThanOrEqual(width);
      }
    });
  }
}

test('axe: the guest pages and the 404 pass too', async ({ browser }) => {
  const dana = await signIn(browser, 'dana@meridian.demo.test', { width: 390 });
  const po = await firstHref(dana, '/o/northwind/commitments', '/commitments/');
  for (const url of ['/o/northwind/commitments', po, '/o/northwind/settings/members']) {
    await dana.goto(url);
    expect.soft(await axe(dana), url).toEqual([]);
  }
});

test('a guest gets the 404 for every staff page (PRD §1, D-51)', async ({ browser }) => {
  const dana = await signIn(browser, 'dana@meridian.demo.test');
  for (const path of ['settings/members', 'settings/rules', 'settings/audit', 'projects', 'requests', 'invoices', 'variance']) {
    expect((await dana.goto(`/o/northwind/${path}`))?.status(), path).toBe(404);
  }
  await expect(dana.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(dana.getByRole('link', { name: 'Your orgs' })).toBeVisible();
});

// Live gate (D-57): a settings page the role may not open is the same 404 as a missing page, not the error page. The
// template's pages throw on a missing permission, which a page renders as a 500; a layout beside each answers first.
test('staff get the 404, not an error page, for a settings page their role may not open (D-57)', async ({ browser }) => {
  const nowhere = 'settings/danger/export/00000000-0000-4000-8000-000000000000';
  const member = await signIn(browser, 'member@northwind.demo.test');
  for (const path of ['settings/audit', 'settings/apikeys', 'settings/danger', nowhere, 'settings/security', 'settings/sso']) {
    expect((await member.goto(`/o/northwind/${path}`))?.status(), `member ${path}`).toBe(404);
    await expect(member.getByRole('heading', { name: 'Page not found' }), `member ${path}`).toBeVisible();
  }
  expect((await member.goto('/o/northwind/settings/members'))?.status(), 'member settings/members').toBe(200);

  const admin = await signIn(browser, 'admin@northwind.demo.test');
  for (const path of ['settings/danger', nowhere, 'settings/sso']) expect((await admin.goto(`/o/northwind/${path}`))?.status(), `admin ${path}`).toBe(404);
  for (const path of ['settings/audit', 'settings/apikeys', 'settings/security']) expect((await admin.goto(`/o/northwind/${path}`))?.status(), `admin ${path}`).toBe(200);

  // Whoever holds the permission is let through exactly as before.
  const owner = await signIn(browser, 'owner@northwind.demo.test');
  for (const path of ['settings/audit', 'settings/apikeys', 'settings/danger', 'settings/security', 'settings/sso']) expect((await owner.goto(`/o/northwind/${path}`))?.status(), `owner ${path}`).toBe(200);
  expect((await owner.goto(`/o/northwind/${nowhere}`))?.status(), 'owner, an export that does not exist').toBe(404);
});

// Live gate (D-59, PRD §11 open item UX S5): on a phone every member's role and controls are on screen, with no
// sideways scroll inside the table. Before, the role was clipped and the controls sat off the right edge.
test('the members page is usable on a phone: each row shows its role and controls inside the viewport (D-59)', async ({ browser }) => {
  const owner = await signIn(browser, 'owner@northwind.demo.test', { width: 390 });
  await owner.goto('/o/northwind/settings/members');
  const table = owner.locator('main table').first();
  expect(await table.evaluate((t) => t.scrollWidth <= t.clientWidth), 'the table does not scroll sideways').toBe(true);
  const row = table.getByRole('row').filter({ hasText: 'member@northwind.demo.test' });
  for (const part of [row.getByRole('cell').nth(1), row.getByLabel('Role for member@northwind.demo.test'), row.getByRole('button', { name: 'Change role' }), row.getByRole('button', { name: 'Remove' })]) {
    await expect(part).toBeVisible();
    const box = (await part.boundingBox())!;
    expect(box.x, 'left edge').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'right edge').toBeLessThanOrEqual(390);
  }
  await expect(row.getByRole('cell').nth(1)).toHaveText('member');
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a refused request keeps the line, agency and text the person entered (D-52)', async ({ browser }) => {
  const member = await signIn(browser, 'member@northwind.demo.test');
  await member.goto('/o/northwind/requests');
  await member.getByLabel('Budget line').selectOption({ label: 'Demand Gen / Paid Social / Q2 Paid Social' });
  await member.getByLabel('Agency').selectOption({ label: 'Meridian Creative' });
  await member.getByLabel('Amount (USD)').fill('twelve');
  await member.getByLabel('What it is for').fill('Kept after a refusal');
  await member.getByRole('button', { name: 'Submit request' }).click();
  await expect(member.locator('main').getByRole('alert')).toBeVisible();
  await expect(member.getByLabel('Budget line').locator('option:checked')).toHaveText('Demand Gen / Paid Social / Q2 Paid Social');
  await expect(member.getByLabel('Agency').locator('option:checked')).toHaveText('Meridian Creative');
  await expect(member.getByLabel('Amount (USD)')).toHaveValue('twelve');
  await expect(member.getByLabel('What it is for')).toHaveValue('Kept after a refusal');
});

test('the skip link moves focus past the sidebar', async ({ browser }) => {
  const owner = await signIn(browser, 'owner@northwind.demo.test');
  await owner.goto('/o/northwind');
  await owner.keyboard.press('Tab');
  await expect(owner.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await owner.keyboard.press('Enter');
  await expect(owner.locator('#content')).toBeFocused();
});

// PRD-C C2 (review U10, A2; D-79): a page that answers the 404 is titled "Page not found", so the route announcer
// does not read out the name of a page the visitor cannot see.
test('a 404 inside an org is titled Page not found, whoever is refused', async ({ browser }) => {
  const dana = await signIn(browser, 'dana@meridian.demo.test');
  for (const url of ['/o/northwind/requests', '/o/northwind/invoices', '/o/northwind/variance', '/o/northwind/settings/rules', '/o/northwind/settings/members', '/o/nosuchorg', `/o/northwind/commitments/${crypto.randomUUID()}`]) {
    await dana.goto(url);
    await expect(dana.getByRole('heading', { name: 'Page not found' }), url).toBeVisible();
    await expect(dana, url).toHaveTitle(/^Page not found/);
  }
  const member = await signIn(browser, 'member@northwind.demo.test');
  for (const url of ['/o/northwind/settings/audit', '/o/northwind/settings/danger', '/o/northwind/plan']) {
    await member.goto(url);
    await expect(member, url).toHaveTitle(/^Page not found/);
  }
  await member.goto('/o/northwind/requests'); // and a page the role may open keeps its own title
  await expect(member).toHaveTitle(/^Requests/);
});

// PRD-C C3, C4 (review A1, A4, A5; D-81): after a refused submit, focus is on the refusal, the field it names is
// marked invalid and points at it, and the same refusal a second time is a fresh alert.
test('focus moves to the refusal, the named field is marked invalid, and a repeat is announced again', async ({ browser }) => {
  const page = await signIn(browser, 'member@northwind.demo.test', { width: 390 });
  await page.goto('/o/northwind/requests');
  await page.getByLabel('Amount (USD)').fill('twelve');
  await page.getByLabel('What it is for').fill('a11y probe');
  for (let k = 0; k < 2; k++) {
    await page.getByRole('button', { name: 'Submit request' }).click();
    const alert = page.locator('main').getByRole('alert');
    await expect(alert).toHaveText(/^Amount must be/);
    await expect(alert).toBeFocused();
    await expect(alert).toBeInViewport();
    const amount = page.getByLabel('Amount (USD)');
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(await amount.getAttribute('aria-describedby')).toContain(await alert.getAttribute('id'));
  }
});
