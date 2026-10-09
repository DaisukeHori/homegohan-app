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

import { test, expect, completeStep1, selectRows } from "./helpers";

test.describe("Tour - Step 1: 写真追加", () => {
  test.setTimeout(60_000);

  test("Step 1 intro 吹き出しが表示される (tour-step-1-intro)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    await expect(page.getByTestId("tour-step-1-intro")).toBeVisible({ timeout: 20_000 });
    // 吹き出し (tour-bubble) の中に、intro の文言が入っている
    await expect(page.getByTestId("tour-step-1-intro").getByTestId("tour-bubble-body")).not.toBeEmpty();
  });

  test("Step 1: meal-camera-button が Spotlight ターゲットとして表示される", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    // intro (1.1) とカメラの Spotlight (1.2) の間、カメラボタンは画面にある。解析中 (1.3) からは消える
    await expect(page.getByTestId("meal-camera-button")).toBeVisible({ timeout: 20_000 });
    // intro が終わるとカメラの吹き出し (1.2) に切り替わる
    await expect(page.getByTestId("tour-step-1-intro")).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("tour-bubble")).toBeVisible();
  });

  test("Step 1: 結果を確認して [保存] → Step 2 へ遷移 (meal-save-button は Spotlight の対象)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    // 結果 → [次へ] → 保存ボタンの Spotlight → [保存] → /handson-tour/menu
    await completeStep1(page);

    // Step 2 の intro 吹き出しが出る
    await expect(page.getByTestId("tour-step-2-intro")).toBeVisible({ timeout: 20_000 });
  });

  // 既知の不具合 (#846 の E2E で見つけた)。直したら .fixme を外す。
  test.fixme(
    "Step 1: 保存の API (POST /api/meal-plans/add-from-photo) が成功し、お試しの記録 (is_sandbox = true) が DB に入る",
    {
      annotation: {
        type: "fixme",
        description:
          "ツアーが送る本文 (MOCK_PHOTO_RESPONSE) に dayDate と mealType が無く、API が 400 (mealType を指定してください) を返す。" +
          "画面は失敗を無視して Step 2 へ進むので、利用者には見えない。" +
          "お試しの記録を何として残すか (日付・食事の区分・カレンダーに出すか) は製品判断が要る。",
      },
    },
    async ({ page, tourUser }) => {
      await page.goto("/handson-tour/photo");

      const saved = await completeStep1(page);

      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const sandboxDays = await selectRows(
        "user_daily_meals",
        `user_id=eq.${tourUser.id}&is_sandbox=eq.true&select=id`,
      );
      expect(sandboxDays).toHaveLength(1);
    },
  );

  test("Step 1: meal-result-dish-name が表示される (サンドボックス固定値)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/photo");

    // 解析中 (meal-analyzing-view。1.5 秒だけ出る) を経て結果が出る。短い間の画面なので、フレームごとに見る waitFor で待つ
    await page.getByTestId("meal-analyzing-view").waitFor({ state: "visible", timeout: 20_000 });
    const dishName = page.getByTestId("meal-result-dish-name");
    await expect(dishName).toBeVisible({ timeout: 20_000 });

    // 固定の料理名 (packages/handson-tour-shared の MOCK_PHOTO_RESPONSE.dishName。v1 では変更しない値)
    await expect(dishName).toContainText("鶏の唐揚げ定食");
    await expect(page.getByTestId("meal-result-screen")).toBeVisible();
  });
});
