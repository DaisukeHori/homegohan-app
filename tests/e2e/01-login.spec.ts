/**
 * 01-login.spec.ts
 * ログインフローの基本動作確認
 *
 * 移行: fresh user fixture を使用 (毎 test でユニーク認証情報)
 * createFreshUser で admin API 経由でユーザー作成し、ログイン UI をテスト。
 */
import { test, expect } from "@playwright/test";
import { createFreshUser, cleanupFreshUser } from "./fixtures/fresh-user";

// 認証状態を持たない clean state で実行
test.use({ storageState: { cookies: [], origins: [] } });

test("ログインできる", async ({ page }) => {
  // fresh-user fixture から admin クライアントを使うため、テスト内で直接呼び出す
  // getAdminClient は fresh-user.ts 内部で export していないため、
  // createFreshUser に渡す admin クライアントは fresh-user.ts のインターナルを利用できない。
  // 代わりに fetch ベースの admin API を直接呼び出す。
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (!supabaseUrl || !serviceRoleKey) {
    test.skip(true, "Supabase 環境変数が未設定");
    return;
  }

  // admin API (fetch) でユーザー作成
  const email = `e2e-login-${Date.now()}-${Math.floor(Math.random() * 10000)}@homegohan.test`;
  const password = "TestE2E2026!secure";

  const createResp = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (!createResp.ok) {
    const body = await createResp.text();
    throw new Error(`[01-login] ユーザー作成失敗 (${createResp.status}): ${body.substring(0, 200)}`);
  }

  const userData = await createResp.json() as { id: string };
  const userId = userData.id;

  try {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // client-side rate limit key をクリア
    await page.evaluate(() => { localStorage.removeItem('auth_last_fail_ts'); });

    // React hydration 完了を確認
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('form button[type="submit"], button[type="submit"]');
        if (!btn) return false;
        return Object.keys(btn as Record<string, unknown>).some(
          (k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber") || k.startsWith("__react"),
        );
      },
      { timeout: 20_000 },
    ).catch(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);

    // waitForURL を先に登録してから click する
    const navPromise = page.waitForURL(
      (url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/auth"),
      { timeout: 30000 },
    );
    await page.locator("button[type=submit]").click();
    await navPromise;

    // ログイン後は /login 以外のページへ遷移する
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
    // home / menus / onboarding のいずれかに遷移すること
    await expect(page).toHaveURL(/\/(home|menus|onboarding|$)/, { timeout: 15000 });
  } finally {
    // cleanup
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }).catch(() => {});
  }
});
