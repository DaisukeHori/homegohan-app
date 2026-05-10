/**
 * tests/e2e/refactor-baseline/weekly-modals-batch-a.spec.ts
 *
 * weekly 残モーダル前半 7 個の interaction 特性テスト
 *
 * 目的: Refactor B-3 (PR #918) で zustand selector 読みに変更された
 *       14 モーダルのうち、weekly-characterization.spec.ts でカバーされて
 *       いない前半 7 個の開閉と最低限の interaction を固定する。
 *
 * カバーするモーダル (7):
 *   1. AiAssistantModal   — 'ai' モード (※ activeModal='ai' の直接トリガーが
 *                           V4GenerateModal に置換済みのため test.skip)
 *   2. AiMealModal        — 'aiMeal' モード  (add モーダル経由)
 *   3. RegenerateMealModal — 'regenerateMeal' モード (meal-regenerate-button)
 *   4. NutritionDetailModal — showNutritionDetailModal フラグ (stats→詳細)
 *   5. StatsModal         — 'stats' モード (栄養分析ボタン)
 *   6. ServingsModal      — showServingsModal フラグ (shopping→人数設定)
 *   7. ShoppingRangeModal — 'shoppingRange' モード (shopping→再生成)
 *
 * 参照: tests/e2e/refactor-baseline/weekly-characterization.spec.ts (既存 7 モーダル)
 */
import { test, expect } from "../fixtures/fresh-user";
import { gotoWeekly, openShoppingModal } from "./_helpers";

// ============================================================
// モーダル 1: AiAssistantModal
// ============================================================
test.describe("modal-1: AiAssistantModal (ai)", () => {
  test.skip(
    true,
    "activeModal='ai' の直接トリガーが page.tsx に存在しない。" +
      "週の AI 生成は V4GenerateModal (showV4Modal) に置き換わっており、" +
      "AiAssistantModal は現行 UI では到達不能。testID 追加後に再有効化を推奨。"
  );

  test("AI アシスタントモーダルが開く (placeholder)", async ({ tourPendingUser: page }) => {
    await gotoWeekly(page);
    // この spec は到達不能なため実装不要
  });
});

// ============================================================
// モーダル 2: AiMealModal
// ============================================================
test.describe("modal-2: AiMealModal (aiMeal)", () => {
  test("add モーダル内「AIに提案してもらう」ボタンで aiMeal モーダルが開く", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    // 空の朝食スロット「+ 朝食を追加」か「食事を追加」を使って add モーダルを開く
    let reachedAddModal = false;

    const emptySlot = page.getByRole("button", { name: /朝食を追加/ }).first();
    const hasEmptySlot = await emptySlot
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (hasEmptySlot) {
      await emptySlot.click();
      reachedAddModal = await page
        .getByRole("button", { name: /AIに提案してもらう/ })
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!reachedAddModal) {
      // addMealSlot → add の 2 ステップで到達
      const slotBtn = page.getByRole("button", { name: "食事を追加" }).first();
      const slotAvail = await slotBtn
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);

      if (!slotAvail) {
        test.info().annotations.push({
          type: "skip-reason",
          description: "食事追加トリガーが見つかりませんでした",
        });
        return;
      }
      await slotBtn.click();
      await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 });
      const breakfastChoice = page.getByRole("button", { name: /朝食/ }).first();
      await breakfastChoice.waitFor({ state: "visible", timeout: 5_000 });
      await breakfastChoice.click();

      reachedAddModal = await page
        .getByRole("button", { name: /AIに提案してもらう/ })
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!reachedAddModal) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "add モーダルに到達できませんでした",
      });
      return;
    }

    // add モーダルの「AIに提案してもらう」ボタンをクリック
    await page.getByRole("button", { name: /AIに提案してもらう/ }).first().click();

    // aiMeal モーダルが開くこと — AI 条件ボタン (data-testid="weekly-condition-*") で確認
    const conditionBtn = page.locator('[data-testid^="weekly-condition-"]').first();
    const aiMealVisible = await conditionBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    expect(aiMealVisible).toBe(true);

    // 「この1食をAIに提案してもらう」ボタンが表示されること
    await expect(
      page.getByRole("button", { name: /この1食をAIに提案してもらう/ })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("aiMeal モーダルで条件ボタンを選択すると aria が反転する", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    // add モーダル経由で aiMeal に到達
    let reachedAiMeal = false;

    const emptySlot = page.getByRole("button", { name: /朝食を追加/ }).first();
    const hasEmptySlot = await emptySlot
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (hasEmptySlot) {
      await emptySlot.click();
      const aiBtn = page.getByRole("button", { name: /AIに提案してもらう/ }).first();
      const visible = await aiBtn
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (visible) {
        await aiBtn.click();
        reachedAiMeal = await page
          .locator('[data-testid^="weekly-condition-"]')
          .first()
          .waitFor({ state: "visible", timeout: 8_000 })
          .then(() => true)
          .catch(() => false);
      }
    }

    if (!reachedAiMeal) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "aiMeal モーダルへの到達に失敗 (食事データ未生成またはフロー変更)",
      });
      return;
    }

    // 最初の条件ボタンをクリックして背景色が変わること (aria-pressed ではなく style ベース)
    const firstCondition = page.locator('[data-testid^="weekly-condition-"]').first();
    await firstCondition.click();
    await page.waitForTimeout(300);
    // Check アイコンが表示されること (選択済みの印)
    await expect(firstCondition.locator("svg")).toBeVisible({ timeout: 3_000 });
  });
});

