/**
 * Playwright globalSetup
 *
 * テスト実行開始前に 1 回だけ E2E ユーザーでログインし、
 * storageState を .auth/user.json に保存する。
 * 各テストはこのキャッシュを使い回すことで Supabase 認証への
 * リクエスト頻度を削減し、rate limit cascade fail を防ぐ。
 *
 * #310 #311 #323 対応
 */

import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";

const STORAGE_STATE_PATH = path.join(
  process.cwd(),
  "tests/e2e/.auth/user.json"
);

export default async function globalSetup() {
  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const email =
    process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local";
  const password = process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!";

  // .auth ディレクトリを作成
  const authDir = path.dirname(STORAGE_STATE_PATH);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  try {
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await Promise.all([
      page.waitForURL(
        (url) =>
          !url.pathname.startsWith("/login") &&
          !url.pathname.startsWith("/auth"),
        { timeout: 60_000 }
      ),
      page.locator("button[type=submit]").click(),
    ]);

    // オンボーディングが出た場合は API で完了させる
    if (page.url().includes("/onboarding")) {
      await page.evaluate(async () => {
        try {
          await fetch("/api/onboarding/complete", {
            method: "POST",
            credentials: "include",
          });
        } catch {
          // ignore
        }
      });
      await page.goto("/home");
      await page.waitForURL("**/home", { timeout: 30_000 });
    }

    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`[globalSetup] storageState saved to ${STORAGE_STATE_PATH}`);
  } finally {
    await browser.close();
  }
}
