/**
 * Bug #215: /settings にアカウント削除 UI がない (API は実装済)
 *
 * 確認:
 * - 削除ボタンが /settings に表示される
 * - ボタン押下で確認モーダルが開く
 * - 確認テキスト未入力では削除ボタンが disabled
 * - 「削除します」入力後に削除ボタンが enabled になる
 * - 削除実行で POST /api/account/delete が呼ばれ /login にリダイレクト
 */
import { test, expect } from "./fixtures/auth";

test.describe("アカウント削除 UI (#215)", () => {
  test("削除ボタンが /settings に表示される", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    const deleteButton = authedPage.getByRole("button", {
      name: /アカウントを削除する/,
    });
    await expect(deleteButton).toBeVisible();
  });

  test("削除ボタン押下で確認モーダルが表示される", async ({ authedPage }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await expect(
      authedPage.getByText("アカウントを削除しますか？")
    ).toBeVisible();
  });

  test("確認テキスト未入力では削除ボタンが disabled", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    const confirmButton = authedPage.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });
    await expect(confirmButton).toBeDisabled();
  });

  test("「削除します」入力後に削除ボタンが enabled になる", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await authedPage
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除します");

    const confirmButton = authedPage.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });
    await expect(confirmButton).toBeEnabled();
  });

  test("モーダルのキャンセルボタンでモーダルが閉じる", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await expect(
      authedPage.getByText("アカウントを削除しますか？")
    ).toBeVisible();

    await authedPage.getByRole("button", { name: /キャンセル/ }).click();

    await expect(
      authedPage.getByText("アカウントを削除しますか？")
    ).not.toBeVisible();
  });

  test("削除実行で POST /api/account/delete が呼ばれ /login にリダイレクト", async ({
    authedPage,
  }) => {
    await authedPage.goto("/settings");

    await authedPage
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await authedPage
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除します");

    const requestPromise = authedPage.waitForRequest(
      (req) =>
        req.url().includes("/api/account/delete") && req.method() === "POST"
    );

    await authedPage
      .getByRole("button", { name: /アカウントを完全に削除する/ })
      .click();

    const request = await requestPromise;
    expect(request).toBeTruthy();

    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.confirm).toBe(true);

    await authedPage.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(authedPage).toHaveURL(/\/login/);
  });
});
