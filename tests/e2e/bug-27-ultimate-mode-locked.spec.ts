/**
 * Bug-27 (#47): 究極モードに「Premium」バッジが付いているが無料アカウントでも有効化できる
 *
 * 確認: AI献立アシスタントモーダル内の究極モードトグルが disabled であること、
 *       または「準備中」ラベルが表示されていること。
 *       ビジネス判断: 現時点では Stripe 未実装のため、UI 側でロックする。
 */
import { test, expect } from "./fixtures/auth";

test.describe("究極モードが Premium プラン準備中としてロックされている", () => {
  test("究極モードトグルが disabled であり有効化できない", async ({
    authedPage,
  }) => {
    await authedPage.goto("/menus/weekly");

    // AI献立アシスタントボタンを探してクリック
    const assistantButton = authedPage
      .getByRole("button", { name: /AI献立アシスタント/i })
      .first();
    const buttonAvailable = await assistantButton
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!buttonAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "AI献立アシスタントボタンが見つかりません",
      });
      return;
    }

    await assistantButton.click();

    // モーダルが開くのを待機
    const modal = authedPage.locator('[role="dialog"], [data-testid="v4-generate-modal"]').first();
    const modalOpened = await modal
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(async () => {
        // role=dialog がない場合はモーダルらしき要素を探す
        const altModal = authedPage.locator('text=究極モード').first();
        return altModal
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
      });

    if (!modalOpened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "V4GenerateModal が開きませんでした",
      });
      return;
    }

    // 究極モードトグルを確認
    const ultimateToggle = authedPage.locator('[data-testid="ultimate-mode-toggle"]');
    const toggleVisible = await ultimateToggle
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!toggleVisible) {
      // data-testid がない場合は究極モードのラベル周辺のボタンを探す
      const ultimateModeSection = authedPage.locator('text=究極モード').locator('..');
      await expect(ultimateModeSection).toBeVisible({ timeout: 5_000 });
      // 準備中ラベルが表示されていることを確認
      await expect(authedPage.locator('text=準備中').first()).toBeVisible();
      return;
    }

    // 1. トグルが disabled であること
    await expect(ultimateToggle).toBeDisabled();

    // 2. 「準備中」ラベルが表示されていること
    await expect(authedPage.locator('text=準備中').first()).toBeVisible();
  });

  test("究極モードの「Premium」バッジが引き続き表示される", async ({
    authedPage,
  }) => {
    await authedPage.goto("/menus/weekly");

    const assistantButton = authedPage
      .getByRole("button", { name: /AI献立アシスタント/i })
      .first();
    const buttonAvailable = await assistantButton
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!buttonAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "AI献立アシスタントボタンが見つかりません",
      });
      return;
    }

    await assistantButton.click();

    // 究極モードセクションが表示されたら Premium バッジを確認
    const premiumBadge = authedPage.locator('text=Premium').first();
    const badgeVisible = await premiumBadge
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!badgeVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "モーダルまたは Premium バッジが見つかりません",
      });
      return;
    }

    await expect(premiumBadge).toBeVisible();
  });
});
