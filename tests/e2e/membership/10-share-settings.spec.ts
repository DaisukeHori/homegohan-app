/**
 * tests/e2e/membership/10-share-settings.spec.ts
 *
 * spec10: 共有設定 (share settings) — P7 実装
 *
 * 設計書: membership/02-flow-spec.md §13
 *
 * テスト戦略:
 *   - fresh 2 名 family をセットアップ
 *   - PATCH /api/family/members/me/share で share_meals/health/menu を個別 OFF
 *   - service_role で family_members の値を確認
 *   - 各 toggle が独立していることを確認
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
  getFamilyMemberShareSettings,
  patchShareSettings,
  cleanupFamily,
} from "../helpers/membership-paste";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// worktree 環境でも .env.local を読み込む (3段フォールバック)
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────

test.describe("共有設定 (share settings)", () => {
  /**
   * spec10-01: share_meals OFF で DB に反映される
   */
  test("spec10-01: share_meals OFF → PATCH 200 + DB 反映", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-member" });

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
          nickname: `E2E Share ${u.email}`,
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
        familyName: `E2E Share Family ${Date.now()}`,
      });
      familyId = family.familyId;

      // member としてログイン
      await injectSession(page, memberUser.email, memberUser.password);
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      // PATCH share_meals = false
      const result = await patchShareSettings(page, { share_meals: false });
      expect(result.status, "PATCH /api/family/members/me/share は 200 を返すこと").toBe(200);

      // DB で確認
      const settings = await getFamilyMemberShareSettings({
        familyId,
        userId: memberUser.id,
      });

      expect(settings, "family_members レコードが存在すること").toBeTruthy();
      expect(settings?.share_meals, "share_meals が false に更新されること").toBe(false);
      // 他の設定は変わらない
      expect(settings?.share_menu, "share_menu は true のまま").toBe(true);
    } finally {
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec10-02: share_meals OFF → ON で復活
   */
  test("spec10-02: share_meals OFF → ON で復活", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-on-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-on-member" });

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
          nickname: `E2E ShareOn ${u.email}`,
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

      await injectSession(page, memberUser.email, memberUser.password);
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      // OFF にする
      await patchShareSettings(page, { share_meals: false });
      const settingsOff = await getFamilyMemberShareSettings({ familyId, userId: memberUser.id });
      expect(settingsOff?.share_meals, "OFF に設定されること").toBe(false);

      // ON に戻す
      const resultOn = await patchShareSettings(page, { share_meals: true });
      expect(resultOn.status, "ON への変更も 200").toBe(200);

      const settingsOn = await getFamilyMemberShareSettings({ familyId, userId: memberUser.id });
      expect(settingsOn?.share_meals, "ON に復活すること").toBe(true);
    } finally {
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec10-03: share_health の独立 toggle
   */
  test("spec10-03: share_health OFF は share_meals/share_menu に影響しない", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-h-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-h-member" });

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
          nickname: `E2E ShareH ${u.email}`,
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

      await injectSession(page, memberUser.email, memberUser.password);
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      // share_health だけ OFF
      const result = await patchShareSettings(page, { share_health: true });
      expect(result.status).toBe(200);

      // share_health を OFF
      const resultOff = await patchShareSettings(page, { share_health: false });
      expect(resultOff.status, "share_health OFF も 200").toBe(200);

      const settings = await getFamilyMemberShareSettings({ familyId, userId: memberUser.id });
      expect(settings?.share_health, "share_health が false に").toBe(false);
      expect(settings?.share_meals, "share_meals は変わらず true").toBe(true);
      expect(settings?.share_menu, "share_menu は変わらず true").toBe(true);
    } finally {
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec10-04: share_menu の独立 toggle
   */
  test("spec10-04: share_menu OFF は share_meals/share_health に影響しない", async ({ page }) => {
    const supabaseAdmin = getAdminClient();
    const ownerUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-m-owner" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-share-m-member" });

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
          nickname: `E2E ShareM ${u.email}`,
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

      await injectSession(page, memberUser.email, memberUser.password);
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await page.goto(`${baseURL}/home`);

      // share_menu だけ OFF
      const result = await patchShareSettings(page, { share_menu: false });
      expect(result.status, "share_menu OFF も 200").toBe(200);

      const settings = await getFamilyMemberShareSettings({ familyId, userId: memberUser.id });
      expect(settings?.share_menu, "share_menu が false に").toBe(false);
      expect(settings?.share_meals, "share_meals は変わらず true").toBe(true);
      // share_health は初期値 false のまま
      expect(settings?.share_health, "share_health は変わらず false").toBe(false);
    } finally {
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [ownerUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, ownerUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec10-05: 未認証は PATCH 401
   */
  test("spec10-05: 未認証の PATCH /api/family/members/me/share は 401", async ({ page }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    await page.goto(`${baseURL}/login`);

    const result = await page.evaluate(async () => {
      const res = await fetch("/api/family/members/me/share", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ share_meals: false }),
      });
      return { status: res.status };
    });

    expect(result.status, "未認証は 401").toBe(401);
  });
});
