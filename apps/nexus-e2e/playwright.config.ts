import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the NexusPay React app against the real backends (spec acceptance test 9).
 *
 * Needs `auth` (3000, gRPC 5000) and `wallet` (3004, gRPC 5003) running, with PostgreSQL and
 * Redis; global setup creates two fresh users and funds one. Playwright starts (or reuses) the
 * nexus dev server, whose proxy sends /api/* to the backends.
 *
 *   npx nx run nexus-e2e:e2e
 */
export default defineConfig({
  testDir: './src',
  globalSetup: './src/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4300',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx nx serve nexus',
    cwd: '../..',
    url: 'http://localhost:4300',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
