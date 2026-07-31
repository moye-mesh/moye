import { Locator, Page } from '@playwright/test';

/**
 * Shared behavior across every moye.ai page.
 * Nav is rendered by moye-nav.js as plain <a href="...">Label</a> (no data-i18n).
 * Dashboard mounts with siteOrigin=https://moye.ai, so those hrefs may be absolute.
 */
export class BasePage {
  constructor(protected readonly page: Page) {}

  async goto(path: string) {
    await this.page.goto(path);
  }

  /** Locate a top-nav link by its path (e.g. '/', '/directory', '/docs'). */
  navByPath(path: string): Locator {
    if (path === '/') {
      return this.page.locator('#nav a[href="/"], #nav a[href="https://moye.ai/"]').first();
    }
    // Match relative or absolute (dashboard uses siteOrigin).
    return this.page.locator(
      `#nav a[href="${path}"], #nav a[href="https://moye.ai${path}"], #nav a[href$="${path}"]`,
    ).first();
  }
}
