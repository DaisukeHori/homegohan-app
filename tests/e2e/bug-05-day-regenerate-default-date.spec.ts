/**
 * Bug-5 (#21): 「1日献立変更」モーダルの日付デフォルトが今日固定
 *
 * 確認: 週間献立画面で AI チャットを開き「1日献立変更」モーダルを
 *       表示した時、日付ピッカーのデフォルト値が「今日」ではなく、
 *       週間ビューで現在表示中の日付（または明日）になっていること。
 *
 * これにより、ユーザーが将来の日 (例: 5/8) の献立を作り直したくて
 * モーダルを開いた際に、デフォルトの「今日」のまま「作成する」を
 * 押して当日の献立を誤って上書きするリスクを回避する。
 */
import { test, expect } from "./fixtures/auth";

test("day-regenerate modal does not default the date input to today", async ({ authedPage }) => {
  await authedPage.goto("/menus/weekly");

  // 週間献立ページがロードされ、選択中の日付が window に公開されるまで待つ
  await authedPage.waitForLoadState("networkidle");
  await authedPage
    .waitForFunction(() => typeof (window as any).__weeklyCurrentDate === "string", undefined, {
      timeout: 15_000,
    })
    .catch(() => {
      // 公開タイミングがずれてもテスト本体は続行（フォールバックの「明日」を検証する）
    });

  // 週間ビューが現在保持している選択日（fallback 計算と比較するために取得）
  const weeklyCurrentDate = await authedPage.evaluate(
    () => (window as any).__weeklyCurrentDate ?? null,
  );

  // フローティング AI アシスタントボタンを開く
  const aiBubble = authedPage.locator('button:has(svg.lucide-sparkles)').first();
  await expect(aiBubble).toBeVisible({ timeout: 10_000 });
  await aiBubble.click();

  // 「1日献立変更」クイックアクションをクリック
  const dayMenuButton = authedPage.getByRole("button", { name: /1日献立変更/ });
  await expect(dayMenuButton).toBeVisible({ timeout: 10_000 });
  await dayMenuButton.click();

  // モーダルが開き、日付入力が出現するのを待つ
  await expect(authedPage.getByText("日付を選択")).toBeVisible();
  const dateInput = authedPage.locator('input[type="date"]');
  await expect(dateInput).toBeVisible();

  const value = await dateInput.inputValue();
  const todayStr = new Date().toISOString().split("T")[0];

  // 主要アサーション: デフォルトが今日ではないこと（誤上書き防止）
  expect(value).not.toBe(todayStr);
  // ISO 形式で何らかの日付が入っていること
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // 週間ページが現在の表示日を公開しており、それが今日ではない場合、
  // モーダルはその日付に揃うべき。今日と一致してしまう公開値は
  // フォールバック（明日）に置き換わるため、ここでは != today のみ検証。
  if (weeklyCurrentDate && weeklyCurrentDate !== todayStr) {
    expect(value).toBe(weeklyCurrentDate);
  }
});
