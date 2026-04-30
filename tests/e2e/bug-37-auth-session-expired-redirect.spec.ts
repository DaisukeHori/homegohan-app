/**
 * Bug-37 (#55): 認証セッション切れ時にログイン画面ではなく「ゲストモード」へ自動遷移する
 *
 * 確認:
 *   1. Cookie/localStorage を全てクリアした状態 (= 未認証) で /home にアクセスする
 *   2. /login にリダイレクトされること (URL に /login が含まれること)
 *   3. ?next=/home パラメータが付与されていること (middleware がセット)
 *   4. ゲストモードのままホームが表示されないこと
 *
 * 注意: production では未認証でも /home がゲストモードで表示される実装のため、
 *       /login へのリダイレクトを前提とするテストは現状 skip。
 *       middleware でゲストモードを廃止し /login へ強制リダイレクトする修正後に有効化する。
 */
import { test, expect } from "@playwright/test";

/** Cookie + ストレージを完全クリアして未認証状態を再現 */
async function clearSession(page: any) {
  await page.context().clearCookies();
  // addInitScript で次ページロード前に localStorage/sessionStorage をクリア
  await page.addInitScript(() => {
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
  });
}

/** middleware で !isPublicPath に Cache-Control: private, no-store を設定し CDN bypass を解消済み */
const REDIRECT_EXPECTED = true;

test("unauthenticated access to /home redirects to /login", async ({ page }) => {
  if (!REDIRECT_EXPECTED) {
    test.skip(true, '未認証アクセスがゲストモードで /home を表示する実装のため skip (middleware 修正待ち)');
    return;
  }
  await clearSession(page);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});

test("redirect URL includes ?next= pointing back to the original protected route", async ({ page }) => {
  if (!REDIRECT_EXPECTED) {
    test.skip(true, '未認証アクセスがゲストモードで /home を表示する実装のため skip (middleware 修正待ち)');
    return;
  }
  await clearSession(page);
  await page.goto("/home");
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  const url = new URL(page.url());
  const nextParam = url.searchParams.get("next");
  expect(nextParam).toBe("/home");
});

test("unauthenticated access to /health redirects to /login with correct next param", async ({ page }) => {
  if (!REDIRECT_EXPECTED) {
    test.skip(true, '未認証アクセスがゲストモードで /home を表示する実装のため skip (middleware 修正待ち)');
    return;
  }
  await clearSession(page);
  await page.goto("/health");
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  const url = new URL(page.url());
  const nextParam = url.searchParams.get("next");
  expect(nextParam).toBe("/health");
});

test("guest mode ('ゲスト') is not shown on home page when unauthenticated — login page shown instead", async ({ page }) => {
  if (!REDIRECT_EXPECTED) {
    test.skip(true, '未認証アクセスがゲストモードで /home を表示する実装のため skip (middleware 修正待ち)');
    return;
  }
  await clearSession(page);
  await page.goto("/home");
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  const guestText = page.locator("text=ゲストさん");
  await expect(guestText).not.toBeVisible();
  const loginForm = page.locator('form').or(page.locator('input[type="email"]')).first();
  await expect(loginForm).toBeVisible({ timeout: 10_000 });
});
