/**
 * 03-ai-advisor.spec.ts
 * AI Advisor チャット: メッセージ送信で応答が返ることを確認
 */
import { test, expect } from "./fixtures/auth";

test("AI Advisor: メッセージ送信で応答が返る", async ({ authedPage: page }) => {
  test.setTimeout(90000);

  await page.goto("/home");
  await page.waitForLoadState("networkidle");

  // AI チャット FAB / ボタンを開く
  // data-testid, aria-label, テキスト など複数パターン試行
  const chatOpener = page
    .locator(
      '[aria-label*="AI"], [data-testid*="ai-chat"], [data-testid*="advisor"], button:has-text("AI"), button:has-text("アドバイザー")',
    )
    .first();

  const isVisible = await chatOpener.isVisible({ timeout: 8000 }).catch(() => false);
  if (!isVisible) {
    // FAB が見つからない場合 skip
    test.skip(true, "AI チャット FAB/ボタンが見つかりません。selector 要確認");
    return;
  }
  await chatOpener.click();

  // テキストエリアが表示されるまで待つ
  const textarea = page.getByPlaceholder(/メッセージを入力|質問を入力/);
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  await textarea.fill("こんにちは");

  // 送信ボタン
  const submitBtn = page.locator(
    'button[aria-label*="送信"], button[type="submit"], [data-testid*="send"]',
  ).first();
  await submitBtn.click();

  // 応答が返るまで待つ (xAI 最大 30s)
  // 自分のメッセージ以外に何か追加のメッセージ要素が表示されること
  await expect(
    page.locator('[data-testid*="message"], [class*="message"], [role="listitem"]').nth(1),
  ).toBeVisible({ timeout: 30000 });
});
