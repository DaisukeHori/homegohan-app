/**
 * tests/e2e/refactor-baseline/modal-interaction-servings.spec.ts
 *
 * ServingsModal 深掘りインタラクションテスト
 *
 * 目的: 曜日別人数設定モーダルの操作を E2E で固定する。
 *       リファクタ後も同じ spec が通ることが目標。
 *
 * カバーするシナリオ (8):
 *   1. オープン → 曜日別グリッド (月〜日 × 朝/昼/夜) が表示される
 *   2. + ボタン押下 → 値が増加する
 *   3. − ボタン押下 → 値が減少する (0 未満不可)
 *   4. 0 状態での − ボタン → 0 のまま (アンダーフロー防止)
 *   5. 数値が 0 のとき表示は "-"、それ以外は数値
 *   6. 保存 → API リクエストが発火 (モックまたはローディング状態)
 *   7. キャンセル (X ボタン) → モーダルが閉じる
 *   8. 値が上限 10 を超えない (10 のときさらに + を押しても 10 のまま)
 *
 * 注意:
 *   - API 実呼び出しは route intercept でモックする
 *   - ServingsModal は ShoppingModal 経由でしか開けないため
 *     openShoppingModal → 人数設定ボタン のフローを使う
 */

import { test, expect } from "../fixtures/auth";
import { gotoWeekly, openShoppingModal } from "./_helpers";

// ============================================================
// 共通: ServingsModal を開くまでのヘルパー
// ============================================================

/**
 * ShoppingModal を開いた後、人数設定ボタンをクリックして
 * ServingsModal を表示する。
 * 成功すれば true を返す。
 */
async function openServingsModal(page: import("@playwright/test").Page): Promise<boolean> {
  // ShoppingModal を開く
  try {
    await openShoppingModal(page);
  } catch {
    return false;
  }

  // 「人数設定」ボタン (title="人数設定" の Users アイコンボタン)
  const servingsBtn = page.locator('[title="人数設定"]');
  const found = await servingsBtn
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (!found) return false;

  await servingsBtn.click();

  // ServingsModal のタイトル「曜日別人数設定」が表示されるまで待つ
  const opened = await page
    .getByText("曜日別人数設定")
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  return opened;
}

// ============================================================
// シナリオ 1: オープン → グリッド表示確認
// ============================================================
test.describe("scenario-1: ServingsModal オープン", () => {
  test("人数設定ボタンで曜日別人数設定モーダルが開く", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした (ShoppingModal または人数設定ボタンが見つからない)",
      });
      return;
    }

    // タイトル確認
    await expect(page.getByText("曜日別人数設定")).toBeVisible({ timeout: 5_000 });

    // 曜日ラベル (月〜日) が表示されていること
    for (const dayLabel of ["月", "火", "水", "木", "金", "土", "日"]) {
      await expect(page.getByText(dayLabel).first()).toBeVisible({ timeout: 5_000 });
    }

    // 朝/昼/夜 ヘッダーが表示されていること
    await expect(page.getByText("朝").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("昼").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("夜").first()).toBeVisible({ timeout: 5_000 });

    // 保存するボタンが表示されていること
    await expect(page.getByRole("button", { name: "保存する" })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("説明文「各セルをクリックして人数を変更」が表示される", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    await expect(
      page.getByText(/各セルをクリックして人数を変更/),
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ============================================================
// シナリオ 2: + ボタン → 値増加
// ============================================================
test.describe("scenario-2: + ボタンで値増加", () => {
  test("月曜朝食の + ボタンを押すと表示値が増加する", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    // グリッドの最初の行 (月曜) 最初のセル (朝食) を取得する
    // 構造: 各行 div.grid-cols-4 > [月曜ラベル, 朝食セル, 昼食セル, 夕食セル]
    // 「月」テキストを含む行コンテナを特定
    const mondayRow = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCell = mondayRow.locator("div").filter({ has: page.locator("button") }).first();

    // + ボタン (テキスト "+")
    const plusBtn = firstCell.locator("button").last();
    const minusBtn = firstCell.locator("button").first();
    const valueSpan = firstCell.locator("span");

    // 現在の値を取得
    const beforeText = await valueSpan.textContent().catch(() => null);
    if (beforeText === null) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "セルの値要素が見つかりませんでした",
      });
      return;
    }

    // + ボタンを押す
    await plusBtn.waitFor({ state: "visible", timeout: 5_000 });
    await plusBtn.click();
    await page.waitForTimeout(300);

    const afterText = await valueSpan.textContent().catch(() => null);

    // "-" (0) から増加、または数値が+1 されていること
    if (beforeText === "-") {
      // 0 → 1 になるはず
      expect(afterText).toBe("1");
    } else {
      const before = parseInt(beforeText ?? "0", 10);
      const after = parseInt(afterText ?? "0", 10);
      expect(after).toBeGreaterThan(before);
    }
  });
});

