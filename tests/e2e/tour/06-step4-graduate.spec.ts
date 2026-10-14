/**
 * tests/e2e/tour/06-step4-graduate.spec.ts
 *
 * Step 4: 卒業画面。完了処理 (saving) → 卒業画面 (tutorial_complete バッジ・disclaimer) → 「ホームへ」→ /home 遷移
 *
 * testID (実装済み):
 *   tour-step-4-saving, tour-step-4-graduate, tour-step-4-go-home,
 *   tour-step-4-error, tour-step-4-retry, tour-step-4-badge-disclaimer (PR #834 で追加済)
 *
 * 卒業画面は開いた瞬間に POST /api/handson-tour/complete (RPC complete_handson_tour) を呼び、
 * ツアー完了日時と tutorial_complete バッジを DB に記録する。
 *
 * 注意: API モック禁止。実 Supabase に接続する。Step 4 だけを見るテストは、前の Step を通らず /handson-tour/graduate を直接開く。
 * Step 0 から卒業までを 1 本で通すのは「tour-step-4-go-home タップ → /home へ遷移」だけ。
 * 例外: 完了の通信が失敗したときの画面 (tour-step-4-error / tour-step-4-retry) は、本物の API を失敗させる手段が無いため、
 * そのテストだけ complete API の最初の 1 回を 500 に差し替える (2 回目以降は本物の API に通す)。
 */

import {
  AUTO_ADVANCE_TIMEOUT_MS,
  EMPTY_STORAGE_STATE,
  NAVIGATION_TIMEOUT_MS,
  completeStep1,
  completeStep2,
  completeStep3,
  expect,
  hasBadge,
  openTour,
  readTourProfile,
  startTour,
  test,
} from "./helpers";

test.use({ storageState: EMPTY_STORAGE_STATE });

/** 「ホームへ」が押せるようになるまでの待ち (仕様: 卒業画面を出してから 5 秒後に活性化) に余裕を足した上限 */
const GO_HOME_ENABLED_TIMEOUT_MS = 10_000;

/** Step 0 から卒業までを通しで進めるテストの上限 (各 Step の自動進行 + 画面遷移で 25〜35 秒前後。既定の 60 秒では足りないことがある) */
const FULL_TOUR_TEST_TIMEOUT_MS = 120_000;

/** 完了の通信を失敗させるテストで返すステータス (サーバーの内部エラー) */
const HTTP_INTERNAL_SERVER_ERROR = 500;

test.describe("Tour - Step 4: 卒業画面", () => {
  test("Step 4: tour-step-4-saving → tour-step-4-graduate が表示される", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/graduate");

    // 完了処理中 (saving) か完了後 (graduate)。処理は速いので saving は一瞬のことがある
    await expect(page.getByTestId("tour-step-4-saving").or(page.getByTestId("tour-step-4-graduate"))).toBeVisible({
      timeout: AUTO_ADVANCE_TIMEOUT_MS,
    });

    // 完了処理後に卒業画面が表示される
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-4-saving")).toHaveCount(0);

    // 完了が DB に記録され、tutorial_complete バッジが付く
    const profile = await readTourProfile(tourUser.id);
    expect(profile.handson_tour_completed_at).not.toBeNull();
    expect(await hasBadge(tourUser.id, "tutorial_complete")).toBe(true);
  });

  test("Step 4: tour-step-4-badge-disclaimer が表示される (PR #834 追加済)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/graduate");

    // 卒業画面表示
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });

    // disclaimer が表示される (PR #834 で追加済)。バッジは課金・特典に連動しない、という注意書き
    const disclaimer = page.getByTestId("tour-step-4-badge-disclaimer");
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText("課金");
  });

  test("Step 4: tour-step-4-go-home タップ → /home へ遷移 (Step 0 から通しで)", async ({ page, tourUser }) => {
    test.setTimeout(FULL_TOUR_TEST_TIMEOUT_MS);

    await openTour(page);
    await startTour(page);
    await completeStep1(page);
    await completeStep2(page);
    await completeStep3(page);

    // 卒業画面表示を確認
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });

    // 「ホームへ」ボタンが有効化されるまで待機 (仕様: 5 秒後に活性化)
    await expect(page.getByTestId("tour-step-4-go-home")).toBeEnabled({ timeout: GO_HOME_ENABLED_TIMEOUT_MS });

    // 「ホームへ」をクリック → /home に遷移
    await page.getByTestId("tour-step-4-go-home").click();
    await page.waitForURL("**/home", { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "commit" });
    expect(new URL(page.url()).pathname).toBe("/home");

    // ツアーを最後まで終えたので、完了が記録され、tutorial_complete バッジが付いている (スキップではない)
    const profile = await readTourProfile(tourUser.id);
    expect(profile.handson_tour_completed_at).not.toBeNull();
    expect(profile.handson_tour_skipped_at).toBeNull();
    expect(await hasBadge(tourUser.id, "tutorial_complete")).toBe(true);
  });

  test("Step 4: 完了の通信が成功したときは、エラー画面 (tour-step-4-error / tour-step-4-retry) を出さない", async ({
    page,
    tourUser,
  }) => {
    await page.goto("/handson-tour/graduate");

    // 卒業画面 (成功パス) が出る
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });

    // 成功時は、エラー画面も [もう一度] も出ない
    await expect(page.getByTestId("tour-step-4-error")).toHaveCount(0);
    await expect(page.getByTestId("tour-step-4-retry")).toHaveCount(0);
  });

  test("Step 4: 完了の通信が失敗すると tour-step-4-error と tour-step-4-retry が出て、[もう一度] で卒業画面へ進める", async ({
    page,
    tourUser,
  }) => {
    // 最初の 1 回だけ 500 にする。2 回目 ([もう一度]) からは本物の API に通す
    let completeCalls = 0;
    await page.route("**/api/handson-tour/complete", async (route) => {
      completeCalls += 1;
      if (completeCalls === 1) {
        await route.fulfill({
          status: HTTP_INTERNAL_SERVER_ERROR,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal_error", message: "サーバーエラーが発生しました" } }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/handson-tour/graduate");

    // エラー画面と [もう一度] が出て、卒業画面は出ない
    await expect(page.getByTestId("tour-step-4-error")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-4-retry")).toBeVisible();
    await expect(page.getByTestId("tour-step-4-graduate")).toHaveCount(0);

    // [もう一度] を押すと、今度は本物の API が成功して卒業画面になる
    await page.getByTestId("tour-step-4-retry").click();
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-4-error")).toHaveCount(0);
    expect(completeCalls).toBe(2);
    expect(await hasBadge(tourUser.id, "tutorial_complete")).toBe(true);
  });
});
