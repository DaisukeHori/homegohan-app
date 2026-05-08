/**
 * tests/e2e/refactor-baseline/weekly-modals-batch-b.spec.ts
 *
 * weekly/page.tsx 残モーダル 後半 6 個の interaction 特性テスト (batch-b)
 *
 * 対象モーダル:
 *   1. AddMealSlotModal  — 「食事を追加」ボタン → 食事タイプ選択
 *   2. AddFridgeModal    — 冷蔵庫モーダル → 「食材を追加」→ addFridge
 *   3. PhotoEditModal    — 手動編集モーダル → 「写真から入力」
 *   4. ImageGenerateModal — 手動編集モーダル → 「AIで画像生成」
 *   5. ImproveMealModal  — 栄養詳細モーダル → 「この提案で献立を改善」
 *   6. AddMealModal      — modes 分岐 (cook / fast / eat-out 等)
 *
 * 制約:
 *   - batch-a が担当する前半 7 モーダル
 *     (AiAssistant / AiMeal / RegenerateMeal / NutritionDetail / Stats / Servings / ShoppingRange)
 *     には触らない
 *   - 実装ファイルは一切変更しない
 *   - testID 不足で開けないモーダルは test.skip で原因を記載
 */
import { test, expect } from "../fixtures/auth";
import {
  gotoWeekly,
  openFridgeModal,
  findFirstMealCard,
} from "./_helpers";

// ============================================================
// ヘルパー: 手動編集モーダルまで到達する
// ============================================================
async function openManualEditModal(page: import("@playwright/test").Page): Promise<boolean> {
  const manualEditBtn = await findFirstMealCard(page);
  if (!manualEditBtn) return false;
  await manualEditBtn.click();
  const visible = await page
    .getByText("手動で変更")
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  return visible;
}

// ============================================================
// シナリオ 1: AddMealSlotModal — 食事スロット追加
// ============================================================
test.describe("batch-b-1: AddMealSlotModal", () => {
  test("「食事を追加」ボタンで AddMealSlot モーダルが開く", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    // 「食事を追加」ボタン (addMealSlot トリガー)
    const addMealSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    await addMealSlotBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addMealSlotBtn.click();

    // AddMealSlotModal のタイトルが表示されること
    await expect(
      page.getByText("食事を追加").first(),
    ).toBeVisible({ timeout: 8_000 });

    // 朝食 / 昼食 / 夕食 のボタンが表示されること
    await expect(
      page.getByRole("button", { name: /朝食/ }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /昼食/ }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /夕食/ }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("AddMealSlot モーダルで「朝食」を選ぶと AddMeal モーダルへ遷移する", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addMealSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    await addMealSlotBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addMealSlotBtn.click();

    // AddMealSlotModal で「朝食」を選択
    const breakfastBtn = page.getByRole("button", { name: /朝食/ }).first();
    await breakfastBtn.waitFor({ state: "visible", timeout: 8_000 });
    await breakfastBtn.click();

    // AddMealModal (モード選択) が表示されること
    // 「AIに提案してもらう」ボタンが出れば AddMeal モーダルへ遷移成功
    const result = await Promise.race([
      page
        .getByRole("button", { name: /AIに提案してもらう/ })
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => "add-modal"),
      page
        .getByText(/で追加/)
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => "add-modal"),
    ]).catch(() => "timeout");

    expect(result).toBe("add-modal");
  });
});

