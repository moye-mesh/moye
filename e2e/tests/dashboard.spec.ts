import { expect, test } from '@playwright/test';
import { DashboardPage } from '../pages/DashboardPage';

test.describe('Dashboard page', () => {
  test('renders totals that match the live /api/dashboard response', async ({ page, request }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    const api = await request.get('/a2a/api/dashboard');
    expect(api.ok()).toBeTruthy();
    const body = await api.json();

    await expect(dashboard.agentsTotal).toHaveText(String(body.totals.agents), { timeout: 10000 });
    await expect(dashboard.roomsTotal).toHaveText(String(body.totals.rooms));
    await expect(dashboard.ledgerTotal).toHaveText(String(body.totals.ledger_entries));
  });

  test('nav links back to home and directory', async ({ page }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    // Dashboard mounts nav with siteOrigin=https://moye.ai (backend-served page).
    await expect(dashboard.homeLink).toHaveAttribute('href', /\/$/);
    await expect(dashboard.directoryLink).toHaveAttribute('href', /\/directory$/);
  });
});
