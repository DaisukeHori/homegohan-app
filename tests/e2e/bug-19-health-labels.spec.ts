/**
 * Bug-19 (#33): 健康ページ「今日の記録」のラベル不足
 *
 * 確認: 「体重」「気分」「睡眠時間」または「睡眠の質」が DOM 上に存在し、
 *       スクリーンリーダーで意味のある単位として読まれる。
 */
import { test, expect } from "./fixtures/auth";

test("health page today's record cards have visible labels (or empty-state CTA)", async ({ authedPage }) => {
  await authedPage.goto("/health");
  // データありユーザー: 3カード (体重/気分/睡眠) のラベルが見える
  // データなしユーザー: 「今日の記録をつける」CTA が見える
  // どちらにせよ「今日の記録」見出しは必ず見える
  await expect(authedPage.getByRole("heading", { name: "今日の記録" })).toBeVisible({ timeout: 15_000 });

  const weightLabel = authedPage.getByText("体重", { exact: true });
  const ctaButton = authedPage.getByText("今日の記録をつける", { exact: true });
  const hasData = await weightLabel.first().isVisible({ timeout: 1_500 }).catch(() => false);

  if (hasData) {
    await expect(weightLabel.first()).toBeVisible();
    await expect(authedPage.getByText("気分", { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByText(/睡眠時間|睡眠の質/).first()).toBeVisible();
  } else {
    await expect(ctaButton.first()).toBeVisible();
  }
});
