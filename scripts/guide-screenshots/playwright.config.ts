/**
 * 使い方ガイドの撮影 (#1852) の Playwright の設定。run.sh から使う (e2e の tests/e2e とは別。テストではなく撮影の台本)。
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:<ポート> npx playwright test --config scripts/guide-screenshots/playwright.config.ts
 *
 * 撮影の台本のファイル名は shoot.pw.ts (vitest が *.spec.ts / *.test.ts を拾わないよう、その形にしない)。
 */
import { defineConfig, devices } from "@playwright/test";
import { config as dotenvConfig } from "dotenv";
import * as path from "path";
import { SHOOT_DEVICE_SCALE_FACTOR, SHOOT_VIEWPORT } from "./guide-users";

// ローカルの Supabase の接続情報 (bash scripts/supabase-local.sh env .env.local が書く)
dotenvConfig({ path: path.resolve(__dirname, "..", "..", ".env.local") });

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error("PLAYWRIGHT_BASE_URL (撮影するアプリの URL) を指定してください (run.sh が渡す)");

/** 1 枚の撮影の時間の上限 (ms)。本番ビルドを開いて待つだけなので、e2e の既定 (60 秒) と同じにする */
const SHOT_TIMEOUT_MS = 60_000;
/** 画面の要素を待つ上限 (ms) */
const EXPECT_TIMEOUT_MS = 20_000;

export default defineConfig({
  testDir: __dirname,
  testMatch: /shoot\.pw\.ts$/,
  outputDir: path.resolve(__dirname, "..", "..", ".guide-shots", "playwright-output"),
  timeout: SHOT_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  // バッジの画面は「開いた 1 回目だけ新しいバッジのお知らせが出る」ので、台本の順に 1 本ずつ撮る
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    ...devices["Pixel 7"],
    viewport: SHOOT_VIEWPORT,
    deviceScaleFactor: SHOOT_DEVICE_SCALE_FACTOR,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // 日付の入力欄などブラウザ自身が描く部分も日本語の書式 (2026/10/17) にする (locale だけでは Chromium の表示の言語は変わらない)
    launchOptions: { args: ["--lang=ja-JP"], env: { ...process.env, LANG: "ja_JP.UTF-8", LANGUAGE: "ja" } },
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium" }],
});
