/**
 * tests/e2e/membership/11-operator-emergency.spec.ts
 *
 * spec11: 運営管理者 緊急介入 (super_admin) — P7 実装
 *
 * 設計書: membership/02-flow-spec.md §14, 05-operator-emergency-ui.md
 *
 * テスト戦略:
 *   - superAdminUser fixture (fresh-user.ts) を使用
 *   - inactive org/family を service_role で直接セットアップ
 *   - API レベルで POST transfer/dissolve → 200 確認 + DB 検証
 *   - GET /api/operator/membership/audit でログ確認
 *
 * 注意: UI フルフローは後続 phase で実装予定。
 *       本 spec は API + DB 整合性を中心に検証する。
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
  cleanupFamily,
} from "../helpers/membership-paste";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

// worktree 環境でも .env.local を読み込む (3段フォールバック)
dotenvConfig({ path: path.resolve(__dirname, "../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../.env.local") });
dotenvConfig({ path: path.resolve(__dirname, "../../../../../../.env.local") });

// ─────────────────────────────────────────────────────────────────────────────
// 共通ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/** page.evaluate 経由で API を叩く */
async function apiFetch(
  page: import("@playwright/test").Page,
  apiPath: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async (args: { path: string; method: string; body: unknown }) => {
      const res = await fetch(args.path, {
        method: args.method,
        headers: args.body ? { "Content-Type": "application/json" } : {},
        credentials: "include",
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      return { status: res.status, body };
    },
    { path: apiPath, method: options.method ?? "GET", body: options.body ?? null },
  );
}

/** organization を service_role で INSERT し id を返す */
async function createTestOrg(params: { ownerId: string; name?: string }): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const name = params.name ?? `E2E Operator Org ${Date.now()}`;

  const resp = await fetch(`${supabaseUrl}/rest/v1/organizations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ name, plan: "standard", owner_id: params.ownerId }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`organizations INSERT 失敗 (${resp.status}): ${text.substring(0, 200)}`);
  }
  const rows = (await resp.json()) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error("organizations INSERT: id が返却されませんでした");
  return id;
}

/** user_profiles を service_role で UPSERT する */
async function upsertProfile(params: {
  userId: string;
  nickname?: string;
  roles?: string[];
  organizationId?: string | null;
  orgRole?: string | null;
  lastLoginAt?: string | null;
}): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const body: Record<string, unknown> = {
    id: params.userId,
    nickname: params.nickname ?? "E2E Operator Test User",
    age_group: "30s",
    gender: "unspecified",
    roles: params.roles ?? ["user"],
    onboarding_completed_at: new Date().toISOString(),
  };

  if (params.organizationId !== undefined) body.organization_id = params.organizationId;
  if (params.orgRole !== undefined) body.org_role = params.orgRole;
  if (params.lastLoginAt !== undefined) body.last_login_at = params.lastLoginAt;

  const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`user_profiles UPSERT 失敗 (${resp.status}): ${text.substring(0, 200)}`);
  }
}

/** 31日前の日時文字列 (inactive 判定: 90日より厳しいテスト用に短くするが、RPC がデフォルト 90日) */
function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────────────────────────────────────

test.describe("運営管理者 緊急介入 (super_admin)", () => {
  /**
   * spec11-01: 非 super_admin は operator API に 401/403
   */
  test("spec11-01: 非 super_admin は /api/operator/membership/orgs/inactive に 401 または 403", async ({
    page,
  }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    await page.goto(`${baseURL}/login`);

    // 未認証
    const { status } = await apiFetch(page, "/api/operator/membership/orgs/inactive");
    expect([401, 403], `未認証は 401 か 403 (実際: ${status})`).toContain(status);
  });

  /**
   * spec11-02: super_admin は inactive org 一覧を取得できる
   *
   * - fresh owner user を作り last_login_at を 91 日前に設定
   * - organizations に owner として INSERT
   * - super_admin で GET /api/operator/membership/orgs/inactive → 200
   */
  test("spec11-02: super_admin が inactive org 一覧を取得できる", async ({ superAdminUser }) => {
    const supabaseAdmin = getAdminClient();

    // inactive owner を作成
    const inactiveOwner = await createFreshUser(supabaseAdmin, {
      emailPrefix: "e2e-op-inactive-owner",
    });

    let orgId: string | undefined;

    try {
      // last_login_at = 91日前で upsert (inactive 判定対象)
      await upsertProfile({
        userId: inactiveOwner.id,
        nickname: "Inactive Owner",
        roles: ["user"],
        lastLoginAt: daysAgoISO(91),
      });

      orgId = await createTestOrg({ ownerId: inactiveOwner.id, name: `E2E Inactive Org ${Date.now()}` });

      // super_admin page で API 叩く
      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await superAdminUser.page.goto(`${baseURL}/home`);

      const result = await apiFetch(superAdminUser.page, "/api/operator/membership/orgs/inactive");
      expect(result.status, "GET /api/operator/membership/orgs/inactive は 200").toBe(200);

      const body = result.body as { data?: unknown[] };
      expect(Array.isArray(body.data), "data が配列であること").toBe(true);
    } finally {
      // cleanup
      if (orgId) {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}`, {
          method: "DELETE",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: "return=minimal",
          },
        }).catch(() => {});
      }
      await cleanupFreshUser(supabaseAdmin, inactiveOwner.id);
    }
  });

  /**
   * spec11-03: super_admin が org owner 強制譲渡を実行できる
   *
   * - fresh org owner + member を作成
   * - POST /api/operator/membership/org/{id}/transfer → 200
   * - DB で owner が変わっていること + membership_audit に記録
   */
  test("spec11-03: super_admin が org owner 強制譲渡 → 200 + DB 反映", async ({ superAdminUser }) => {
    const supabaseAdmin = getAdminClient();
    const orgOwner = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-org-owner" });
    const orgMember = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-org-member" });

    let orgId: string | undefined;

    try {
      // 両者の user_profiles を INSERT
      await upsertProfile({
        userId: orgOwner.id,
        nickname: "Org Owner",
        roles: ["user"],
        lastLoginAt: daysAgoISO(91),
      });
      await upsertProfile({
        userId: orgMember.id,
        nickname: "Org Member",
        roles: ["user"],
        lastLoginAt: new Date().toISOString(),
      });

      orgId = await createTestOrg({ ownerId: orgOwner.id, name: `E2E Op Transfer Org ${Date.now()}` });

      // owner / member の org_role + organization_id を設定
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

      // org_role を設定
      for (const [uid, role] of [[orgOwner.id, "owner"], [orgMember.id, "member"]] as const) {
        await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${uid}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ organization_id: orgId, org_role: role }),
        });
      }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await superAdminUser.page.goto(`${baseURL}/home`);

      // POST /api/operator/membership/org/{id}/transfer
      const result = await apiFetch(
        superAdminUser.page,
        `/api/operator/membership/org/${orgId}/transfer`,
        {
          method: "POST",
          body: {
            to_user_id: orgMember.id,
            reason: "E2E テスト: owner が 90 日以上未ログインのため強制譲渡",
          },
        },
      );

      expect(result.status, "POST transfer は 200").toBe(200);

      // DB: organization の owner_id が orgMember.id に変わっていること
      const orgResp = await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}&select=owner_id`, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      });
      const orgRows = (await orgResp.json()) as Array<{ owner_id: string }>;
      expect(orgRows[0]?.owner_id, "organization.owner_id が新 owner に変わること").toBe(orgMember.id);

      // DB: membership_audit に記録
      const auditResp = await fetch(
        `${supabaseUrl}/rest/v1/membership_audit?scope=eq.organization&scope_id=eq.${orgId}&action=eq.operator_force_owner_transfer&select=id,action,metadata`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const auditRows = (await auditResp.json()) as Array<{ id: string; action: string; metadata: unknown }>;
      expect(auditRows.length, "membership_audit に operator_force_owner_transfer が記録されること").toBeGreaterThanOrEqual(1);
    } finally {
      if (orgId) {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}`, {
          method: "DELETE",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: "return=minimal",
          },
        }).catch(() => {});
      }
      await cleanupFreshUser(supabaseAdmin, orgOwner.id);
      await cleanupFreshUser(supabaseAdmin, orgMember.id);
    }
  });

  /**
   * spec11-04: super_admin が org 強制解散を実行できる
   *
   * - POST /api/operator/membership/org/{id}/dissolve → 200
   * - organizations.status = 'dissolved'
   */
  test("spec11-04: super_admin が org 強制解散 → 200 + dissolved", async ({ superAdminUser }) => {
    const supabaseAdmin = getAdminClient();
    const orgOwner = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-dissolve-owner" });
    const orgMember = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-dissolve-member" });

    let orgId: string | undefined;

    try {
      await upsertProfile({ userId: orgOwner.id, nickname: "Dissolve Owner", roles: ["user"] });
      await upsertProfile({ userId: orgMember.id, nickname: "Dissolve Member", roles: ["user"] });

      orgId = await createTestOrg({ ownerId: orgOwner.id, name: `E2E Op Dissolve Org ${Date.now()}` });

      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

      for (const [uid, role] of [[orgOwner.id, "owner"], [orgMember.id, "member"]] as const) {
        await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${uid}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ organization_id: orgId, org_role: role }),
        });
      }

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await superAdminUser.page.goto(`${baseURL}/home`);

      const result = await apiFetch(
        superAdminUser.page,
        `/api/operator/membership/org/${orgId}/dissolve`,
        {
          method: "POST",
          body: { reason: "E2E テスト: 強制解散" },
        },
      );

      expect(result.status, "POST dissolve は 200").toBe(200);

      // DB: organizations.status = 'dissolved'
      const orgResp = await fetch(
        `${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}&select=status`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const orgRows = (await orgResp.json()) as Array<{ status: string }>;
      expect(
        orgRows[0]?.status,
        "organizations.status が dissolved に変わること",
      ).toBe("dissolved");
    } finally {
      // 解散後は status が dissolved なのでそのまま削除
      if (orgId) {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}`, {
          method: "DELETE",
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: "return=minimal",
          },
        }).catch(() => {});
      }
      await cleanupFreshUser(supabaseAdmin, orgOwner.id);
      await cleanupFreshUser(supabaseAdmin, orgMember.id);
    }
  });

  /**
   * spec11-05: super_admin が family 代表者強制譲渡を実行できる
   */
  test("spec11-05: super_admin が family 代表者強制譲渡 → 200 + DB 反映", async ({ superAdminUser }) => {
    const supabaseAdmin = getAdminClient();
    const repUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-fam-rep" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-fam-member" });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    for (const u of [repUser, memberUser]) {
      await upsertProfile({ userId: u.id, nickname: `E2E FamOp ${u.email}`, roles: ["user"] });
    }

    let familyId: string | undefined;

    try {
      const family = await setupFamilyWithTwoMembers({
        ownerId: repUser.id,
        ownerEmail: repUser.email,
        memberId: memberUser.id,
        memberEmail: memberUser.email,
        familyName: `E2E Op Family ${Date.now()}`,
      });
      familyId = family.familyId;

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await superAdminUser.page.goto(`${baseURL}/home`);

      // POST /api/operator/membership/family/{id}/transfer
      const result = await apiFetch(
        superAdminUser.page,
        `/api/operator/membership/family/${familyId}/transfer`,
        {
          method: "POST",
          body: {
            to_user_id: memberUser.id,
            reason: "E2E テスト: 代表者が inactive のため強制譲渡",
          },
        },
      );

      expect(result.status, "POST family/transfer は 200").toBe(200);

      // DB: family_groups.representative_id が memberUser に変わっていること
      const fgResp = await fetch(
        `${supabaseUrl}/rest/v1/family_groups?id=eq.${familyId}&select=representative_id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const fgRows = (await fgResp.json()) as Array<{ representative_id: string }>;
      expect(
        fgRows[0]?.representative_id,
        "family_groups.representative_id が新代表者に変わること",
      ).toBe(memberUser.id);

      // DB: membership_audit に記録
      const auditResp = await fetch(
        `${supabaseUrl}/rest/v1/membership_audit?scope=eq.family&scope_id=eq.${familyId}&action=eq.operator_force_representative_transfer&select=id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const auditRows = (await auditResp.json()) as Array<{ id: string }>;
      expect(
        auditRows.length,
        "membership_audit に operator_force_representative_transfer が記録されること",
      ).toBeGreaterThanOrEqual(1);
    } finally {
      if (familyId) {
        await cleanupFamily({ familyId, memberIds: [repUser.id, memberUser.id] });
      }
      await cleanupFreshUser(supabaseAdmin, repUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec11-06: super_admin が family 強制解散を実行できる
   */
  test("spec11-06: super_admin が family 強制解散 → 200 + dissolved", async ({ superAdminUser }) => {
    const supabaseAdmin = getAdminClient();
    const repUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-fam-dissolve-rep" });
    const memberUser = await createFreshUser(supabaseAdmin, { emailPrefix: "e2e-op-fam-dissolve-m" });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    for (const u of [repUser, memberUser]) {
      await upsertProfile({ userId: u.id, nickname: `E2E FamDissolve ${u.email}`, roles: ["user"] });
    }

    let familyId: string | undefined;

    try {
      const family = await setupFamilyWithTwoMembers({
        ownerId: repUser.id,
        ownerEmail: repUser.email,
        memberId: memberUser.id,
        memberEmail: memberUser.email,
        familyName: `E2E Op Dissolve Family ${Date.now()}`,
      });
      familyId = family.familyId;

      const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
      await superAdminUser.page.goto(`${baseURL}/home`);

      const result = await apiFetch(
        superAdminUser.page,
        `/api/operator/membership/family/${familyId}/dissolve`,
        {
          method: "POST",
          body: { reason: "E2E テスト: 家族強制解散" },
        },
      );

      expect(result.status, "POST family/dissolve は 200").toBe(200);

      // DB: family_groups.status = 'dissolved'
      const fgResp = await fetch(
        `${supabaseUrl}/rest/v1/family_groups?id=eq.${familyId}&select=status`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const fgRows = (await fgResp.json()) as Array<{ status: string }>;
      expect(
        fgRows[0]?.status,
        "family_groups.status が dissolved に変わること",
      ).toBe("dissolved");

      // DB: user_profiles.family_id が null に
      const profileResp = await fetch(
        `${supabaseUrl}/rest/v1/user_profiles?id=in.(${repUser.id},${memberUser.id})&select=id,family_id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        },
      );
      const profileRows = (await profileResp.json()) as Array<{ id: string; family_id: string | null }>;
      for (const row of profileRows) {
        expect(row.family_id, `user ${row.id} の family_id が null になること`).toBeNull();
      }
    } finally {
      // dissolved 後はファミリーの cleanup は省略 (status=dissolved で外部整合)
      if (familyId) {
        const supabaseUrl2 = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceRoleKey2 = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        await fetch(`${supabaseUrl2}/rest/v1/family_members?family_id=eq.${familyId}`, {
          method: "DELETE",
          headers: {
            apikey: serviceRoleKey2,
            Authorization: `Bearer ${serviceRoleKey2}`,
            Prefer: "return=minimal",
          },
        }).catch(() => {});
        await fetch(`${supabaseUrl2}/rest/v1/family_groups?id=eq.${familyId}`, {
          method: "DELETE",
          headers: {
            apikey: serviceRoleKey2,
            Authorization: `Bearer ${serviceRoleKey2}`,
            Prefer: "return=minimal",
          },
        }).catch(() => {});
      }
      await cleanupFreshUser(supabaseAdmin, repUser.id);
      await cleanupFreshUser(supabaseAdmin, memberUser.id);
    }
  });

  /**
   * spec11-07: super_admin が監査ログを閲覧できる
   */
  test("spec11-07: super_admin が /api/operator/membership/audit で監査ログを取得できる", async ({
    superAdminUser,
  }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    await superAdminUser.page.goto(`${baseURL}/home`);

    const result = await apiFetch(
      superAdminUser.page,
      "/api/operator/membership/audit?limit=10",
    );

    expect(result.status, "GET /api/operator/membership/audit は 200").toBe(200);

    const body = result.body as { data?: unknown[]; total?: number };
    expect(Array.isArray(body.data), "data が配列であること").toBe(true);
  });

  /**
   * spec11-08: super_admin が family inactive 一覧を取得できる
   */
  test("spec11-08: super_admin が inactive family 一覧を取得できる", async ({ superAdminUser }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    await superAdminUser.page.goto(`${baseURL}/home`);

    const result = await apiFetch(
      superAdminUser.page,
      "/api/operator/membership/families/inactive",
    );

    expect(result.status, "GET /api/operator/membership/families/inactive は 200").toBe(200);
    const body = result.body as { data?: unknown[] };
    expect(Array.isArray(body.data), "data が配列であること").toBe(true);
  });
});
