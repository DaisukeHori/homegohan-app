/**
 * tests/e2e/tour/02-step0-welcome.spec.ts
 *
 * Step 0 ウェルカム画面の表示・「はじめる」タップ → Step 1 遷移を検証する。
 *
 * testID (実装済み):
 *   tour-step-0, tour-step-0-title, tour-step-0-subtitle,
 *   tour-step-0-start, tour-step-0-skip, tour-step-1-intro
 *
 * 注意: API モック禁止。実 Supabase に接続して新規ユーザーを作成する。
 * テストの引数に tourUser を書くと、onboarding 完了済みの新規ユーザーが作られ、page がそのユーザーでログイン済みになる
 * (使わなくても書く。後始末は ./helpers の fixture が行う)。
 */

import { test, expect, openTour, startTour } from "./helpers";

test.describe("Tour - Step 0: Welcome", () => {
  test.setTimeout(60_000);

  test("Step 0 が表示される (tour-step-0 / title / subtitle)", async ({ page, tourUser }) => {
    await openTour(page);

    // タイトルとサブタイトルが表示される
    await expect(page.getByTestId("tour-step-0-title")).toBeVisible();
    await expect(page.getByTestId("tour-step-0-subtitle")).toBeVisible();

    // タイトルには "ようこそ" が含まれ、ニックネーム (user_profiles.nickname) が差し込まれる
    await expect(page.getByTestId("tour-step-0-title")).toContainText("ようこそ");
    await expect(page.getByTestId("tour-step-0-title")).toContainText("E2E Test User");
  });

  test("Step 0 で「はじめる」タップ → Step 1 へ遷移 (tour-step-0-start)", async ({ page, tourUser }) => {
    await openTour(page);

    // 「はじめる」ボタンをタップ → /handson-tour/photo へ
    await startTour(page);

    // Step 0 が消えて、Step 1 の intro 吹き出し (tour-step-1-intro) が出る
    await expect(page.getByTestId("tour-step-0")).toHaveCount(0);
    await expect(page.getByTestId("tour-step-1-intro")).toBeVisible({ timeout: 20_000 });
  });

  test("Step 0 で「あとで」ボタンが表示される (tour-step-0-skip)", async ({ page, tourUser }) => {
    await openTour(page);

    // 「あとで」ボタンが存在する
    await expect(page.getByTestId("tour-step-0-skip")).toBeVisible();
    await expect(page.getByTestId("tour-step-0-skip")).toBeEnabled();
  });
});
