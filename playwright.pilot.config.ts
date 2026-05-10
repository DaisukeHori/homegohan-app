/**
 * playwright.pilot.config.ts
 *
 * パイロット 5 spec 移行の検証用 Playwright 設定 (Step 2)。
 * global-setup (storageState 共有) をスキップし、fresh user fixture で完結する。
 *
 * 使用: npx playwright test --config=playwright.pilot.config.ts
 */

import { defineConfig, devices } from "@playwright/test";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: ".env.local" });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const useExistingServer = !!process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "tests/e2e/.output-pilot",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // global-setup を使わない (fresh user fixture は admin API で自前作成)
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // storageState は使わない (毎テスト fresh start)
  },
  testMatch: [
    "**/tests/e2e/01-login.spec.ts",
    "**/tests/e2e/bug-33-signup-password-strength.spec.ts",
    "**/tests/e2e/bug-79-81-82-onboarding-validation.spec.ts",
    "**/tests/e2e/tour/01-eligibility.spec.ts",
    "**/tests/e2e/bug-36-localstorage-cleanup-on-signout.spec.ts",
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: useExistingServer
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
