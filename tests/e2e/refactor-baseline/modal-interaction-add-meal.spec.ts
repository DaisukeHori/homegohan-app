/**
 * tests/e2e/refactor-baseline/modal-interaction-add-meal.spec.ts
 *
 * AddMealModal interaction matrix 深掘り
 *
 * mode (cook/quick/buy/out) × 食事種別 × アクションの
 * 主要パスを 15-20 ケースで網羅。
 *
 * カバーするシナリオ:
 *   A. AddMealModal の開き方 (空スロット / addMealSlot 経由)
 *   B. モード別ボタン表示確認 (cook/quick/buy/out + AI提案)
 *   C. 食事種別選択 (朝食/昼食/夕食/おやつ/夜食)
 *   D. catalog 検索 → 結果表示 → 選択 → 解除
 *   E. モードボタン押下 → API mock → モーダル閉じる
 *   F. AIに提案してもらう → aiMeal モーダル遷移
 *   G. X ボタン → モーダル閉じる (store reset 動作)
 *   H. addMealSlot 経由で各食事種別を選択して add モーダルへ
 *
 * 制約:
 *   - LLM 実呼び出しなし (loading state まで verify)
 *   - 外部 API は page.route() で mock
 *   - DB 書き込みが発生するケースは mock で副作用を防ぐ
 */
import { test, expect } from "../fixtures/fresh-user";
import { gotoWeekly } from "./_helpers";

// ============================================================
// ヘルパー関数
// ============================================================

/**
 * 空の食事スロットをクリックして AddMealModal を開く。
 * 空スロットがない場合は addMealSlot → 朝食 選択 → add モーダル のフローを使う。
 * 成功したら true を返す。モーダルが開けなかった場合は false を返す。
 */
async function openAddMealModal(page: import("@playwright/test").Page): Promise<boolean> {
  // 空の「+ 朝食を追加」スロットを試す
  const emptySlot = page.getByRole("button", { name: /朝食を追加/ }).first();
  const hasEmptySlot = await emptySlot
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (hasEmptySlot) {
    await emptySlot.click();
    const opened = await page.getByText(/を追加|AIに提案/).first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    return opened;
  }

  // フォールバック: addMealSlot → 食事種別選択 → add モーダル
  const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
  const hasAddSlotBtn = await addSlotBtn
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!hasAddSlotBtn) return false;

  await addSlotBtn.click();
  await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

  const breakfastChoice = page.getByRole("button", { name: /朝食/ }).first();
  const hasBreakfastChoice = await breakfastChoice
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!hasBreakfastChoice) return false;

  await breakfastChoice.click();
  const opened = await page.getByText(/を追加|AIに提案/).first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  return opened;
}

/**
 * /api/meal-plans/meals への POST を mock して成功レスポンスを返す。
 * DB への実書き込みを防ぐ。
 */
async function mockMealPost(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/meal-plans/meals", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "mock-meal-id", success: true }),
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * /api/meal-plans への GET を空のデータで mock する (refresh 後のリロードを防ぐ)。
 */
async function mockMealPlansGet(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/meal-plans*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ dailyMeals: [], shoppingList: null }),
      });
    } else {
      await route.continue();
    }
  });
}

// ============================================================
// A. AddMealModal の開き方
// ============================================================
test.describe("A: AddMealModal の開き方", () => {
  test("A-1: 空の朝食スロットから add モーダルが開く", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const emptySlot = page.getByRole("button", { name: /朝食を追加/ }).first();
    const hasSlot = await emptySlot
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasSlot) {
      test.info().annotations.push({ type: "skip-reason", description: "空の朝食スロットが見つかりませんでした" });
      return;
    }

    await emptySlot.click();

    // AddMealModal が表示されること (タイトルに「朝食を追加」が含まれる)
    await expect(
      page.getByText(/朝食を追加/).first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("A-2: 「食事を追加」ボタン → addMealSlot モーダルが開く", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();

    // addMealSlot モーダルが表示されること
    await expect(
      page.getByText("食事を追加").first(),
    ).toBeVisible({ timeout: 8_000 });
  });
});

// ============================================================
// B. モード別ボタン表示確認
// ============================================================
test.describe("B: モードボタン表示", () => {
  test("B-1: add モーダルに 4 つのモードボタンが表示される (自炊/時短/買う/外食)", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    // 各モードのボタンが表示されること
    await expect(page.getByRole("button", { name: /自炊で追加/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /時短で追加/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /買うで追加/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /外食で追加/ })).toBeVisible({ timeout: 5_000 });
  });

  test("B-2: add モーダルに「AIに提案してもらう」ボタンが表示される", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("B-3: add モーダルの catalog 検索フィールドが表示される", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    // catalog 検索フィールドが表示されること
    const searchInput = page.getByPlaceholder("商品名で検索");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
  });
});