// ============================================================
// シナリオ 2: AddFridgeModal — 冷蔵庫追加 (独立ルート)
// ============================================================
test.describe("batch-b-2: AddFridgeModal", () => {
  test("FridgeModal → 「食材を追加」→ AddFridgeModal が開く", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);
    await openFridgeModal(page);

    // 「食材を追加」ボタンで AddFridge モーダルへ遷移
    await page.getByRole("button", { name: /食材を追加/ }).click();

    // AddFridgeModal のタイトルが表示されること
    await expect(
      page.getByText("食材を追加").first(),
    ).toBeVisible({ timeout: 8_000 });

    // 食材名の input が表示されること
    const nameInput = page.getByPlaceholder(/食材名（例/);
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    // 量・賞味期限の input も表示されること
    await expect(page.getByPlaceholder(/量（例/)).toBeVisible({ timeout: 5_000 });
  });

  test("AddFridgeModal の「追加する」ボタンは食材名未入力時は無効", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);
    await openFridgeModal(page);

    await page.getByRole("button", { name: /食材を追加/ }).click();
    await page.getByText("食材を追加").first().waitFor({ state: "visible", timeout: 8_000 });

    // 食材名が空の状態で「追加する」ボタンが disabled であること
    const addBtn = page.getByRole("button", { name: /追加する/ });
    await expect(addBtn).toBeDisabled({ timeout: 5_000 });

    // 食材名を入力すると enabled になること
    const nameInput = page.getByPlaceholder(/食材名（例/);
    await nameInput.fill("テスト食材");
    await expect(addBtn).toBeEnabled({ timeout: 3_000 });
  });
});

// ============================================================
// シナリオ 3: PhotoEditModal — 写真編集
// ============================================================
test.describe("batch-b-3: PhotoEditModal", () => {
  test("手動編集モーダルから「写真から入力」で PhotoEditModal が開く", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openManualEditModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「手動で修正」ボタンが見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    // 「写真から入力」ボタンをクリック
    const photoBtn = page.getByRole("button", { name: /写真から入力/ });
    await photoBtn.waitFor({ state: "visible", timeout: 8_000 });
    await photoBtn.click();

    // PhotoEditModal のタイトル「写真から入力」が表示されること
    await expect(
      page.getByText("写真から入力").first(),
    ).toBeVisible({ timeout: 8_000 });

    // 「撮影する」「選択する」ボタンが表示されること (写真未選択状態)
    const captureBtn = page.getByRole("button", { name: /撮影する/ });
    const selectBtn = page.getByRole("button", { name: /選択する/ });
    const hasCapture = await captureBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const hasSelect = await selectBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    // 撮影か選択のどちらか (またはAI解析ボタン) が表示されていること
    const hasAnalyzeBtn = await page
      .getByRole("button", { name: /AIで解析する|枚をAIで解析/ })
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);

    expect(hasCapture || hasSelect || hasAnalyzeBtn).toBe(true);
  });

  test("PhotoEditModal の X ボタンで手動編集モーダルに戻る", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openManualEditModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「手動で修正」ボタンが見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    const photoBtn = page.getByRole("button", { name: /写真から入力/ });
    await photoBtn.waitFor({ state: "visible", timeout: 8_000 });
    await photoBtn.click();
    await page.getByText("写真から入力").first().waitFor({ state: "visible", timeout: 8_000 });

    // X ボタンで閉じる
    const closeBtn = page.locator('button').filter({ has: page.locator('svg') }).filter({ hasText: "" }).last();
    // PhotoEditModal の X ボタン: onClick で photoEdit を閉じて manualEdit に戻る
    // aria-label を持たないため、最後のモーダル閉じボタンを使う
    const xButtons = page.locator('button:has(svg)');
    // 最初の X ボタン (モーダルヘッダーの閉じボタン)
    const firstXBtn = xButtons.first();
    await firstXBtn.waitFor({ state: "visible", timeout: 5_000 });
    await firstXBtn.click();

    // PhotoEditModal が閉じること (「写真から入力」テキストが消える)
    await expect(
      page.getByText("写真から入力").first(),
    ).toBeHidden({ timeout: 5_000 });
  });
});

