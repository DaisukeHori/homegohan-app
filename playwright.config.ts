import { defineConfig, devices } from "@playwright/test";
import * as fs from "fs";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const isCI = !!process.env.CI;
const useExistingServer = !!process.env.PLAYWRIGHT_BASE_URL;

// global-setup が生成する storageState ファイルが存在する場合のみ設定する。
// 存在しない場合は各テストの authedPage fixture が個別ログインにフォールバックする。
const STORAGE_STATE_PATH = "tests/e2e/.auth/user.json";
const storageState = fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "tests/e2e/.output",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never", outputFolder: "tests/e2e/.report" }]] : "list",
  // グローバルセットアップでログインを 1 回だけ行い storageState を生成する。
  // 全 worker が共有することで auth fixture の都度ログインによるタイムアウト連鎖を防ぐ。
  // #310 #311 #323 対応
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // global-setup で生成した認証済み storageState を全テストで共有 (存在する場合のみ)
    ...(storageState ? { storageState } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: useExistingServer
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !isCI,
        timeout: 120_000,
      },
});
