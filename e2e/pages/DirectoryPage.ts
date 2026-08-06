import { expect, Page } from '@playwright/test';
import { BasePage } from './BasePage';

export interface RegisterAgentInput {
  name: string;
  description?: string;
  capabilities?: string; // comma-separated, matches the raw input field
  endpoint?: string;
  /** Backup passphrase (required by current UI; defaults to a test passphrase). */
  passphrase?: string;
}

export class DirectoryPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async goto() {
    await super.goto('/directory');
  }

  get docsLink() { return this.navByPath('/docs'); }
  get dashboardLink() {
    return this.page.locator('#nav a[href*="dashboard"]').first();
  }

  /** Account-area "Register" button (rendered by renderAccount()). */
  get registerButton() {
    return this.page.locator('#account').getByRole('button', { name: 'Register' });
  }

  get agentGrid() { return this.page.locator('#agents-out'); }
  get regModal() { return this.page.locator('#modal-host .modal'); }
  get toast() { return this.page.locator('.toast-host .toast').last(); }

  async openRegisterModal() {
    await this.registerButton.click();
    await expect(this.regModal).toBeVisible();
  }

  /**
   * Fills and submits the registration form (non-extractable key + encrypted backup flow).
   * After success the backup-prompt modal appears; we dismiss it with "Saved — continue".
   */
  async registerAgent({ name, description, capabilities, endpoint, passphrase }: RegisterAgentInput) {
    const pass = passphrase || 'e2e-test-passphrase';
    await this.openRegisterModal();
    await this.page.locator('#r-name').fill(name);
    if (description) await this.page.locator('#r-desc').fill(description);
    if (capabilities) await this.page.locator('#r-caps').fill(capabilities);
    if (endpoint) await this.page.locator('#r-ep').fill(endpoint);
    await this.page.locator('#r-pass').fill(pass);
    await this.page.locator('#r-pass2').fill(pass);
    await this.page.locator('#r-go').click();
    // Backup prompt replaces the register modal on success.
    await expect(this.page.getByRole('heading', { name: /Save your identity backup/i })).toBeVisible({
      timeout: 20000,
    });
    await this.page.getByRole('button', { name: /Saved — continue|Saved - continue/i }).click();
    await expect(this.regModal).toHaveCount(0);
  }

  agentCard(name: string) {
    return this.agentGrid.locator('.agent-card, .card', { hasText: name });
  }

  /** P2-6: no browse-all — the directory only ever shows search/graph results, so finding a
   * just-registered agent requires searching for it (by name here). */
  async search(query: string) {
    await this.page.locator('#q').fill(query);
    await this.page.locator('#btn-search').click();
  }

  async waitForAgentVisible(name: string) {
    await this.search(name);
    await expect(this.agentCard(name)).toBeVisible({ timeout: 15000 });
  }
}
