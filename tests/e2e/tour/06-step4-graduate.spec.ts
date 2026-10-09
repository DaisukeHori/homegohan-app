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
  test,
  expect,
  completeStep1,
  completeStep2,
  completeStep3,
  hasBadge,
  openTour,
  selectRows,
  startTour,
} from "./helpers";

test.describe("Tour - Step 4: 卒業画面", () => {
  test.setTimeout(60_000);

  test("Step 4: tour-step-4-saving → tour-step-4-graduate が表示される", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/graduate");

    // 完了処理中 (saving) か完了後 (graduate)。処理は速いので saving は一瞬のことがある
    await expect(page.getByTestId("tour-step-4-saving").or(page.getByTestId("tour-step-4-graduate"))).toBeVisible({
      timeout: 20_000,
    });

    // 完了処理後に卒業画面が表示される
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("tour-step-4-saving")).toHaveCount(0);

    // 完了が DB に記録され、tutorial_complete バッジが付く
    const [profile] = await selectRows<{ handson_tour_completed_at: string | null }>(
      "user_profiles",
      `id=eq.${tourUser.id}&select=handson_tour_completed_at`,
    );
    expect(profile.handson_tour_completed_at).not.toBeNull();
    expect(await hasBadge(tourUser.id, "tutorial_complete")).toBe(true);
  });

  test("Step 4: tour-step-4-badge-disclaimer が表示される (PR #834 追加済)", async ({ page, tourUser }) => {
    await page.goto("/handson-tour/graduate");

    // 卒業画面表示
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });

    // disclaimer が表示される (PR #834 で追加済)。バッジは課金・特典に連動しない、という注意書き
    const disclaimer = page.getByTestId("tour-step-4-badge-disclaimer");
    await expect(disclaimer).toBeVisible({ timeout: 10_000 });
    await expect(disclaimer).toContainText("課金");
  });

  test("Step 4: tour-step-4-go-home タップ → /home へ遷移 (Step 0 から通しで)", async ({ page, tourUser }) => {
    // 通しで 25 秒前後かかる (各 Step の自動進行 + 卒業ボタンが有効になるまでの 5 秒)
    test.setTimeout(120_000);

    await openTour(page);
    await startTour(page);
    await completeStep1(page);
    await completeStep2(page);
    await completeStep3(page);

    // 卒業画面表示を確認
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });

    // 「ホームへ」ボタンが有効化されるまで待機 (仕様: 5 秒後に活性化)
    await expect(page.getByTestId("tour-step-4-go-home")).toBeEnabled({ timeout: 10_000 });

    // 「ホームへ」をクリック
    await page.getByTestId("tour-step-4-go-home").click();

    // /home に遷移することを確認
    await page.waitForURL("**/home", { timeout: 30_000, waitUntil: "commit" });
    expect(page.url()).toContain("/home");

    // ツアーを最後まで終えたので、完了が記録され、tutorial_complete バッジが付いている (スキップではない)
    const [profile] = await selectRows<{ handson_tour_completed_at: string | null; handson_tour_skipped_at: string | null }>(
      "user_profiles",
      `id=eq.${tourUser.id}&select=handson_tour_completed_at,handson_tour_skipped_at`,
    );
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
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });

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
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal_error", message: "サーバーエラーが発生しました" } }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/handson-tour/graduate");

    // エラー画面と [もう一度] が出て、卒業画面は出ない
    await expect(page.getByTestId("tour-step-4-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("tour-step-4-retry")).toBeVisible();
    await expect(page.getByTestId("tour-step-4-graduate")).toHaveCount(0);

    // [もう一度] を押すと、今度は本物の API が成功して卒業画面になる
    await page.getByTestId("tour-step-4-retry").click();
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("tour-step-4-error")).toHaveCount(0);
    expect(completeCalls).toBe(2);
    expect(await hasBadge(tourUser.id, "tutorial_complete")).toBe(true);
  });
});
