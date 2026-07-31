import { expect, test } from '@playwright/test';
import { HomePage } from '../pages/HomePage';

test.describe('Home page', () => {
  test('loads and shows the hero + nav', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(page).toHaveTitle(/MOYE/);
    await expect(home.homeLink).toBeVisible();
    await expect(home.directoryLink).toBeVisible();
    await expect(home.dashboardLink).toBeVisible();
    await expect(home.docsLink).toBeVisible();
  });

  test('nav links point at the right pages', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(home.directoryLink).toHaveAttribute('href', '/directory');
    await expect(home.dashboardLink).toHaveAttribute('href', /\/a2a\/dashboard/);
    await expect(home.docsLink).toHaveAttribute('href', '/docs');
  });

  test('nav shows English labels (no language switcher)', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await expect(home.homeLink).toHaveText('Home');
    await expect(page.locator('.lang-btn')).toHaveCount(0);
  });

  test('directory nav link leads to a working directory page', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await home.directoryLink.click();
    await expect(page).toHaveURL(/\/directory$/);
  });
});
