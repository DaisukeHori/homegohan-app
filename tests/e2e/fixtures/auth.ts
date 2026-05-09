import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "fs";
import { config as dotenvConfig } from "dotenv";
import * as path from "path";
import {
  refreshSupabaseSession,
  getStorageStatePath,
  getRefreshTokenPath,
  getWorkerUserEmail,
} from "../global-setup";

// Worker プロセスでも .env.local が読み込まれるよう dotenv を再実行する
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

// ログインタイムアウト
const LOGIN_TIMEOUT_MS = 90_000;
// UI リトライ設定
const MAX_UI_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;
// storageState が期限まで何秒未満なら expired と判定するバッファ
const EXPIRY_BUFFER_SECONDS = 300; // 5 分

/** 分散対象ユーザー数 (global-setup と合わせる) */
const MULTI_USER_COUNT = 4;

/**
 * worker インデックスに対応するユーザー認証情報を返す。
 *
 * - E2E_USER_EMAIL がマルチユーザーパターン外なら単一ユーザーモード
 * - それ以外は workerIndex % 4 で e2e-user-01〜04 を割り当て
 */
export function getUserCredentials(workerIndex: number): { email: string; password: string } {
  const envEmail = process.env.E2E_USER_EMAIL;
  const isMultiUserPattern = !envEmail || /^e2e-user-\d+@homegohan\.test$/.test(envEmail);

  if (!isMultiUserPattern) {
    // backward compat: 単一ユーザーモード
    return {
      email: envEmail!,
      password: process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
    };
  }

  const idx = (workerIndex % 4) + 1;
  const padded = String(idx).padStart(2, "0");
  const password =
    process.env[`E2E_USER_${padded}_PASSWORD`] ??
    process.env.E2E_USER_PASSWORD ??
    "TestE2E2026!secure";
  const email = getWorkerUserEmail(workerIndex);
  return { email, password };
}

/**
 * worker インデックスに対応する storageState ファイルパスを返す。
 *
 * 単一ユーザーモード (E2E_USER_EMAIL がパターン外) では従来パスを返す。
 */
function resolveStorageStatePath(workerIndex: number): string {
  const envEmail = process.env.E2E_USER_EMAIL;
  const isMultiUserPattern = !envEmail || /^e2e-user-\d+@homegohan\.test$/.test(envEmail);
  if (!isMultiUserPattern) {
    return "tests/e2e/.auth/user.json";
  }
  return getStorageStatePath(workerIndex);
}

/**
 * worker インデックスに対応する refresh token ファイルパスを返す。
 */
