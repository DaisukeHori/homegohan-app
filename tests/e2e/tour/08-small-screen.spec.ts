/**
 * tests/e2e/tour/08-small-screen.spec.ts
 *
 * 小さい画面のスマートフォン (360x640) でも、ツアーを Step 0 から卒業画面まで通しで進められる (#846)。
 *
 * 背景:
 *   ツアーは全面のオーバーレイと吹き出しで案内する。吹き出しを「対象の下」に固定していると、画面が小さいときに
 *   吹き出しの [次へ] が画面の外に出て押せず、先へ進めなくなる (Step 1 の結果・Step 2 の結果・Step 3 のバッジ一覧)。
 *   下に余白が無ければ上に出す位置 (auto) にし、Step 3 は対象のバッジを画面の中央へスクロールするようにした。
 *   その回帰を、実際のレイアウトで確かめる。Playwright の既定の画面 (1280x720) は、Step 3 以外では下に収まるため、
 *   この spec が無いと小さい画面での不具合に気づけない。
 *
 * 注意: API モック禁止。実 Supabase に接続する。
 */

import { test, expect, completeStep1, completeStep2, completeStep3, hasBadge, openTour, startTour } from "./helpers";

test.describe("Tour - 小さい画面", () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test("360x640 の画面でも、Step 0 から卒業画面まで [次へ] を押して通しで進める", async ({ page, tourUser }) => {
    // 通しで 25〜35 秒前後かかる (各 Step の自動進行 + 画面遷移)
    test.setTimeout(120_000);

    await openTour(page);
    await startTour(page);
    await completeStep1(page);
    await completeStep2(page);
    await completeStep3(page);

    // 卒業画面まで来て (完了の通信が成功したあとにだけ出る)、tutorial_complete バッジが付いている
    await expect(page.getByTestId("tour-step-4-graduate")).toBeVisible({ timeout: 20_000 });
    expect(await hasBadge(tourUser.id, "tutorial_complete")).toBe(true);
  });
});