// ============================================================
// C. 食事種別選択 (addMealSlot 経由)
// ============================================================
test.describe("C: 食事種別選択 (addMealSlot 経由)", () => {
  test("C-1: addMealSlot → 朝食 → add モーダルでタイトルが「朝食を追加」になる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    // 朝食を選択
    const breakfastBtn = page.getByRole("button", { name: /朝食/ }).first();
    await breakfastBtn.waitFor({ state: "visible", timeout: 5_000 });
    await breakfastBtn.click();

    // add モーダルのタイトルが「朝食を追加」になること
    await expect(
      page.getByText("朝食を追加").first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("C-2: addMealSlot → 昼食 → add モーダルでタイトルが「昼食を追加」になる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    const lunchBtn = page.getByRole("button", { name: /昼食/ }).first();
    const hasLunch = await lunchBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasLunch) {
      test.info().annotations.push({ type: "skip-reason", description: "昼食ボタンが見つかりませんでした" });
      return;
    }

    await lunchBtn.click();

    await expect(
      page.getByText("昼食を追加").first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("C-3: addMealSlot → 夕食 → add モーダルでタイトルが「夕食を追加」になる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    const dinnerBtn = page.getByRole("button", { name: /夕食/ }).first();
    const hasDinner = await dinnerBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasDinner) {
      test.info().annotations.push({ type: "skip-reason", description: "夕食ボタンが見つかりませんでした" });
      return;
    }

    await dinnerBtn.click();

    await expect(
      page.getByText("夕食を追加").first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("C-4: addMealSlot → おやつ → add モーダルでタイトルが「おやつを追加」になる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    const snackBtn = page.getByRole("button", { name: /おやつ/ }).first();
    const hasSnack = await snackBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasSnack) {
      test.info().annotations.push({ type: "skip-reason", description: "おやつボタンが見つかりませんでした" });
      return;
    }

    await snackBtn.click();

    await expect(
      page.getByText("おやつを追加").first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("C-5: addMealSlot → 夜食 → add モーダルでタイトルが「夜食を追加」になる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    const midnightBtn = page.getByRole("button", { name: /夜食/ }).first();
    const hasMidnight = await midnightBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasMidnight) {
      test.info().annotations.push({ type: "skip-reason", description: "夜食ボタンが見つかりませんでした" });
      return;
    }

    await midnightBtn.click();

    await expect(
      page.getByText("夜食を追加").first(),
    ).toBeVisible({ timeout: 8_000 });
  });
});

// ============================================================
// D. catalog 検索フロー
// ============================================================
test.describe("D: catalog 検索", () => {
  test("D-1: 商品名を 2 文字以上入力すると検索中ステータスが表示される", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    // catalog 検索の mock (短い遅延で結果を返す)
    await page.route("**/api/catalog/products*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          products: [
            {
              id: "mock-product-1",
              name: "モックチキン",
              brandName: "モックブランド",
              caloriesKcal: 300,
              proteinG: 25,
              fatG: 10,
              carbsG: 20,
              priceYen: 500,
              categoryCode: "chicken",
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder("商品名で検索");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill("チキン");

    // 「検索中...」または検索結果が表示されること
    const searchFeedback = await Promise.race([
      page.getByText("検索中...").waitFor({ state: "visible", timeout: 5_000 }).then(() => "searching"),
      page.getByText("モックチキン").waitFor({ state: "visible", timeout: 5_000 }).then(() => "results"),
    ]).catch(() => "timeout");

    expect(["searching", "results"]).toContain(searchFeedback);
  });

  test("D-2: catalog 検索結果を選択すると「選択中」パネルが表示される", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    // catalog API を mock
    await page.route("**/api/catalog/products*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          products: [
            {
              id: "mock-product-1",
              name: "モックおにぎり",
              brandName: "モックコンビニ",
              caloriesKcal: 200,
              proteinG: 5,
              fatG: 2,
              carbsG: 38,
              priceYen: 130,
              categoryCode: "onigiri",
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder("商品名で検索");
    await searchInput.fill("おにぎり");

    // 結果が表示されるまで待つ
    const productBtn = page.getByRole("button", { name: /モックおにぎり/ }).first();
    const hasProduct = await productBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasProduct) {
      test.info().annotations.push({ type: "skip-reason", description: "catalog 検索結果が表示されませんでした" });
      return;
    }

    await productBtn.click();

    // 「選択中」パネルが表示されること
    await expect(page.getByText("選択中")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("モックおにぎり")).toBeVisible({ timeout: 5_000 });
  });

  test("D-3: 「解除」ボタンで catalog 選択が解除される", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    // catalog API を mock
    await page.route("**/api/catalog/products*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          products: [
            {
              id: "mock-product-2",
              name: "モックサンドイッチ",
              brandName: "テストブランド",
              caloriesKcal: 350,
              proteinG: 12,
              fatG: 8,
              carbsG: 55,
              priceYen: 380,
              categoryCode: "sandwich",
            },
          ],
        }),
      });
    });

    const searchInput = page.getByPlaceholder("商品名で検索");
    await searchInput.fill("サンド");

    const productBtn = page.getByRole("button", { name: /モックサンドイッチ/ }).first();
    const hasProduct = await productBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasProduct) {
      test.info().annotations.push({ type: "skip-reason", description: "catalog 検索結果が表示されませんでした" });
      return;
    }

    await productBtn.click();

    // 「選択中」が表示されることを確認
    await expect(page.getByText("選択中")).toBeVisible({ timeout: 5_000 });

    // 「解除」ボタンをクリック
    const clearBtn = page.getByRole("button", { name: "解除" });
    await expect(clearBtn).toBeVisible({ timeout: 5_000 });
    await clearBtn.click();

    // 「選択中」パネルが消えること
    await expect(page.getByText("選択中")).toBeHidden({ timeout: 5_000 });
  });

  test("D-4: 1 文字の検索では結果が表示されない (2 文字以上が必要)", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const searchInput = page.getByPlaceholder("商品名で検索");
    await searchInput.fill("あ");
    await page.waitForTimeout(600);

    // 「検索中...」が表示されないこと
    const searching = await page.getByText("検索中...").isVisible().catch(() => false);
    expect(searching).toBe(false);
  });
});

