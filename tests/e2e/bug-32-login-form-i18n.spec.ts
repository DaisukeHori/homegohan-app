/**
 * Bug-32 (#52): ログイン/サインアップ画面のフォームバリデーションメッセージが英語のまま
 *
 * 確認: /login と /signup で必須フィールドを空欄のまま submit した際に、
 *       HTML5 ネイティブの英語メッセージ "Please fill out this field." ではなく
 *       日本語のカスタムメッセージが表示される。
 */
import { test, expect } from "@playwright/test";

test.describe("auth form validation messages are localized to Japanese", () => {
  test("login: empty email shows Japanese validationMessage", async ({ page }) => {
    await page.goto("/login");

    const submit = page.locator('form button[type="submit"]');
    await submit.click();

    const message = await page.locator("#email").evaluate(
      (el) => (el as HTMLInputElement).validationMessage,
    );

    expect(message).not.toMatch(/please fill out/i);
    // 日本語が含まれていること (メールアドレス を含む)
    expect(message).toContain("メールアドレス");
  });

  test("signup: empty email shows Japanese validationMessage", async ({ page }) => {
    await page.goto("/signup");

    const submit = page.locator('form button[type="submit"]');
    await submit.click();

    const message = await page.locator("#email").evaluate(
      (el) => (el as HTMLInputElement).validationMessage,
    );

    expect(message).not.toMatch(/please fill out/i);
    expect(message).toContain("メールアドレス");
  });

  test("login: empty password shows Japanese validationMessage", async ({ page }) => {
    await page.goto("/login");

    // メールアドレスは埋めてパスワードだけ空欄
    await page.locator("#email").fill("test@example.com");
    await page.locator('form button[type="submit"]').click();

    const message = await page.locator("#password").evaluate(
      (el) => (el as HTMLInputElement).validationMessage,
    );

    expect(message).not.toMatch(/please fill out/i);
    expect(message).toContain("パスワード");
  });
});
