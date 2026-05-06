/**
 * 04-menu-page.spec.ts
 * 献立画面: 週間メニューが表示されることを確認
 */
import { test, expect } from "./fixtures/auth";

test("献立画面: 週間メニューが表示される", async ({ authedPage: page }) => {
  test.setTimeout(30000);

  await page.goto("/menus/weekly");
  await page.waitForLoadState("networkidle");

  // 7 曜日ラベルのいずれかが表示されること
  await expect(
    page.locator("text=/月|火|水|木|金|土|日/").first(),
  ).toBeVisible({ timeout: 15000 });
});
