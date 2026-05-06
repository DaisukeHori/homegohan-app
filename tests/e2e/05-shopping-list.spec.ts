/**
 * 05-shopping-list.spec.ts
 * 買い物リスト: モーダル URL (?modal=shopping-list) で開くことを確認
 */
import { test, expect } from "./fixtures/auth";

test("買い物リスト: モーダル URL で開く", async ({ authedPage: page }) => {
  test.setTimeout(30000);

  await page.goto("/menus/weekly?modal=shopping-list");
  await page.waitForLoadState("networkidle");

  // 買い物リストモーダルのタイトルが表示されること
  await expect(
    page.getByText(/買い物リスト|お買い物リスト|ショッピングリスト/).first(),
  ).toBeVisible({ timeout: 15000 });
});
