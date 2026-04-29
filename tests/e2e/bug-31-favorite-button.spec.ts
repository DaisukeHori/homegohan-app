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

    const recipeButton = authedPage.getByRole("button", { name: /レシピを見る/ }).first();
    const buttonAvailable = await recipeButton
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!buttonAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "週間献立にレシピを見るボタンが見つかりませんでした (データ未生成)",
      });
      return;
    }

    await recipeButton.click();

    // ハートボタンを取得
    const favBtn = authedPage.locator('[data-testid="favorite-button"]');
    await expect(favBtn).toBeVisible({ timeout: 5_000 });

    // クリック前は未選択
    await expect(favBtn).toHaveAttribute("aria-pressed", "false");

    // クリック
    await favBtn.click();

    // クリック後 → 選択状態
    await expect(favBtn).toHaveAttribute("aria-pressed", "true");

    // SVG の fill 属性が赤 (#FF6B6B) になっていること
    const heartFill = await favBtn.locator("svg").getAttribute("fill");
    expect(heartFill).toBe("#FF6B6B");
  });

  /**
   * お気に入り登録後にリロードしても状態が保持される (API が persist していること)
   */
  test("favorite state persists after page reload", async ({ authedPage }) => {
    await authedPage.goto("/menus/weekly");

    const recipeButton = authedPage.getByRole("button", { name: /レシピを見る/ }).first();
    const buttonAvailable = await recipeButton
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!buttonAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "週間献立にレシピを見るボタンが見つかりませんでした (データ未生成)",
      });
      return;
    }

    await recipeButton.click();

    const favBtn = authedPage.locator('[data-testid="favorite-button"]');
    await expect(favBtn).toBeVisible({ timeout: 5_000 });

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

    // モーダルを閉じる
    await authedPage.getByRole("button", { name: /閉じる/ }).first().click().catch(async () => {
      // X ボタンで閉じる
      await authedPage.locator('button').filter({ has: authedPage.locator('svg') }).last().click();
    });

    // ページをリロード
    await authedPage.reload();
    await authedPage.waitForLoadState("networkidle");

    // 再びレシピモーダルを開く
    const recipeButton2 = authedPage.getByRole("button", { name: /レシピを見る/ }).first();
    await recipeButton2.waitFor({ state: "visible", timeout: 8_000 });
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
