/**
 * tests/e2e/tour/helpers.ts
 *
 * Playwright E2E ハンズオンツアー共通ヘルパー
 */

import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** テストユーザーのパスワード (固定値) */
const TEST_USER_PASSWORD = "E2eTourUser2026!";

/** Supabase service_role 経由でテストユーザーを削除する */
export async function cleanupTestUser(userId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[tour/helpers] SUPABASE_SERVICE_ROLE_KEY が未設定のためユーザー削除をスキップ");
    return;
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text();
      console.warn(`[tour/helpers] ユーザー削除失敗 (${resp.status}): ${body.substring(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[tour/helpers] cleanupTestUser error: ${err}`);
  }
}

/**
 * Supabase service_role admin API で新規ユーザーを作成し、
 * user_profiles に初期レコードを insert する。
 * anon key の signup ではなく admin API を使うことで
 * email_confirm (メール確認) を強制的にバイパスする。
 * 成功した場合は user_id を返す。
 */
export async function signupViaApi(email: string, password: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[tour/helpers] SUPABASE_SERVICE_ROLE_KEY が未設定 — admin API でのユーザー作成不可");
    return null;
  }
  try {
    // service_role admin API: email_confirm をバイパスしてユーザー作成
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true, // メール確認をスキップして即時有効化
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`[tour/helpers] admin/users 作成失敗 (${resp.status}): ${body.substring(0, 200)}`);
      return null;
    }
    const data = await resp.json() as Record<string, unknown>;
    // admin API のレスポンスは { id: "...", email: "...", ... } 形式
    const userId = (data.id as string | undefined) ?? null;
    if (!userId) return null;

    // user_profiles に onboarding 完了済みの初期レコードを insert する。
    // onboarding_completed_at を設定することで getHandsonTourStatusInternal が
    // 'eligible' を返し、/handson-tour に正しくリダイレクトされる。
    const now = new Date().toISOString();
    const profileResp = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        id: userId,
        nickname: "E2E Test User",
        age_group: "30s",
        gender: "unspecified",
        onboarding_completed_at: now,
      }),
    });
    if (!profileResp.ok) {
      const profileBody = await profileResp.text();
      console.warn(`[tour/helpers] user_profiles 初期レコード作成失敗 (${profileResp.status}): ${profileBody.substring(0, 200)}`);
      // profile 作成失敗でもユーザー自体は作成されているので userId を返す
    }

    return userId;
  } catch (err) {
    console.warn(`[tour/helpers] signupViaApi error: ${err}`);
    return null;
  }
}

/**
 * Supabase Cookie を page context に注入してログイン状態を作る。
 * @supabase/ssr は Cookie ベース認証を使用する。
 */
async function injectSession(page: Page, email: string, password: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) return false;
    const session = await resp.json() as Record<string, unknown>;
    if (!session.access_token) return false;

    const supabaseRef = SUPABASE_URL.replace("https://", "").split(".")[0];
    const cookieName = `sb-${supabaseRef}-auth-token`;
    const baseURL = (page.context() as unknown as { _options?: { baseURL?: string } })._options?.baseURL ?? "http://localhost:3000";
    const domain = new URL(baseURL).hostname;
    const cookieValue = encodeURIComponent(JSON.stringify(session));
    const expiresAt = (session.expires_at as number) ?? (Date.now() / 1000 + 3600);

    await page.context().clearCookies();
    await page.context().addCookies([
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
    return true;
  } catch {
    return false;
  }
}

/**
 * 新規ユーザーとして signup → onboarding 完了 → /handson-tour 自動到達。
 *
 * - email はテスト内でユニークである必要がある
 * - UI signup フォームを通さず API でユーザーを作成し Cookie を注入する
 * - signupViaApi で user_profiles.onboarding_completed_at を設定済みのため
 *   onboarding ページへのリダイレクトは発生しない
 * - /handson-tour/layout.tsx が status API で eligible を確認して表示する
 *
 * @returns userId (afterEach での cleanupTestUser 用)
 */
export async function signupAsNewUser(page: Page, email: string): Promise<string | null> {
  // 1. Supabase API で新規 signup (onboarding_completed_at を同時に設定)
  const userId = await signupViaApi(email, TEST_USER_PASSWORD);
  if (!userId) {
    console.warn(`[tour/helpers] signupAsNewUser: signup 失敗 (${email})`);
    return null;
  }

  // 2. Cookie セッション注入
  const injected = await injectSession(page, email, TEST_USER_PASSWORD);
  if (!injected) {
    console.warn("[tour/helpers] signupAsNewUser: セッション注入失敗");
    return userId;
  }

  // 3. /handson-tour へ直接遷移 (onboarding_completed_at 設定済み + 新規なので eligible)
  await page.goto("/handson-tour");
  await page.waitForLoadState("domcontentloaded");

  return userId;
}

/**
 * testID による要素の表示を確認するラッパー。
 * タイムアウトなど共通オプションを統一する。
 */
export async function expectTestId(
  page: Page,
  testId: string,
  options?: { timeout?: number; visible?: boolean },
): Promise<Locator> {
  const locator = page.getByTestId(testId);
  if (options?.visible !== false) {
    await expect(locator).toBeVisible({ timeout: options?.timeout ?? 10_000 });
  }
  return locator;
}

/** ユニークなテストメールを生成する */
export function generateTestEmail(prefix = "e2e-tour"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@homegohan.test`;
}
