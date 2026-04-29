/**
 * Bug-6 (#24): AIアドバイザーチャットウィンドウが意図せず開く (誤クリック発生時)
 *
 * 確認:
 *  1. フローティングボタンに明示的な aria-label が付与されている
 *  2. 通常のページ背景クリックではチャットが開かない
 *  3. 明示的にボタンをクリックすればチャットは開く (回帰防止)
 */
import { test, expect } from "./fixtures/auth";

test.describe("AI chat floating button misclick guard", () => {
  test("floating button has explicit aria-label", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const button = authedPage.getByTestId("ai-chat-floating-button");
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("aria-label", /AIアドバイザー/);
  });

  test("clicking the page background does NOT open the AI chat", async ({ authedPage }) => {
    await authedPage.goto("/home");

    // ページ中央付近(背景)をクリック
    const viewport = authedPage.viewportSize();
    if (viewport) {
      await authedPage.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
    }

    // チャットヘッダーが出現していないことを確認 (チャットは閉じたまま)
    const chatHeader = authedPage.getByRole("heading", { name: /AIアドバイザー/ });
    await expect(chatHeader).toHaveCount(0);

    // フローティングボタンは依然として見えている
    await expect(authedPage.getByTestId("ai-chat-floating-button")).toBeVisible();
  });

  test("explicit click on floating button opens the chat", async ({ authedPage }) => {
    await authedPage.goto("/home");
    const button = authedPage.getByTestId("ai-chat-floating-button");
    await button.click();

    // チャットが開いたらヘッダーが表示される
    await expect(authedPage.getByRole("heading", { name: /AIアドバイザー/ })).toBeVisible({
      timeout: 5_000,
    });
  });
});
