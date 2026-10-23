/**
 * tests/e2e/membership/15-self-dissolve.spec.ts
 *
 * #1917 代表者・オーナーが自分で家族グループ・組織を解散し、そのあと退会できる
 * (設計書: docs/design/family/11-self-dissolve.md §21.4)
 *   - spec15-01: 代表者が POST /api/family/dissolve で解散 → DB の状態 → POST /api/account/delete が 200
 *   - spec15-02: 大人が POST /api/family/dissolve → 403 NOT_FAMILY_REPRESENTATIVE (家族は active のまま)
 *   - spec15-03: 代表者がメンバーシップ設定の画面で解散する (画面の経路)
 *   - spec15-04: オーナーが POST /api/org/dissolve で解散 → DB の状態 → POST /api/account/delete が 200
 */

import { expect } from "@playwright/test";
import { test } from "../fixtures/fresh-family";
import { setupFreshOrgWithMembers } from "../fixtures/fresh-org";
import { injectSession } from "../fixtures/fresh-user";
import { apiFetch, getFamilyGroupFromDB, gotoWithoutClientErrors } from "../helpers/membership-family";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/** この spec が叩く API (tests/e2e-api-paths.test.ts が実在を確かめる) */
const FAMILY_DISSOLVE_API = "/api/family/dissolve";
const ORG_DISSOLVE_API = "/api/org/dissolve";
const ACCOUNT_DELETE_API = "/api/account/delete";

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
/** 画面の待ちの上限 (ミリ秒) */
const UI_TIMEOUT_MS = 15_000;

/** service_role の REST で行を読む (assertion 用) */
async function serviceSelect(endpoint: string): Promise<Array<Record<string, unknown>>> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const resp = await fetch(`${supabaseUrl}/rest/v1/${endpoint}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  return (await resp.json()) as Array<Record<string, unknown>>;
}

test.describe("#1917 家族グループの解散 (代表者)", () => {
  test("spec15-01: 代表者が POST /api/family/dissolve で解散 → DB は dissolved・representative_id NULL・メンバー left・family_id NULL・membership_audit に group_dissolved → そのあと POST /api/account/delete が 200", async ({
    freshFamilyWithMembers,
  }) => {
    const { ownerPage, family } = freshFamilyWithMembers;
    const adult = family.adults[0];

    const dissolved = await apiFetch(ownerPage, FAMILY_DISSOLVE_API, {
      method: "POST",
      body: { family_id: family.familyId, confirm: true },
    });
    expect(dissolved.status).toBe(HTTP_OK);
    expect((dissolved.body as { data: { family_id: string } }).data.family_id).toBe(family.familyId);

    const group = await getFamilyGroupFromDB(family.familyId);
    expect(group?.status).toBe("dissolved");
    expect(group?.representative_id).toBeNull();
    expect(group?.dissolved_at).not.toBeNull();

    const members = await serviceSelect(`family_members?family_id=eq.${family.familyId}&select=status`);
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.status === "left")).toBe(true);
    const profiles = await serviceSelect(`user_profiles?id=in.(${family.owner.userId},${adult.userId})&select=family_id`);
    expect(profiles.every((p) => p.family_id === null)).toBe(true);
    const audits = await serviceSelect(
      `membership_audit?scope=eq.family&scope_id=eq.${family.familyId}&action=eq.group_dissolved&select=actor_id`,
    );
    expect(audits).toEqual([{ actor_id: family.owner.userId }]);

    const deleted = await apiFetch(ownerPage, ACCOUNT_DELETE_API, { method: "POST", body: { confirm: true } });
    expect(deleted.status).toBe(HTTP_OK);
  });

  test("spec15-02: 大人が POST /api/family/dissolve → 403 NOT_FAMILY_REPRESENTATIVE。家族は active のまま", async ({
    freshFamilyWithMembers,
    browser,
  }) => {
    const { family } = freshFamilyWithMembers;
    const adult = family.adults[0];
    const adultCtx = await browser.newContext();
    const adultPage = await adultCtx.newPage();
    try {
      await injectSession(adultPage, adult.email);
      const res = await apiFetch(adultPage, FAMILY_DISSOLVE_API, {
        method: "POST",
        body: { family_id: family.familyId, confirm: true },
      });
      expect(res.status).toBe(HTTP_FORBIDDEN);
      expect((res.body as { error: { code: string } }).error.code).toBe("NOT_FAMILY_REPRESENTATIVE");
      const group = await getFamilyGroupFromDB(family.familyId);
      expect(group?.status).toBe("active");
      expect(group?.representative_id).toBe(family.owner.userId);
    } finally {
      await adultCtx.close();
    }
  });

  test("spec15-03: 代表者がメンバーシップ設定で「家族グループを解散」→「解散します」を入力 → 押す → 「家族グループを解散しました。」が出て、所属家族が「所属していません」になる。ページを読み直しても「所属していません」のまま", async ({
    freshFamilyWithOwner,
  }) => {
    const { ownerPage, family } = freshFamilyWithOwner;
    await gotoWithoutClientErrors(ownerPage, `${BASE_URL}/settings/membership`);

    await ownerPage.getByRole("button", { name: "家族グループを解散" }).click({ timeout: UI_TIMEOUT_MS });
    await ownerPage.getByTestId("self-dissolve-family-keyword").fill("解散します");
    await ownerPage.getByTestId("self-dissolve-family-submit").click();

    await expect(ownerPage.getByRole("status")).toHaveText("家族グループを解散しました。", { timeout: UI_TIMEOUT_MS });
    const familySection = ownerPage.locator("section", { has: ownerPage.getByRole("heading", { name: "所属家族" }) });
    await expect(familySection).toContainText("所属していません");

    await ownerPage.reload();
    await expect(
      ownerPage.locator("section", { has: ownerPage.getByRole("heading", { name: "所属家族" }) }),
    ).toContainText("所属していません", { timeout: UI_TIMEOUT_MS });
    const group = await getFamilyGroupFromDB(family.familyId);
    expect(group?.status).toBe("dissolved");
  });
});

test.describe("#1917 組織の解散 (オーナー)", () => {
  test("spec15-04: オーナーが POST /api/org/dissolve で解散 → organizations は dissolved・owner_id NULL・メンバーの所属が外れる → POST /api/account/delete が 200", async ({
    page,
  }) => {
    const org = await setupFreshOrgWithMembers({ memberCount: 1, ownerPage: page });
    try {
      const dissolved = await apiFetch(page, ORG_DISSOLVE_API, {
        method: "POST",
        body: { organization_id: org.orgId, confirm: true },
      });
      expect(dissolved.status).toBe(HTTP_OK);

      const rows = await serviceSelect(`organizations?id=eq.${org.orgId}&select=status,owner_id`);
      expect(rows).toEqual([{ status: "dissolved", owner_id: null }]);
      const memberIds = [org.owner.id, org.admin.id, ...org.members.map((m) => m.id)];
      const profiles = await serviceSelect(`user_profiles?id=in.(${memberIds.join(",")})&select=organization_id,org_role`);
      expect(profiles).toHaveLength(memberIds.length);
      expect(profiles.every((p) => p.organization_id === null && p.org_role === null)).toBe(true);

      const deleted = await apiFetch(page, ACCOUNT_DELETE_API, { method: "POST", body: { confirm: true } });
      expect(deleted.status).toBe(HTTP_OK);
    } finally {
      // 組織の行を消してから利用者を消す (owner_id → auth.users は ON DELETE RESTRICT。解散した行は owner_id が NULL)
      await org.cleanup();
    }
  });
});
