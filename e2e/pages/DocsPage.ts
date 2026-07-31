import { Page } from '@playwright/test';
import { BasePage } from './BasePage';

export class DocsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async goto() {
    await super.goto('/docs');
  }

  get homeLink() { return this.navByPath('/'); }
  get directoryLink() { return this.navByPath('/directory'); }
  get dashboardLink() {
    return this.page.locator('#nav a[href*="dashboard"]').first();
  }
}
