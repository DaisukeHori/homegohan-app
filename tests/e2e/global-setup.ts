/**
 * Playwright グローバルセットアップ
 *
 * 全 worker が共有する storageState を生成する。
 *
 * 戦略:
 * 1. Supabase Auth REST API でトークン取得 (ブラウザログインをスキップ)
 * 2. 取得したセッションを Cookie として Playwright コンテキストに直接設定
 *    (@supabase/ssr は localStorage でなく Cookie を使うため)
 * 3. /home に遷移して認証済み状態を確認
 * 4. storageState を atomic write (tmp + rename) で保存
 * 5. refresh_token を別ファイルに atomic write で保存 (auth fixture での再認証に利用)
 *
 * workers=4 対応:
 * - e2e-user-01〜04 の 4 ユーザーを 1 秒間隔で順次セットアップ (rate limit 回避)
 * - 各 worker は test.workerIndex に応じてユーザーを切り替え (auth fixture 側)
 * - backward compat: E2E_USER_EMAIL が設定済みかつパターン外なら単一ユーザーモード
 *
 * ログイン失敗時は警告を出力して続行する (各テストが個別ログインにフォールバック)。
 */

import { chromium, type FullConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { seedClassifyFixtures } from "./setup/seed-classify-fixtures";

/** backward compat: 既存コードが参照するエクスポート (user-01 のパスを返す) */
export const REFRESH_TOKEN_PATH = "tests/e2e/.auth/refresh-01.json";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/** 分散対象のユーザー数 */
const MULTI_USER_COUNT = 4;

/** worker インデックス (1-based) に対応するユーザーのメールアドレスを返す */
export function getWorkerUserEmail(workerIndex: number): string {
  const idx = (workerIndex % MULTI_USER_COUNT) + 1;
  return `e2e-user-0${idx}@homegohan.test`;
}

/** worker インデックス (1-based) に対応する storageState ファイルパスを返す */
export function getStorageStatePath(workerIndex: number): string {
  const idx = (workerIndex % MULTI_USER_COUNT) + 1;
  return `tests/e2e/.auth/user-0${idx}.json`;
}

/** worker インデックス (1-based) に対応する refresh token ファイルパスを返す */
export function getRefreshTokenPath(workerIndex: number): string {
  const idx = (workerIndex % MULTI_USER_COUNT) + 1;
  return `tests/e2e/.auth/refresh-0${idx}.json`;
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
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Supabase Auth REST API でサインインしてセッションを取得する。
 */
async function fetchSupabaseSession(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<Record<string, unknown> | null> {
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
      const body = await resp.text();
      console.warn(`[global-setup] Supabase auth API error ${resp.status}: ${body.substring(0, 200)}`);
      return null;
    }
    const data = await resp.json() as Record<string, unknown>;
    if (!data.access_token) {
      console.warn(`[global-setup] Supabase auth: no access_token in response`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[global-setup] fetchSupabaseSession error: ${err}`);
    return null;
  }
}

/**
 * refresh_token を使って新しいセッションを取得する (rate limit が password grant より緩い)。
 */
export async function refreshSupabaseSession(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`[global-setup] Supabase refresh API error ${resp.status}: ${body.substring(0, 200)}`);
      return null;
    }
    const data = await resp.json() as Record<string, unknown>;
    if (!data.access_token) {
      console.warn(`[global-setup] Supabase refresh: no access_token in response`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[global-setup] refreshSupabaseSession error: ${err}`);
    return null;
  }
}

/**
 * 1ユーザー分の storageState を生成して保存する。
 * MAX_RETRIES 回失敗しても警告のみで続行する。
 */
async function setupUserSession(
  baseURL: string,
  email: string,
  password: string,
  supabaseUrl: string,
  supabaseAnonKey: string,
  storageStatePath: string,
  refreshTokenPath: string,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const browser = await chromium.launch();
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await context.newPage();

    try {
      let sessionInjected = false;

      if (supabaseUrl && supabaseAnonKey) {
        console.log(`[global-setup] ${email} セッション取得中... (attempt ${attempt})`);
        const session = await fetchSupabaseSession(supabaseUrl, supabaseAnonKey, email, password);

        if (session) {
          const supabaseRef = supabaseUrl.replace("https://", "").split(".")[0];
          const cookieName = `sb-${supabaseRef}-auth-token`;
          const domain = new URL(baseURL).hostname;
          const cookieValue = encodeURIComponent(JSON.stringify(session));
          const expiresAt = (session.expires_at as number) ?? (Date.now() / 1000 + 3600);

          await context.addCookies([
            {
              name: cookieName,
              value: cookieValue,
              domain,
              path: "/",
              expires: expiresAt,
              httpOnly: false,
              secure: baseURL.startsWith("https"),
              sameSite: "Lax",
            },
          ]);

          console.log(`[global-setup] Cookie セッション設定完了: ${cookieName} @ ${domain} (${email})`);

          if (session.refresh_token) {
            atomicWriteJson(refreshTokenPath, {
              refresh_token: session.refresh_token,
              expires_at: session.expires_at ?? (Math.floor(Date.now() / 1000) + 3600),
              saved_at: Math.floor(Date.now() / 1000),
            });
            console.log(`[global-setup] refresh_token saved to ${refreshTokenPath}`);
          }

          await page.goto(`${baseURL}/home`, { timeout: 60_000 });
          // C: waitForURL リトライ (Vercel cold-start 対応)
          let navigated = false;
          for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
            try {
              await page.waitForURL(
                (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
                { timeout: 60_000 },
              );
              navigated = true;
              break;
            } catch (navErr) {
              if (navAttempt < 2) {
                console.warn(`[global-setup] waitForURL attempt ${navAttempt} timeout for ${email}, retrying...`);
                await page.goto(`${baseURL}/home`, { timeout: 60_000 });
              } else {
                throw navErr;
              }
            }
          }
          if (!navigated) throw new Error(`[global-setup] ${email}: /home に遷移できませんでした`);
          console.log(`[global-setup] 認証確認成功 (${email}): ${page.url()}`);
          sessionInjected = true;
        }
      }

      if (!sessionInjected) {
        console.log(`[global-setup] UI ログインにフォールバック (${email}, attempt ${attempt})`);
        await page.goto(`${baseURL}/login`);
        await page.waitForLoadState("networkidle");
        // #1057 (UX1-16 round-2): キーがメールアドレス単位 (`auth_last_fail_ts:<email>`) に
        // 変わったため prefix 一致で全て削除する
        await page.evaluate(() => {
          Object.keys(localStorage)
            .filter((k) => k.startsWith("auth_last_fail_ts"))
            .forEach((k) => localStorage.removeItem(k));
        });

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

        const navPromise = page.waitForURL(
          (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
          { timeout: 90_000 },
        );
        await page.locator("button[type=submit]").click();
        await navPromise;

        if (page.url().includes("/onboarding")) {
          await page.evaluate(async () => {
            try {
              await fetch("/api/onboarding/complete", { method: "POST", credentials: "include" });
            } catch { /* ignore */ }
          });
          await page.goto(`${baseURL}/home`);
          await page.waitForURL("**/home", { timeout: 60_000 });
        }
      }

      // storageState を atomic write (tmp path -> rename) で保存
      const storageStateTmpPath = `${storageStatePath}.tmp.${process.pid}`;
      await context.storageState({ path: storageStateTmpPath });
      fs.renameSync(storageStateTmpPath, storageStatePath);
      console.log(`[global-setup] storageState saved to ${storageStatePath} (${email}, attempt ${attempt})`);
      await context.close();
      await browser.close();
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[global-setup] ログイン試行 ${attempt}/${MAX_RETRIES} 失敗 (${email}): ${err}`);
      await context.close();
      await browser.close();

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[global-setup] ${delay}ms 待機後にリトライ...`);
        await sleep(delay);
      }
    }
  }

  console.warn(`[global-setup] ${MAX_RETRIES} 回試行後もログイン失敗 (${email})。storageState なしで続行: ${lastError}`);
}