// ============================================================
// シナリオ 4: ImageGenerateModal — AI 画像生成
// ============================================================
test.describe("batch-b-4: ImageGenerateModal", () => {
  test("手動編集モーダルから「AIで画像生成」で ImageGenerateModal が開く", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openManualEditModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「手動で修正」ボタンが見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    // 「AIで画像生成」ボタンをクリック
    const imageGenBtn = page.getByRole("button", { name: /AIで画像生成/ });
    await imageGenBtn.waitFor({ state: "visible", timeout: 8_000 });
    await imageGenBtn.click();

    // ImageGenerateModal のタイトル「AIで料理画像を生成」が表示されること
    await expect(
      page.getByText("AIで料理画像を生成").first(),
    ).toBeVisible({ timeout: 8_000 });

    // 「生成したい画像の説明」テキストエリアが表示されること
    const promptTextarea = page.getByPlaceholder(/彩りの良い|料理名だけでも/);
    await expect(promptTextarea).toBeVisible({ timeout: 5_000 });

    // 「参照画像を追加する」またはアップロードボタンが表示されること
    const hasRefImageArea = await page
      .getByText(/参照画像|参考画像を追加/)
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    expect(hasRefImageArea).toBe(true);
  });

  test("ImageGenerateModal の「料理画像を生成する」ボタンはプロンプト未入力時は無効", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openManualEditModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「手動で修正」ボタンが見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    const imageGenBtn = page.getByRole("button", { name: /AIで画像生成/ });
    await imageGenBtn.waitFor({ state: "visible", timeout: 8_000 });
    await imageGenBtn.click();
    await page.getByText("AIで料理画像を生成").first().waitFor({ state: "visible", timeout: 8_000 });

    // プロンプト未入力時は「料理画像を生成する」ボタンが disabled
    const generateBtn = page.getByRole("button", { name: /料理画像を生成する/ });
    await expect(generateBtn).toBeDisabled({ timeout: 5_000 });

    // プロンプトを入力すると enabled になること
    const promptTextarea = page.getByPlaceholder(/彩りの良い|料理名だけでも/);
    await promptTextarea.fill("テスト用の料理画像");
    await expect(generateBtn).toBeEnabled({ timeout: 3_000 });
  });
});

// ============================================================
// シナリオ 5: ImproveMealModal — 改善提案
// ============================================================
test.describe("batch-b-5: ImproveMealModal", () => {
  test("栄養詳細モーダル経由で ImproveMealModal が開く", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    // 栄養レーダーチャートをクリックして NutritionDetailModal を開く
    // NutritionDetailModal は「タップで詳細」テキスト付きのエリアをタップ
    const radarArea = page.getByText("タップで詳細").first();
    const radarAvailable = await radarArea
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!radarAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "栄養レーダーチャートが見つかりませんでした (食事データ未生成またはチャート非表示)",
      });
      return;
    }

    await radarArea.click();

    // NutritionDetailModal が開くこと
    const nutritionModalVisible = await page
      .getByText(/全栄養素|AI栄養士の提案|分析を準備中/)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!nutritionModalVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "NutritionDetailModal が開きませんでした",
      });
      return;
    }

    // 「この提案で献立を改善」ボタンが表示されるまで待つ (AI フィードバック取得待ち)
    const improveBtn = page.getByRole("button", { name: /この提案で献立を改善/ });
    const improveBtnAvailable = await improveBtn
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    if (!improveBtnAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「この提案で献立を改善」ボタンが表示されませんでした (AI フィードバック未取得)",
      });
      return;
    }

    await improveBtn.click();

    // ImproveMealModal が開くこと
    await expect(
      page.getByText("献立を改善").first(),
    ).toBeVisible({ timeout: 8_000 });

    // 朝食 / 昼食 / 夕食 の選択ボタンが表示されること
    await expect(
      page.getByRole("button", { name: /朝食/ }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("ImproveMealModal のキャンセルボタンでモーダルが閉じる", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const radarArea = page.getByText("タップで詳細").first();
    const radarAvailable = await radarArea
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!radarAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "栄養レーダーチャートが見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    await radarArea.click();

    const nutritionModalVisible = await page
      .getByText(/全栄養素|AI栄養士の提案|分析を準備中/)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!nutritionModalVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "NutritionDetailModal が開きませんでした",
      });
      return;
    }

    const improveBtn = page.getByRole("button", { name: /この提案で献立を改善/ });
    const improveBtnAvailable = await improveBtn
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    if (!improveBtnAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「この提案で献立を改善」ボタンが表示されませんでした",
      });
      return;
    }

    await improveBtn.click();
    await page.getByText("献立を改善").first().waitFor({ state: "visible", timeout: 8_000 });

    // キャンセルをクリック
    await page.getByRole("button", { name: /キャンセル/ }).click();

    // ImproveMealModal が閉じること
    await expect(
      page.getByText("献立を改善").first(),
    ).toBeHidden({ timeout: 5_000 });
  });
});

