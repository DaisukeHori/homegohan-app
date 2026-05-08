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
 * 4. storageState を保存
 *
 * ログイン失敗時は警告を出力して続行する (各テストが個別ログインにフォールバック)。
 */

import { chromium, type FullConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { seedClassifyFixtures } from "./setup/seed-classify-fixtures";

const STORAGE_STATE_PATH = "tests/e2e/.auth/user.json";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function globalSetup(config: FullConfig): Promise<void> {
  // classify-test fixture を /tmp/classify-test/ に生成 (存在しない場合のみ)
  seedClassifyFixtures();

  const baseURL =
    config.projects[0]?.use?.baseURL ??
    process.env.PLAYWRIGHT_BASE_URL ??
    "http://localhost:3000";

  const email =
    process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local";
  const password = process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  // 保存先ディレクトリを作成
  const dir = path.dirname(STORAGE_STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const browser = await chromium.launch();
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await context.newPage();

    try {
      // 1. Supabase REST API でセッション取得
      let sessionInjected = false;

      if (supabaseUrl && supabaseAnonKey) {
        console.log(`[global-setup] Supabase REST API でセッション取得中... (attempt ${attempt})`);
        const session = await fetchSupabaseSession(supabaseUrl, supabaseAnonKey, email, password);

        if (session) {
          // 2. @supabase/ssr は Cookie を使う。セッションを Cookie として設定する。
          //    Cookie 名は sb-{project-ref}-auth-token
          const supabaseRef = supabaseUrl.replace("https://", "").split(".")[0];
          const cookieName = `sb-${supabaseRef}-auth-token`;

          // baseURL の domain を取得
          const domain = new URL(baseURL).hostname;

          // Cookie value は URL-encode された JSON
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

          console.log(`[global-setup] Cookie セッション設定完了: ${cookieName} @ ${domain}`);

          // 3. /home に遷移して認証済み状態を確認
          await page.goto(`${baseURL}/home`);
          await page.waitForURL(
            (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
            { timeout: 30_000 },
          );
          console.log(`[global-setup] 認証確認成功: ${page.url()}`);
          sessionInjected = true;
        }
      }

      if (!sessionInjected) {
        // フォールバック: UI ログイン
        console.log(`[global-setup] UI ログインにフォールバック (attempt ${attempt})`);
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

      // 4. storageState を保存
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log(`[global-setup] storageState saved to ${STORAGE_STATE_PATH} (attempt ${attempt})`);
      await context.close();
      await browser.close();
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[global-setup] ログイン試行 ${attempt}/${MAX_RETRIES} 失敗: ${err}`);
      await context.close();
      await browser.close();

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[global-setup] ${delay}ms 待機後にリトライ...`);
        await sleep(delay);
      }
    }
  }

  // ログイン失敗時はエラーをスローせず警告のみ出力して続行する。
  console.warn(`[global-setup] ${MAX_RETRIES} 回試行後もログイン失敗。storageState なしで続行: ${lastError}`);
}

export default globalSetup;
