/**
 * tests/e2e/family/02-family-menu-view.spec.ts
 *
 * #1584 の 1 — 週間献立の「家族の表示」で、家族の共有の献立を読み取り専用で見る
 * (設計書 docs/design/family/10-family-menu-view.md §19.5)。
 *
 *   spec02-01: 家族の大人の週間献立に、代表者の今日の献立が読み取り専用で出て、子供には注記が出る
 *   spec02-02: 代表者が「週間献立を家族に見せる」をオフにすると、行が消えて注記が出て、切り替えのシートに「(献立は非公開)」が出る
 *   spec02-03: 「自分だけ」を選ぶと家族の行も注記も出ず、家族の献立の API を呼ばない
 *
 * ユーザー: fixtures/fresh-family.ts の freshFamilyWithMembers (代表者「お母さん」・大人「大人1」・子供「子供1」。3 人とも share_menu = true)。
 * 見る人は大人1 (helpers/persona-api.ts の openUserContext で別のブラウザのコンテキストに入る)。代表者の操作は fixture の ownerPage。
 * 招待と承諾はしない (承諾の流れは family/01 が見る)。片付けは fixture が家族と利用者を消す (献立は利用者の削除の CASCADE で消える)。
 *
 * 実行:
 *   npx playwright test tests/e2e/family/02-family-menu-view.spec.ts
 */

import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/fresh-family";
import { EMPTY_STORAGE_STATE, apiRequest, openUserContext } from "../helpers/persona-api";
import { todayLocal } from "../../../packages/shared/src/date-utils";

/** 代表者が今日の夕食を作る API (POST)。3 つのテストの準備 */
const MEAL_CREATE_API_PATH = "/api/meal-plans/meals";
/** 代表者が「週間献立を家族に見せる」をオフにする API (PATCH)。spec02-02 */
const SHARE_SETTINGS_API_PATH = "/api/family/members/me/share";
/** 家族の献立の API (src/lib/membership/family-menu.ts の FAMILY_MENU_API_PATH と同じ値)。spec02-03 で呼ばれた回数を数える */
const FAMILY_MENU_API_PATH = "/api/family/menu";
/** 家族の名前の API。spec02-03 で、切り替えの適用 (loadFamilyData の読み直し) が名前を取り終えた印として応答を待つ */
const FAMILY_MEMBER_NAMES_API_PATH = "/api/family/members/names";

// 共有のログイン状態 (playwright.config.ts の storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: EMPTY_STORAGE_STATE });

// ─── 定数 ────────────────────────────────────────────────────────────────────

/**
 * 各テストの時間の上限。献立を作り、週間献立の画面 (大きいクライアントの画面) を本番ビルドで開き、
 * 切り替えを適用して取り直すので、playwright.config.ts の既定 (60 秒) より延ばす。
 */
const FAMILY_FLOW_TIMEOUT_MS = 180_000;

/** 画面の要素が出るまで待つ上限 (ほかの spec と同じ。本番ビルドの初回の描画を含めて足りる長さ) */
const PAGE_READY_TIMEOUT_MS = 20_000;

/** 代表者が作る今日の夕食の料理の名前 (「編集」「削除」を含まない語) */
const SPEC02_DISH_NAME = "E2E 家族の肉じゃが";

/** 代表者のメンバーの表示名 (fixtures/fresh-family.ts:302 の buildFamilyFixture が付ける) */
const OWNER_DISPLAY_NAME = "お母さん";

/** 子供のメンバーの表示名 (fixtures/fresh-family.ts:355 の buildFamilyFixture が付ける。1 人目) */
const CHILD_DISPLAY_NAME = "子供1";

/** POST /api/meal-plans/meals の成功の status */
const HTTP_OK = 200;

// ─── 道具 ────────────────────────────────────────────────────────────────────

