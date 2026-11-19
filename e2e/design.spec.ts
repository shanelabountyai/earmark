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
