import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests of the NexusPay React app against the real backends (phase 2 test 9; phase 4
 * tests 10 and the trade flows).
 *
 * Needs `auth` (3000, gRPC 5000), `wallet` (3004, gRPC 5003) and `market` (3006) running,
 * with PostgreSQL, Redis, RabbitMQ and Pulsar. Global setup creates fresh users, funds them, and
 * starts the realtime gateway (3007) from `dist/apps/realtime` unless one is running (then the
 * reconnect test is skipped: it only kills a gateway it started). Playwright starts (or reuses)
 * the nexus dev server, whose proxy sends /api/* to the backends.
 *
 *   npx nx run nexus-e2e:e2e
 */
export default defineConfig({
  testDir: './src',
  globalSetup: './src/global-setup.ts',
  globalTeardown: './src/global-teardown.ts',
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
