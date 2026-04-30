/**
 * Bug-91: 献立データなしで「この設定で買い物リストを生成」押下 → API 未呼出でサイレント失敗
 *
 * 修正内容:
 *   1. 「献立から再生成」ボタン押下時に currentPlan が空なら即座にエラーメッセージを表示
 *   2. regenerateShoppingList 内で選択した日付範囲にも献立データがなければエラーを表示
 *   3. silent fail なし: API を呼ばずにエラーが visible になること
 *
 * テスト戦略:
 *   翌週ボタンを複数回クリックして未来の週（確実に献立データなし）に移動してから
 *   「献立から再生成」を押す。
 */
import { test, expect } from "./fixtures/auth";

/**
 * 買い物リスト「献立から再生成」ボタン (data-testid="shopping-regenerate-button") が
 * 表示されるまで、買い物リストモーダルを開く。
 */
async function openShoppingModal(page: import("@playwright/test").Page) {
  const cartBtn = page.getByRole("button", { name: "買い物リストを開く" });
  await cartBtn.waitFor({ state: "visible", timeout: 10_000 });
  await cartBtn.click();
  await page.waitForTimeout(500);
}

test.describe("Bug-91: 買い物リスト生成 — 献立なし時のエラー表示", () => {
  /**
   * 未来の週（献立データなし）に移動して「献立から再生成」を押下すると、
   * API を呼ばずに「献立がありません」エラーダイアログが表示されること。
   */
  test("献立なし週で「献立から再生成」押下 → API 未呼出 + エラーダイアログ表示", async ({
    authedPage: page,
  }) => {
    const shoppingRegenerateApiCalls: string[] = [];

    page.on("request", (req) => {
      if (
        req.url().includes("/api/shopping-list/regenerate") &&
        req.method() === "POST"
      ) {
        shoppingRegenerateApiCalls.push(req.url());
      }
    });

    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle", { timeout: 30_000 });

    // 翌週ボタンを4回押して未来の週へ移動（4週後 = 確実に献立なし）
    const nextWeekBtn = page.getByRole("button", { name: "翌週" });
    await nextWeekBtn.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < 4; i++) {
      await nextWeekBtn.click();
      await page.waitForTimeout(400);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // 買い物リストモーダルを開く
    await openShoppingModal(page);

    // 「献立から再生成」ボタンをクリック
    const regenBtn = page.locator('[data-testid="shopping-regenerate-button"]');
    await regenBtn.waitFor({ state: "visible", timeout: 10_000 });
    await regenBtn.click();

    // API は呼ばれないこと（献立なし状態）
    await page.waitForTimeout(1500);
    expect(
      shoppingRegenerateApiCalls,
      "献立なし状態では /api/shopping-list/regenerate を呼んではいけない",
    ).toHaveLength(0);

    // エラーダイアログが visible になること
    const title = page.locator('[data-testid="success-message-title"]');
    await expect(title).toBeVisible({ timeout: 5_000 });
    const titleText = await title.textContent();
    expect(titleText, "エラータイトルに「献立」が含まれること").toMatch(/献立/);

    // ダイアログ本文に「先に献立を生成」が含まれること
    const body = page.locator('[data-testid="success-message-body"]');
    await expect(body).toBeVisible({ timeout: 3_000 });
    const bodyText = await body.textContent();
    expect(bodyText, "エラー本文に案内文が含まれること").toMatch(
      /先に献立を生成/,
    );
  });

  /**
   * 献立なし週で「この設定で買い物リストを生成」ボタンまで進んでも
   * API を呼ばずにエラーダイアログが表示されること（二重保護の確認）。
   *
   * 「献立から再生成」クリック後のパスは2通り:
   *   - hasAnyMealsThisWeek=false → 即エラーダイアログ (Test 1 でカバー)
   *   - 万が一モーダルが開いた場合 → 「この設定で生成」でもエラーになること
   * このテストではどちらのパスも受け付ける。
   */
  test("献立なし週でモーダル経由「この設定で買い物リストを生成」→ API 未呼出 + エラーダイアログ", async ({
    authedPage: page,
  }) => {
    const shoppingRegenerateApiCalls: string[] = [];

    page.on("request", (req) => {
      if (
        req.url().includes("/api/shopping-list/regenerate") &&
        req.method() === "POST"
      ) {
        shoppingRegenerateApiCalls.push(req.url());
      }
    });

    await page.goto("/menus/weekly");
    await page.waitForLoadState("networkidle", { timeout: 30_000 });

    // 翌週ボタンを4回押して未来の週へ移動（4週後 = 確実に献立なし）
    const nextWeekBtn = page.getByRole("button", { name: "翌週" });
    await nextWeekBtn.waitFor({ state: "visible", timeout: 10_000 });
    for (let i = 0; i < 4; i++) {
      await nextWeekBtn.click();
      await page.waitForTimeout(400);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // 買い物リストモーダルを開く
    await openShoppingModal(page);

    // 「献立から再生成」ボタンをクリック
    const regenBtn = page.locator('[data-testid="shopping-regenerate-button"]');
    await regenBtn.waitFor({ state: "visible", timeout: 10_000 });
    await regenBtn.click();
    await page.waitForTimeout(500);

    // Case 1: エラーダイアログが即座に表示された場合（hasAnyMealsThisWeek=false）
    const immediateTitle = page.locator('[data-testid="success-message-title"]');
    const isImmediateError = await immediateTitle.isVisible().catch(() => false);

    if (isImmediateError) {
      const titleText = await immediateTitle.textContent();
      expect(titleText).toMatch(/献立/);
      const body = page.locator('[data-testid="success-message-body"]');
      const bodyText = await body.textContent();
      expect(bodyText).toMatch(/先に献立を生成/);
      expect(shoppingRegenerateApiCalls).toHaveLength(0);
      return; // 修正が正しく機能している
    }

    // Case 2: モーダルが開いた場合は「次へ」→「この設定で買い物リストを生成」まで進む
    const rangeModal = page.locator('text=買い物の範囲を選択').first();
    await expect(rangeModal).toBeVisible({ timeout: 5_000 });

    // 「明日の分」を選択して次へ
    const tomorrowBtn = page.locator('button').filter({ hasText: '明日の分' }).first();
    await tomorrowBtn.click();
    await page.waitForTimeout(300);
    const nextBtn = page.locator('button').filter({ hasText: '次へ' }).first();
    await nextBtn.click();
    await page.waitForTimeout(500);

    // 「この設定で買い物リストを生成」をクリック
    const generateBtn = page.locator('[data-testid="generate-shopping-list-button"]');
    await generateBtn.waitFor({ state: "visible", timeout: 5_000 });
    await generateBtn.click();
    await page.waitForTimeout(2000);

    // API は呼ばれないこと
    expect(
      shoppingRegenerateApiCalls,
      "献立なし範囲では /api/shopping-list/regenerate を呼んではいけない",
    ).toHaveLength(0);

    // エラーダイアログが表示されること
    const title = page.locator('[data-testid="success-message-title"]');
    await expect(title).toBeVisible({ timeout: 5_000 });
    const titleText = await title.textContent();
    expect(titleText).toMatch(/献立/);

    const body = page.locator('[data-testid="success-message-body"]');
    const bodyText = await body.textContent();
    expect(bodyText).toMatch(/先に献立を生成/);
  });
});
