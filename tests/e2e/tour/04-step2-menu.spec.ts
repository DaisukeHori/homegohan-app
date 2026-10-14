/**
 * tests/e2e/tour/04-step2-menu.spec.ts
 *
 * Step 2: 献立生成。intro → 条件フラグ → 自由メモ → [生成する] → 結果 → [次へ] → [献立に追加] → Step 3 遷移
 *
 * testID (実装済み):
 *   tour-step-2-intro, v4-no-cook-toggle, v4-note-textarea, v4-generate-button,
 *   v4-result-card, v4-result-dish-name, v4-add-to-menu-button, tour-next-button
 *
 * Step 2 の「生成」はサンドボックスの固定値 (MOCK_MENU_RESPONSE) を 2 秒のローディングのあとに出すだけで、
 * AI の API は呼ばない。環境 (AI のキーなど) に左右されない。
 * Spotlight 対象の上にはオーバーレイがかぶさっていて直接は押せないため、吹き出しの tour-next-button で進める (helpers の completeStep2)。
 *
 * 注意: API モック禁止。実 Supabase に接続する (読み込み中の画面を確かめるテストだけ、/api/badges の応答を遅らせる。中身は本物のまま)。
 * Step 2 だけを見るテストは、前の Step を通らず /handson-tour/menu を直接開く (Step 1 → Step 2 の遷移は 03-step1-photo が確かめる)。
 */

import {
  AUTO_ADVANCE_TIMEOUT_MS,
  EMPTY_STORAGE_STATE,
  clickNextAndWaitForNextBubble,
  completeStep2,
  delayBadgesApi,
  describeBody,
  expect,
  hasBadge,
  nextButton,
  test,
} from "./helpers";

test.use({ storageState: EMPTY_STORAGE_STATE });

const HTTP_OK = 200;

test.describe("Tour - Step 2: AI 献立生成", () => {
  test("Step 2 intro 吹き出しが表示される (tour-step-2-intro)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/menu");

    await expect(page.getByTestId("tour-step-2-intro")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-2-intro").getByTestId("tour-bubble-body")).not.toBeEmpty();
  });

  test("Step 2: v4-no-cook-toggle が表示される", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/menu");

    // 「調理しなくていい」がチェック済みで出る (Spotlight の対象は intro のあと)
    const toggle = page.getByTestId("v4-no-cook-toggle");
    await expect(toggle).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("Step 2: v4-generate-button → v4-result-card 表示", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/menu");

    // intro (自動) → 条件フラグ → 自由メモ → 生成ボタン
    await expect(page.getByTestId("v4-no-cook-toggle")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await clickNextAndWaitForNextBubble(page, "次へ");
    await expect(page.getByTestId("v4-note-textarea")).toBeVisible();
    await clickNextAndWaitForNextBubble(page, "次へ");
    await expect(page.getByTestId("v4-generate-button")).toBeVisible();

    // [生成する] → ローディング (自動 2 秒) → 結果カード
    await nextButton(page, "生成する").click();
    await expect(page.getByTestId("v4-result-card")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });

    // 固定の献立 (packages/handson-tour-shared の MOCK_MENU_RESPONSE.dish_name)
    await expect(page.getByTestId("v4-result-dish-name")).toContainText("豚肉と野菜の生姜焼き");
  });

  test("Step 2: v4-add-to-menu-button → Step 3 遷移 (planner バッジが付く)", async ({ page, tourUser }) => {
    // バッジを読み込む間の画面 (tour-step-3-loading) は、速いと一瞬で消えて見えないので、応答だけ遅らせる
    await delayBadgesApi(page);
    await page.goto("/handson-tour/menu");

    const saved = await completeStep2(page);

    // Step 3: バッジを読み込む間の画面が出る (遅らせた応答が返るまでの間だけなので、先に確かめる)
    await expect(page.getByTestId("tour-step-3-loading")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });

    // 追加の API (POST /api/menu-plans/add) が成功し、planner バッジが付く
    expect(saved.status, describeBody(saved.body)).toBe(HTTP_OK);
    expect(saved.body).toMatchObject({ success: true, badge_awarded: { code: "planner" } });
    expect(await hasBadge(tourUser.id, "planner")).toBe(true);
  });
});
