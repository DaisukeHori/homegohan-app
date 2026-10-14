/**
 * tests/e2e/tour/07-skip-and-replay.spec.ts
 *
 * スキップ & リプレイシナリオ:
 * 1. Step 0 で「あとで」→ /home へ即遷移 (スキップが DB に記録される)
 * 2. スキップ済みなら /handson-tour を開いても /home に戻される
 * 3. /settings から `settings-restart-handson-tour` タップ → Step 0 再表示
 *
 * 実装済み testID:
 *   tour-step-0, tour-step-0-skip
 *   settings-restart-handson-tour (実装側命名、設計書の settings-replay-handson-tour とは異なる)
 *
 * 注意: API モック禁止。実 Supabase に接続する。
 */

import {
  AUTO_ADVANCE_TIMEOUT_MS,
  EMPTY_STORAGE_STATE,
  NAVIGATION_TIMEOUT_MS,
  expect,
  openTour,
  readTourProfile,
  skipTourAtStep0,
  test,
  waitForReactHandlers,
} from "./helpers";

test.use({ storageState: EMPTY_STORAGE_STATE });

test.describe("Tour - Skip and Replay", () => {
  test("Step 0 で「あとで」タップ → /home へ即遷移", async ({ page, tourUser }) => {
    await openTour(page);

    await skipTourAtStep0(page);
    expect(new URL(page.url()).pathname).toBe("/home");

    // スキップしたことが DB に記録される (ツアーを完了したことにはならない)
    const profile = await readTourProfile(tourUser.id);
    expect(profile.handson_tour_skipped_at).not.toBeNull();
    expect(profile.handson_tour_completed_at).toBeNull();
  });

  test("「あとで」後に /handson-tour に戻っても tour-step-0 が表示されない (skipped)", async ({ page, tourUser }) => {
    await openTour(page);
    await skipTourAtStep0(page);

    // スキップ後に /handson-tour に直接遷移しても /home にリダイレクトされる
    // (layout.tsx が status API と同じ判定 (already_skipped) で redirect('/home') する)
    await page.goto("/handson-tour", { waitUntil: "commit" });
    await page.waitForURL("**/home", { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "commit" });

    await expect(page.getByTestId("tour-step-0")).toHaveCount(0);
  });

  test("/settings から settings-restart-handson-tour タップ → Step 0 再表示", async ({ page, tourUser }) => {
    // まず「あとで」でスキップ
    await openTour(page);
    await skipTourAtStep0(page);

    // /settings に遷移して、「使い方ガイドをもう一度見る」を押す
    await page.goto("/settings");
    const restartBtn = page.getByTestId("settings-restart-handson-tour");
    await expect(restartBtn).toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS });
    await waitForReactHandlers(page, "settings-restart-handson-tour");
    await restartBtn.click();

    // /handson-tour/replay (Cookie を発行) を経て /handson-tour に戻り、スキップ済みでも Step 0 が再表示される
    await page.waitForURL((url) => url.pathname === "/handson-tour", { timeout: NAVIGATION_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-0")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
  });

  test("settings-restart-handson-tour が /settings ページに存在する", async ({ page, tourUser }) => {
    // スキップして /settings に移動
    await openTour(page);
    await skipTourAtStep0(page);

    await page.goto("/settings");

    await expect(page.getByTestId("settings-restart-handson-tour")).toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS });
  });
});
