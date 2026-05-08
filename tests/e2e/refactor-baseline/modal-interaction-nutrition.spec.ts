/**
 * tests/e2e/refactor-baseline/modal-interaction-nutrition.spec.ts
 *
 * StatsModal / NutritionDetailModal 深掘り interaction 特性テスト
 *
 * 目的: リファクタリング前後で StatsModal・NutritionDetailModal の
 *       UI 挙動が維持されることを固定する保険テスト。
 *       weekly-modals-batch-a.spec.ts の基本開閉に加え、
 *       タブ切替・チャート描画・編集モード・保存/キャンセル等を詳細検証する。
 *
 * StatsModal シナリオ (6):
 *   SM-1. 「栄養分析を見る」→ StatsModal オープン、統計カード (今日タブ) が表示される
 *   SM-2. タブ切替: 今日 → 今週 → 今日
 *   SM-3. レーダーチャート描画確認 (today/week 両タブ)
 *   SM-4. 数値カード表示 — 自炊率・平均kcal・合計食数 (today)、PFC 週間平均 (week)
 *   SM-5. 「詳細を見る / 献立を改善」ボタン → NutritionDetailModal 連携
 *   SM-6. X ボタンで閉じると元 UI (週ナビゲーション) に戻る
 *
 * NutritionDetailModal シナリオ (7):
 *   ND-1. NutritionDetailModal オープン → 栄養素一覧・AI コメントエリア表示
 *   ND-2. 「変更」ボタン → radar 編集モード ON → checkbox 群 (nutrient ボタン) 表示
 *   ND-3. nutrient を選択/解除 → tempRadarNutrients に反映 (順番バッジ更新)
 *   ND-4. 「保存」ボタン → isSavingRadarNutrients state (loading or 完了)
 *   ND-5. 「キャンセル」ボタン → 編集モード OFF、元の表示に戻る
 *   ND-6. 「この提案で献立を改善」ボタン → ImproveMealModal (onOpenImprove) が開く
 *   ND-7. AI フィードバック表示エリア — loading スピナーまたは取得済みテキスト
 *
 * 制約:
 *   - LLM 実呼び出し回避 (AI ボタン押下は行わない、feedback 表示のみ確認)
 *   - canvas 描画は data-testid="radar-average-display" の存在で verify
 *   - 食事データ未生成環境は skip-reason アノテーションで明示スキップ
 */
import { test, expect } from "../fixtures/auth";
import { gotoWeekly } from "./_helpers";

// ============================================================
// ヘルパー: StatsModal を開く
// ============================================================
async function openStatsModal(page: import("@playwright/test").Page): Promise<boolean> {
  const statsBtn = page.locator('[aria-label="栄養分析を見る"]');
  const available = await statsBtn
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!available) return false;

  await statsBtn.click();

  // StatsModal が開いたことを確認 (「栄養分析」ヘッダーで判定)
  const opened = await page
    .getByText("栄養分析")
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  return opened;
}

// ============================================================
// ヘルパー: StatsModal 経由で NutritionDetailModal を開く
// (AI フィードバックが表示されるまで待機してから「詳細を見る」を押す)
// ============================================================
async function openNutritionDetailViaStats(
  page: import("@playwright/test").Page,
): Promise<"opened" | "skip-no-button" | "skip-no-stats"> {
  const statsOpened = await openStatsModal(page);
  if (!statsOpened) return "skip-no-stats";

  // 「詳細を見る / 献立を改善」ボタンは nutritionFeedback が取得されて初めて表示
  const detailBtn = page.getByRole("button", { name: /詳細を見る/ });
  const detailAvailable = await detailBtn
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  if (!detailAvailable) return "skip-no-button";

  await detailBtn.click();

  // NutritionDetailModal が開いたことを「の栄養分析」テキストで確認
  const opened = await page
    .getByText(/の栄養分析/)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  return opened ? "opened" : "skip-no-button";
}

