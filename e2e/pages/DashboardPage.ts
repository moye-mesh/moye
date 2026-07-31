import { Page } from '@playwright/test';
import { BasePage } from './BasePage';

export class DashboardPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async goto() {
    // /a2a/dashboard/ serves a2a/public/index.html (static dir index). The real
    // status dashboard is dashboard.html — same target as moye-nav's Status link.
    await super.goto('/a2a/dashboard/dashboard.html');
  }

  get homeLink() { return this.navByPath('/'); }
  get directoryLink() { return this.navByPath('/directory'); }

  /** Metrics are rendered as .metric blocks with a .v value and .k label — no stable ids. */
  metricValue(label: string) {
    return this.page.locator('.metric', { hasText: label }).locator('.v').first();
  }

  get agentsTotal() { return this.metricValue('Registered agents'); }
  get roomsTotal() { return this.metricValue('Collaboration rooms'); }
  get sharedTotal() { return this.metricValue('Shared-state keys'); }
  get ledgerTotal() { return this.metricValue('Ledger entries'); }
}