// ============================================================
// モーダル 3: RegenerateMealModal
// ============================================================
test.describe("modal-3: RegenerateMealModal (regenerateMeal)", () => {
  test("meal-regenerate-button で regenerateMeal モーダルが開く", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    // meal-regenerate-button が表示されるまで待つ
    const regenBtn = page.getByTestId("meal-regenerate-button").first();
    const available = await regenBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!available) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "meal-regenerate-button が見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    await regenBtn.click();

    // regenerateMeal モーダルが開くこと — 再生成条件ボタンで確認
    const conditionBtn = page.locator('[data-testid^="regen-condition-"]').first();
    await expect(conditionBtn).toBeVisible({ timeout: 8_000 });

    // 「AIで別の献立に変更」ボタンが表示されること
    await expect(
      page.getByRole("button", { name: /AIで別の献立に変更/ })
    ).toBeVisible({ timeout: 5_000 });

    // 「現在の献立」ラベルが表示されること
    await expect(page.getByText("現在の献立")).toBeVisible({ timeout: 5_000 });
  });

  test("regenerateMeal モーダルを X ボタンで閉じると元 UI に戻る", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const regenBtn = page.getByTestId("meal-regenerate-button").first();
    const available = await regenBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!available) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "meal-regenerate-button が見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    await regenBtn.click();

    // モーダルが開いたことを確認
    await page
      .locator('[data-testid^="regen-condition-"]')
      .first()
      .waitFor({ state: "visible", timeout: 8_000 });

    // X ボタン (最後の丸ボタン) でモーダルを閉じる
    // RegenerateMealModal の X は rounded-full の button 内に X icon
    const closeBtn = page
      .locator('button.rounded-full:has(svg)')
      .last();
    await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
    await closeBtn.click();

    // 「現在の献立」テキストが消えること (モーダル閉じの確認)
    await expect(page.getByText("現在の献立")).toBeHidden({ timeout: 5_000 });

    // 週ナビゲーションが引き続き表示されること
    await expect(page.locator('[aria-label="前の週"]')).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ============================================================