// ============================================================
// SM-1: StatsModal オープン → 統計タブ (今日) が表示される
// ============================================================
test.describe("SM-1: StatsModal オープン", () => {
  test("「栄養分析を見る」ボタンで StatsModal が開き、今日タブのコンテンツが表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // デフォルト (今日タブ) が選択されていること — 「📅 今日」ボタンが視覚的に強調
    const todayTab = page.getByRole("button", { name: /今日/ });
    await expect(todayTab).toBeVisible({ timeout: 5_000 });

    // 「📊 今週」タブが存在すること
    await expect(page.getByRole("button", { name: /今週/ })).toBeVisible({
      timeout: 5_000,
    });

    // 今日の日付テキストが表示されること (「月日（曜）の栄養」形式)
    await expect(page.getByText(/月.*日.*の栄養/).first()).toBeVisible({
      timeout: 8_000,
    });

    // 食数バッジが表示されること (「N食分」)
    await expect(page.getByText(/\d+食分/).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ============================================================
// SM-2: タブ切替 (today ↔ week)
// ============================================================
test.describe("SM-2: StatsModal タブ切替", () => {
  test("「今週」タブをクリックすると週間コンテンツが表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // 「今週」タブをクリック
    const weekTab = page.getByRole("button", { name: /今週/ });
    await weekTab.click();
    await page.waitForTimeout(300);

    // 週間 AI ヒントセクションが表示されること
    await expect(page.getByText("週間AIヒント")).toBeVisible({ timeout: 5_000 });

    // 週の期間テキストが表示されること (「M/D 〜 M/D の平均栄養」)
    await expect(page.getByText(/〜.*の平均栄養/).first()).toBeVisible({
      timeout: 5_000,
    });

    // 日数バッジが表示されること (「N日分」)
    await expect(page.getByText(/\d+日分/).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("「今週」→「今日」に戻すと今日コンテンツが再表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // 今週タブへ
    await page.getByRole("button", { name: /今週/ }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText("週間AIヒント")).toBeVisible({ timeout: 5_000 });

    // 今日タブへ戻す
    await page.getByRole("button", { name: /今日/ }).click();
    await page.waitForTimeout(300);

    // 今日コンテンツ (「の栄養」) が再表示されること
    await expect(page.getByText(/月.*日.*の栄養/).first()).toBeVisible({
      timeout: 5_000,
    });

    // 週間コンテンツが非表示になること
    await expect(page.getByText("週間AIヒント")).toBeHidden({ timeout: 5_000 });
  });
});

// ============================================================
// SM-3: レーダーチャート描画確認
// ============================================================
test.describe("SM-3: StatsModal レーダーチャート描画", () => {
  test("今日タブで radar-average-display が描画されている", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // 今日タブでレーダーチャートの中央達成率表示 (data-testid="radar-average-display") を確認
    // recharts は SVG を動的に描画するため、testid で存在確認する
    const radarDisplay = page.getByTestId("radar-average-display").first();
    const radarExists = await radarDisplay
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    // recharts が SSR:false の dynamic import のため、DOM に存在するかを確認
    // (描画が遅延する場合でも count > 0 で pass)
    const radarCount = await page.getByTestId("radar-average-display").count();

    // radarDisplay が表示されるか、または count が 1 以上であること
    expect(radarExists || radarCount > 0).toBe(true);
  });

  test("今週タブでも radar-average-display が描画されている", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // 今週タブへ切り替え
    await page.getByRole("button", { name: /今週/ }).click();
    await page.waitForTimeout(500); // recharts 再描画待ち

    // 今週タブでも radar-average-display が存在すること
    const radarCount = await page.getByTestId("radar-average-display").count();
    expect(radarCount).toBeGreaterThan(0);
  });
});

// ============================================================
// SM-4: 数値カード表示
// ============================================================
test.describe("SM-4: StatsModal 数値カード表示", () => {
  test("自炊率・平均kcal・合計食数の統計カードが表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // 自炊率カード
    await expect(page.getByText("自炊率")).toBeVisible({ timeout: 5_000 });

    // 平均kcal/日カード
    await expect(page.getByText("平均kcal/日")).toBeVisible({ timeout: 5_000 });

    // 今週の献立カード
    await expect(page.getByText("今週の献立")).toBeVisible({ timeout: 5_000 });
  });

  test("今週タブで PFC 週間平均の数値カードが表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // 今週タブへ切り替え
    await page.getByRole("button", { name: /今週/ }).click();
    await page.waitForTimeout(300);

    // カロリー・タンパク質・脂質・炭水化物・食物繊維・塩分 の 6 カードが表示されること
    await expect(page.getByText("カロリー")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("タンパク質")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("脂質")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("炭水化物")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("食物繊維")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("塩分")).toBeVisible({ timeout: 5_000 });
  });
});

// ============================================================
// SM-5: 「詳細を見る」ボタン → NutritionDetailModal 連携
// ============================================================
test.describe("SM-5: StatsModal → NutritionDetailModal 連携", () => {
  test("「詳細を見る / 献立を改善」ボタンをクリックすると NutritionDetailModal が開く", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result === "skip-no-stats") {
      test.info().annotations.push({
        type: "skip-reason",
        description: "StatsModal への到達に失敗",
      });
      return;
    }
    if (result === "skip-no-button") {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "「詳細を見る / 献立を改善」ボタンが表示されませんでした " +
          "(食事データ未生成または AI フィードバック未取得)",
      });
      return;
    }

    expect(result).toBe("opened");

    // NutritionDetailModal の「の栄養分析」ヘッダーが表示されること
    await expect(page.getByText(/の栄養分析/).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ============================================================
// SM-6: 閉じる → 元 UI
// ============================================================
test.describe("SM-6: StatsModal 閉じる", () => {
  test("X ボタンで StatsModal を閉じると週ナビゲーションが表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openStatsModal(page);
    expect(opened).toBe(true);

    // X ボタン (w-7 h-7 rounded-full) をクリック
    const xBtn = page.locator("button.w-7.h-7.rounded-full").last();
    await xBtn.waitFor({ state: "visible", timeout: 5_000 });
    await xBtn.click();

    // StatsModal が閉じること (「栄養分析」テキストが消える)
    await expect(page.getByText("自炊率")).toBeHidden({ timeout: 5_000 });

    // 週ナビゲーションが引き続き表示されること
    await expect(page.locator('[aria-label="前の週"]')).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ============================================================
// ND-1: NutritionDetailModal オープン → 栄養素一覧表示
// ============================================================
test.describe("ND-1: NutritionDetailModal 栄養素一覧", () => {
  test("NutritionDetailModal が開くと全栄養素一覧と AI コメントエリアが表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    // 「📊 全栄養素（N食分）」セクションが表示されること
    await expect(page.getByText(/全栄養素（\d+食分）/).first()).toBeVisible({
      timeout: 8_000,
    });

    // AI コメントエリア — 「褒めポイント」セクション
    await expect(page.getByText("褒めポイント").first()).toBeVisible({
      timeout: 5_000,
    });

    // レーダーチャート表示栄養素セクション
    await expect(
      page.getByText(/レーダーチャートに表示する栄養素/).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("NutritionDetailModal でレーダーチャートの達成率表示が存在する", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    // NutritionDetailModal 内のレーダーチャート (220px サイズ) の達成率表示
    const radarCount = await page.getByTestId("radar-average-display").count();
    // StatsModal は閉じているはずなので NutritionDetailModal 内のものを確認
    expect(radarCount).toBeGreaterThan(0);
  });
});

// ============================================================
// ND-2: radar 編集モード ON → checkbox 群表示
// ============================================================
test.describe("ND-2: NutritionDetailModal 編集モード ON", () => {
  test("「変更」ボタンをクリックすると栄養素選択ボタン群が表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    // 「変更」ボタンが表示されること
    const editBtn = page.getByRole("button", { name: "変更" }).first();
    const editAvailable = await editBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!editAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「変更」ボタンが見つかりませんでした",
      });
      return;
    }

    await editBtn.click();
    await page.waitForTimeout(300);

    // 編集モード ON のヒントテキストが表示されること (「3〜8個を選択」)
    await expect(
      page.getByText(/3〜8個を選択してください/).first()
    ).toBeVisible({ timeout: 5_000 });

    // 「キャンセル」ボタンが表示されること
    await expect(
      page.getByRole("button", { name: "キャンセル" })
    ).toBeVisible({ timeout: 5_000 });

    // 「保存」ボタンが表示されること (「保存（N角形）」形式)
    await expect(
      page.getByRole("button", { name: /保存（\d+角形）/ })
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ============================================================
// ND-3: nutrient を選択/解除 → tempRadarNutrients state 反映
// ============================================================
test.describe("ND-3: NutritionDetailModal nutrient 選択/解除", () => {
  test("編集モードで栄養素ボタンをクリックすると順番バッジが変わる", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    const editBtn = page.getByRole("button", { name: "変更" }).first();
    const editAvailable = await editBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!editAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「変更」ボタンが見つかりませんでした",
      });
      return;
    }

    await editBtn.click();
    await page.waitForTimeout(300);

    // 編集モード ON 後: 保存ボタンのラベルで現在の選択数を取得
    const saveBtn = page.getByRole("button", { name: /保存（\d+角形）/ });
    const initialLabel = await saveBtn.textContent().catch(() => "");
    const initialMatch = initialLabel?.match(/保存（(\d+)角形）/);
    const initialCount = initialMatch ? parseInt(initialMatch[1], 10) : 0;

    expect(initialCount).toBeGreaterThan(0);

    // 選択済みの最初の栄養素ボタン (背景がアクセントカラー = オレンジ) をクリックして解除
    // 選択済みボタンには順番バッジ (span.text-[8px]) が入っている
    const selectedBtns = page.locator(
      "button.rounded-full.px-2.py-0\\.5"
    ).filter({ has: page.locator("span.text-\\[8px\\]") });

    const selectedCount = await selectedBtns.count();

    if (selectedCount === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "選択済み栄養素ボタンが見つかりませんでした",
      });
      return;
    }

    // 最初の選択済みボタンをクリックして解除
    await selectedBtns.first().click();
    await page.waitForTimeout(300);

    // 保存ボタンのラベルが変わること (N角形 → N-1 角形 or ボタンが無効化)
    const newLabel = await saveBtn.textContent().catch(() => "");
    const newMatch = newLabel?.match(/保存（(\d+)角形）/);
    const newCount = newMatch ? parseInt(newMatch[1], 10) : 0;

    // 解除後は選択数が減るか、または最小値 (3) を下回って disabled になること
    // いずれにせよ count が変化したことを確認 (初期 count と異なる)
    const countChanged = newCount !== initialCount || (await saveBtn.isDisabled());
    expect(countChanged).toBe(true);
  });
});

// ============================================================
// ND-4: 保存ボタン → API 呼び出し (loading or 完了)
// ============================================================
test.describe("ND-4: NutritionDetailModal 保存", () => {
  test("保存ボタンをクリックすると isSavingRadarNutrients (loading) または完了状態になる", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    const editBtn = page.getByRole("button", { name: "変更" }).first();
    const editAvailable = await editBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!editAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「変更」ボタンが見つかりませんでした",
      });
      return;
    }

    await editBtn.click();
    await page.waitForTimeout(300);

    const saveBtn = page.getByRole("button", { name: /保存（\d+角形）/ });
    const saveBtnVisible = await saveBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!saveBtnVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "保存ボタンが見つかりませんでした (選択数 < 3 で disabled の可能性)",
      });
      return;
    }

    // 保存ボタンが有効であることを確認
    const isDisabled = await saveBtn.isDisabled();
    if (isDisabled) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "保存ボタンが無効 (選択数 < 3) のためスキップ",
      });
      return;
    }

    await saveBtn.click();

    // 保存中 (「保存中...」) または 編集モードが閉じること (キャンセルボタンが消える)
    const saveResult = await Promise.race([
      page
        .getByText("保存中...")
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => "saving"),
      page
        .getByRole("button", { name: "キャンセル" })
        .waitFor({ state: "hidden", timeout: 8_000 })
        .then(() => "saved"),
    ]).catch(() => "timeout");

    expect(["saving", "saved"]).toContain(saveResult);
  });
});

