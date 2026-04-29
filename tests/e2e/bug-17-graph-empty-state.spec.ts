/**
 * Bug-17 (#31): 推移グラフ画面でデータなしでも「最大 100.0」が常に表示される
 *
 * 確認: /health/graphs にアクセスし、グラフにデータが無いタブでは
 *       統計サマリの「最大」値がハードコードされた "100.0" にならないこと。
 *       データなし時はハイフン (-) 表示、または「データがありません」が見えること。
 */
import { test, expect } from "./fixtures/auth";

const METRIC_TABS = ["体重", "体脂肪率", "血圧", "睡眠"] as const;

test.describe("health graphs empty state", () => {
  test("does not show hardcoded '最大 100.0' when no data exists", async ({ authedPage }) => {
    await authedPage.goto("/health/graphs");
    await expect(authedPage.getByRole("heading", { name: "推移グラフ" })).toBeVisible({
      timeout: 15_000,
    });

    for (const tabLabel of METRIC_TABS) {
      const tab = authedPage.getByRole("button", { name: tabLabel }).first();
      const tabAvailable = await tab
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!tabAvailable) continue;
      await tab.click();

      // ローディングスピナーが消えるのを待つ（簡易的に少し待機）
      await authedPage.waitForLoadState("networkidle").catch(() => {});

      const emptyMessage = authedPage.getByText("データがありません").first();
      const hasEmptyMessage = await emptyMessage.isVisible({ timeout: 2_000 }).catch(() => false);

      if (hasEmptyMessage) {
        // データなし: 「最大 100.0」が表示されてはいけない
        // 統計カードは「最大」ラベルの直後に値テキストが入っている
        const maxLabel = authedPage.getByText("最大", { exact: true }).first();
        await expect(maxLabel).toBeVisible();

        // 親カード内の値テキストを取得
        const maxCard = maxLabel.locator("..");
        const cardText = (await maxCard.innerText()).trim();

        // ハードコードの "100.0" を含んではいけない
        expect(cardText).not.toMatch(/100\.0/);
        // ハイフン or 0.0 のいずれかは許容
        expect(cardText).toMatch(/[-－—]|0\.0/);
      }
    }
  });
});
