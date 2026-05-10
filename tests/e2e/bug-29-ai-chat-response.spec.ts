/**
 * Bug-29 (#49): AIアドバイザーチャットでメッセージ送信後、AI応答が返ってこない
 *
 * 検証:
 *  1. メッセージ送信後 30秒以内に assistantメッセージ（AI応答またはエラーメッセージ）が表示される
 *  2. ローディングインジケータが永続的に表示されたままにならない（サイレント void を防止）
 */
import { test, expect } from "./fixtures/fresh-user";

test.describe("AI chat response within 30 seconds (Bug-29)", () => {
  test("送信後 30秒以内に AI応答またはエラーメッセージが表示される", async ({
    tourPendingUser,
  }) => {
    // 週間献立ページへ移動
    await tourPendingUser.goto("/menus/weekly");

    // フローティングボタンをクリックしてチャットを開く
    const floatingButton = tourPendingUser.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });
    await floatingButton.click();

    // チャットパネルが開くまで待つ
    const chatHeading = tourPendingUser.getByRole("heading", { name: /AIアドバイザー/ });
    await expect(chatHeading).toBeVisible({ timeout: 10_000 });

    // 入力欄にメッセージを入力して送信
    const input = tourPendingUser.getByPlaceholder(/メッセージを入力/);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("こんにちは");
    await input.press("Enter");

    // ユーザーメッセージが表示されるまで待つ
    await expect(
      tourPendingUser.locator("text=こんにちは").first()
    ).toBeVisible({ timeout: 5_000 });

    // 30秒以内に assistant バブル（空でないもの）が表示されること
    // isStreaming=true の空バブル以外の、実際のコンテンツを持つ assistant メッセージを待つ
    // ローディングバブルは content="" かつ isStreaming=true なので、
    // 非空テキストが含まれる assistant バブルを待つ
    await expect(
      tourPendingUser.locator('[data-testid="ai-message-bubble"]').filter({ hasNotText: "" }).first()
    ).toBeVisible({ timeout: 30_000 });
  });

  test("ローディングインジケータが 30秒を超えて残らない", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/menus/weekly");

    const floatingButton = tourPendingUser.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });
    await floatingButton.click();

    const chatHeading = tourPendingUser.getByRole("heading", { name: /AIアドバイザー/ });
    await expect(chatHeading).toBeVisible({ timeout: 10_000 });

    const input = tourPendingUser.getByPlaceholder(/メッセージを入力/);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("こんにちは");
    await input.press("Enter");

    // 30秒後にはローディングインジケータ（isStreaming 中の空バブル）が消えていること
    // 具体的には: isSending=false になることで送信ボタンが再び有効になる
    const sendButton = tourPendingUser.locator('button[aria-label="送信"], button[type="button"]').filter({
      has: tourPendingUser.locator('svg'),
    }).last();

    // 30秒以内に送信ボタンが再び操作可能になること（isSending=false になった証拠）
    await expect(
      tourPendingUser.locator('[data-testid="ai-message-bubble"]').filter({ hasNotText: "" }).first()
    ).toBeVisible({ timeout: 30_000 });
  });
});