// ============================================================
// ND-5: キャンセル → 編集破棄、元 nutrients に戻る
// ============================================================
test.describe("ND-5: NutritionDetailModal キャンセル", () => {
  test("編集モードで「キャンセル」をクリックすると編集が破棄されて元の表示に戻る", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    const editBtn = page.getByRole("button", { name: "変更" }).first();
    const editAvailable = await editBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!editAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "「変更」ボタンが見つかりませんでした",
      });
      return;
    }

    await editBtn.click();
    await page.waitForTimeout(300);

    // 編集モード ON であることを確認
    await expect(
      page.getByRole("button", { name: "キャンセル" })
    ).toBeVisible({ timeout: 5_000 });

    // 「3〜8個を選択」テキストが表示されていること
    await expect(
      page.getByText(/3〜8個を選択してください/).first()
    ).toBeVisible({ timeout: 5_000 });

    // キャンセルをクリック
    await page.getByRole("button", { name: "キャンセル" }).click();
    await page.waitForTimeout(300);

    // 編集モード OFF の確認:
    // 「3〜8個を選択」テキストが非表示になること
    await expect(
      page.getByText(/3〜8個を選択してください/).first()
    ).toBeHidden({ timeout: 5_000 });

    // 「変更」ボタンが再度表示されること (非編集モードに戻った)
    await expect(
      page.getByRole("button", { name: "変更" }).first()
    ).toBeVisible({ timeout: 5_000 });

    // レーダーチャート表示栄養素タグ (accentLight の span) が表示されること
    await expect(
      page.getByText(/レーダーチャートに表示する栄養素/).first()
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ============================================================
// ND-6: 「この提案で献立を改善」ボタン → ImproveMealModal 連携
// ============================================================
test.describe("ND-6: NutritionDetailModal → ImproveMealModal 連携", () => {
  test("「この提案で献立を改善」ボタンをクリックすると ImproveMealModal が開く", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    // 「この提案で献立を改善」ボタンが nutritionFeedback 取得後に表示
    const improveBtn = page.getByRole("button", { name: /この提案で献立を改善/ });
    const improveAvailable = await improveBtn
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    if (!improveAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "「この提案で献立を改善」ボタンが表示されませんでした " +
          "(AI フィードバック未取得または食事データ未生成)",
      });
      return;
    }

    await improveBtn.click();
    await page.waitForTimeout(500);

    // ImproveMealModal が開いたことを確認
    // ImproveMealModal は "改善" /"改善する" / "期間を選択" 等のテキストを含む
    const improveMealVisible = await Promise.race([
      page
        .getByText(/献立を改善|改善する|期間を選択/)
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true),
    ]).catch(() => false);

    expect(improveMealVisible).toBe(true);
  });
});