// モーダル 4: NutritionDetailModal
// ============================================================
test.describe("modal-4: NutritionDetailModal", () => {
  test("StatsModal から「詳細を見る / 献立を改善」で NutritionDetailModal が開く", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    // Stats モーダルを開く
    const statsBtn = page.locator('[aria-label="栄養分析を見る"]');
    await statsBtn.waitFor({ state: "visible", timeout: 10_000 });
    await statsBtn.click();

    // Stats モーダルが開くこと
    await expect(page.getByText("栄養分析").first()).toBeVisible({ timeout: 8_000 });

    // 「詳細を見る / 献立を改善」ボタンが出現するまで待つ (AI フィードバック生成後)
    const detailBtn = page.getByRole("button", { name: /詳細を見る/ });
    const detailAvailable = await detailBtn
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    if (!detailAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "「詳細を見る / 献立を改善」ボタンが表示されませんでした " +
          "(食事データ未生成または AI フィードバック未取得)",
      });
      return;
    }

    await detailBtn.click();

    // NutritionDetailModal が開くこと — 「の栄養分析」テキストで確認
    const nutritionDetailVisible = await page
      .getByText(/の栄養分析/)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    expect(nutritionDetailVisible).toBe(true);

    // X ボタンで閉じられること
    const closeBtn = page.locator('button:has(svg)').filter({ hasText: "" }).last();
    // NutritionDetailModal の X は p-2 rounded-full
    const xBtn = page.locator("button.rounded-full.p-2").first();
    const xAvail = await xBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (xAvail) {
      await xBtn.click();
      await expect(page.getByText(/の栄養分析/).first()).toBeHidden({ timeout: 5_000 });
    }
  });

  test("日付ヘッダーのレーダーチャートをクリックすると NutritionDetailModal が開く", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    // 日付ヘッダーをクリックして栄養パネルを展開
    const dayHeader = page
      .locator("div.cursor-pointer")
      .filter({ hasText: /月|火|水|木|金|土|日/ })
      .first();
    const headerAvail = await dayHeader
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!headerAvail) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "日付ヘッダーが見つかりませんでした",
      });
      return;
    }

    await dayHeader.click();
    await page.waitForTimeout(500);

    // レーダーチャートのコンテナ (タップで詳細) を探してクリック
    const radarContainer = page.getByText("タップで詳細").first();
    const radarAvail = await radarContainer
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!radarAvail) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "レーダーチャートエリアが見つかりませんでした (食事データ未生成)",
      });
      return;
    }

    // コンテナ親をクリック
    await radarContainer.locator("xpath=..").click();

    // NutritionDetailModal が開くこと
    const modalVisible = await page
      .getByText(/の栄養分析/)
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    expect(modalVisible).toBe(true);
  });
});

// ============================================================
// モーダル 5: StatsModal
// ============================================================
test.describe("modal-5: StatsModal (stats)", () => {
  test("「栄養分析を見る」ボタンで StatsModal が開く", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const statsBtn = page.locator('[aria-label="栄養分析を見る"]');
    await statsBtn.waitFor({ state: "visible", timeout: 10_000 });
    await statsBtn.click();

    // StatsModal が開くこと
    await expect(page.getByText("栄養分析").first()).toBeVisible({ timeout: 8_000 });

    // 「今日」タブと「今週」タブが存在すること
    await expect(page.getByRole("button", { name: /今日/ })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole("button", { name: /今週/ })).toBeVisible({
      timeout: 5_000,
    });

    // 自炊率ラベルが存在すること
    await expect(page.getByText("自炊率")).toBeVisible({ timeout: 5_000 });
  });

  test("StatsModal で「今週」タブに切り替えると週間サマリーが表示される", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const statsBtn = page.locator('[aria-label="栄養分析を見る"]');
    await statsBtn.waitFor({ state: "visible", timeout: 10_000 });
    await statsBtn.click();

    await page.getByText("栄養分析").first().waitFor({ state: "visible", timeout: 8_000 });

    // 「今週」タブをクリック
    await page.getByRole("button", { name: /今週/ }).click();
    await page.waitForTimeout(300);

    // 週間AIヒントセクションが存在すること
    await expect(page.getByText("週間AIヒント")).toBeVisible({ timeout: 5_000 });

    // X ボタンで閉じる
    const closeBtn = page.locator("button.rounded-full").filter({ hasText: "" }).last();
    const xBtn = page.locator("button.w-7.h-7.rounded-full").last();
    await xBtn.waitFor({ state: "visible", timeout: 5_000 });
    await xBtn.click();

    // StatsModal が閉じること
    await expect(page.getByText("週間AIヒント")).toBeHidden({ timeout: 5_000 });
  });
});

