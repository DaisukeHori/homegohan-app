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
// storageState が期限まで何秒未満なら先回り refresh するしきい値
const PRE_REFRESH_BUFFER_SECONDS = 600; // 10 分
// password grant の retry 設定
const PASSWORD_GRANT_MAX_RETRIES = 3;
const PASSWORD_GRANT_BASE_DELAY_MS = 2_000;
// waitForURL タイムアウト (Vercel cold-start 対応: 60s)
const WAIT_FOR_URL_TIMEOUT_MS = 60_000;

/** 分散対象ユーザー数 (global-setup と合わせる) */
const MULTI_USER_COUNT = 4;

/**
 * worker インデックスごとのログイン中 Promise キャッシュ。
 * 同一 worker 内で複数テストが同時に auth fixture を呼んでも 1 回しか signin しない。
 */
const workerLoginPromises = new Map<number, Promise<void>>();

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
 * JSON ファイルを atomic write (tmp + rename) で保存する。
 * 並列 worker が同じファイルを同時更新しても中途半端なファイルが残らない。
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // tmpPath が残っている場合は削除を試みる
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * storageState の access_token が期限切れ (または期限まで指定秒数未満) かどうかを確認する。
 * Cookie の中の Supabase セッション JSON から expires_at を取得して判定する。
 * bufferSeconds を変えることで「expired 判定」と「先回り refresh 判定」の両方に使う。
 */