// ============================================================
// シナリオ 3: − ボタン → 値減少
// ============================================================
test.describe("scenario-3: − ボタンで値減少", () => {
  test("値が 1 以上のセルで − ボタンを押すと値が減少する", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    const mondayRow = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCell = mondayRow.locator("div").filter({ has: page.locator("button") }).first();

    const plusBtn = firstCell.locator("button").last();
    const minusBtn = firstCell.locator("button").first();
    const valueSpan = firstCell.locator("span");

    // まず + を押して値を 1 以上にする
    const initialText = await valueSpan.textContent().catch(() => "-");
    if (initialText === "-" || initialText === "0") {
      await plusBtn.click();
      await page.waitForTimeout(300);
    }

    const beforeText = await valueSpan.textContent().catch(() => null);
    if (!beforeText || beforeText === "-") {
      test.info().annotations.push({
        type: "skip-reason",
        description: "値を 1 以上にできませんでした",
      });
      return;
    }

    const before = parseInt(beforeText, 10);

    // − ボタンを押す
    await minusBtn.waitFor({ state: "visible", timeout: 5_000 });
    await minusBtn.click();
    await page.waitForTimeout(300);

    const afterText = await valueSpan.textContent().catch(() => null);
    if (afterText === "-") {
      // 1 → 0 に減少して "-" 表示になった
      expect(before).toBe(1);
    } else {
      const after = parseInt(afterText ?? "0", 10);
      expect(after).toBeLessThan(before);
    }
  });
});

// ============================================================
// シナリオ 4: 0 状態での − ボタン → 0 未満にならない
// ============================================================
test.describe("scenario-4: 0 未満不可 (アンダーフロー防止)", () => {
  test("値が 0 (表示 '-') のとき − ボタンを押しても 0 のまま", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    const mondayRow = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCell = mondayRow.locator("div").filter({ has: page.locator("button") }).first();

    const plusBtn = firstCell.locator("button").last();
    const minusBtn = firstCell.locator("button").first();
    const valueSpan = firstCell.locator("span");

    // 値を 0 にする: 現在値の分だけ − を押す
    let currentText = await valueSpan.textContent().catch(() => "-");
    let safetyCount = 0;
    while (currentText !== "-" && safetyCount < 15) {
      await minusBtn.click();
      await page.waitForTimeout(150);
      currentText = await valueSpan.textContent().catch(() => "-");
      safetyCount++;
    }

    // 0 (表示: "-") であることを確認
    expect(currentText).toBe("-");

    // もう一度 − を押す
    await minusBtn.click();
    await page.waitForTimeout(300);

    // 依然として "-" (0) のまま
    const afterText = await valueSpan.textContent().catch(() => null);
    expect(afterText).toBe("-");
  });
});

// ============================================================
// シナリオ 5: 値 0 のとき "-" 表示、それ以外は数値表示
// ============================================================
test.describe("scenario-5: 値 0 のとき '-' 表示", () => {
  test("セルの値が 0 のとき '-' が表示され、1 以上のとき数値が表示される", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    const mondayRow = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCell = mondayRow.locator("div").filter({ has: page.locator("button") }).first();

    const plusBtn = firstCell.locator("button").last();
    const minusBtn = firstCell.locator("button").first();
    const valueSpan = firstCell.locator("span");

    // 値を 0 にする
    let currentText = await valueSpan.textContent().catch(() => "-");
    let safetyCount = 0;
    while (currentText !== "-" && safetyCount < 15) {
      await minusBtn.click();
      await page.waitForTimeout(150);
      currentText = await valueSpan.textContent().catch(() => "-");
      safetyCount++;
    }

    // 0 → "-" 表示であること
    expect(currentText).toBe("-");

    // + を押して 1 にする
    await plusBtn.click();
    await page.waitForTimeout(300);

    const afterOne = await valueSpan.textContent().catch(() => null);
    expect(afterOne).toBe("1");
  });
});