/** 代表者が今日の夕食を作り、その献立の id を返す */
async function createOwnerDinner(ownerPage: Page): Promise<string> {
  const created = await apiRequest(ownerPage, MEAL_CREATE_API_PATH, {
    method: "POST",
    body: { dayDate: todayLocal(), mealType: "dinner", dishName: SPEC02_DISH_NAME },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(HTTP_OK);
  const mealId = (created.body as { meal?: { id?: unknown } }).meal?.id;
  if (typeof mealId !== "string") {
    throw new Error(`献立の作成の応答に meal.id がありません: ${JSON.stringify(created.body)}`);
  }
  return mealId;
}

/** 見る人の週間献立を開き、代表者の行 (今日の夕食) が 1 件出るまで待つ */
async function openWeeklyAndWaitOwnerRow(page: Page, ownerMemberId: string, mealId: string) {
  await page.goto("/menus/weekly");
  const ownerRow = page.locator(`[data-testid="family-menu-row"][data-member-id="${ownerMemberId}"]`);
  await expect(ownerRow).toHaveCount(1, { timeout: PAGE_READY_TIMEOUT_MS });
  await expect(ownerRow).toHaveAttribute("data-meal-id", mealId);
  return ownerRow;
}

// ─── テスト ──────────────────────────────────────────────────────────────────

test.describe("family: 週間献立の家族の表示 (#1584 の 1)", () => {
  test("spec02-01: 家族の大人の週間献立に、代表者の今日の献立が読み取り専用で出て、子供には注記が出る", async ({
    freshFamilyWithMembers,
    browser,
  }) => {
    test.setTimeout(FAMILY_FLOW_TIMEOUT_MS);
    const { ownerPage, family } = freshFamilyWithMembers;
    const mealId = await createOwnerDinner(ownerPage);

    const { context, page } = await openUserContext(browser, family.adults[0].email);
    try {
      const ownerRow = await openWeeklyAndWaitOwnerRow(page, family.owner.memberId, mealId);
      await expect(ownerRow).toContainText(SPEC02_DISH_NAME);
      await expect(ownerRow).toContainText(OWNER_DISPLAY_NAME);
      // 読み取り専用: 編集・削除のボタンが無い
      await expect(ownerRow.getByRole("button", { name: /編集|削除/ })).toHaveCount(0);
      // 日の末尾に子供の注記
      await expect(page.getByText(`${CHILD_DISPLAY_NAME} (子供) の献立は、アカウントを持つまで出ません`)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("spec02-02: 代表者が「週間献立を家族に見せる」をオフにすると、行が消えて注記が出て、切り替えのシートに「(献立は非公開)」が出る", async ({
    freshFamilyWithMembers,
    browser,
  }) => {
    test.setTimeout(FAMILY_FLOW_TIMEOUT_MS);
    const { ownerPage, family } = freshFamilyWithMembers;
    const mealId = await createOwnerDinner(ownerPage);

    const { context, page } = await openUserContext(browser, family.adults[0].email);
    try {
      const ownerRow = await openWeeklyAndWaitOwnerRow(page, family.owner.memberId, mealId);

      const shareOff = await apiRequest(ownerPage, SHARE_SETTINGS_API_PATH, {
        method: "PATCH",
        body: { share_menu: false },
      });
      expect(shareOff.status, JSON.stringify(shareOff.body)).toBe(HTTP_OK);

      // 切り替えを適用し直す (プリセットは既定の「家族全員」のまま) → 取り直しと家族の一覧の読み直し
      await page.getByRole("button", { name: "ビューを切替" }).click();
      const sheet = page.getByRole("dialog", { name: "表示するメンバーを選択" });
      await sheet.getByRole("button", { name: "適用する" }).click();

      await expect(ownerRow).toHaveCount(0, { timeout: PAGE_READY_TIMEOUT_MS });
      await expect(page.getByText(`${OWNER_DISPLAY_NAME} は献立を共有していません`)).toBeVisible();

      await page.getByRole("button", { name: "ビューを切替" }).click();
      await expect(page.getByRole("dialog", { name: "表示するメンバーを選択" }).getByText("(献立は非公開)")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("spec02-03: 「自分だけ」を選ぶと家族の行も注記も出ず、家族の献立の API を呼ばない", async ({
    freshFamilyWithMembers,
    browser,
  }) => {
    test.setTimeout(FAMILY_FLOW_TIMEOUT_MS);
    const { ownerPage, family } = freshFamilyWithMembers;
    const mealId = await createOwnerDinner(ownerPage);

    const { context, page } = await openUserContext(browser, family.adults[0].email);
    try {
      const ownerRow = await openWeeklyAndWaitOwnerRow(page, family.owner.memberId, mealId);

      let familyMenuRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === FAMILY_MENU_API_PATH) familyMenuRequests += 1;
      });

      await page.getByRole("button", { name: "ビューを切替" }).click();
      const sheet = page.getByRole("dialog", { name: "表示するメンバーを選択" });
      await sheet.getByRole("button", { name: "自分だけ" }).click();
      // 名前の API の要求は、loadFamilyData が family_members を読み終えた後に出る。その応答が届いた時点で
      // 家族の献立の要求が 0 なら、適用では取らなかったと言える (時間で待たない。設計書 §19.5)
      const namesReloaded = page.waitForResponse(
        (response) => new URL(response.url()).pathname === FAMILY_MEMBER_NAMES_API_PATH,
      );
      await sheet.getByRole("button", { name: "適用する" }).click();
      await namesReloaded;

      await expect(ownerRow).toHaveCount(0);
      await expect(page.getByText(`${CHILD_DISPLAY_NAME} (子供) の献立は、アカウントを持つまで出ません`)).toHaveCount(0);
      await expect(page.getByText("家族の献立を読み込んでいます")).toHaveCount(0);
      expect(familyMenuRequests).toBe(0);
    } finally {
      await context.close();
    }
  });
});
