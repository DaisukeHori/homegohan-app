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
import { test, expect } from "./fixtures/fresh-user";

test.describe("アカウント削除 UI (#215)", () => {
  test("削除ボタンが /settings に表示される", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/settings");

    const deleteButton = tourPendingUser.getByRole("button", {
      name: /アカウントを削除する/,
    });
    await expect(deleteButton).toBeVisible();
  });

  test("削除ボタン押下で確認モーダルが表示される", async ({ tourPendingUser }) => {
    await tourPendingUser.goto("/settings");

    await tourPendingUser
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await expect(
      tourPendingUser.getByText("アカウントを削除しますか？")
    ).toBeVisible();
  });

  test("確認テキスト未入力では削除ボタンが disabled", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/settings");

    await tourPendingUser
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    const confirmButton = tourPendingUser.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });
    await expect(confirmButton).toBeDisabled();
  });

  test("「削除します」入力後に削除ボタンが enabled になる", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/settings");

    await tourPendingUser
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await tourPendingUser
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除します");

    const confirmButton = tourPendingUser.getByRole("button", {
      name: /アカウントを完全に削除する/,
    });
    await expect(confirmButton).toBeEnabled();
  });

  test("モーダルのキャンセルボタンでモーダルが閉じる", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/settings");

    await tourPendingUser
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await expect(
      tourPendingUser.getByText("アカウントを削除しますか？")
    ).toBeVisible();

    await tourPendingUser.getByRole("button", { name: /キャンセル/ }).click();

    await expect(
      tourPendingUser.getByText("アカウントを削除しますか？")
    ).not.toBeVisible();
  });

  test("削除実行で POST /api/account/delete が呼ばれ /login にリダイレクト", async ({
    tourPendingUser,
  }) => {
    await tourPendingUser.goto("/settings");

    await tourPendingUser
      .getByRole("button", { name: /アカウントを削除する/ })
      .click();

    await tourPendingUser
      .getByRole("textbox", { name: /削除確認テキスト入力/ })
      .fill("削除します");

    const requestPromise = tourPendingUser.waitForRequest(
      (req) =>
        req.url().includes("/api/account/delete") && req.method() === "POST"
    );

    await tourPendingUser
      .getByRole("button", { name: /アカウントを完全に削除する/ })
      .click();

    const request = await requestPromise;
    expect(request).toBeTruthy();

    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.confirm).toBe(true);

    await tourPendingUser.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(tourPendingUser).toHaveURL(/\/login/);
  });
});
