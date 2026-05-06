/**
 * 01-login.spec.ts
 * ログインフローの基本動作確認
 */
import { test, expect } from "@playwright/test";

test("ログインできる", async ({ page }) => {
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
    // フォールバック: 500ms 追加待機
    await new Promise((r) => setTimeout(r, 500));
  });

  await page.locator("#email").fill(
    process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  );
  await page.locator("#password").fill(
    process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
  );

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
});
