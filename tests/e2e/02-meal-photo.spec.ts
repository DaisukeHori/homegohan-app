/**
 * 02-meal-photo.spec.ts
 * 食事画像認識フローの確認
 *
 * 前提: tests/e2e/fixtures/karaage.jpg が存在すること。
 * なければ skip するのでテスト全体はブロックしない。
 */
import { test, expect } from "./fixtures/auth";
import path from "path";
import fs from "fs";

const FIXTURE_IMAGE = path.join(__dirname, "fixtures", "karaage.jpg");

test("食事画像認識: 結果画面に料理が表示される", async ({ authedPage: page }) => {
  test.setTimeout(90000);

  if (!fs.existsSync(FIXTURE_IMAGE)) {
    test.skip(true, `fixture 画像が存在しません: ${FIXTURE_IMAGE}`);
    return;
  }

  await page.goto("/meals/new");
  await page.waitForLoadState("networkidle");

  // モード選択: 「食事」ボタンをクリックして photoMode を 'meal' にする
  // ボタンテキストは「食事\n食事の写真を記録」のため hasText で部分一致
  const mealTab = page.getByRole("button").filter({ hasText: /^食事/ }).first();
  if (await mealTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await mealTab.click();
  }

  // 「撮影へ進む」ボタンをクリックして capture ステップへ遷移
  const nextBtn = page.getByRole("button", { name: /撮影へ進む/ });
  await nextBtn.waitFor({ state: "attached", timeout: 8000 });
  await nextBtn.click();

  // ファイル入力 (capture ステップにのみ存在する)
  // capture 属性なし (fileInputRef) を使う
  const fileInput = page.locator('input[type="file"]:not([capture])');
  await fileInput.waitFor({ state: "attached", timeout: 10000 });
  await fileInput.setInputFiles(FIXTURE_IMAGE);

  // 解析ボタン: 写真選択後に表示される「AIで解析する」ボタン
  const analyzeBtn = page.getByRole("button", { name: /AIで解析|解析する/ });
  if (await analyzeBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await analyzeBtn.click();
  }

  // 結果画面の確認 (Gemini 応答まで最大 60s)
  // ヘッダーが「解析結果」に変わること、または栄養グリッドの「カロリー ... kcal」が表示されることを確認
  // 「栄養」は capture ステップのヒントにも含まれるため、より specific なセレクターを使う
  await expect(
    page.locator("text=解析結果").first(),
  ).toBeVisible({ timeout: 60000 });
});
