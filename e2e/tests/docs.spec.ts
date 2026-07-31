import { expect, test } from '@playwright/test';
import { DocsPage } from '../pages/DocsPage';

test.describe('Docs page', () => {
  test('loads and links back to home/directory/dashboard', async ({ page }) => {
    const docs = new DocsPage(page);
    await docs.goto();
    await expect(page).toHaveTitle(/MOYE/);
    await expect(docs.homeLink).toHaveAttribute('href', '/');
    await expect(docs.directoryLink).toHaveAttribute('href', '/directory');
    await expect(docs.dashboardLink).toHaveAttribute('href', /dashboard/);
  });

  test('shows a runnable Python quick-start code sample', async ({ page }) => {
    const docs = new DocsPage(page);
    await docs.goto();
    // English-only docs (ADR-0024): single content model, no data-lang-block toggle.
    await expect(page.locator('pre code', { hasText: 'from moye import Agent' })).toBeVisible();
  });
});
