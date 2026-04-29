/**
 * Bug-8 (#26): 週間献立の「翌週」「前の週」ナビボタンに aria-label が機能していない
 * Bug-23 (#37): 週間献立画面の右上3アイコン (グラフ/冷蔵庫/カート) に aria-label が無い
 *
 * 確認: getByRole('button', { name: ... }) で全てのナビ + 右上3アイコンが取得できる。
 */
import { test, expect } from "./fixtures/auth";

test.describe("weekly menu aria-labels", () => {
  test("week navigation buttons expose aria-label", async ({ authedPage }) => {
    await authedPage.goto("/menus/weekly");
    await expect(authedPage.getByRole("button", { name: "前の週" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "翌週" })).toBeVisible();
  });

  test("top-right action icons expose aria-label", async ({ authedPage }) => {
    await authedPage.goto("/menus/weekly");
    await expect(authedPage.getByRole("button", { name: "栄養分析を見る" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "冷蔵庫を確認" })).toBeVisible();
    await expect(authedPage.getByRole("button", { name: "買い物リストを開く" })).toBeVisible();
  });
});
