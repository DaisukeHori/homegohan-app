/**
 * tests/e2e/family/01-invite-accept-share.spec.ts
 *
 * T14 (#856) — 家族のペルソナの happy path: 代表者が招待 → 招待された人が承諾 → 家族で共有する献立の画面を見る
 *
 *   T14-F1: 未ログインでは家族の招待を作れない (401)
 *   T14-F2: 家族に入っていない人は、その家族の招待を作れない (403)
 *   T14-F3: 代表者が招待を作り (POST /api/family/invites)、招待された人が招待の画面 (/invite/{token}) で
 *           「週間献立」を共有する設定のまま承諾すると、家族の画面と、週間献立の画面の家族の表示の切り替えに 2 人の家族として出る
 *
 * ユーザー:
 *   - 代表者: fixtures/fresh-family.ts の freshFamilyWithOwner (家族と代表者のメンバーの行を service_role で作る)
 *   - 招待された人: このテストの中で作り、別のブラウザのコンテキストで動かす (helpers/persona-api.ts の openUserContext)
 *   - 家族に入っていない人: fixtures/fresh-user.ts の regularUser
 * どのユーザーも、SUPABASE_SERVICE_ROLE_KEY (.env.local) が無ければ fixture が例外で失敗する (skip にはしない)。
 *
 * 実行:
 *   npx playwright test tests/e2e/family
 */

import { randomUUID } from "node:crypto";
import { mergeTests } from "@playwright/test";
import {
  test as freshUserTest,
  expect,
  createFreshUser,
  getAdminClient,
  upsertUserProfile,
} from "../fixtures/fresh-user";
import { test as freshFamilyTest } from "../fixtures/fresh-family";
import { getFamilyInviteFromDB, getFamilyMemberFromDB } from "../helpers/membership-family";
import {
  EMPTY_STORAGE_STATE,
  apiRequest,
  dataOf,
  deleteRoleUser,
  errorCodeOf,
  openUserContext,
  serviceRoleRest,
} from "../helpers/persona-api";

const test = mergeTests(freshUserTest, freshFamilyTest);

// 共有のログイン状態 (playwright.config.ts の storageState) を引き継がず、各テストが自分のユーザーで入る
test.use({ storageState: EMPTY_STORAGE_STATE });

// ─── 定数 ────────────────────────────────────────────────────────────────────

/**
 * T14-F3 の時間の上限。招待・承諾のあと、家族の画面と週間献立の画面 (大きいクライアントの画面) を本番ビルドで順に開く。
 * playwright.config.ts の既定 (60 秒) は 1 画面を開くテストの長さなので、開く画面の数のぶん延ばす。
 */
const FAMILY_FLOW_TIMEOUT_MS = 180_000;

/** 画面の要素が出るまで待つ上限 (ほかの spec と同じ。本番ビルドの初回の描画を含めて足りる長さ) */
const PAGE_READY_TIMEOUT_MS = 20_000;

/** 招待のトークンの長さ (create_family_invite が gen_random_uuid() 2 つの 16 進 (32 + 32 文字) を連ねて作る) */
const FAMILY_INVITE_TOKEN_LENGTH = 64;

/** 承諾のあとの家族の人数 (代表者 + 承諾した人) */
const MEMBER_COUNT_AFTER_ACCEPT = 2;

/** 代表者のメンバーの表示名 (fixtures/fresh-family.ts の buildFamilyFixture が付ける) */
const OWNER_DISPLAY_NAME = "お母さん";

// ─── テスト ──────────────────────────────────────────────────────────────────

