/**
 * tests/e2e/membership/09-meal-paste.spec.ts
 *
 * spec09: meal paste (家族へのペースト) — P7 実装
 *
 * 設計書: membership/02-flow-spec.md §12
 *
 * テスト戦略:
 *   - fresh user 2 名を admin API で生成し、family を直接 INSERT してセットアップ
 *   - API レベルで POST /api/meals/paste を検証 (UI 依存を避けて安定化)
 *   - paste_group_id が全対象ユーザに共通であることを service_role で確認
 */

import { test, expect } from "../fixtures/fresh-user";
import {
  createFreshUser,
  cleanupFreshUser,
  injectSession,
} from "../fixtures/fresh-user";
import {
  getAdminClient,
  setupFamilyWithTwoMembers,
  createMealForUser,
  pasteToFamily,
  verifyMealsCount,
  cleanupFamily,
  cleanupUserMeals,
} from "../helpers/membership-paste";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// worktree 環境でも .env.local を読み込む (3段フォールバック)
// membership/ から worktree root は 3 段上、main repo は 6 段上
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────

test.describe("meal paste (家族へのペースト)", () => {
  /**
   * spec09-01: ペースト実行 happy path
   *
   * preCondition: family with owner + adult member 1 名
   * 1. owner が meals テーブルに 1 食追加 (direct INSERT)
   * 2. POST /api/meals/paste → paste_group_id 返却
   * 3. 全対象ユーザーの meals に複製確認、paste_group_id 同じであること
   */
  test("spec09-01: ペースト実行 happy path — paste_group_id が共通", async ({ page }) => {
    const supabaseAdmin = getAdminClient();

    // --- setup: 2 名の fresh user を生成 ---
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-paste-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-paste-member" });

    // user_profiles を UPSERT (必須: onboarding 完了)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    for (const u of [ownerUser, memberUser]) {
      const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          id: u.id,
          nickname: `E2E Paste User ${u.email}`,
          age_group: "30s",
          gender: "unspecified",
          roles: ["user"],
          onboarding_completed_at: new Date().toISOString(),
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`user_profiles UPSERT 失敗 (${resp.status}): ${text.substring(0, 200)}`);
      }
    }

    let familyId: string | undefined;
    let sourceMealId: string | undefined;

    try {
      // --- family セットアップ ---
      const family = await setupFamilyWithTwoMembers({
        ownerId: ownerUser.id,
        ownerEmail: ownerUser.email,
        memberId: memberUser.id,
        memberEmail: memberUser.email,
        familyName: `E2E Paste Family ${Date.now()}`,
      });
      familyId = family.familyId;

      // --- owner の meal を作成 ---
      const today = new Date().toISOString().split("T")[0];
      sourceMealId = await createMealForUser({
        userId: ownerUser.id,
        mealDate: today,
        mealTime: "dinner",
        menuName: "テスト夕食",
      });

      // --- owner の session で page を認証 ---
      await injectSession(page, ownerUser.email, ownerUser.password);

      // --- POST /api/meals/paste ---
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      const result = await pasteToFamily(page, {
        sourceMealId,
        targetUserIds: [memberUser.id],
      });

      // --- アサーション: API 200 + paste_group_id ---
      expect(result.status, "POST /api/meals/paste は 200 を返すこと").toBe(200);
      expect(result.pasteGroupId, "paste_group_id が返却されること").toBeTruthy();
      expect(result.insertedCount, "inserted_count が 1 であること").toBe(1);

      const pasteGroupId = result.pasteGroupId!;

      // --- service_role で member の meals を確認 ---
      const { counts } = await verifyMealsCount({
        userIds: [ownerUser.id, memberUser.id],
        expectedCount: 1,
        pasteGroupId,
      });

      // source meal にも paste_group_id が付くのでオーナー側も 1 件
      expect(
        counts[ownerUser.id],
        `オーナー (${ownerUser.id}) の paste_group_id=${pasteGroupId} の meal が 1 件以上あること`,
      ).toBeGreaterThanOrEqual(1);

      // member には複製が 1 件
      expect(
        counts[memberUser.id],
        `メンバー (${memberUser.id}) に paste_group_id=${pasteGroupId} の meal が 1 件複製されること`,
      ).toBe(1);
    } finally {
      // --- cleanup ---
      if (sourceMealId) await cleanupUserMeals(ownerUser.id);
      await cleanupUserMeals(memberUser.id);
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec09-02: paste_group 表示確認 (複製 meal が paste_group_id を共有)
   *
   * ペースト後に source meal と複製 meal が同じ paste_group_id を持つことを確認。
   */
  test("spec09-02: ペースト後に source と複製が同じ paste_group_id を持つ", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-paste-group-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-paste-group-member" });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    for (const u of [ownerUser, memberUser]) {
      await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          id: u.id,
          nickname: `E2E PasteGroup ${u.email}`,
          age_group: "30s",
          gender: "unspecified",
          roles: ["user"],
          onboarding_completed_at: new Date().toISOString(),
        }),
      });
    }

    let familyId: string | undefined;

    try {
      const family = await setupFamilyWithTwoMembers({
        ownerId: ownerUser.id,
        ownerEmail: ownerUser.email,
        memberId: memberUser.id,
        memberEmail: memberUser.email,
      });
      familyId = family.familyId;

      const today = new Date().toISOString().split("T")[0];
      const sourceMealId = await createMealForUser({
        userId: ownerUser.id,
        mealDate: today,
        mealTime: "lunch",
        menuName: "テスト昼食",
      });

      await injectSession(page, ownerUser.email, ownerUser.password);
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      const result = await pasteToFamily(page, {
        sourceMealId,
        targetUserIds: [memberUser.id],
      });

      expect(result.status).toBe(200);
      expect(result.pasteGroupId).toBeTruthy();

      const pasteGroupId = result.pasteGroupId!;

      // source meal の paste_group_id を確認 (service_role)
      const sourceResp = await fetch(
        `${supabaseUrl}/rest/v1/meals?id=eq.${sourceMealId}&select=paste_group_id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const sourceRows = (await sourceResp.json()) as Array<{ paste_group_id: string | null }>;
      expect(
        sourceRows[0]?.paste_group_id,
        "source meal の paste_group_id が設定されること",
      ).toBe(pasteGroupId);

      // member の複製 meal の paste_group_id を確認
      const memberResp = await fetch(
        `${supabaseUrl}/rest/v1/meals?user_id=eq.${memberUser.id}&paste_group_id=eq.${pasteGroupId}&select=id,paste_group_id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const memberRows = (await memberResp.json()) as Array<{ id: string; paste_group_id: string }>;
      expect(memberRows.length, "member に複製 meal が 1 件あること").toBe(1);
      expect(memberRows[0]?.paste_group_id, "複製 meal の paste_group_id が一致すること").toBe(pasteGroupId);
    } finally {
      await cleanupUserMeals(ownerUser.id);
      await cleanupUserMeals(memberUser.id);
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec09-03: 他人の meal はペーストできない (403)
   */
  test("spec09-03: 他人の meal をペーストしようとすると 403 が返る", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-paste-auth-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-paste-auth-member" });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    for (const u of [ownerUser, memberUser]) {
      await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          id: u.id,
          nickname: `E2E PasteAuth ${u.email}`,
          age_group: "30s",
          gender: "unspecified",
          roles: ["user"],
          onboarding_completed_at: new Date().toISOString(),
        }),
      });
    }

    let familyId: string | undefined;

    try {
      const family = await setupFamilyWithTwoMembers({
        ownerId: ownerUser.id,
        ownerEmail: ownerUser.email,
        memberId: memberUser.id,
        memberEmail: memberUser.email,
      });
      familyId = family.familyId;

      const today = new Date().toISOString().split("T")[0];
      // owner の meal を作成
      const ownerMealId = await createMealForUser({
        userId: ownerUser.id,
        mealDate: today,
        mealTime: "breakfast",
        menuName: "オーナーの朝食",
      });

      // member としてログイン (owner の meal をペーストしようとする)
      await injectSession(page, memberUser.email, memberUser.password);
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      const result = await pasteToFamily(page, {
        sourceMealId: ownerMealId,
        targetUserIds: [memberUser.id],
      });

      // 他人の meal なので 403 が期待される
      expect(
        [403, 400],
        `他人の meal のペーストは 403 か 400 が返ること (実際: ${result.status})`,
      ).toContain(result.status);
    } finally {
      await cleanupUserMeals(ownerUser.id);
      await cleanupUserMeals(memberUser.id);
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });
});
