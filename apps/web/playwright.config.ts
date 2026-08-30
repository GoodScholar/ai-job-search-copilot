import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = "3120";
const baseURL = `http://127.0.0.1:${port}`;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceHealthOnly = process.env.E2E_SOURCE_HEALTH_ONLY === "1";
const sourceHealthScenarios = {
  "10000000-0000-4000-8000-000000000121": {
    "greenhouse:e2e-health-desktop-good": "healthy",
    "greenhouse:e2e-health-desktop-limited": "rate_limited",
  },
  "10000000-0000-4000-8000-000000000122": {
    "greenhouse:e2e-health-mobile-good": "healthy",
    "greenhouse:e2e-health-mobile-limited": "rate_limited",
  },
};

export default defineConfig({
  testDir: "./e2e",
  testIgnore: sourceHealthOnly ? undefined : /source-health\.spec\.ts/,
  testMatch: sourceHealthOnly ? /source-health\.spec\.ts/ : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "node scripts/local-runtime.mjs --test",
    cwd: repositoryRoot,
    env: {
      E2E_JOB_NORMALIZER_DELAY_MS: "750",
      JOB_PAGE_FETCHER_TEST_ORIGIN: "http://127.0.0.1:39333",
      E2E_AGENT_RUN_SCENARIOS: JSON.stringify({
        "10000000-0000-4000-8000-000000000101": "slow_checkpoint",
        "10000000-0000-4000-8000-000000000102": "slow_checkpoint",
        "10000000-0000-4000-8000-000000000103": "retry_once",
        "10000000-0000-4000-8000-000000000104": "retry_until_budget",
        "10000000-0000-4000-8000-000000000111": "slow_checkpoint",
        "10000000-0000-4000-8000-000000000112": "slow_checkpoint",
        "10000000-0000-4000-8000-000000000113": "retry_once",
        "10000000-0000-4000-8000-000000000114": "retry_until_budget",
      }),
      ...(sourceHealthOnly ? { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: JSON.stringify(sourceHealthScenarios) } : {}),
    },
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    stdout: "pipe",
    wait: { stdout: /本地测试运行时已就绪/ },
    timeout: 120_000,
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "Mobile Safari",
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