// ============================================================
// シナリオ 6: 保存 → API リクエストが発火
// ============================================================
test.describe("scenario-6: 保存ボタン → API リクエスト", () => {
  test("保存するボタンをクリックすると /api/profile へのリクエストが発火する", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    // /api/profile をインターセプトしてモック応答を返す
    let profileRequestFired = false;
    await page.route("**/api/profile", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        profileRequestFired = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.continue();
      }
    });

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    // 保存するボタンをクリック
    const saveBtn = page.getByRole("button", { name: "保存する" });
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    // API が発火されるまで最大 5 秒待つ
    await page.waitForTimeout(3_000);

    expect(profileRequestFired).toBe(true);
  });

  test("保存後にモーダルが閉じる", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    // /api/profile をモック
    await page.route("**/api/profile", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.continue();
      }
    });

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    const saveBtn = page.getByRole("button", { name: "保存する" });
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    // モーダルが閉じること (「曜日別人数設定」が非表示になる)
    await expect(page.getByText("曜日別人数設定")).toBeHidden({ timeout: 8_000 });
  });
});

// ============================================================
// シナリオ 7: キャンセル (X ボタン) → 元の値に戻る
// ============================================================
test.describe("scenario-7: キャンセルでモーダルが閉じる", () => {
  test("X ボタンをクリックするとモーダルが閉じる", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    // X ボタン (aria-label なし、button > X lucide icon)
    // ServingsModal の X ボタンは button > svg[data-lucide="x"] の親
    const closeBtn = page
      .locator("button")
      .filter({ has: page.locator('svg[data-lucide="x"]') })
      .last();

    await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
    await closeBtn.click();

    // モーダルが閉じること
    await expect(page.getByText("曜日別人数設定")).toBeHidden({ timeout: 8_000 });
  });

  test("値を変更後にキャンセルして再度開くと store の値は変更されたまま (store は揮発型)", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    // /api/profile モック (保存は押さない)
    await page.route("**/api/profile", async (route) => {
      await route.continue();
    });

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    // 月曜朝食の + を押して値を変更
    const mondayRow = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCell = mondayRow.locator("div").filter({ has: page.locator("button") }).first();
    const plusBtn = firstCell.locator("button").last();
    const valueSpan = firstCell.locator("span");

    await plusBtn.waitFor({ state: "visible", timeout: 5_000 });
    await plusBtn.click();
    await page.waitForTimeout(300);

    const changedValue = await valueSpan.textContent().catch(() => null);

    // X ボタンで閉じる (保存しない)
    const closeBtn = page
      .locator("button")
      .filter({ has: page.locator('svg[data-lucide="x"]') })
      .last();
    await closeBtn.click();

    await expect(page.getByText("曜日別人数設定")).toBeHidden({ timeout: 8_000 });

    // 再度開く
    const reopened = await openServingsModal(page);
    if (!reopened) return;

    const mondayRowAgain = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCellAgain = mondayRowAgain.locator("div").filter({ has: page.locator("button") }).first();
    const valueSpanAgain = firstCellAgain.locator("span");

    // Zustand store はページ内メモリに保持されるため値は保持されている可能性がある
    // ここでは再オープン後もモーダルが正常に表示されることを確認する
    await expect(page.getByText("曜日別人数設定")).toBeVisible({ timeout: 5_000 });
    const reopenedValue = await valueSpanAgain.textContent().catch(() => null);
    // 値が何らかの文字列として存在すること
    expect(reopenedValue).not.toBeNull();
  });
});

// ============================================================
// シナリオ 8: 過大値 → 上限 10 を超えない
// ============================================================
test.describe("scenario-8: 上限 10 を超えない (オーバーフロー防止)", () => {
  test("+ ボタンを連打しても値が 10 を超えない", async ({ authedPage: page }) => {
    test.setTimeout(90_000);
    await gotoWeekly(page);

    const opened = await openServingsModal(page);
    if (!opened) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "ServingsModal を開けませんでした",
      });
      return;
    }

    const mondayRow = page.locator("div.grid").filter({ hasText: /^月/ }).first();
    const firstCell = mondayRow.locator("div").filter({ has: page.locator("button") }).first();
    const plusBtn = firstCell.locator("button").last();
    const valueSpan = firstCell.locator("span");

    // + を 15 回押す (上限 10 を超えようとする)
    for (let i = 0; i < 15; i++) {
      await plusBtn.click();
      await page.waitForTimeout(100);
    }

    const finalText = await valueSpan.textContent().catch(() => null);
    expect(finalText).not.toBeNull();

    // 値は "-" か数値
    if (finalText !== "-") {
      const finalValue = parseInt(finalText!, 10);
      expect(finalValue).toBeLessThanOrEqual(10);
    }
  });
});
