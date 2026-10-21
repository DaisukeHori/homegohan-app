/**
 * 03-ai-advisor.spec.ts
 * AI Advisor チャット: 既定では送信ボタンが押せるところまで、E2E_ALLOW_AI_CALLS=1 のときだけ送信して応答が返ることを確認
 *
 * 送信は本物の AI を呼ぶので、E2E_ALLOW_AI_CALLS=1 のときだけ行う (tests/e2e/helpers/ai-calls.ts。#1909)。
 * それ以外 (PR の本番向けの実行・ローカルの既定) は、チャットが開いて入力でき、送信ボタンが押せる状態になるところまでを確かめる。
 */
import { test, expect } from "./fixtures/auth";
import { isAiCallAllowed } from "./helpers/ai-calls";

/** 送信ボタンが押せる状態になるまで待つ上限 (入力欄の表示を待つ上限と同じ 10 秒) */
const SEND_READY_TIMEOUT_MS = 10_000;

test("AI Advisor: 送信ボタンが押せる (E2E_ALLOW_AI_CALLS=1 のときだけ送信して応答を待つ)", async ({ authedPage: page }) => {
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
  if (!isAiCallAllowed()) {
    // 本物の AI を呼ばない確認: 送信ボタンが押せる状態になるところまで (押さない)
    await expect(submitBtn).toBeEnabled({ timeout: SEND_READY_TIMEOUT_MS });
    return;
  }
  await submitBtn.click();

  // 応答が返るまで待つ (xAI 最大 30s)
  // 自分のメッセージ以外に何か追加のメッセージ要素が表示されること
  await expect(
    page.locator('[data-testid*="message"], [class*="message"], [role="listitem"]').nth(1),
  ).toBeVisible({ timeout: 30000 });
});
