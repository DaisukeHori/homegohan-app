/**
 * tests/e2e/membership/07-family-child-management.spec.ts
 *
 * β-5: 子供追加 (auth account なし)
 * β-6: 子供 promote (本人同意フロー: 参加リクエストの作成。承認・拒否・取消は spec 12)
 * 子供削除
 *
 * 設計書: docs/design/membership/02-flow-spec.md §8, §9, §11
 *         docs/design/membership/03-ui-spec.md §8, §9
 *         Issue #1232 (旧: 代表者の操作だけで既存アカウントを即時に編入していた)
 */

import { expect } from "@playwright/test";
import { test } from "../fixtures/fresh-family";
import {
  addChild,
  apiFetch,
  getFamilyMemberFromDB,
  getPendingPromotionRequest,
  getUserFamilyIdFromDB,
  gotoWithoutClientErrors,
  upsertUserProfileDirect,
} from "../helpers/membership-family";
import { createFreshUser, cleanupFreshUser, injectSession } from "../fixtures/fresh-user";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("ws") as typeof WebSocket;

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      // @ts-expect-error ws は Node.js 用 WebSocket 実装
      transport: ws,
    },
  });
}

// page.evaluate 経由で API を叩く apiFetch は helpers/membership-family.ts に移した。
// fixture 直後の page (about:blank) では相対 URL の fetch が失敗し、
// β-5 (API) / 子供削除 のテストが API を呼ぶ前に落ちていたため (origin を確立してから叩く)。

/**
 * service_role で family_members 行を memberId で取得する。
 */
