/**
 * Bug-33 (#53): サインアップ時にパスワード強度バリデーションが効かず、エラー表示もない
 *
 * 確認: /signup で弱いパスワード ("123") を送信したとき、インラインで日本語の
 *       強度エラーが表示されてフォーム送信がブロックされること。
 *       強いパスワード ("Password1!") を入力するとエラーが解消されること。
 */
import { test, expect } from "@playwright/test";

test.describe("signup password strength validation", () => {
  test("weak password shows inline Japanese error and blocks submission", async ({
    page,
  }) => {
    await page.goto("/signup");

    await page.locator("#email").fill("test-weak-pwd@example.com");
    await page.locator("#password").fill("123");

    // submit を押下
    await page.locator('form button[type="submit"]').click();

    // インラインのエラーメッセージが表示される (alert role)
    const errorAlert = page.getByRole("alert").first();
    await expect(errorAlert).toBeVisible({ timeout: 3_000 });

    const text = (await errorAlert.textContent()) ?? "";
    // 「8文字以上」もしくは「強度」/「英字」/「数字」など、強度関連の日本語メッセージを含むこと
    expect(text).toMatch(/8文字以上|英字|数字|強度|パスワード/);

    // URL は /signup のまま (画面遷移していない)
    await expect(page).toHaveURL(/\/signup$/);
  });

  test("strong password clears the inline error", async ({ page }) => {
    await page.goto("/signup");

    await page.locator("#email").fill("test-strong-pwd@example.com");
    await page.locator("#password").fill("123");

    // 弱パスワードで一度エラー出す
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 3_000 });

    // 強いパスワードに修正 (8文字以上 + 英字 + 数字)
    await page.locator("#password").fill("Password1!");

    // インラインエラーが消えること (input 中のリアルタイム再評価)
    await expect
      .poll(
        async () => {
          const alerts = await page.getByRole("alert").allTextContents();
          // password-error の alert が消えているか (空 or 別の form-error のみ)
          return alerts.filter((t) => /8文字以上|英字|数字/.test(t)).length;
        },
        { timeout: 3_000 },
      )
      .toBe(0);
  });
});
