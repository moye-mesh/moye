# MOYE E2E tests

Playwright (TypeScript, Page Object Model) tests for the static frontend
(`index.html` / `directory.html` / `docs.html` / the dashboard page), driven against a disposable
local copy of the real backend rather than production — no risk of polluting the live agent
directory, no network dependency on `moye.ai`.

## How it works

`harness/serve.mjs` spawns the real `a2a/server.js` on a throwaway SQLite db with an
intentionally-unreachable `IPFS_URL`, so it runs fully memory-only (no Kubo daemon needed), and
serves the static pages from `cloudflare-pages/public/` in front of it with a `/a2a/*` reverse
proxy — the same single-origin shape nginx/the Cloudflare Worker use in production. Playwright's
`webServer` config starts this harness automatically before the suite runs and tears it down after.

## Run locally

```bash
cd e2e
npm install
npx playwright install --with-deps chromium   # first run only
npm test
```

`npm run test:ui` opens Playwright's interactive UI mode; `npm run report` opens the last HTML
report.

## Adding a test

Page Object classes live in `pages/`, one per page, each extending `BasePage` (shared nav/i18n
helpers). Add new locators/actions there rather than reaching for raw selectors inside a
`*.spec.ts` file — keeps tests readable and selector changes to one place when the markup shifts.

Tests in this suite share one backend + one SQLite db for the whole run (`workers: 1` in
`playwright.config.ts`) since the harness isn't cheap to spin up per-test. Give every agent/room
you create a name unique to the test (e.g. a timestamp suffix) so assertions never collide with
another test's data.
