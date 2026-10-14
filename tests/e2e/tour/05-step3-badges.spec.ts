/**
 * tests/e2e/tour/05-step3-badges.spec.ts
 *
 * Step 3: バッジ確認。読み込み → intro → first_bite → planner → tutorial_complete (それぞれ [次へ]) → Step 4 遷移
 *
 * testID (実装済み):
 *   tour-step-3-loading, tour-step-3-intro, badge-card-* (動的, e.g. badge-card-first_bite),
 *   tour-next-button
 *
 * Step 3 は /api/badges (本物の API) が返すバッジの一覧を出す。前の Step で付いているはずのバッジは、
 * service_role で user_badges に直接入れて「Step 1/2 を終えたあと」の状態を作る (beforeEach)。
 * Spotlight 対象の上にはオーバーレイがかぶさっていて直接は押せないため、吹き出しの tour-next-button で進める (helpers の completeStep3)。
 *
 * 注意: API モック禁止 (読み込み中の画面を確かめるテストだけ、応答を遅らせる。中身は本物のまま)。実 Supabase に接続する。
 * Step 3 だけを見るテストは、前の Step を通らず /handson-tour/badges を直接開く
 * (Step 2 → Step 3 の遷移は 04-step2-menu が確かめる)。
 */

import {
  AUTO_ADVANCE_TIMEOUT_MS,
  EMPTY_STORAGE_STATE,
  awardBadge,
  completeStep3,
  delayBadgesApi,
  expect,
  test,
} from "./helpers";

test.use({ storageState: EMPTY_STORAGE_STATE });

/** 獲得済みのバッジのカードに出る文言 (src/app/handson-tour/badges/page.tsx) */
const EARNED_LABEL = "獲得済";

test.describe("Tour - Step 3: バッジ確認", () => {
  test.beforeEach(async ({ tourUser }) => {
    // Step 1 / Step 2 を終えたあとの状態: first_bite と planner は獲得済み、tutorial_complete は Step 4 でもらう
    await awardBadge(tourUser.id, "first_bite");
    await awardBadge(tourUser.id, "planner");
  });

  test("Step 3 intro 吹き出しが表示される (tour-step-3-intro)", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    await expect(page.getByTestId("tour-step-3-intro")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-3-intro").getByTestId("tour-bubble-body")).not.toBeEmpty();
  });

  test("Step 3: tour-step-3-loading が表示される", async ({ page }) => {
    // 読み込み中の画面は、速いと一瞬で消えて見えないので、/api/badges の応答だけ遅らせる
    await delayBadgesApi(page);
    await page.goto("/handson-tour/badges");

    await expect(page.getByTestId("tour-step-3-loading")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    // 読み込みが終わると、バッジの一覧に切り替わる
    await expect(page.getByTestId("badge-card-first_bite")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-3-loading")).toHaveCount(0);
  });

  test("Step 3: badge-card-first_bite が表示される", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    // Spotlight の対象になる 3 枚 (first_bite → planner → tutorial_complete) が一覧にある
    await expect(page.getByTestId("badge-card-first_bite")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("badge-card-planner")).toBeVisible();
    await expect(page.getByTestId("badge-card-tutorial_complete")).toBeVisible();
  });

  // 製品の既知の不具合で通らない (#846 の E2E で見つけた。直したら .fixme を外し、tests/e2e-tour-contract.test.ts の KNOWN_FIXMES を減らす)
  test.fixme(
    "Step 3: 前の Step で獲得したバッジ (first_bite / planner) に「獲得済」が付き、tutorial_complete には付かない",
    {
      annotation: {
        type: "fixme",
        description:
          "Step 3 の画面 (src/app/handson-tour/badges/page.tsx) は各バッジの obtained_at を見て「獲得済」を出すが、" +
          "/api/badges は earned と obtainedAt (キャメルケース) を返すので、獲得済みのバッジにも「獲得済」が付かない。",
      },
    },
    async ({ page }) => {
      await page.goto("/handson-tour/badges");

      await expect(page.getByTestId("badge-card-first_bite")).toContainText(EARNED_LABEL, {
        timeout: AUTO_ADVANCE_TIMEOUT_MS,
      });
      await expect(page.getByTestId("badge-card-planner")).toContainText(EARNED_LABEL);
      await expect(page.getByTestId("badge-card-tutorial_complete")).not.toContainText(EARNED_LABEL);
    },
  );

  test("Step 3: 「次へ」タップ → Step 4 (tour-step-4-saving) へ遷移", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    // first_bite → planner → tutorial_complete の順に [次へ] を押すと、卒業画面 (Step 4) へ
    await completeStep3(page);

    // Step 4: 完了処理中 (tour-step-4-saving) か、完了後の卒業画面 (tour-step-4-graduate)。処理は速いので saving は一瞬のことがある
    await expect(page.getByTestId("tour-step-4-saving").or(page.getByTestId("tour-step-4-graduate"))).toBeVisible({
      timeout: AUTO_ADVANCE_TIMEOUT_MS,
    });
  });
});
