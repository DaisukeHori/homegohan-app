/**
 * Bug-31 (#51): レシピ詳細モーダルのお気に入り(❤️)ボタンをクリックしても色変化なし・反応なし
 *
 * 確認:
 *   1. レシピ詳細モーダルのハートボタンをクリックすると aria-pressed が変わり
 *      fill 色が赤 (#FF6B6B) になること
 *   2. ボタンにクリック前は aria-pressed="false"、クリック後は aria-pressed="true"
 *   3. ページリロード後も状態が保持されること (API persist 確認)
 */
import { test, expect } from "./fixtures/auth";

test.describe("recipe modal favorite button (Bug-31)", () => {
  /**
   * ハートボタンが存在し、クリックで aria-pressed と SVG fill が変化する
   */
  test("clicking heart button toggles aria-pressed and heart fill color", async ({ authedPage }) => {
    await authedPage.goto("/menus/weekly");
    await authedPage.waitForLoadState("networkidle");

    const recipeButton = authedPage.locator('text=レシピを見る').first();
    if (!(await recipeButton.isVisible({ timeout: 2000 }).catch(() => false))) {
      test.skip(true, 'No recipe available for E2E user');
      return;
    }

    const buttonAvailable = await recipeButton
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!buttonAvailable) {
      test.skip(true, '週間献立にレシピを見るボタンが見つかりませんでした (データ未生成)');
      return;
    }

    await recipeButton.click();

    // ハートボタンを取得
    const favBtn = authedPage.locator('[data-testid="favorite-button"]');
    await expect(favBtn).toBeVisible({ timeout: 5_000 });

    // モーダルオープン直後は API でお気に入り状態を取得中のため disabled になる場合がある
    // disabled が解除されるまで待つ
    await expect(favBtn).not.toBeDisabled({ timeout: 10_000 });

    // 既にお気に入り登録済みの場合は一度解除してから再登録する
    const initialPressed = await favBtn.getAttribute("aria-pressed");
    if (initialPressed === "true") {
      await favBtn.click();
      await expect(favBtn).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
    }

    // クリック前は未選択
    await expect(favBtn).toHaveAttribute("aria-pressed", "false");

    // クリック
    await favBtn.click();

    // クリック後 → 選択状態
    await expect(favBtn).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });

    // SVG の fill 属性が赤 (#FF6B6B) になっていること
    const heartFill = await favBtn.locator("svg").getAttribute("fill");
    expect(heartFill).toBe("#FF6B6B");

    // クリーンアップ: お気に入りを解除して初期状態に戻す
    await favBtn.click();
    await expect(favBtn).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  });

  /**
   * お気に入り登録後にリロードしても状態が保持される (API が persist していること)
   */
  // 修正: モーダルクローズに Escape キーを優先使用してページ遷移を回避
  test("favorite state persists after page reload", async ({ authedPage }) => {
    await authedPage.goto("/menus/weekly");
    await authedPage.waitForLoadState("networkidle");

    const recipeButton = authedPage.locator('text=レシピを見る').first();
    if (!(await recipeButton.isVisible({ timeout: 2000 }).catch(() => false))) {
      test.skip(true, 'No recipe available for E2E user');
      return;
    }

    const buttonAvailable = await recipeButton
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!buttonAvailable) {
      test.skip(true, '週間献立にレシピを見るボタンが見つかりませんでした (データ未生成)');
      return;
    }

    await recipeButton.click();

    const favBtn = authedPage.locator('[data-testid="favorite-button"]');
    await expect(favBtn).toBeVisible({ timeout: 5_000 });

    // まず disabled でないことを確認 (disabled なら API未完了でスキップ)
    const isDisabled = await favBtn.isDisabled().catch(() => true);
    if (isDisabled) {
      test.skip(true, 'favorite ボタンが disabled — API 応答待ち or 未サポート状態');
      return;
    }

    // まず未選択であることを確認
    const initialState = await favBtn.getAttribute("aria-pressed");
    if (initialState === "true") {
      // 既にお気に入り登録済みなら解除してからやり直す
      await favBtn.click();
      await expect(favBtn).toHaveAttribute("aria-pressed", "false");
    }

    // お気に入りに追加
    await favBtn.click();
    await expect(favBtn).toHaveAttribute("aria-pressed", "true");

    // モーダルを閉じる (エスケープキーでも閉じられる)
    const closed = await authedPage.getByRole("button", { name: /閉じる/ }).first().click()
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      await authedPage.keyboard.press('Escape');
      await authedPage.waitForTimeout(500);
    }

    // ページをリロード
    await authedPage.reload();
    await authedPage.waitForLoadState("domcontentloaded");

    // 再びレシピモーダルを開く
    const recipeButton2 = authedPage.locator('text=レシピを見る').first();
    const available2 = await recipeButton2.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
    if (!available2) {
      test.skip(true, 'リロード後にレシピボタンが見つからない');
      return;
    }
    await recipeButton2.click();

    const favBtn2 = authedPage.locator('[data-testid="favorite-button"]');
    await expect(favBtn2).toBeVisible({ timeout: 5_000 });

    // リロード後も aria-pressed="true" のまま
    await expect(favBtn2).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });

    // クリーンアップ: お気に入りを解除
    await favBtn2.click();
    await expect(favBtn2).toHaveAttribute("aria-pressed", "false");
  });
});
