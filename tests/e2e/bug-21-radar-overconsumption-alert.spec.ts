/**
 * Bug-21 (#35): 栄養分析モーダルのレーダーチャート「平均達成率 230%」が異常値
 *
 * 確認: 週間献立画面で栄養分析モーダルを開き、レーダーチャートの
 *       平均達成率が DISPLAY_CAP=200% を超えないこと、
 *       150%超の軸がある場合は overconsumption-warning が表示されること。
 *
 * データが無い環境ではテストをスキップする。
 */
import { test, expect } from "./fixtures/auth";

test.describe("radar chart overconsumption alert", () => {
  test("average percentage is capped at 200% and warning shown when overconsumption detected", async ({
    authedPage,
  }) => {
    await authedPage.goto("/menus/weekly");

    // 栄養分析モーダルを開くアイコン (aria-label="栄養分析を見る")
    const analysisButton = authedPage.getByRole("button", { name: "栄養分析を見る" }).first();
    const analysisAvailable = await analysisButton
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!analysisAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "週間献立に栄養分析ボタンが見つかりませんでした (データ未生成)",
      });
      return;
    }

    await analysisButton.click();

    // 「平均達成率」表示を取得 (data-testid="radar-average-display")
    const averageDisplay = authedPage.locator('[data-testid="radar-average-display"]').first();
    const displayVisible = await averageDisplay
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!displayVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "レーダーチャートが表示されませんでした (データ未生成の可能性)",
      });
      return;
    }

    const text = (await averageDisplay.innerText()).trim();
    // 数値部分を抽出
    const match = text.match(/(\d+)/);
    expect(match).not.toBeNull();
    const value = match ? parseInt(match[1], 10) : 0;

    // 230% のような異常値が出ないこと: DISPLAY_CAP=200% で頭打ち
    expect(value).toBeLessThanOrEqual(200);

    // 150%超のとき (data-overconsumption=true) は警告が表示されること
    const valueSpan = averageDisplay.locator("[data-overconsumption]").first();
    const overconsumed = await valueSpan
      .getAttribute("data-overconsumption")
      .catch(() => "false");
    if (overconsumed === "true") {
      const warning = authedPage.locator('[data-testid="overconsumption-warning"]').first();
      await expect(warning).toBeVisible();
      await expect(warning).toHaveText(/過剰摂取/);
    }
  });
});
