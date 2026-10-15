/**
 * tests/e2e/tour/03-step1-photo.spec.ts
 *
 * Step 1: 写真追加。intro → カメラ → 解析中 → 結果 → [次へ] → [保存] → Step 2 遷移
 *
 * testID (実装済み):
 *   tour-step-1-intro, meal-camera-button, meal-analyzing-view, meal-result-screen,
 *   meal-result-dish-name, meal-save-button, tour-next-button
 *
 * Step 1 は、写真の撮影・AI 解析をせず、サンドボックスの固定値 (MOCK_PHOTO_RESPONSE) で自動進行する。
 * 利用者の操作は結果の [次へ] と [保存] だけ。ただし meal-save-button などの Spotlight 対象の上には
 * オーバーレイがかぶさっていて直接は押せないため、吹き出しの tour-next-button で進める (helpers の completeStep1)。
 *
 * 注意: API モック禁止。実 Supabase に接続する。Step 1 だけを見るテストは、Step 0 を通らず /handson-tour/photo を直接開く
 * (Step 0 → Step 1 の遷移は 02-step0-welcome が確かめる)。
 */

import {
  AUTO_ADVANCE_TIMEOUT_MS,
  EMPTY_STORAGE_STATE,
  completeStep1,
  describeBody,
  expect,
  insertRow,
  selectRows,
  test,
} from "./helpers";

test.use({ storageState: EMPTY_STORAGE_STATE });

const HTTP_OK = 200;

/** 保存の前後の時刻と、サーバーが入れた食べた時刻を比べるときの許容 (同じ機械の時計。ミリ秒の丸めの分だけ見る) */
const CLOCK_SKEW_TOLERANCE_MS = 1_000;

/** 前の日にお試しの記録をした時刻 (中断して別の日にやり直す場合の模擬) */
const PREVIOUS_DAY_EATEN_AT = "2020-01-01T12:00:00.000Z";

/** intro (1.1) が自動でカメラの段階 (1.2) へ進むのを待つ上限 (intro は 2.5 秒) */
const INTRO_TO_CAMERA_TIMEOUT_MS = 10_000;

test.describe("Tour - Step 1: 写真追加", () => {
  test("Step 1 intro 吹き出しが表示される (tour-step-1-intro)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    await expect(page.getByTestId("tour-step-1-intro")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    // 吹き出し (tour-bubble) の中に、intro の文言が入っている
    await expect(page.getByTestId("tour-step-1-intro").getByTestId("tour-bubble-body")).not.toBeEmpty();
  });

  test("Step 1: meal-camera-button が Spotlight ターゲットとして表示される", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    // intro (1.1) とカメラの Spotlight (1.2) の間、カメラボタンは画面にある。解析中 (1.3) からは消える
    await expect(page.getByTestId("meal-camera-button")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    // intro が終わるとカメラの吹き出し (1.2) に切り替わる (intro の目印は外れ、吹き出しは出たまま)
    await expect(page.getByTestId("tour-step-1-intro")).toBeHidden({ timeout: INTRO_TO_CAMERA_TIMEOUT_MS });
    await expect(page.getByTestId("tour-bubble")).toBeVisible();
  });

  test("Step 1: 結果を確認して [保存] → Step 2 へ遷移 (meal-save-button は Spotlight の対象)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    // 結果 → [次へ] → 保存ボタンの Spotlight → [保存] → /handson-tour/menu
    await completeStep1(page);

    // Step 2 の intro 吹き出しが出る
    await expect(page.getByTestId("tour-step-2-intro")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  });

  // #1604: 以前はツアーが送る本文に mealType が無く、API が 400 (mealType の検証) を返していた (#846 の E2E で発見)。
  // 設計書 03-step1 §3.7 の決めどおり、保存した今の夕食として、お試しの記録が meals に 1 行 (is_sandbox = true) 入る。
  // 本物の記録の日 (user_daily_meals) は作らない (同じ日の本物の記録がお試しの日にぶら下がらないように)
  test("Step 1: 保存の API (POST /api/meal-plans/add-from-photo) が成功し、夕食のお試しの記録 (meals.is_sandbox = true) が 1 行入る", async ({
    page,
    tourUser,
  }) => {
    await page.goto("/handson-tour/photo");

    const before = Date.now();
    const saved = await completeStep1(page);
    const after = Date.now();

    expect(saved.status, describeBody(saved.body)).toBe(HTTP_OK);
    const sandboxMeals = await selectRows<{ meal_type: string; memo: string | null; eaten_at: string }>(
      "meals",
      `user_id=eq.${tourUser.id}&is_sandbox=eq.true&select=meal_type,memo,eaten_at`,
    );
    expect(sandboxMeals).toHaveLength(1);
    expect(sandboxMeals[0]).toMatchObject({ meal_type: "dinner", memo: "鶏の唐揚げ定食" });
    // 食べた時刻はサーバーの保存した今 (ブラウザとサーバーは同じ機械の時計)
    const eatenAt = Date.parse(sandboxMeals[0].eaten_at);
    expect(eatenAt).toBeGreaterThanOrEqual(before - CLOCK_SKEW_TOLERANCE_MS);
    expect(eatenAt).toBeLessThanOrEqual(after + CLOCK_SKEW_TOLERANCE_MS);

    const days = await selectRows("user_daily_meals", `user_id=eq.${tourUser.id}&select=id`);
    expect(days).toEqual([]);
  });

  // 中断した利用者は Step 0 から再開する (設計書 01-trigger-flow §7.3 / §7.4)。前の日のお試しの記録が残っていても保存は成功し、
  // 行は増えない。以前は uniq_user_sandbox_daily_meal の一意違反で 500 になり、エラー画面から先へ進めなかった (#1604)
  test("Step 1: 前の日のお試しの記録が残っていても、やり直しの保存は成功し、お試しの記録は 1 行のまま", async ({ page, tourUser }) => {
    await insertRow("meals", {
      user_id: tourUser.id,
      eaten_at: PREVIOUS_DAY_EATEN_AT,
      meal_type: "lunch",
      is_sandbox: true,
    });
    await page.goto("/handson-tour/photo");

    const saved = await completeStep1(page);

    expect(saved.status, describeBody(saved.body)).toBe(HTTP_OK);
    const sandboxMeals = await selectRows<{ meal_type: string; eaten_at: string }>(
      "meals",
      `user_id=eq.${tourUser.id}&is_sandbox=eq.true&select=meal_type,eaten_at`,
    );
    expect(sandboxMeals).toHaveLength(1);
    expect(sandboxMeals[0].meal_type).toBe("dinner");
    expect(Date.parse(sandboxMeals[0].eaten_at)).toBeGreaterThan(Date.parse(PREVIOUS_DAY_EATEN_AT));
    await expect(page.getByTestId("tour-step-2-intro")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  });

  test("Step 1: meal-result-dish-name が表示される (サンドボックス固定値)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    // 解析中 (meal-analyzing-view。1.5 秒だけ出る) を経て結果が出る。短い間の画面なので、フレームごとに見る waitFor で待つ
    await page.getByTestId("meal-analyzing-view").waitFor({ state: "visible", timeout: AUTO_ADVANCE_TIMEOUT_MS });
    const dishName = page.getByTestId("meal-result-dish-name");
    await expect(dishName).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });

    // 固定の料理名 (packages/handson-tour-shared の MOCK_PHOTO_RESPONSE.dishName)
    await expect(dishName).toContainText("鶏の唐揚げ定食");
    await expect(page.getByTestId("meal-result-screen")).toBeVisible();
  });
});