test.describe("family: 招待 → 承諾 → 共有の献立の閲覧 (T14)", () => {
  test("T14-F1: 未ログインで家族の招待を作ろうとすると 401", async ({ page }) => {
    const { status, body } = await apiRequest(page, "/api/family/invites", {
      method: "POST",
      body: { family_id: randomUUID(), email: `e2e-t14-f1-${Date.now()}@homegohan.test` },
    });

    expect(status).toBe(401);
    expect(errorCodeOf(body)).toBe("NOT_AUTHENTICATED");
  });

  test("T14-F2: 家族に入っていない人は、その家族の招待を作れない (403)", async ({ regularUser }) => {
    const { status, body } = await apiRequest(regularUser, "/api/family/invites", {
      method: "POST",
      body: { family_id: randomUUID(), email: `e2e-t14-f2-${Date.now()}@homegohan.test` },
    });

    expect(status).toBe(403);
    expect(errorCodeOf(body)).toBe("NOT_FAMILY_ADULT");
  });

  test("T14-F3: 代表者が招待し、招待された人が承諾すると、家族の画面と週間献立の家族の表示に 2 人で出る", async ({
    freshFamilyWithOwner,
    browser,
  }) => {
    test.setTimeout(FAMILY_FLOW_TIMEOUT_MS);
    const { ownerPage, family } = freshFamilyWithOwner;

    // 招待される人 (初期設定は済ませておく。まだ家族には入っていない)
    const invitee = await createFreshUser(getAdminClient(), { emailPrefix: "e2e-t14-family-invitee" });
    let inviteeContext: Awaited<ReturnType<typeof openUserContext>>["context"] | null = null;

    try {
      await upsertUserProfile(invitee.id, { nickname: "E2E T14 Invitee" });

      // 1. 代表者が招待を作る (アプリの API。メールの送信に失敗しても招待は残る)
      const created = await apiRequest(ownerPage, "/api/family/invites", {
        method: "POST",
        body: { family_id: family.familyId, email: invitee.email },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const createdData = dataOf(created.body) as { invite?: { token?: unknown }; invite_url?: unknown };
      const token = createdData.invite?.token;
      if (typeof token !== "string") {
        throw new Error(`招待の応答に token がありません: ${JSON.stringify(created.body)}`);
      }
      expect(token).toHaveLength(FAMILY_INVITE_TOKEN_LENGTH);
      expect(createdData.invite_url).toEqual(expect.stringContaining(`/invite/${token}`));

      const pendingInvite = await getFamilyInviteFromDB(token);
      expect(pendingInvite?.family_id).toBe(family.familyId);
      expect(pendingInvite?.status).toBe("pending");

      // 2. 招待された人が、自分のブラウザで招待の画面を開いて承諾する (共有の設定は既定のまま。週間献立は共有する)
      const opened = await openUserContext(browser, invitee.email);
      inviteeContext = opened.context;
      const inviteePage = opened.page;

      await inviteePage.goto(`/invite/${token}`);
      await expect(inviteePage.getByRole("heading", { name: `${family.familyName}への招待` })).toBeVisible({
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      const shareMenuCheckbox = inviteePage.locator("label", { hasText: "週間献立" }).locator('input[type="checkbox"]');
      await expect(shareMenuCheckbox).toBeChecked();

      await inviteePage.getByRole("button", { name: "承諾する" }).click();
      await inviteePage.waitForURL((url) => url.pathname === "/family/dashboard", { timeout: PAGE_READY_TIMEOUT_MS });

      // 家族の画面: 家族の名前と、代表者・承諾した人の 2 人が出る
      await expect(inviteePage.getByRole("heading", { level: 1 })).toHaveText(family.familyName, {
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      await expect(inviteePage.getByText(new RegExp(`^${MEMBER_COUNT_AFTER_ACCEPT}/\\d+ 人$`))).toBeVisible();
      await expect(inviteePage.getByText(OWNER_DISPLAY_NAME)).toBeVisible();

      // DB: 招待は承諾済み。承諾した人は大人のメンバーで、週間献立を共有する
      const acceptedInvite = await getFamilyInviteFromDB(token);
      expect(acceptedInvite?.status).toBe("accepted");
      expect(acceptedInvite?.accepted_by).toBe(invitee.id);
      const inviteeMember = await getFamilyMemberFromDB({ familyId: family.familyId, userId: invitee.id });
      expect(inviteeMember?.role).toBe("adult");
      expect(inviteeMember?.share_menu).toBe(true);

      // 3. 承諾した人が週間献立の画面を開くと、家族の表示の切り替え (既定は「家族全員」) に 2 人の家族として出る
      await inviteePage.goto("/menus/weekly");
      const familyViewSwitcher = inviteePage.getByRole("button", { name: "ビューを切替" });
      await expect(familyViewSwitcher).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
      await expect(familyViewSwitcher).toContainText("家族全員");
      await expect(familyViewSwitcher).toContainText(`${MEMBER_COUNT_AFTER_ACCEPT}人`);

      // 表示するメンバーの選択に、代表者が出る
      await familyViewSwitcher.click();
      const memberSheet = inviteePage.getByRole("dialog", { name: "表示するメンバーを選択" });
      await expect(memberSheet).toBeVisible();
      await expect(memberSheet.getByText(OWNER_DISPLAY_NAME)).toBeVisible();
    } finally {
      await inviteeContext?.close();
      // 承諾した人のメンバーの行を先に消す (残したまま利用者を消すと family_members.user_id が NULL になり、
      // 大人の行は user_id 必須の CHECK (family_members_child_profile_consistency) に反して消せない)
      await serviceRoleRest(`family_members?user_id=eq.${invitee.id}`, { method: "DELETE" });
      await deleteRoleUser(invitee.id);
    }
  });
});
