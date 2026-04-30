import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "path";
import fs from "fs";

export const E2E_USER = {
  email: process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
};

/**
 * globalSetup が保存した storageState ファイルのパス。
 * ファイルが存在しない場合は通常ログインにフォールバックする。
 *
 * #310 #323 対応: storageState 再利用で Supabase auth rate limit を回避
 */
export const STORAGE_STATE_PATH = path.join(
  process.cwd(),
  "tests/e2e/.auth/user.json"
);

/**
 * globalSetup で保存した storageState を返す。
 * ファイルが存在しない場合は null を返す。
 */
export function getStorageStatePath(): string | undefined {
  return fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;
}

export async function login(page: Page) {
  // globalSetup でキャッシュされた storageState があれば復元してスキップ
  const storagePath = getStorageStatePath();
  if (storagePath) {
    try {
      const state = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
      // cookies を現在のコンテキストに注入して再ログインを回避
      if (state.cookies && state.cookies.length > 0) {
        await page.context().addCookies(state.cookies);
        // /home へアクセスしてセッションの有効性を確認
        await page.goto("/home");
        const url = page.url();
        if (!url.includes("/login") && !url.includes("/auth")) {
          // オンボーディングが出た場合は API で完了させる
          if (url.includes("/onboarding")) {
            await page.evaluate(async () => {
              try {
                await fetch("/api/onboarding/complete", { method: "POST", credentials: "include" });
              } catch {
                // ignore
              }
            });
            await page.goto("/home");
            await page.waitForURL("**/home", { timeout: 30_000 });
          }
          return; // storageState 再利用成功
        }
      }
    } catch {
      // storageState の復元に失敗した場合は通常ログインにフォールバック
    }
  }

  // 通常ログイン (storageState がない or 無効な場合)
  await page.goto("/login");
  await page.locator("#email").fill(E2E_USER.email);
  await page.locator("#password").fill(E2E_USER.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"), {
      timeout: 60_000,
    }),
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
    await page.waitForURL("**/home", { timeout: 30_000 });
  }
}

/**
 * multi-context テスト (#311 対応) 向けのヘルパー。
 * browser.newContext() に storageState を渡して認証済みコンテキストを作成する。
 *
 * 使用例:
 *   const contextB = await newAuthedContext(browser);
 *   const pageB = await contextB.newPage();
 */
export async function newAuthedContext(
  browser: import("@playwright/test").Browser,
  extraOptions: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {}
): Promise<BrowserContext> {
  const storagePath = getStorageStatePath();
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
