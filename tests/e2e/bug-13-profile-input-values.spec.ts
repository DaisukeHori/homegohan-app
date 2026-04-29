/**
 * Bug-13 (#30): プロフィール編集の年齢/身長/体重フィールドで placeholder と実値の見分けがつかない
 *
 * 確認:
 *   1. プロフィール編集モーダル「基本」タブの年齢/身長/体重 input は、
 *      placeholder が "例:" プレフィックス付きで明示される。
 *   2. 入力欄が空の場合は「未入力」バッジが Label の隣に表示される。
 *   3. 入力欄に値を入れたあと、ネイティブの value 属性 (DOM の value プロパティ) が
 *      placeholder ではなく、実際の入力値を保持していること。
 */
import { test, expect } from "./fixtures/auth";

test("profile basic-tab inputs distinguish placeholder vs real value", async ({ authedPage }) => {
  await authedPage.goto("/profile");

  // ヘッダーの編集アイコン (鉛筆ボタン) で編集モーダルを開く
  // 既に未入力タブガイド (setIsEditing) が自動オープンしている可能性もあるので両対応
  const ageInput = authedPage.locator("#profile-age-input");
  const heightInput = authedPage.locator("#profile-height-input");
  const weightInput = authedPage.locator("#profile-weight-input");

  if (!(await ageInput.isVisible().catch(() => false))) {
    // 編集ボタンが見つかれば押下して開く
    const editButton = authedPage.locator("button").filter({ has: authedPage.locator("svg") }).first();
    await editButton.click().catch(() => {});
  }

  await expect(ageInput).toBeVisible({ timeout: 10_000 });
  await expect(heightInput).toBeVisible();
  await expect(weightInput).toBeVisible();

  // placeholder に "例:" プレフィックスがあること
  await expect(ageInput).toHaveAttribute("placeholder", /^例:/);
  await expect(heightInput).toHaveAttribute("placeholder", /^例:/);
  await expect(weightInput).toHaveAttribute("placeholder", /^例:/);

  // 値を入力 → DOM の value 属性が placeholder ではなく入力値を保持
  await ageInput.fill("");
  await ageInput.fill("28");
  await expect(ageInput).toHaveValue("28");

  await heightInput.fill("");
  await heightInput.fill("172");
  await expect(heightInput).toHaveValue("172");

  await weightInput.fill("");
  await weightInput.fill("66");
  await expect(weightInput).toHaveValue("66");

  // 値が入っていれば「未入力」バッジは存在しないこと
  await expect(authedPage.getByTestId("profile-age-empty-badge")).toHaveCount(0);
  await expect(authedPage.getByTestId("profile-height-empty-badge")).toHaveCount(0);
  await expect(authedPage.getByTestId("profile-weight-empty-badge")).toHaveCount(0);

  // クリア → 「未入力」バッジが表示される
  await ageInput.fill("");
  await expect(authedPage.getByTestId("profile-age-empty-badge")).toBeVisible();
});
