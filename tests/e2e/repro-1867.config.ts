// 一時的な再現用の設定 (#1867 戻る)。globalSetup (ログイン) を通さずに back-navigation.spec.ts だけを chromium と webkit で流す。あとで消す。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'back-navigation.spec.ts',
  outputDir: '.output-repro',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 2,
  reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