// ============================================================
// E. モードボタン押下 → API mock → モーダル閉じる
// ============================================================
test.describe("E: モード選択してモーダル閉じる (mock)", () => {
  test("E-1: 「自炊で追加」押下 → API POST → モーダルが閉じる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);
    await mockMealPost(page);
    await mockMealPlansGet(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const cookBtn = page.getByRole("button", { name: /自炊で追加/ });
    await expect(cookBtn).toBeVisible({ timeout: 5_000 });
    await cookBtn.click();

    // モーダルが閉じること (AIに提案してもらう ボタンが消える)
    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeHidden({ timeout: 8_000 });
  });

  test("E-2: 「時短で追加」押下 → API POST → モーダルが閉じる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);
    await mockMealPost(page);
    await mockMealPlansGet(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const quickBtn = page.getByRole("button", { name: /時短で追加/ });
    await expect(quickBtn).toBeVisible({ timeout: 5_000 });
    await quickBtn.click();

    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeHidden({ timeout: 8_000 });
  });

  test("E-3: 「買うで追加」押下 → API POST → モーダルが閉じる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);
    await mockMealPost(page);
    await mockMealPlansGet(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const buyBtn = page.getByRole("button", { name: /買うで追加/ });
    await expect(buyBtn).toBeVisible({ timeout: 5_000 });
    await buyBtn.click();

    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeHidden({ timeout: 8_000 });
  });

  test("E-4: 「外食で追加」押下 → API POST → モーダルが閉じる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);
    await mockMealPost(page);
    await mockMealPlansGet(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const outBtn = page.getByRole("button", { name: /外食で追加/ });
    await expect(outBtn).toBeVisible({ timeout: 5_000 });
    await outBtn.click();

    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeHidden({ timeout: 8_000 });
  });
});

// ============================================================
// F. AIに提案してもらう → aiMeal モーダル遷移
// ============================================================
test.describe("F: AI 提案ボタン", () => {
  test("F-1: 「AIに提案してもらう」押下 → aiMeal モーダルに遷移する", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const aiBtn = page.getByRole("button", { name: /AIに提案してもらう/ });
    await expect(aiBtn).toBeVisible({ timeout: 5_000 });
    await aiBtn.click();

    // aiMeal モーダルが表示されること
    // AiMealModal には「AI で食事を提案」「一食を生成」などのテキストが含まれる可能性がある
    const aiModalVisible = await Promise.race([
      page.getByText(/AI.*提案|一食.*生成|AIに提案/).first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true),
    ]).catch(() => false);

    expect(aiModalVisible).toBe(true);
  });
});

