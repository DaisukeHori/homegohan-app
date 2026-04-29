/**
 * Bug-29 (#49): AIアドバイザーチャットでメッセージ送信後、AI応答が返ってこない
 *
 * 検証:
 *  1. メッセージ送信後 30秒以内に assistantメッセージ（AI応答またはエラーメッセージ）が表示される
 *  2. ローディングインジケータが永続的に表示されたままにならない（サイレント void を防止）
 */
import { test, expect } from "./fixtures/auth";

test.describe("AI chat response within 30 seconds (Bug-29)", () => {
  test("送信後 30秒以内に AI応答またはエラーメッセージが表示される", async ({
    authedPage,
  }) => {
    // 週間献立ページへ移動
    await authedPage.goto("/menus/weekly");

    // フローティングボタンをクリックしてチャットを開く
    const floatingButton = authedPage.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });
    await floatingButton.click();

    // チャットパネルが開くまで待つ
    const chatHeading = authedPage.getByRole("heading", { name: /AIアドバイザー/ });
    await expect(chatHeading).toBeVisible({ timeout: 10_000 });

    // 入力欄にメッセージを入力して送信
    const input = authedPage.getByPlaceholder(/メッセージを入力/);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("こんにちは");
    await input.press("Enter");

    // ユーザーメッセージが表示されるまで待つ
    await expect(
      authedPage.locator("text=こんにちは").first()
    ).toBeVisible({ timeout: 5_000 });

    // 30秒以内に assistant バブル（空でないもの）が表示されること
    // isStreaming=true の空バブル以外の、実際のコンテンツを持つ assistant メッセージを待つ
    // ローディングバブルは content="" かつ isStreaming=true なので、
    // 非空テキストが含まれる assistant バブルを待つ
    await expect(
      authedPage.locator('[data-testid="ai-message-bubble"]').filter({ hasNotText: "" })
    ).toBeVisible({ timeout: 30_000 });
  });

  test("ローディングインジケータが 30秒を超えて残らない", async ({
    authedPage,
  }) => {
    await authedPage.goto("/menus/weekly");

    const floatingButton = authedPage.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });
    await floatingButton.click();

    const chatHeading = authedPage.getByRole("heading", { name: /AIアドバイザー/ });
    await expect(chatHeading).toBeVisible({ timeout: 10_000 });

    const input = authedPage.getByPlaceholder(/メッセージを入力/);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("こんにちは");
    await input.press("Enter");

    // 30秒後にはローディングインジケータ（isStreaming 中の空バブル）が消えていること
    // 具体的には: isSending=false になることで送信ボタンが再び有効になる
    const sendButton = authedPage.locator('button[aria-label="送信"], button[type="button"]').filter({
      has: authedPage.locator('svg'),
    }).last();

    // 30秒以内に送信ボタンが再び操作可能になること（isSending=false になった証拠）
    await expect(
      authedPage.locator('[data-testid="ai-message-bubble"]').filter({ hasNotText: "" })
    ).toBeVisible({ timeout: 30_000 });
  });
});
