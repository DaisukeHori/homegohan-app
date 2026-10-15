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
 * 実際のツアーで Step 3 までに付くのは Step 2 の planner だけ (STEP3_BADGES_EARNED_IN_TOUR)。Step 1 のお試しの記録は
 * first_bite に数えない (#1314) ので、first_bite は入れない (#1626。以前は first_bite も入れていて、ツアーを通した状態と違っていた)。
 * Spotlight 対象の上にはオーバーレイがかぶさっていて直接は押せないため、吹き出しの tour-next-button で進める (helpers の completeStep3)。
 *
 * 注意: API モック禁止 (読み込み中の画面を確かめるテストだけ、応答を遅らせる。中身は本物のまま)。実 Supabase に接続する。
 * Step 3 だけを見るテストは、前の Step を通らず /handson-tour/badges を直接開く
 * (Step 2 → Step 3 の遷移は 04-step2-menu が確かめる)。
 */

// 他の e2e (legal-consent-gate など) と同じく、共有パッケージのファイルを相対パスで直接読む
import { STEP3_BADGES_EARNED_IN_TOUR } from "../../../packages/handson-tour-shared/src/constants";
import {
  AUTO_ADVANCE_TIMEOUT_MS,
  EMPTY_STORAGE_STATE,
  NAVIGATION_TIMEOUT_MS,
  awardBadge,
  clickNextAndWaitForNextBubble,
  completeStep3,
  delayBadgesApi,
  expect,
  nextButton,
  test,
} from "./helpers";

test.use({ storageState: EMPTY_STORAGE_STATE });

/** 獲得済みのバッジのカードに出る文言 (src/app/handson-tour/badges/page.tsx) */
const EARNED_LABEL = "獲得済";

test.describe("Tour - Step 3: バッジ確認", () => {
  test.beforeEach(async ({ tourUser }) => {
    // Step 1 / Step 2 を終えたあとの状態: planner だけ獲得済み (first_bite はお試しの記録では付かない)。tutorial_complete は Step 4 でもらう
    for (const code of STEP3_BADGES_EARNED_IN_TOUR) {
      await awardBadge(tourUser.id, code);
    }
  });

  test("Step 3 intro 吹き出しが表示される (tour-step-3-intro)", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    await expect(page.getByTestId("tour-step-3-intro")).toBeVisible({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await expect(page.getByTestId("tour-step-3-intro").getByTestId("tour-bubble-body")).not.toBeEmpty();
  });

  // #1626: 以前は「もう 2 つ獲得しています」と出ていたが、「獲得済」が付くのは planner の 1 つだけだった
  test("Step 3 intro の「もう n つ獲得しています」の n が、「獲得済」が付いたカードの数と同じ", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    const introBody = page.getByTestId("tour-step-3-intro").getByTestId("tour-bubble-body");
    await expect(introBody).toContainText(`もう ${STEP3_BADGES_EARNED_IN_TOUR.length} つ獲得しています`, {
      timeout: AUTO_ADVANCE_TIMEOUT_MS,
    });
    await expect(page.locator('[data-testid^="badge-card-"]').filter({ hasText: EARNED_LABEL })).toHaveCount(
      STEP3_BADGES_EARNED_IN_TOUR.length,
    );
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

  // #1604: 以前は画面が /api/badges に無い obtained_at を見ていて「獲得済」が付かなかった (#846 の E2E で発見)。画面は earned を見る
  // #1626: Step 1 のお試しの記録は first_bite に数えないので、first_bite には「獲得済」が付かない
  test("Step 3: 前の Step で獲得したバッジ (planner) に「獲得済」が付き、first_bite と tutorial_complete には付かない", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    await expect(page.getByTestId("badge-card-planner")).toContainText(EARNED_LABEL, {
      timeout: AUTO_ADVANCE_TIMEOUT_MS,
    });
    await expect(page.getByTestId("badge-card-first_bite")).not.toContainText(EARNED_LABEL);
    await expect(page.getByTestId("badge-card-tutorial_complete")).not.toContainText(EARNED_LABEL);
  });

  // 既定の画面の大きさ (Desktop Chrome の 1280x720) のまま。以前は 1280x1800 にしないと [次へ] が画面の外に出て押せなかった (#1604)
  test("Step 3: 「次へ」タップ → Step 4 (tour-step-4-saving) へ遷移", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    // first_bite → planner → tutorial_complete の順に [次へ] を押すと、卒業画面 (Step 4) へ
    await completeStep3(page);

    // Step 4: 完了処理中 (tour-step-4-saving) か、完了後の卒業画面 (tour-step-4-graduate)。処理は速いので saving は一瞬のことがある
    await expect(page.getByTestId("tour-step-4-saving").or(page.getByTestId("tour-step-4-graduate"))).toBeVisible({
      timeout: AUTO_ADVANCE_TIMEOUT_MS,
    });
  });

  // #1604: 吹き出しは案内中のカードの下に出て、全面のオーバーレイ (position: fixed) の中にある。利用者は下の一覧をスクロールできないので、
  // 画面がカードを画面の中へ自動でスクロールする (設計書 05-step3-badges §7.2)。既定の高さで、どの段階でも [次へ] が画面の中にある
  test("Step 3: 既定の画面の大きさ (1280x720) でも、案内中のバッジの吹き出しの [次へ] が画面の中にあって押せる", async ({ page }) => {
    await page.goto("/handson-tour/badges");

    // first_bite → planner → tutorial_complete の各段階で、案内中のカードと [次へ] が画面の中にあって押せる
    // first_bite / planner の段階は、押したら吹き出しが次の段階のものに変わるまで待つ (前の段階のボタンを押し直さない)
    for (const card of ["badge-card-first_bite", "badge-card-planner"]) {
      await expect(page.getByTestId(card)).toBeInViewport({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
      await expect(nextButton(page, "次へ")).toBeInViewport({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
      await clickNextAndWaitForNextBubble(page, "次へ");
    }
    // tutorial_complete の段階の [次へ] で Step 4 へ
    await expect(page.getByTestId("badge-card-tutorial_complete")).toBeInViewport({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    const lastNext = nextButton(page, "次へ");
    await expect(lastNext).toBeInViewport({ timeout: AUTO_ADVANCE_TIMEOUT_MS });
    await lastNext.click();
    await page.waitForURL("**/handson-tour/graduate", { timeout: NAVIGATION_TIMEOUT_MS });
  });
});
