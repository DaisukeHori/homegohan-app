/**
 * 01-login.spec.ts
 * ログインフローの基本動作確認
 */
import { test, expect } from "@playwright/test";

test("ログインできる", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  await page.locator("#email").fill(
    process.env.E2E_USER_EMAIL ?? "claude-debug-1777477826@homegohan.local",
  );
  await page.locator("#password").fill(
    process.env.E2E_USER_PASSWORD ?? "ClaudeDebug2026!",
  );
  await page.locator("button[type=submit]").click();

  // ログイン後は /login 以外のページへ遷移する
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });
  // home / menus / onboarding のいずれかに遷移すること
  await expect(page).toHaveURL(/\/(home|menus|onboarding|$)/, { timeout: 30000 });
});
