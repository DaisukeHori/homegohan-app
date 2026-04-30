import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "fs";

export const E2E_USER = {
  email: process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
};

// ログインタイムアウト: 前テストが長時間かかった後でも Supabase Auth レスポンスを待てるよう余裕を持たせる
const LOGIN_TIMEOUT_MS = 90_000;
// リトライ設定: rate limit / 一時的な遅延に耐えるための指数バックオフ
const MAX_LOGIN_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/** globalSetup が保存した storageState ファイルのパス */
const STORAGE_STATE_PATH = "tests/e2e/.auth/user.json";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ページが認証済みかどうかを確認する。
 * storageState でセッションがロード済みの場合、ログインページに遷移しないため
 * /home に navigate して認証状態を確認する。
 */
async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto("/home");
    await page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"), {
      timeout: 10_000,
    });
    return !page.url().includes("/login") && !page.url().includes("/auth");
  } catch {
    return false;
  }
}

export async function login(page: Page): Promise<void> {
  // storageState でセッションがロード済みの場合はログインをスキップ
  if (await isAlreadyLoggedIn(page)) {
    return;
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    try {
      await page.goto("/login");
      await page.locator("#email").fill(E2E_USER.email);
      await page.locator("#password").fill(E2E_USER.password);
      await Promise.all([
        page.waitForURL(
          (url) =>
            !url.pathname.startsWith("/login") &&
            !url.pathname.startsWith("/auth"),
          { timeout: LOGIN_TIMEOUT_MS },
        ),
        page.locator("button[type=submit]").click(),
      ]);
      await expect(page).not.toHaveURL(/\/login/);

      // オンボーディング未完了の場合はAPIで完了させてホームへ誘導する
      if (page.url().includes("/onboarding")) {
        await page.evaluate(async () => {
          try {
            await fetch("/api/onboarding/complete", { method: "POST", credentials: "include" });
          } catch {
            // オンボーディング完了APIのエラーは無視して続行
          }
        });
        await page.goto("/home");
        await page.waitForURL("**/home", { timeout: 60_000 });
      }

      // ログイン成功
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_LOGIN_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[auth fixture] ログイン試行 ${attempt}/${MAX_LOGIN_RETRIES} 失敗。${delay}ms 後にリトライ: ${err}`,
        );
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `[auth fixture] ${MAX_LOGIN_RETRIES} 回試行後もログイン失敗: ${lastError}`,
  );
}

/**
 * multi-context テスト (#311 対応) 向けのヘルパー。
 * browser.newContext() に globalSetup が生成した storageState を渡して
 * 認証済みコンテキストを作成する。pageB も認証済み状態で起動できる。
 *
 * 使用例:
 *   const contextB = await newAuthedContext(browser);
 *   const pageB = await contextB.newPage();
 */
export async function newAuthedContext(
  browser: import("@playwright/test").Browser,
  extraOptions: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const storagePath = fs.existsSync(STORAGE_STATE_PATH)
    ? STORAGE_STATE_PATH
    : undefined;
  return browser.newContext({
    storageState: storagePath,
    ...extraOptions,
  });
}

type AuthFixtures = {
  authedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page }, use) => {
    await login(page);
    await use(page);
  },
});

export { expect };