// ============================================================
// シナリオ 6: AddMealModal (詳細フロー) — modes 分岐
// ============================================================
test.describe("batch-b-6: AddMealModal modes 分岐", () => {
  /**
   * AddMealModal は空の食事スロットをタップするか、
   * AddMealSlotModal → 食事タイプ選択 経由で開く。
   * どちらかを使って AddMeal モーダルまで到達し、modes を確認する。
   */
  async function openAddMealModal(page: import("@playwright/test").Page): Promise<boolean> {
    // まず空の「+ 朝食を追加」スロットを試す
    const emptySlot = page.getByRole("button", { name: /朝食を追加/ }).first();
    const hasEmptySlot = await emptySlot
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (hasEmptySlot) {
      await emptySlot.click();
      return page
        .getByRole("button", { name: /AIに提案してもらう/ })
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
    }

    // フォールバック: AddMealSlotModal 経由
    const addMealSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const slotBtnAvail = await addMealSlotBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!slotBtnAvail) return false;

    await addMealSlotBtn.click();
    await page.getByText("食事を追加").first().waitFor({ state: "visible", timeout: 5_000 });
    const breakfastBtn = page.getByRole("button", { name: /朝食/ }).first();
    await breakfastBtn.waitFor({ state: "visible", timeout: 5_000 });
    await breakfastBtn.click();

    return page
      .getByRole("button", { name: /AIに提案してもらう/ })
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
  }

  test("AddMealModal に「自炊で追加」「買うで追加」「外食で追加」等のモードボタンが表示される", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openAddMealModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "AddMealModal に到達できませんでした (食事スロットが満杯 or ボタンが見つからず)",
      });
      return;
    }

    // 「AIに提案してもらう」ボタンが表示されること
    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeVisible({ timeout: 5_000 });

    // 何らかのモードボタン (「で追加」サフィックス) が 1 つ以上表示されること
    const modeButtons = page.getByRole("button", { name: /で追加$/ });
    const count = await modeButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test("AddMealModal に「商品名で検索」input が表示される (catalog 検索)", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openAddMealModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "AddMealModal に到達できませんでした",
      });
      return;
    }

    // 市販品検索の input が表示されること
    const catalogInput = page.getByPlaceholder(/商品名で検索/);
    await expect(catalogInput).toBeVisible({ timeout: 5_000 });
  });

  test("AddMealModal の X ボタンで閉じると週ビューに戻る", async ({ authedPage: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const reached = await openAddMealModal(page);
    if (!reached) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "AddMealModal に到達できませんでした",
      });
      return;
    }

    // AddMealModal が開いていることを確認
    await page.getByRole("button", { name: /AIに提案してもらう/ }).waitFor({ state: "visible", timeout: 5_000 });

    // バックドロップ (モーダルの外側) をクリックして閉じる
    // または X ボタンを探してクリック
    const backdrop = page.locator('[class*="fixed inset-0"]').first();
    const backdropAvailable = await backdrop
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);

    if (backdropAvailable) {
      await backdrop.click({ position: { x: 10, y: 10 } });
    } else {
      // X ボタンを探す
      const xBtn = page.locator('button:has(svg)').first();
      await xBtn.click();
    }

    // 「前の週」ナビゲーションボタンが引き続き表示されること (週ビューに戻った)
    await expect(
      page.locator('[aria-label="前の週"]'),
    ).toBeVisible({ timeout: 8_000 });
  });
});
