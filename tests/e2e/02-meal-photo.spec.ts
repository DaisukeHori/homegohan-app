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

  // モード選択 (「食事」タブ or ボタン)
  const mealTab = page.getByText(/^食事$/).first();
  if (await mealTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await mealTab.click();
  }

  // 次へ / 撮影へ進む ボタン
  const nextBtn = page.getByRole("button", { name: /撮影へ進む|次へ|写真を選ぶ|アップロード/ });
  if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await nextBtn.click();
  }

  // ファイル入力
  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: "attached", timeout: 10000 });
  await fileInput.setInputFiles(FIXTURE_IMAGE);

  // 解析ボタン
  const analyzeBtn = page.getByRole("button", { name: /解析|分析|送信/ });
  if (await analyzeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await analyzeBtn.click();
  }

  // 結果画面の確認 (Gemini 応答まで最大 60s)
  await expect(
    page.locator("text=/解析結果|kcal|カロリー|栄養/").first(),
  ).toBeVisible({ timeout: 60000 });
});
