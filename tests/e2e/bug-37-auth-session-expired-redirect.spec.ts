/**
 * Bug-37 (#55): 認証セッション切れ時にログイン画面ではなく「ゲストモード」へ自動遷移する
 *
 * 確認:
 *   1. Cookie/localStorage を全てクリアした状態 (= 未認証) で /home にアクセスする
 *   2. /login にリダイレクトされること (URL に /login が含まれること)
 *   3. ?next=/home パラメータが付与されていること (middleware がセット)
 *   4. ゲストモードのままホームが表示されないこと
 */
import { test, expect } from "@playwright/test";

test("unauthenticated access to /home redirects to /login", async ({ page }) => {
  // Cookie / localStorage / sessionStorage をすべてクリアして未認証状態を再現
  await page.context().clearCookies();

  // /home に直接アクセス
  await page.goto("/home");

  // /login (またはそのサブパス) にリダイレクトされていることを確認
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});

test("redirect URL includes ?next= pointing back to the original protected route", async ({ page }) => {
  await page.context().clearCookies();

  await page.goto("/home");

  // /login に到達するまで待つ
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  const url = new URL(page.url());
  // middleware が ?next=/home を付与しているはず
  const nextParam = url.searchParams.get("next");
  expect(nextParam).toBe("/home");
});

test("unauthenticated access to /health redirects to /login with correct next param", async ({ page }) => {
  await page.context().clearCookies();

  await page.goto("/health");
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  const url = new URL(page.url());
  const nextParam = url.searchParams.get("next");
  expect(nextParam).toBe("/health");
});

test("guest mode ('ゲスト') is not shown on home page when unauthenticated — login page shown instead", async ({ page }) => {
  await page.context().clearCookies();

  await page.goto("/home");
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  // ゲストさん という表示がないことを確認 (ホームページが表示されていない)
  const guestText = page.locator("text=ゲストさん");
  await expect(guestText).not.toBeVisible();

  // ログインフォームが表示されていること
  const loginForm = page.locator('form').or(page.locator('input[type="email"]')).first();
  await expect(loginForm).toBeVisible({ timeout: 10_000 });
});