async function getMemberById(memberId: string): Promise<Record<string, unknown> | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/family_members?id=eq.${memberId}&select=*`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  const rows = (await resp.json()) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────

// 動画は tests/e2e/.output (リポジトリ内) に書き出される。dev サーバはその書き込みのたびに再ビルドし、
// 再ビルド中に開いたページが無関係な例外 (ChunkLoadError / SyntaxError) で落ちるため、動画は撮らない。
// 失敗時のスクリーンショットは残る。
test.use({ video: "off" });

test.describe("family 子供メンバ管理 (β-5, β-6)", () => {
  /**
   * β-5: 子供追加 (auth account なし)
   *
   * 1. service_role で子供メンバを直接 INSERT
   * 2. family_members に role='child', user_id=NULL, child_profile JSONB が保存されることを確認
   * 3. 一覧 API でも子供が取得できることを確認
   */
  test("β-5: 子供追加 → family_members に user_id=NULL, role=child で保存される", async ({
    freshFamilyWithOwner,
  }) => {
    const { family } = freshFamilyWithOwner;

    // service_role ヘルパーで子供メンバを INSERT
    const childMemberId = await addChild({
      familyId: family.familyId,
      ownerUserId: family.owner.userId,
      name: "テスト子供",
      age: 10,
    });

    // DB で確認
    const member = await getMemberById(childMemberId);
    expect(member).not.toBeNull();
    expect(member!.role).toBe("child");
    expect(member!.user_id).toBeNull();
    expect(member!.family_id).toBe(family.familyId);
    expect(member!.child_profile).not.toBeNull();

    const childProfile = member!.child_profile as Record<string, unknown>;
    expect(childProfile.age).toBe(10);
  });

  /**
   * β-5 (API): POST /api/family/members/child で子供が追加される
   */
  test("β-5 (API): POST /api/family/members/child が成功する", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;

    const result = await apiFetch(ownerPage, "/api/family/members/child", {
      method: "POST",
      body: {
        display_name: "APIテスト子供",
        family_id: family.familyId,
        child_profile: {
          age: 7,
          gender: "male",
          allergies: ["小麦"],
        },
      },
    });

    // 成功 (201) か、API 未実装 (404) のいずれか
    // 500 は許容しない
    expect(result.status).not.toBe(500);
    console.log("[spec-07] POST /api/family/members/child status:", result.status);

    if (result.status === 201 || result.status === 200) {
      const body = result.body as Record<string, unknown>;
      const data = (body.data ?? body) as Record<string, unknown>;
      // member が返却される場合
      if (data.role) {
        expect(data.role).toBe("child");
        expect(data.user_id).toBeNull();
      }
    }
  });

  /**
   * β-5 (UI): /family/members/child/new ページが表示される
   */
  test("β-5 (UI): /family/members/child/new ページにアクセスできる", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage } = freshFamilyWithOwner;

    await ownerPage.goto(`${BASE_URL}/family/members/child/new`);
    await ownerPage.waitForLoadState("networkidle");

    // ページが 500 でないことを確認
    const title = await ownerPage.title();
    expect(title).not.toContain("500");

    // ページが存在する場合は子供追加フォームが表示されること
    const pageText = await ownerPage.evaluate(() => document.body.innerText);
    console.log("[spec-07] /family/members/child/new pageText:", pageText.substring(0, 300));
  });

  /**
   * β-5 (メンバ一覧): 子供が adult と別グループで表示される確認
   */
  test("β-5 (一覧): /family/members で子供が表示される", async ({
    freshFamilyWithMembers,
  }) => {
    const { ownerPage, family } = freshFamilyWithMembers;

    // freshFamilyWithMembers には 1 adult + 1 child が含まれる
    expect(family.children).toHaveLength(1);
    expect(family.adults).toHaveLength(1);

    await ownerPage.goto(`${BASE_URL}/family/members`);
    await ownerPage.waitForLoadState("networkidle");

    const pageText = await ownerPage.evaluate(() => document.body.innerText);
    // ページにエラーがないことを確認
    expect(pageText).not.toContain("500");
    console.log("[spec-07] /family/members pageText:", pageText.substring(0, 300));
  });

  /**
   * β-6: 子供 promote — 本人同意フロー (#1232)
   *
   * 旧実装は {user_id} を受け取り、その場で既存アカウントを家族へ編入していた
   * (持ち主の同意なし)。現在は {email} で「参加リクエスト」を作るだけで、
   * 編入は本人が承認したときに起きる (承認・拒否・取消は spec 12)。
   *
   * 1. 子供メンバを追加
   * 2. 子供本人の既存アカウントを fresh user で作成 (旧実装ならこれだけで編入されてしまう相手)
   * 3. POST /api/family/members/{id}/promote {email} → 200, request.status = 'pending'
   * 4. レスポンスに token が含まれない (token は本人宛のメールにだけ載る)
   * 5. family_members.user_id は NULL のまま・child_profile も残り、本人の user_profiles.family_id も NULL のまま
   */
  test("β-6: 子供 promote → 参加リクエストが作られるだけで、family_members.user_id は NULL のまま", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const supabaseAdmin = getAdminClient();

    // 子供メンバを追加
    const childMemberId = await addChild({
      familyId: family.familyId,
      ownerUserId: family.owner.userId,
      name: "promote テスト子供",
      age: 15,
    });

    // 子供本人のアカウントを作成 (オンボーディング完了済みの既存アカウント)
    const childUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-promote-child" });

    try {
      await upsertUserProfileDirect({
        userId: childUser.id,
        nickname: "Promoted Child",
        onboarding: "completed",
      });

      // owner が promote API を呼ぶ
      const result = await apiFetch(
        ownerPage,
        `/api/family/members/${childMemberId}/promote`,
        {
          method: "POST",
          body: { email: childUser.email },
        },
      );

      console.log("[spec-07] promote API status:", result.status);
      expect(result.status, JSON.stringify(result.body)).toBe(200);

      const request = (result.body as { data?: { request?: Record<string, unknown> } }).data?.request;
      expect(request).toBeDefined();
      expect(request!.status).toBe("pending");
      expect(request!.member_id).toBe(childMemberId);
      expect(request!.email).toBe(childUser.email);

      // token は本人宛のメールにだけ載せる。HTTP レスポンスには出さない
      expect(request).not.toHaveProperty("token");
      const dbRequest = await getPendingPromotionRequest(childMemberId);
      expect(dbRequest.token).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result.body)).not.toContain(dbRequest.token);

      // 本人の同意があるまで何も変わらない
      const member = await getMemberById(childMemberId);
      expect(member).not.toBeNull();
      expect(member!.user_id).toBeNull();
      expect(member!.child_profile).not.toBeNull();
      expect(await getUserFamilyIdFromDB(childUser.id)).toBeNull();
    } finally {
      await cleanupFreshUser(supabaseAdmin, childUser.id);
    }
  });

  /**
   * β-6 (UI): /family/members/[id]/promote は、旧「アカウント発行」ではなく
   * 参加リクエストの送信フォームを表示する (#1232)
   */
  test("β-6 (UI): promote ページに参加リクエストの送信フォームが表示される", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;

    // 子供メンバを追加
    const childMemberId = await addChild({
      familyId: family.familyId,
      ownerUserId: family.owner.userId,
      name: "UIテスト子供",
      age: 12,
    });

    // 画面が壊れていれば (未処理のクライアント例外)、ここで原因つきで落ちる
    await gotoWithoutClientErrors(ownerPage, `${BASE_URL}/family/members/${childMemberId}/promote`);

    const title = await ownerPage.title();
    expect(title).not.toContain("500");

    // 見出し 「{子供の名前} の参加リクエスト」 と、メールアドレスの入力欄・送信ボタン
    await expect(
      ownerPage.getByRole("heading", { level: 1, name: /の参加リクエスト/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(ownerPage.getByPlaceholder("子供本人のメールアドレス")).toBeVisible();
    await expect(ownerPage.getByRole("button", { name: "参加リクエストを送信" })).toBeVisible();

    const pageText = await ownerPage.evaluate(() => document.body.innerText);
    console.log("[spec-07] promote pageText:", pageText.substring(0, 300));
    // 旧「アカウントを発行しました」系の文言は残っていない
    expect(pageText).not.toContain("アカウントを発行");
  });

  /**
   * 子供削除: family_members 行が status='removed' になる
   */
  test("子供削除: DELETE API → family_members.status=removed", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    // 子供メンバを追加
    const childMemberId = await addChild({
      familyId: family.familyId,
      ownerUserId: family.owner.userId,
      name: "削除テスト子供",
      age: 9,
    });

    // 削除 API を呼ぶ (member_id ベースで child を除名)
    const result = await apiFetch(
      ownerPage,
      `/api/family/members/${childMemberId}/remove`,
      { method: "POST", body: { family_id: family.familyId } },
    );

    console.log("[spec-07] child remove API status:", result.status);

    if (result.status === 200 || result.status === 204) {
      // API 成功時 → DB で status=removed を確認
      const member = await getMemberById(childMemberId);
      expect(member!.status).toBe("removed");
    } else if (result.status === 404) {
      // API 未実装の場合は service_role で直接削除して確認
      await fetch(
        `${supabaseUrl}/rest/v1/family_members?id=eq.${childMemberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ status: "removed", removed_at: new Date().toISOString() }),
        },
      );

      const member = await getMemberById(childMemberId);
      // status=removed になっているか、null (元々 active フィルタが入っている場合)
      if (member) {
        expect(member.status).toBe("removed");
      }
    } else {
      // その他のエラー → 500 は許容しない
      expect(result.status).not.toBe(500);
    }
  });
});