function isStorageStateExpired(storageStatePath: string, bufferSeconds = EXPIRY_BUFFER_SECONDS): boolean {
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
              if (remaining < bufferSeconds) {
                console.log(`[auth fixture] storageState Cookie セッション期限切れ (残り ${remaining}秒, buffer ${bufferSeconds}秒)`);
                return true;
              }
              return false;
            }
          } catch {
            // JSON parse 失敗は期限切れ扱い
            return true;
          }
          // Cookie 自体の expires を確認
          if (cookie.expires && cookie.expires - nowSec < bufferSeconds) {
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
                if (remaining < bufferSeconds) {
                  console.log(`[auth fixture] storageState localStorage セッション期限切れ (残り ${remaining}秒, buffer ${bufferSeconds}秒)`);
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

    // 新しい refresh_token を atomic write で保存
    if (session.refresh_token) {
      atomicWriteJson(refreshTokenPath, {
        refresh_token: session.refresh_token,
        expires_at: session.expires_at ?? (Math.floor(Date.now() / 1000) + 3600),
        saved_at: Math.floor(Date.now() / 1000),
      });
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
    await page.goto(`${targetBase}/home`, { timeout: WAIT_FOR_URL_TIMEOUT_MS });

    // C: waitForURL リトライ (Vercel cold-start 対応)
    let navigated = false;
    for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
      try {
        await page.waitForURL(
          (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
          { timeout: WAIT_FOR_URL_TIMEOUT_MS },
        );
        navigated = true;
        break;
      } catch (navErr) {
        if (navAttempt < 2) {
          console.warn(`[auth fixture] refreshSessionViaCookie waitForURL attempt ${navAttempt} timeout, retrying...`);
          await page.goto(`${targetBase}/home`, { timeout: WAIT_FOR_URL_TIMEOUT_MS });
        } else {
          throw navErr;
        }
      }
    }
    if (!navigated) throw new Error("[auth fixture] refreshSessionViaCookie: /home に遷移できませんでした");

    console.log("[auth fixture] refresh_token でセッション更新成功");
    return true;
  } catch (err) {
    console.warn(`[auth fixture] refreshSessionViaCookie error: ${err}`);
    return false;
  }
}

/**
 * Supabase REST API でセッションを取得し、Cookie として Playwright コンテキストに注入する。
 * 429 / 500 は exponential backoff + jitter で最大 PASSWORD_GRANT_MAX_RETRIES 回リトライする。
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

  let lastStatus = 0;

  for (let attempt = 1; attempt <= PASSWORD_GRANT_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
        },
        body: JSON.stringify({ email, password }),
      });

      lastStatus = resp.status;

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.warn(`[auth fixture] Supabase API login failed: ${resp.status} (attempt ${attempt}/${PASSWORD_GRANT_MAX_RETRIES}): ${body.substring(0, 200)}`);

        // 429 (rate limit) または 5xx はリトライ対象
        if ((resp.status === 429 || resp.status >= 500) && attempt < PASSWORD_GRANT_MAX_RETRIES) {
          const baseDelay = PASSWORD_GRANT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          // jitter: baseDelay の ±25% をランダムに加算
          const jitter = Math.floor(baseDelay * 0.25 * (Math.random() * 2 - 1));
          const delay = Math.max(1000, baseDelay + jitter);
          console.log(`[auth fixture] ${delay}ms 後にリトライ...`);
          await sleep(delay);
          continue;
        }

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
      await page.goto(`${targetBase}/home`, { timeout: WAIT_FOR_URL_TIMEOUT_MS });

      // C: waitForURL リトライ (Vercel cold-start 対応)
      let navigated = false;
      for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
        try {
          await page.waitForURL(
            (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
            { timeout: WAIT_FOR_URL_TIMEOUT_MS },
          );
          navigated = true;
          break;
        } catch (navErr) {
          if (navAttempt < 2) {
            console.warn(`[auth fixture] injectSessionViaCookie waitForURL attempt ${navAttempt} timeout, retrying...`);
            await page.goto(`${targetBase}/home`, { timeout: WAIT_FOR_URL_TIMEOUT_MS });
          } else {
            throw navErr;
          }
        }
      }
      if (!navigated) throw new Error("[auth fixture] injectSessionViaCookie: /home に遷移できませんでした");

      return true;
    } catch (err) {
      console.warn(`[auth fixture] injectSessionViaCookie error (attempt ${attempt}/${PASSWORD_GRANT_MAX_RETRIES}): ${err}`);
      if (attempt < PASSWORD_GRANT_MAX_RETRIES) {
        const baseDelay = PASSWORD_GRANT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const jitter = Math.floor(baseDelay * 0.25 * (Math.random() * 2 - 1));
        const delay = Math.max(1000, baseDelay + jitter);
        await sleep(delay);
      }
    }
  }

  console.warn(`[auth fixture] injectSessionViaCookie: ${PASSWORD_GRANT_MAX_RETRIES} 回失敗 (last status: ${lastStatus})`);
  return false;
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

/**
 * 実際のログイン処理本体。worker ごとの mutex (Promise キャッシュ) の外から呼ばれる。
 */
async function doLogin(page: Page, baseURL: string, workerIndex: number): Promise<void> {
  const { email, password } = getUserCredentials(workerIndex);
  const storageStatePath = resolveStorageStatePath(workerIndex);
  const refreshTokenPath = resolveRefreshTokenPath(workerIndex);

  // 1. storageState が存在し access_token が有効期限内 (5分超) かどうかを確認
  const storageExpired = isStorageStateExpired(storageStatePath, EXPIRY_BUFFER_SECONDS);

  if (!storageExpired) {
    // 1a. 期限まで 10 分未満なら先回り refresh (access_token が切れる前に更新)
    const needsPreRefresh = isStorageStateExpired(storageStatePath, PRE_REFRESH_BUFFER_SECONDS);
    if (needsPreRefresh && fs.existsSync(refreshTokenPath)) {
      console.log(`[auth fixture] worker${workerIndex}: 期限 10 分前のため先回り refresh 実行`);
      const refreshOk = await refreshSessionViaCookie(page, baseURL, refreshTokenPath);
      if (refreshOk) return;
      // refresh 失敗なら通常の認証フローにフォールスルー
    } else {
      // 期限まで余裕あり → 既にログイン済みか確認してスキップ
      if (await isAlreadyLoggedIn(page, baseURL)) {
        return;
      }
    }
  }

  // 2. storageState が期限切れ → refresh_token で再取得 (password grant より rate limit が緩い)
  if (fs.existsSync(refreshTokenPath)) {
    const refreshOk = await refreshSessionViaCookie(page, baseURL, refreshTokenPath);
    if (refreshOk) {
      return;
    }
  }

  // 3. refresh_token も使えない場合は password grant で直接 signin (retry+jitter 付き)
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
 * worker ごとの mutex (in-memory Promise キャッシュ) 付きのログイン関数。
 * 同一 worker 内で複数テストが同時に呼んでも 1 回しか signin しない。
 */
export async function login(page: Page, baseURL = "", workerIndex = 0): Promise<void> {
  const existing = workerLoginPromises.get(workerIndex);
  if (existing) {
    // 既に進行中のログイン Promise を待つ
    try {
      await existing;
      return;
    } catch {
      // 前回のログインが失敗していた場合は再試行
      workerLoginPromises.delete(workerIndex);
    }
  }

  const loginPromise = doLogin(page, baseURL, workerIndex).finally(() => {
    // ログイン完了後はキャッシュをクリア (次のテストは再度チェックする)
    workerLoginPromises.delete(workerIndex);
  });

  workerLoginPromises.set(workerIndex, loginPromise);
  await loginPromise;
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
  /**
   * B: worker 別 fresh login fixture。
   *
   * storageState 共有による refresh_token race (複数 worker が同一 refresh_token を
   * 並行使用して invalid になる問題) を解消するため、毎回 password grant で
   * 独立した refresh_token を持つセッションを取得する。
   *
   * Speed cost: 1 worker あたり +~3s (Supabase REST 往復) だが、
   * auth 失敗による retry > timeout > リトライ連鎖より大幅に速い。
   */
  authedPage: async ({ page, baseURL }, use) => {
    const workerIndex = test.info().workerIndex;
    const resolvedBase = baseURL ?? "";
    const { email, password } = getUserCredentials(workerIndex);

    // password grant で毎回 fresh なセッションを取得 (refresh_token race を回避)
    const cookieLoginOk = await injectSessionViaCookie(page, resolvedBase, email, password);
    if (!cookieLoginOk) {
      // フォールバック: storageState ベースの login (既存フロー)
      console.warn(`[auth fixture] worker${workerIndex}: fresh login 失敗、storageState フォールバックを使用`);
      await login(page, resolvedBase, workerIndex);
    }

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

// fresh-user fixture の re-export (signup/onboarding/tour 系テスト向け)
export {
  createFreshUser,
  cleanupFreshUser,
  injectSession as injectFreshSession,
} from "./fresh-user";
