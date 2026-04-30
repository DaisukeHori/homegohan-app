/**
 * Bug-92 (#92): 重複メールで signup すると silent-success により /auth/verify に
 * 遷移してしまい、ユーザーがエラーに気付かない問題
 *
 * 修正方針:
 *   1. signUp レスポンスの identities?.length === 0 で重複検知 → /signup にエラー表示
 *   2. /auth/verify 画面に「すでにアカウントをお持ちの場合はログインへ」リンクを追加
 */
import { test, expect } from "@playwright/test";
import { E2E_USER } from "./fixtures/auth";

// ────────────────────────────────────────────────────────
// シナリオ A: 重複メールアドレスで signup → エラー表示
// ────────────────────────────────────────────────────────
test.describe("Bug-92: 重複メールアドレスの signup 処理", () => {
  test("既存ユーザーのメールで signup すると /signup にエラーが表示される", async ({
    page,
  }) => {
    await page.goto("/signup");

    // 既存 E2E ユーザーのメールで signup を試みる
    await page.locator("#email").fill(E2E_USER.email);
    await page.locator("#password").fill(E2E_USER.password);

    await page.locator('form button[type="submit"]').click();

    // エラーアラートが /signup 画面に表示されること
    const errorAlert = page.getByRole("alert");
    await expect(errorAlert).toBeVisible({ timeout: 10_000 });

    const text = (await errorAlert.textContent()) ?? "";
    expect(text).toMatch(/既に登録|ログイン/);

    // /auth/verify に遷移していないこと
    await expect(page).toHaveURL(/\/signup$/, { timeout: 5_000 });
  });

  // ────────────────────────────────────────────────────────
  // シナリオ B: /auth/verify 画面に「ログインへ」リンクが存在する
  // ────────────────────────────────────────────────────────
  test("/auth/verify 画面に「すでにアカウントをお持ちの場合」のログインリンクが表示される", async ({
    page,
  }) => {
    await page.goto("/auth/verify?email=test%40example.com");

    // フォールバック保険: 「すでにアカウントをお持ちの場合はログインへ」リンク
    const loginLink = page.getByRole("link", { name: /ログインへ/ });
    await expect(loginLink).toBeVisible({ timeout: 5_000 });

    // リンク先が /login であること
    const href = await loginLink.getAttribute("href");
    expect(href).toMatch(/\/login/);
  });
});