function resolveRefreshTokenPath(workerIndex: number): string {
  const envEmail = process.env.E2E_USER_EMAIL;
  const isMultiUserPattern = !envEmail || /^e2e-user-\d+@homegohan\.test$/.test(envEmail);
  if (!isMultiUserPattern) {
    return "tests/e2e/.auth/refresh.json";
  }
  return getRefreshTokenPath(workerIndex);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * storageState の access_token が期限切れ (または期限まで 5 分未満) かどうかを確認する。
 * Cookie の中の Supabase セッション JSON から expires_at を取得して判定する。
 */
function isStorageStateExpired(storageStatePath: string): boolean {
  try {
    const raw = fs.readFileSync(storageStatePath, "utf-8");
    const state = JSON.parse(raw) as {
      cookies?: Array<{ name: string; value: string; expires?: number }>;
      origins?: Array<{
        localStorage?: Array<{ name: string; value: string }>;
      }>;
    };

    const nowSec = Math.floor(Date.now() / 1000);

    // Cookie ベースのセッション確認 (sb-...-auth-token)
    if (state.cookies) {
      for (const cookie of state.cookies) {
        if (cookie.name?.startsWith("sb-") && cookie.name.endsWith("-auth-token")) {
          try {
            const decoded = decodeURIComponent(cookie.value);
            const session = JSON.parse(decoded) as { expires_at?: number };
            if (session.expires_at) {
              const remaining = session.expires_at - nowSec;
              if (remaining < EXPIRY_BUFFER_SECONDS) {
                console.log(`[auth fixture] storageState Cookie セッション期限切れ (残り ${remaining}秒)`);
                return true;
              }
              return false;
            }
          } catch {
            // JSON parse 失敗は期限切れ扱い
            return true;
          }
          // Cookie 自体の expires を確認
          if (cookie.expires && cookie.expires - nowSec < EXPIRY_BUFFER_SECONDS) {
            console.log(`[auth fixture] storageState Cookie expires 期限切れ`);
            return true;
          }
        }
      }
    }

    // localStorage ベースのセッション確認 (sb-...-auth-token)
    if (state.origins) {
      for (const origin of state.origins) {
        for (const item of origin.localStorage ?? []) {
          if (item.name?.startsWith("sb-") && item.name.endsWith("-auth-token")) {
            try {
              const session = JSON.parse(item.value) as { expires_at?: number };
              if (session.expires_at) {
                const remaining = session.expires_at - nowSec;
                if (remaining < EXPIRY_BUFFER_SECONDS) {
                  console.log(`[auth fixture] storageState localStorage セッション期限切れ (残り ${remaining}秒)`);
                  return true;
                }
                return false;
              }
            } catch {
              return true;
            }
          }
        }
      }
    }

    // セッション情報が見つからない場合は期限切れ扱い
    return true;
  } catch {
    // ファイルが存在しない等のエラーは期限切れ扱い
    return true;
  }
}

/**
 * refresh_token を使ってセッションを更新し、Cookie として Playwright コンテキストに注入する。
 * password grant より rate limit が緩い。
 */
async function refreshSessionViaCookie(
  page: Page,
  baseURL: string,
  refreshTokenPath: string,
): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) return false;

  try {
    const raw = fs.readFileSync(refreshTokenPath, "utf-8");
    const { refresh_token } = JSON.parse(raw) as { refresh_token: string };
    if (!refresh_token) return false;

    console.log("[auth fixture] refresh_token でセッション更新中...");
    const session = await refreshSupabaseSession(supabaseUrl, anonKey, refresh_token);
    if (!session) return false;

    // 新しい refresh_token を保存
    if (session.refresh_token) {
      fs.writeFileSync(
        refreshTokenPath,
        JSON.stringify({
          refresh_token: session.refresh_token,
          expires_at: session.expires_at ?? (Math.floor(Date.now() / 1000) + 3600),
          saved_at: Math.floor(Date.now() / 1000),
        }),
        "utf-8",
      );
    }

    const supabaseRef = supabaseUrl.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const domain = baseURL ? new URL(baseURL).hostname : "localhost";
    const isSecure = baseURL.startsWith("https");
    const cookieValue = encodeURIComponent(JSON.stringify(session));
    const expiresAt = (session.expires_at as number) ?? (Math.floor(Date.now() / 1000) + 3600);

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

    const targetBase = baseURL || "";
    await page.goto(`${targetBase}/home`);
    await page.waitForURL(
      (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
      { timeout: 30_000 },
    );
    console.log("[auth fixture] refresh_token でセッション更新成功");
    return true;
  } catch (err) {
    console.warn(`[auth fixture] refreshSessionViaCookie error: ${err}`);
    return false;
  }
}

/**
 * Supabase REST API でセッションを取得し、Cookie として Playwright コンテキストに注入する。
 * @supabase/ssr は Cookie ベースの認証を使うため、localStorage 注入では機能しない。
 */
async function injectSessionViaCookie(
  page: Page,
  baseURL: string,
  email: string,
  password: string,
): Promise<boolean> {
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
      body: JSON.stringify({ email, password }),
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

export async function login(page: Page, baseURL = "", workerIndex = 0): Promise<void> {
  const { email, password } = getUserCredentials(workerIndex);
  const storageStatePath = resolveStorageStatePath(workerIndex);
  const refreshTokenPath = resolveRefreshTokenPath(workerIndex);

  // 1. storageState の access_token が有効期限内かつ認証済みなら signin をスキップ
  if (!isStorageStateExpired(storageStatePath)) {
    if (await isAlreadyLoggedIn(page, baseURL)) {
      return;
    }
  }

  // 2. storageState が期限切れ → refresh_token で再取得 (password grant より rate limit が緩い)
  if (fs.existsSync(refreshTokenPath)) {
    const refreshOk = await refreshSessionViaCookie(page, baseURL, refreshTokenPath);
    if (refreshOk) {
      return;
    }
  }

  // 3. refresh_token も使えない場合は password grant で直接 signin
  const cookieLoginOk = await injectSessionViaCookie(page, baseURL, email, password);
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

      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);

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
  workerIndex = 0,
): Promise<BrowserContext> {
  const storageStatePath = resolveStorageStatePath(workerIndex);
  const storagePath = fs.existsSync(storageStatePath) ? storageStatePath : undefined;
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
    const workerIndex = test.info().workerIndex;
    await login(page, baseURL ?? "", workerIndex);
    await use(page);
  },
});

export { expect };

// backward compat: 既存コードが REFRESH_TOKEN_PATH / E2E_USER をインポートしている場合の互換
export { MULTI_USER_COUNT };

/** @deprecated workerIndex を受け取る getUserCredentials() を使うこと */
export const E2E_USER = {
  get email() {
    return process.env.E2E_USER_EMAIL ?? "e2e-user-01@homegohan.test";
  },
  get password() {
    return process.env.E2E_USER_PASSWORD ?? "TestE2E2026!secure";
  },
};
