/**
 * Bug-19 (#33): 健康ページ「今日の記録」のラベル不足
 *
 * 確認: 「体重」「気分」「睡眠時間」または「睡眠の質」が DOM 上に存在し、
 *       スクリーンリーダーで意味のある単位として読まれる。
 */
import { test, expect } from "./fixtures/auth";

test("health page today's record cards have visible labels", async ({ authedPage }) => {
  await authedPage.goto("/health");
  await expect(authedPage.getByText("体重", { exact: true })).toBeVisible();
  await expect(authedPage.getByText("気分", { exact: true })).toBeVisible();
  // 睡眠は記録の有無で「睡眠時間」「睡眠の質」のどちらかが出る
  await expect(
    authedPage.getByText(/睡眠時間|睡眠の質/),
  ).toBeVisible();
});
