/**
 * Bug-19 (#33): 健康ページ「今日の記録」のラベル不足
 *
 * 確認: 「体重」「気分」「睡眠時間」または「睡眠の質」が DOM 上に存在し、
 *       スクリーンリーダーで意味のある単位として読まれる。
 */
import { test, expect } from "./fixtures/auth";

test("health page today's record cards have visible labels (or empty-state CTA)", async ({ authedPage }) => {
  await authedPage.goto("/health");
  // データありユーザー: 「今日の記録」見出し + 3カード (体重/気分/睡眠) のラベルが見える
  // データなしユーザー: 「今日の記録をつける」CTA が見える
  // 「今日の記録」見出しは todayRecord がある場合のみ描画されるため、必須とは扱わない
  const weightLabel = authedPage.getByText("体重", { exact: true });
  const ctaButton = authedPage.getByText("今日の記録をつける", { exact: true });

  // ページが安定するまで待機（見出しか CTA のどちらかが出現するまで）
  await authedPage
    .waitForFunction(
      () =>
        document.querySelector('[class*="font-semibold"]')?.textContent?.includes("今日の記録") ||
        Array.from(document.querySelectorAll("p,button")).some(
          (el) => el.textContent?.trim() === "今日の記録をつける",
        ),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {
      // タイムアウトしてもテスト本体を続行（下の isVisible で判定する）
    });

  const hasData = await weightLabel.first().isVisible({ timeout: 1_500 }).catch(() => false);

  if (hasData) {
    await expect(weightLabel.first()).toBeVisible();
    await expect(authedPage.getByText("気分", { exact: true }).first()).toBeVisible();
    await expect(authedPage.getByText(/睡眠時間|睡眠の質/).first()).toBeVisible();
  } else {
    await expect(ctaButton.first()).toBeVisible();
  }
});
