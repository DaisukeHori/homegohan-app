/**
 * Bug-10 (#28): ホームの今日の献立チェックボックスをクリックしても進捗 0% から動かない
 *
 * 確認: `/home` の「今日の献立」セクションで朝食/昼食/夕食のチェックボックスを押下すると、
 *       右カラム「今日の進捗」の % 表示が 5 秒以内に更新されること。
 *
 * 注意: 本日の献立が未登録のユーザーではテストをスキップする (graceful skip)。
 */
import { test, expect } from "./fixtures/auth";

test("home meal toggle updates today's progress percentage", async ({ authedPage }) => {
  await authedPage.goto("/home");

  const percentEl = authedPage.getByTestId("home-progress-percent");
  await expect(percentEl).toBeVisible({ timeout: 10_000 });

  // 朝食/昼食/夕食のいずれか最初に見つかったチェックボタン
  const toggleCandidates = [
    authedPage.getByTestId("meal-toggle-breakfast").first(),
    authedPage.getByTestId("meal-toggle-lunch").first(),
    authedPage.getByTestId("meal-toggle-dinner").first(),
  ];

  let toggle = null;
  for (const candidate of toggleCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      toggle = candidate;
      break;
    }
  }

  test.skip(!toggle, "today's meal plan is empty for this user; cannot exercise toggle");

  const before = (await percentEl.textContent())?.trim() ?? "0%";

  await toggle!.click();

  // 5 秒以内に % 表示が変わる (楽観的更新が即時反映される)
  await expect
    .poll(
      async () => (await percentEl.textContent())?.trim() ?? "",
      { timeout: 5_000, message: "progress percent should change within 5s after toggle" },
    )
    .not.toBe(before);

  // クリーンアップ: 元の状態に戻す (テストを冪等にする)
  await toggle!.click();
  await expect
    .poll(
      async () => (await percentEl.textContent())?.trim() ?? "",
      { timeout: 5_000 },
    )
    .toBe(before);
});