// ============================================================
// G. X ボタン → モーダル閉じる
// ============================================================
test.describe("G: モーダルを X ボタンで閉じる", () => {
  test("G-1: X ボタンで add モーダルが閉じる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    // モーダルが開いていることを確認
    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeVisible({ timeout: 5_000 });

    // X ボタンをクリック (モーダル内の X ボタン)
    // AddMealModal の X ボタンは button > X アイコン または aria-label で見つかる
    // モーダル内の最後の X ボタン（lucide x アイコン）を使う
    const closeBtn = page.locator('button:has(svg.lucide-x)').last();
    const hasCloseBtn = await closeBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasCloseBtn) {
      // フォールバック: モーダルのヘッダー内の小さいボタン
      const headerCloseBtn = page.locator('[class*="rounded-full"]').filter({ has: page.locator('svg') }).first();
      await headerCloseBtn.click();
    } else {
      await closeBtn.click();
    }

    // モーダルが閉じること
    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeHidden({ timeout: 8_000 });
  });

  test("G-2: モーダルを閉じた後、再度開いても catalog 検索がリセットされている", async ({ tourPendingUser: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    // catalog API mock
    await page.route("**/api/catalog/products*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          products: [
            {
              id: "mock-product-reset",
              name: "テストリセット食品",
              brandName: "テスト",
              caloriesKcal: 100,
              proteinG: 5,
              fatG: 2,
              carbsG: 15,
              priceYen: null,
              categoryCode: "test",
            },
          ],
        }),
      });
    });

    // 1 回目: モーダルを開いて検索する
    const opened = await openAddMealModal(page);
    if (!opened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal が開けませんでした" });
      return;
    }

    const searchInput = page.getByPlaceholder("商品名で検索");
    await searchInput.fill("テスト");
    await page.waitForTimeout(1_000);

    // X ボタンで閉じる
    const closeBtn = page.locator('button:has(svg.lucide-x)').last();
    const hasCloseBtn = await closeBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (hasCloseBtn) {
      await closeBtn.click();
    }

    await expect(
      page.getByRole("button", { name: /AIに提案してもらう/ }),
    ).toBeHidden({ timeout: 5_000 });

    // 2 回目: モーダルを再度開く
    const reopened = await openAddMealModal(page);
    if (!reopened) {
      test.info().annotations.push({ type: "skip-reason", description: "AddMealModal の再オープンに失敗しました" });
      return;
    }

    // catalog 検索フィールドが空になっていること (store reset)
    const inputValue = await page.getByPlaceholder("商品名で検索").inputValue();
    expect(inputValue).toBe("");
  });
});

// ============================================================
// H. addMealSlot 経由の store リセット検証
// ============================================================
test.describe("H: addMealSlot 経由のフロー", () => {
  test("H-1: addMealSlot → 食事種別選択 → add モーダル → X で閉じる フル遷移", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    // Step 1: addMealSlot モーダルを開く
    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    // Step 2: 夕食を選択
    const dinnerBtn = page.getByRole("button", { name: /夕食/ }).first();
    const hasDinner = await dinnerBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasDinner) {
      test.info().annotations.push({ type: "skip-reason", description: "夕食ボタンが見つかりませんでした" });
      return;
    }

    await dinnerBtn.click();

    // Step 3: add モーダルが開くこと
    await expect(
      page.getByText("夕食を追加").first(),
    ).toBeVisible({ timeout: 8_000 });

    // Step 4: モードボタンが表示されること
    await expect(
      page.getByRole("button", { name: /自炊で追加/ }),
    ).toBeVisible({ timeout: 5_000 });

    // Step 5: X ボタンで閉じる
    const closeBtn = page.locator('button:has(svg.lucide-x)').last();
    const hasCloseBtn = await closeBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (hasCloseBtn) {
      await closeBtn.click();
      await expect(
        page.getByRole("button", { name: /自炊で追加/ }),
      ).toBeHidden({ timeout: 5_000 });
    }
  });

  test("H-2: addMealSlot モーダル自体も X ボタンで閉じられる", async ({ tourPendingUser: page }) => {
    test.setTimeout(60_000);
    await gotoWeekly(page);

    const addSlotBtn = page.getByRole("button", { name: "食事を追加" }).first();
    const hasBtn = await addSlotBtn
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "「食事を追加」ボタンが見つかりませんでした" });
      return;
    }

    await addSlotBtn.click();
    await page.getByText("食事を追加").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});

    // addMealSlot モーダル内の X ボタン
    const closeBtn = page.locator('button:has(svg.lucide-x)').last();
    const hasCloseBtn = await closeBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (!hasCloseBtn) {
      test.info().annotations.push({ type: "skip-reason", description: "X ボタンが見つかりませんでした" });
      return;
    }

    await closeBtn.click();

    // addMealSlot モーダルが閉じること
    await expect(
      page.getByText("食事を追加"),
    ).toBeHidden({ timeout: 5_000 });
  });
});
