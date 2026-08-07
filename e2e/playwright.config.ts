import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 13400);

export default defineConfig({
  testDir: './tests',
  // Tests share one backend instance + one SQLite db (see harness/serve.mjs), so agent/room
  // names must stay unique across tests but running them in parallel workers is still fine --
  // only fullyParallel *within a single spec file* is avoided implicitly by Playwright's default
  // serial-per-file execution, which is enough given each spec uses its own name prefix.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node harness/serve.mjs',
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
