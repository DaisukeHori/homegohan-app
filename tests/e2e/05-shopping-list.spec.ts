/**
 * 05-shopping-list.spec.ts
 * 買い物リスト: ボタンクリックでモーダルが開くことを確認
 *
 * Note: ?modal=shopping-list URL パラメータは現時点で未実装のため、
 * aria-label="買い物リストを開く" ボタンをクリックしてモーダルを開く。
 */
import { test, expect } from "./fixtures/auth";

test("買い物リスト: ボタンクリックでモーダルが開く", async ({ authedPage: page }) => {
  test.setTimeout(30000);

  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // 買い物リストボタンをクリック
  const shoppingBtn = page.getByRole("button", { name: /買い物リストを開く/ });
  await shoppingBtn.waitFor({ state: "visible", timeout: 10000 });
  await shoppingBtn.click();

  // 買い物リストモーダルのタイトルが表示されること
  await expect(
    page.getByText(/買い物リスト/).first(),
  ).toBeVisible({ timeout: 10000 });
});
