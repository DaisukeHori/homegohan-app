/**
 * tests/e2e/tour/04-step2-menu.spec.ts
 *
 * Step 2: 献立生成。intro → 条件フラグ → 自由メモ → [生成する] → 結果 → [次へ] → [献立に追加] → Step 3 遷移
 *
 * testID (実装済み):
 *   tour-step-2-intro, v4-no-cook-toggle, v4-note-textarea, v4-generate-button,
 *   v4-loading-spinner, v4-result-card, v4-add-to-menu-button, tour-next-button
 *
 * Step 2 の「生成」はサンドボックスの固定値 (MOCK_MENU_RESPONSE) を 2 秒のローディングのあとに出すだけで、
 * AI の API は呼ばない。環境 (AI のキーなど) に左右されない。
 * Spotlight 対象の上にはオーバーレイがかぶさっていて直接は押せないため、吹き出しの tour-next-button で進める (helpers の completeStep2)。
 *
 * 注意: API モック禁止。実 Supabase に接続する。Step 2 だけを見るテストは、前の Step を通らず /handson-tour/menu を直接開く
 * (Step 1 → Step 2 の遷移は 03-step1-photo が確かめる)。
 */

import { test, expect, completeStep2, clickNextAndWaitForNextBubble, delayBadgesApi, hasBadge, nextButton } from "./helpers";

test.describe("Tour - Step 2: AI 献立生成", () => {
  test.setTimeout(60_000);

  test("Step 2 intro 吹き出しが表示される (tour-step-2-intro)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/menu");

    await expect(page.getByTestId("tour-step-2-intro")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("tour-step-2-intro").getByTestId("tour-bubble-body")).not.toBeEmpty();
  });

  test("Step 2: v4-no-cook-toggle が表示される", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/menu");

    // 「調理しなくていい」がチェック済みで出る (Spotlight の対象は intro のあと)
    const toggle = page.getByTestId("v4-no-cook-toggle");
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("Step 2: v4-generate-button → v4-result-card 表示", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/menu");

    // intro (自動) → 条件フラグ → 自由メモ → 生成ボタン
    await expect(page.getByTestId("v4-no-cook-toggle")).toBeVisible({ timeout: 20_000 });
    await clickNextAndWaitForNextBubble(page, "次へ");
    await expect(page.getByTestId("v4-note-textarea")).toBeVisible();
    await clickNextAndWaitForNextBubble(page, "次へ");
    await expect(page.getByTestId("v4-generate-button")).toBeVisible();

    // [生成する] → ローディング (自動 2 秒) → 結果カード
    await nextButton(page, "生成する").click();
    const resultCard = page.getByTestId("v4-result-card");
    await expect(resultCard).toBeVisible({ timeout: 20_000 });

    // 固定の献立 (MOCK_MENU_RESPONSE.dish_name。v1 では変更しない値)
    await expect(page.getByTestId("v4-result-dish-name")).toContainText("豚肉と野菜の生姜焼き");
  });

  test("Step 2: v4-add-to-menu-button → Step 3 遷移", async ({ page, tourUser }) => {
    // バッジを読み込む間の画面 (tour-step-3-loading) は、速いと一瞬で消えて見えないので、応答だけ遅らせる
    await delayBadgesApi(page);
    await page.goto("/handson-tour/menu");

    const saved = await completeStep2(page);

    // Step 3: バッジを読み込む間の画面が出る (遅らせた応答が返るまでの間だけなので、先に確かめる)
    await expect(page.getByTestId("tour-step-3-loading")).toBeVisible({ timeout: 20_000 });

    // 追加の API (POST /api/menu-plans/add) が成功し、planner バッジが付く
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ success: true, badge_awarded: { code: "planner" } });
    expect(await hasBadge(tourUser.id, "planner")).toBe(true);
  });
});
