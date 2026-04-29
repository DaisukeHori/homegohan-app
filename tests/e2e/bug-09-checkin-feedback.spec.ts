/**
 * Bug-9 (#27): 30秒チェックイン完了後にフィードバック表示なし
 *
 * 確認: ホームの「30秒チェックイン」を入力 → 「✓ チェックイン完了」を押下すると、
 *       成功メッセージ (data-testid="checkin-feedback") が表示される。
 */
import { test, expect } from "./fixtures/auth";

test("30-second check-in shows success feedback after submit", async ({ authedPage }) => {
  await authedPage.goto("/home");

  // 既に今日のチェックインが完了している場合はスキップ
  const startButton = authedPage.getByRole("button", { name: /記録する/ }).first();
  const alreadyDone = await authedPage
    .getByText("今日のチェックイン完了！")
    .isVisible()
    .catch(() => false);
  test.skip(alreadyDone, "today's check-in already submitted; cannot retest feedback flow");

  // チェックインフォームを開く
  if (await startButton.isVisible().catch(() => false)) {
    await startButton.click();
  }

  // 「✓ チェックイン完了」ボタンをクリック (フォームのデフォルト値でOK)
  const submit = authedPage.getByRole("button", { name: /チェックイン完了/ });
  await expect(submit).toBeVisible();
  await submit.click();

  // 成功フィードバックが表示されること
  const feedback = authedPage.getByTestId("checkin-feedback");
  await expect(feedback).toBeVisible({ timeout: 5_000 });
  await expect(feedback).toHaveText(/チェックイン|保存/);
});