async function globalSetup(config: FullConfig): Promise<void> {
  // classify-test fixture を /tmp/classify-test/ に生成 (存在しない場合のみ)
  seedClassifyFixtures();

  const baseURL =
    config.projects[0]?.use?.baseURL ??
    process.env.PLAYWRIGHT_BASE_URL ??
    "http://localhost:3000";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  // 保存先ディレクトリを作成
  const dir = path.dirname(getStorageStatePath(0));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // E2E_USER_EMAIL が設定済みでマルチユーザーパターン外の場合は単一ユーザーモード
  const envEmail = process.env.E2E_USER_EMAIL;
  const isMultiUserPattern = !envEmail || /^e2e-user-\d+@homegohan\.test$/.test(envEmail);

  if (!isMultiUserPattern) {
    // backward compat: 単一ユーザーモード
    const password = process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!";
    console.log(`[global-setup] 単一ユーザーモード (E2E_USER_EMAIL=${envEmail})`);
    await setupUserSession(
      baseURL,
      envEmail!,
      password,
      supabaseUrl,
      supabaseAnonKey,
      "tests/e2e/.auth/user.json",
      "tests/e2e/.auth/refresh.json",
    );
    return;
  }

  // マルチユーザーモード: e2e-user-01〜04 を 1 秒間隔で順次セットアップ (rate limit 回避)
  console.log(`[global-setup] マルチユーザーモード: ${MULTI_USER_COUNT} ユーザーを順次セットアップ (1 秒間隔)`);

  for (let i = 0; i < MULTI_USER_COUNT; i++) {
    const idx = i + 1;
    const padded = String(idx).padStart(2, "0");
    const userEmail = `e2e-user-${padded}@homegohan.test`;
    const storageStatePath = `tests/e2e/.auth/user-${padded}.json`;
    const refreshTokenPath = `tests/e2e/.auth/refresh-${padded}.json`;

    // パスワード優先順位: 個別環境変数 > 共通環境変数 > fallback
    const perUserPassword = process.env[`E2E_USER_${padded}_PASSWORD`];
    const commonPassword = process.env.E2E_USER_PASSWORD;
    const userPassword = perUserPassword ?? commonPassword ?? "TestE2E2026!secure";
    const passwordSource = perUserPassword
      ? `個別 (E2E_USER_${padded}_PASSWORD)`
      : commonPassword
        ? "共通 (E2E_USER_PASSWORD)"
        : "fallback";
    console.log(`[global-setup] user-${padded}: password 由来 = ${passwordSource}`);

    await setupUserSession(
      baseURL,
      userEmail,
      userPassword,
      supabaseUrl,
      supabaseAnonKey,
      storageStatePath,
      refreshTokenPath,
    );

    // 最後のユーザー以外は 1 秒待機して rate limit を回避
    if (i < MULTI_USER_COUNT - 1) {
      console.log(`[global-setup] 次のユーザーまで 1 秒待機...`);
      await sleep(1_000);
    }
  }

  // backward compat: user.json / refresh.json を user-01 のシンボリックリンクとして作成
  const legacyStoragePath = "tests/e2e/.auth/user.json";
  const legacyRefreshPath = "tests/e2e/.auth/refresh.json";
  const target01Storage = "tests/e2e/.auth/user-01.json";
  const target01Refresh = "tests/e2e/.auth/refresh-01.json";

  for (const [linkPath, targetPath] of [
    [legacyStoragePath, target01Storage],
    [legacyRefreshPath, target01Refresh],
  ] as const) {
    try {
      if (fs.existsSync(linkPath)) {
        fs.unlinkSync(linkPath);
      }
      // 相対パスでシンボリックリンクを作成 (同一ディレクトリ内)
      const linkName = path.basename(linkPath);
      const targetName = path.basename(targetPath);
      fs.symlinkSync(targetName, linkPath);
      console.log(`[global-setup] symlink: ${linkName} -> ${targetName}`);
    } catch (err) {
      // シンボリックリンク作成失敗時はコピーでフォールバック
      try {
        if (fs.existsSync(targetPath)) {
          fs.copyFileSync(targetPath, linkPath);
          console.log(`[global-setup] fallback copy: ${targetPath} -> ${linkPath}`);
        }
      } catch {
        console.warn(`[global-setup] backward compat ファイル作成失敗 (${linkPath}): ${err}`);
      }
    }
  }

  console.log(`[global-setup] マルチユーザーセットアップ完了`);
}

export default globalSetup;