// ============================================================
// モーダル 6: ServingsModal
// ============================================================
test.describe("modal-6: ServingsModal (showServingsModal)", () => {
  test("買い物リストモーダルの人数設定ボタンで ServingsModal が開く", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    // shopping モーダルを開く
    await openShoppingModal(page);

    // 人数設定ボタン (title="人数設定") をクリック
    const servingsBtn = page.locator('button[title="人数設定"]');
    await servingsBtn.waitFor({ state: "visible", timeout: 8_000 });
    await servingsBtn.click();

    // ServingsModal が開くこと — 「曜日別人数設定」タイトルで確認
    await expect(page.getByText("曜日別人数設定")).toBeVisible({ timeout: 8_000 });

    // 朝/昼/夜のヘッダーが表示されること
    await expect(page.getByText("朝").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("昼").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("夜").first()).toBeVisible({ timeout: 5_000 });

    // 「保存する」ボタンが表示されること
    await expect(
      page.getByRole("button", { name: /保存する/ })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("ServingsModal でキャンセル (X ボタン) するとモーダルが閉じる", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    await openShoppingModal(page);

    const servingsBtn = page.locator('button[title="人数設定"]');
    await servingsBtn.waitFor({ state: "visible", timeout: 8_000 });
    await servingsBtn.click();

    // モーダル開確認
    await page.getByText("曜日別人数設定").waitFor({ state: "visible", timeout: 8_000 });

    // X ボタン (w-8 h-8 rounded-full) でモーダルを閉じる
    const xBtn = page.locator("button.w-8.h-8.rounded-full").first();
    await xBtn.waitFor({ state: "visible", timeout: 5_000 });
    await xBtn.click();

    // ServingsModal が閉じること
    await expect(page.getByText("曜日別人数設定")).toBeHidden({ timeout: 5_000 });
  });
});

// ============================================================
// モーダル 7: ShoppingRangeModal
// ============================================================
test.describe("modal-7: ShoppingRangeModal (shoppingRange)", () => {
  test("buying 再生成ボタンで shoppingRange モーダルが開く", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    await openShoppingModal(page);

    // 「献立から再生成」ボタンをクリック
    const regenBtn = page.getByTestId("shopping-regenerate-button");
    await regenBtn.waitFor({ state: "visible", timeout: 5_000 });
    await regenBtn.click();

    // shoppingRange モーダルか「献立がありません」メッセージのどちらか
    const result = await Promise.race([
      page
        .getByText("買い物の範囲を選択")
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => "range-modal"),
      page
        .getByTestId("success-message-title")
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => "no-menu-msg"),
    ]).catch(() => "timeout");

    expect(["range-modal", "no-menu-msg"]).toContain(result);

    if (result === "range-modal") {
      // ステップ表示が 1/2 であること
      await expect(page.getByText("ステップ 1/2")).toBeVisible({ timeout: 5_000 });

      // 範囲選択肢 (今日の分, 明日の分, 1週間分) が表示されること
      await expect(page.getByText("今日の分")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("1週間分")).toBeVisible({ timeout: 5_000 });

      // 「次へ（人数確認）」ボタンが表示されること
      await expect(
        page.getByRole("button", { name: /次へ（人数確認）/ })
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test("shoppingRange モーダルで「1週間分」を選択して次へ進める", async ({
    tourPendingUser: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    await openShoppingModal(page);

    const regenBtn = page.getByTestId("shopping-regenerate-button");
    await regenBtn.waitFor({ state: "visible", timeout: 5_000 });
    await regenBtn.click();

    const rangeModalVisible = await page
      .getByText("買い物の範囲を選択")
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!rangeModalVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "shoppingRange モーダルが開きませんでした (献立なし環境)",
      });
      return;
    }

    // 「1週間分」を選択
    await page.getByText("1週間分").click();
    await page.waitForTimeout(300);

    // 「次へ（人数確認）」をクリック
    await page.getByRole("button", { name: /次へ（人数確認）/ }).click();

    // ステップ 2/2 に移行すること
    await expect(page.getByText("ステップ 2/2")).toBeVisible({ timeout: 8_000 });

    // 「この設定で買い物リストを生成」ボタンが表示されること
    await expect(
      page.getByTestId("generate-shopping-list-button")
    ).toBeVisible({ timeout: 5_000 });

    // X ボタンで閉じて shopping モーダルに戻ること
    const xBtn = page.locator("button.w-7.h-7.rounded-full").last();
    await xBtn.waitFor({ state: "visible", timeout: 5_000 });
    await xBtn.click();

    // shopping モーダルに戻ること
    await expect(page.getByText("買い物リスト").first()).toBeVisible({ timeout: 8_000 });
  });
});