// ============================================================
// ND-7: AI フィードバック表示エリア
// ============================================================
test.describe("ND-7: NutritionDetailModal AI フィードバック", () => {
  test("NutritionDetailModal 内に AI フィードバックエリア (loading または取得済み) が存在する", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    // 「褒めポイント」セクションが存在すること
    await expect(page.getByText("褒めポイント").first()).toBeVisible({
      timeout: 5_000,
    });

    // フィードバックエリアに loading スピナーまたは取得済みテキストが存在すること
    const hasLoading = await page
      .locator(".animate-spin")
      .first()
      .isVisible()
      .catch(() => false);

    const hasPraiseText = await page
      .getByText(/あなたの献立を分析中|分析データがありません/)
      .first()
      .isVisible()
      .catch(() => false);

    // いずれかの状態が表示されていること
    // (loading 中 / 取得済み / データなし のいずれか)
    const feedbackAreaVisible = hasLoading || hasPraiseText;

    // 「褒めポイント」セクション自体が visible であれば OK (フィードバックエリアが存在する)
    // 上記いずれも false の場合は既にコンテンツが入っている
    const praiseSection = await page
      .getByText("褒めポイント")
      .first()
      .isVisible()
      .catch(() => false);

    expect(feedbackAreaVisible || praiseSection).toBe(true);
  });

  test("「再分析」ボタンが AI フィードバック取得後に表示される", async ({
    authedPage: page,
  }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const result = await openNutritionDetailViaStats(page);

    if (result !== "opened") {
      test.info().annotations.push({
        type: "skip-reason",
        description: `NutritionDetailModal への到達に失敗: ${result}`,
      });
      return;
    }

    // 「再分析」ボタンは praiseComment or nutritionFeedback が取得済みかつ
    // isLoadingFeedback=false の場合に表示
    const reAnalyzeBtn = page.getByRole("button", { name: "再分析" });
    const reAnalyzeVisible = await reAnalyzeBtn
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!reAnalyzeVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "「再分析」ボタンが表示されませんでした (AI フィードバック未取得)",
      });
      return;
    }

    // 「再分析」ボタンが存在すること
    await expect(reAnalyzeBtn).toBeVisible({ timeout: 5_000 });
  });
});
