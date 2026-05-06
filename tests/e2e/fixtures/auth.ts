import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "fs";
import { config as dotenvConfig } from "dotenv";
import * as path from "path";

// Worker プロセスでも .env.local が読み込まれるよう dotenv を再実行する
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

export const E2E_USER = {
  email: process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
};

// ログインタイムアウト
const LOGIN_TIMEOUT_MS = 90_000;
// UI リトライ設定
const MAX_UI_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

/** globalSetup が保存した storageState ファイルのパス */
const STORAGE_STATE_PATH = "tests/e2e/.auth/user.json";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Supabase REST API でセッションを取得し、Cookie として Playwright コンテキストに注入する。
 * @supabase/ssr は Cookie ベースの認証を使うため、localStorage 注入では機能しない。
 */
async function injectSessionViaCookie(page: Page, baseURL: string): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    console.warn("[auth fixture] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
    return false;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
      },
      body: JSON.stringify({ email: E2E_USER.email, password: E2E_USER.password }),
    });

    if (!resp.ok) {
      console.warn(`[auth fixture] Supabase API login failed: ${resp.status}`);
      return false;
    }

    const session = await resp.json() as Record<string, unknown>;
    if (!session.access_token) return false;

    // @supabase/ssr の Cookie 名は sb-{project-ref}-auth-token
    const supabaseRef = supabaseUrl.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const domain = baseURL ? new URL(baseURL).hostname : "localhost";
    const isSecure = baseURL.startsWith("https");
    const cookieValue = encodeURIComponent(JSON.stringify(session));
    const expiresAt = (session.expires_at as number) ?? (Date.now() / 1000 + 3600);

    // 古いセッション Cookie を消してから新しいものを設定
    await page.context().clearCookies();
    await page.context().addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain,
        path: "/",
        expires: expiresAt,
        httpOnly: false,
        secure: isSecure,
        sameSite: "Lax",
      },
    ]);

    // /home に遷移して認証済み状態を確認
    const targetBase = baseURL || "";
    await page.goto(`${targetBase}/home`);
    await page.waitForURL(
      (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
      { timeout: 30_000 },
    );
    return true;
  } catch (err) {
    console.warn(`[auth fixture] injectSessionViaCookie error: ${err}`);
    return false;
  }
}

/**
 * ページが認証済みかどうかを確認する。
 */
async function isAlreadyLoggedIn(page: Page, baseURL: string): Promise<boolean> {
  try {
    await page.goto(`${baseURL}/home`);
    await page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"), {
      timeout: 10_000,
    });
    return !page.url().includes("/login") && !page.url().includes("/auth");
  } catch {
    return false;
  }
}

export async function login(page: Page, baseURL = ""): Promise<void> {
  // storageState でセッションがロード済みの場合はログインをスキップ
  if (await isAlreadyLoggedIn(page, baseURL)) {
    return;
  }

  // Supabase API 経由で Cookie セッション注入を試みる (hydration 問題・UI login 問題を回避)
  const cookieLoginOk = await injectSessionViaCookie(page, baseURL);
  if (cookieLoginOk) {
    return;
  }

  // フォールバック: UI ログイン
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_UI_RETRIES; attempt++) {
    try {
      await page.goto(`${baseURL}/login`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => { localStorage.removeItem("auth_last_fail_ts"); });

      // React hydration 確認
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('form button[type="submit"], button[type="submit"]');
          if (!btn) return false;
          return Object.keys(btn as Record<string, unknown>).some(
            (k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber") || k.startsWith("__react"),
          );
        },
        { timeout: 20_000 },
      ).catch(async () => { await new Promise((r) => setTimeout(r, 1000)); });

      await page.locator("#email").fill(E2E_USER.email);
      await page.locator("#password").fill(E2E_USER.password);

      const navigationPromise = page.waitForURL(
        (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
        { timeout: LOGIN_TIMEOUT_MS },
      );
      await page.locator("button[type=submit]").click();
      await navigationPromise;
      await expect(page).not.toHaveURL(/\/login/);

      if (page.url().includes("/onboarding")) {
        await page.evaluate(async () => {
          try {
            await fetch("/api/onboarding/complete", { method: "POST", credentials: "include" });
          } catch { /* ignore */ }
        });
        await page.goto(`${baseURL}/home`);
        await page.waitForURL("**/home", { timeout: 60_000 });
      }

      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_UI_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[auth fixture] UI ログイン試行 ${attempt}/${MAX_UI_RETRIES} 失敗。${delay}ms 後にリトライ: ${err}`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`[auth fixture] ログイン失敗: ${lastError}`);
}

/**
 * multi-context テスト向けのヘルパー。
 */
export async function newAuthedContext(
  browser: import("@playwright/test").Browser,
  extraOptions: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const storagePath = fs.existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;
  return browser.newContext({
    storageState: storagePath,
    ...extraOptions,
  });
}

type AuthFixtures = {
  authedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authedPage: async ({ page, baseURL }, use) => {
    await login(page, baseURL ?? "");
    await use(page);
  },
});

export { expect };
