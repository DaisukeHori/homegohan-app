/**
 * Bug-125 (#125): AIフローティングボタン連続クリックでチャットウィンドウが二重表示される
 * Bug-126 (#126): コンテキスト切替後の最終応答が空文字になる
 *
 * 検証:
 *  #125:
 *   1. フローティングボタンを素早く連続クリックしても、チャットウィンドウは1つしか表示されない
 *   2. isToggling フラグが解除された後は再度クリックで正常に開閉できる
 *
 *  #126:
 *   1. メッセージ送信後、AI応答バブルが空文字のままにならない
 *   2. ストリーミング完了後も isStreaming カーソルが消えて、コンテンツが表示される
 */
import { test, expect } from "./fixtures/fresh-user";

test.describe("Bug-125: フローティングボタン連続クリック二重表示防止", () => {
  test("連続クリックしてもチャットウィンドウが1つだけ表示される", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/home");

    const floatingButton = tourPendingUser.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });

    // 素早く3回連続クリック（二重表示バグの再現）
    await floatingButton.click();
    await floatingButton.click({ force: true }).catch(() => {});
    await floatingButton.click({ force: true }).catch(() => {});

    // チャットウィンドウのヘッダーは常に1つだけ
    const chatHeadings = tourPendingUser.getByRole("heading", { name: /AIアドバイザー/ });
    await expect(chatHeadings.first()).toBeVisible({ timeout: 8_000 });
    // 2つ目のウィンドウが存在しないことを確認（count === 1）
    await expect(chatHeadings).toHaveCount(1);
  });

  test("チャットを閉じて再度開いても正常に動作する", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/home");

    const floatingButton = tourPendingUser.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });

    // 1回目: 開く
    await floatingButton.click();
    await expect(
      tourPendingUser.getByRole("heading", { name: /AIアドバイザー/ })
    ).toBeVisible({ timeout: 8_000 });

    // X ボタンを探してクリック（aria-label="AIチャットを閉じる" で特定）
    await tourPendingUser.locator('button[aria-label="AIチャットを閉じる"]').click().catch(async () => {
      // フォールバック: lucide-x クラスを持つ SVG の親ボタン
      await tourPendingUser.locator('button').filter({ has: tourPendingUser.locator('svg.lucide-x') }).last().click().catch(async () => {
        // 最終フォールバック: Escape キーで閉じる
        await tourPendingUser.keyboard.press("Escape");
      });
    });

    // フローティングボタンが再表示される
    await expect(floatingButton).toBeVisible({ timeout: 5_000 });

    // 2回目: 再度開く（isToggling がリセットされていること）
    await floatingButton.click();
    await expect(
      tourPendingUser.getByRole("heading", { name: /AIアドバイザー/ })
    ).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("Bug-126: コンテキスト切替後の空応答防止", () => {
  test("メッセージ送信後 AI応答バブルが空文字にならない", async ({
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

    // ユーザーメッセージが表示されるまで待つ
    await expect(
      tourPendingUser.locator("text=こんにちは").first()
    ).toBeVisible({ timeout: 5_000 });

    // 30秒以内に空でない AI応答バブルが表示されること（#126 の修正確認）
    const aiBubble = tourPendingUser
      .locator('[data-testid="ai-message-bubble"]')
      .filter({ hasNotText: "" })
      .first();
    await expect(aiBubble).toBeVisible({ timeout: 30_000 });

    // 応答テキストが空でないことを確認
    const bubbleText = await aiBubble.textContent();
    expect((bubbleText ?? "").trim().length).toBeGreaterThan(0);
  });

  test("ストリーミング完了後に isStreaming カーソルが消える", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/menus/weekly");

    const floatingButton = tourPendingUser.getByTestId("ai-chat-floating-button");
    await expect(floatingButton).toBeVisible({ timeout: 10_000 });
    await floatingButton.click();

    await expect(
      tourPendingUser.getByRole("heading", { name: /AIアドバイザー/ })
    ).toBeVisible({ timeout: 10_000 });

    const input = tourPendingUser.getByPlaceholder(/メッセージを入力/);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("今日の献立を教えて");
    await input.press("Enter");

    // 30秒以内に streaming カーソルが消えた（非空）バブルが表示されること
    await expect(
      tourPendingUser.locator('[data-testid="ai-message-bubble"]').filter({ hasNotText: "" }).first()
    ).toBeVisible({ timeout: 30_000 });

    // streaming-cursor が消えていること（isStreaming=false になっている）
    const streamingCursor = tourPendingUser.locator(".streaming-cursor");
    await expect(streamingCursor).toHaveCount(0, { timeout: 5_000 });
  });
});
