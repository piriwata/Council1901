import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Start the Cloudflare Worker backend with wrangler dev.
      // Creates .dev.vars from the example file if it does not already exist.
      command: 'cd ../backend && (cp -n .dev.vars.example .dev.vars 2>/dev/null || true) && npm run dev',
      url: 'http://localhost:8787',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Astro dev server; proxies /api/* to localhost:8787 automatically
      // (configured in astro.config.mjs via vite.server.proxy).
      command: 'npm run dev -- --host 0.0.0.0 --port 4321',
      url: 'http://localhost:4321',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
