/**
 * playwright.fresh-user.config.ts
 *
 * fresh-user fixture を使う E2E テスト専用の Playwright 設定。
 * global-setup (storageState 共有) をスキップし、admin API ベースの
 * fresh user fixture のみで完結するテストを実行する。
 *
 * 対象ディレクトリ:
 *   - tests/e2e/fixtures-smoke/  (fixture smoke テスト)
 *   - tests/e2e/*.spec.ts        (fresh user 移行済みの spec)
 *   - tests/e2e/tour/*.spec.ts   (tour spec)
 *
 * 使用: npx playwright test --config=playwright.fresh-user.config.ts
 * 特定ファイル: npx playwright test --config=playwright.fresh-user.config.ts tests/e2e/01-login.spec.ts
 */

import { defineConfig, devices } from "@playwright/test";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: ".env.local" });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const useExistingServer = !!process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "tests/e2e/.output-fresh",
  timeout: 120_000,
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
