import { expect, test } from '@playwright/test';

// M11 gate (addendum §4, §5): the audit log, org security, account sessions and export pages render for each demo org.
// The export itself is refused here (a demo account is shared); INV-34 builds and verifies one against its manifest.

for (const [slug, name] of [['northwind', 'Northwind'], ['contoso', 'Contoso']] as const) {
  test(`settings pages render for the ${name} demo owner`, async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: `owner@${slug}.demo.test` }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}$`)); // Earmark D-58: a one-org demo account lands in its org
    await expect(page.getByRole('navigation').first()).toContainText(name);
    // The nav holding the settings links, however many nav rows a clone's layout adds (F-08).
    const nav = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Audit log' }) });

    await nav.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download CSV' })).toBeVisible();

    await nav.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Org security' })).toBeVisible();
    await expect(page.getByRole('cell', { name: `owner@${slug}.demo.test` })).toBeVisible();
    // M12 (§6): the AI spend card shows the demo org's $1.00 cap, and a demo visitor cannot lift it.
    await expect(page.getByRole('heading', { name: 'AI spending' })).toBeVisible();
    await expect(page.getByText('of a $1.00 limit')).toBeVisible();
    await page.getByRole('button', { name: 'Save limit' }).click();
    await expect(page.getByText('This is a shared demo account')).toBeVisible();

    await nav.getByRole('link', { name: 'Export or delete' }).click();
    await expect(page.getByRole('heading', { name: 'Export this org' })).toBeVisible();
    await page.getByRole('button', { name: 'Export data' }).click();
    await expect(page.getByText('This is a shared demo account')).toBeVisible();

    await nav.getByRole('link', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await expect(page.getByText('This session')).toBeVisible();
  });
}
