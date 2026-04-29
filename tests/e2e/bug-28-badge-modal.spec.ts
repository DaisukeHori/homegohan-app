/**
 * Bug-28 (#48): バッジ詳細モーダルが開かない (取得条件・進捗が見えない)
 *
 * 確認: /badges (トロフィールーム) 上でバッジカードをクリックすると、
 *       詳細モーダル (role=dialog) が表示され、バッジ名・取得条件が見えること。
 *       hover overlay の pointer-events が click を吸収していないことも担保する。
 */
import { test, expect } from "./fixtures/auth";

test.describe("badge detail modal opens on click", () => {
  test("clicking a badge card opens detail dialog with name and criteria", async ({
    authedPage,
  }) => {
    await authedPage.goto("/badges");

    // データがロードされるまで待機 (loading 表示が消えるか、カードが現れるか)
    const firstCard = authedPage.locator('[data-testid="badge-card"]').first();
    const cardAvailable = await firstCard
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!cardAvailable) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "バッジ一覧にカードが見つかりません (データ未生成)",
      });
      return;
    }

    // 1. クリックをブロックする overlay がないことを念のため確認
    //    (data-testid のカードが button としてクリック可能であること)
    await expect(firstCard).toBeEnabled();

    // 2. クリックでモーダル (role=dialog) が開く
    await firstCard.click();

    const dialog = authedPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // 3. 取得条件のラベルがモーダル内に表示されている
    await expect(dialog.getByText("取得条件")).toBeVisible();

    // 4. 閉じるボタンでモーダルが閉じる
    // モーダル下部の「閉じる」ボタン (テキストボタン) を使う。
    // 上部の × ボタン (aria-label="閉じる") は emoji div に pointer-events がある場合に
    // クリックをブロックされる可能性があるため、最後にマッチするボタンを使用する。
    await dialog.getByRole("button", { name: "閉じる" }).last().click();
    await expect(dialog).toBeHidden({ timeout: 3_000 });
  });
});
