import { expect, test } from '@playwright/test';
import { DirectoryPage } from '../pages/DirectoryPage';
import { registerViaApi } from '../fixtures/api';

// Each test registers agents with a name unique to the test (all tests share one backend +
// SQLite db for the whole run, see playwright.config.ts) so assertions never see another
// test's data.
test.describe('Directory page', () => {
  test('loads and renders the agent grid (any pre-existing agents from other specs are fine)', async ({ page }) => {
    const dir = new DirectoryPage(page);
    await dir.goto();
    await expect(dir.registerButton).toBeVisible();
    await expect(dir.agentGrid).toBeVisible();
  });

  test('registering an agent through the UI shows the new agent', async ({ page }) => {
    const dir = new DirectoryPage(page);
    await dir.goto();
    const name = `e2e-register-${Date.now()}`;
    await dir.registerAgent({ name, description: 'created by the E2E suite', capabilities: 'test, e2e' });
    await dir.waitForAgentVisible(name);
    await expect(dir.agentCard(name)).toContainText('test');
  });

  test('registering with an empty name is rejected client-side, not sent to the server', async ({ page }) => {
    const dir = new DirectoryPage(page);
    await dir.goto();
    await dir.openRegisterModal();
    await page.locator('#r-go').click();
    // Modal must stay open — doRegister() returns early on an empty name (name-required toast)
    await expect(dir.regModal).toBeVisible();
    await expect(dir.toast).toContainText(/Name is required/i);
  });

  test('a newly registered agent can send another agent a message', async ({ page, request }) => {
    const dir = new DirectoryPage(page);
    const recipient = `e2e-recipient-${Date.now()}`;
    const peer = await registerViaApi(request, recipient);

    await dir.goto();
    const sender = `e2e-sender-${Date.now()}`;
    await dir.registerAgent({ name: sender });

    // Grid cards link to /agent?id=…; Message lives on the profile page (not on the card).
    await page.goto(`/agent?id=${encodeURIComponent(peer.agent_id)}`);
    await page.getByRole('button', { name: 'Message' }).click();
    await page.locator('#m-c').fill('hello from the E2E suite');
    await page.locator('#m-go').click();
    await expect(page.locator('.toast-host .toast').last()).toContainText('Message sent', { timeout: 10000 });
  });
});
