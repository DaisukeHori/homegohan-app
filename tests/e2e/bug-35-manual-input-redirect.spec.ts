/**
 * Bug-35 (#46): 健康診断記録「手動で入力する」ボタンが週間献立画面にリダイレクトされる
 *
 * 確認: /health/checkups/new で「手動で入力する」ボタンをクリックしたとき、
 *       /menus/weekly へリダイレクトされず、手動入力フォーム (Step 2) が表示されること。
 */
import { test, expect } from "./fixtures/auth";

test.describe("health checkup manual input (Bug-35)", () => {
  test("手動で入力する button shows the form and does not redirect to /menus/weekly", async ({
    authedPage,
  }) => {
    await authedPage.goto("/health/checkups/new");

    // 健康診断を記録ページが表示されること
    await expect(
      authedPage.getByRole("heading", { name: "健康診断を記録" }),
    ).toBeVisible({ timeout: 15_000 });

    // 画像を選択していない状態で「手動で入力する」ボタンが表示されること
    const manualButton = authedPage.getByRole("button", { name: "手動で入力する" });
    await expect(manualButton).toBeVisible({ timeout: 10_000 });

    // ボタンをクリック
    await manualButton.click();

    // /menus/weekly へリダイレクトされていないこと
    await expect(authedPage).not.toHaveURL(/\/menus\/weekly/, { timeout: 5_000 });

    // 手動入力フォーム (Step 2: 検査結果を確認) が表示されること
    await expect(
      authedPage.getByRole("heading", { name: "検査結果を確認" }),
    ).toBeVisible({ timeout: 10_000 });

    // 検査日の入力欄が表示されること (フォームが正しく開いている)
    const dateInput = authedPage.locator('input[type="date"]').first();
    await expect(dateInput).toBeVisible({ timeout: 5_000 });
  });
});
