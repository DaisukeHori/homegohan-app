/**
 * tests/org-admin-authz.test.ts
 *
 * Issue #1235 (第1段): 組織の管理者判定を org_role に一本化したことの単体テスト。
 *   - isOrgAdmin: 所属組織の org_role が owner / admin のときだけ true (roles の 'org_admin' は見ない)
 *   - 運営コンソールのロール変更 API は 'org_admin' を付与できない
 * RLS と API ルートの結合テストは tests/integration/security/org-admin-tenant-scope.test.ts。
 */

import { describe, expect, it } from "vitest";
import { isOrgAdmin } from "../src/lib/auth/org-admin";
import { ALLOWED_ROLES, RoleChangeBodySchema } from "../src/lib/admin/users-schemas";

describe("isOrgAdmin", () => {
  it("所属組織の owner / admin は管理者", () => {
    expect(isOrgAdmin({ organization_id: "org-1", org_role: "owner" })).toBe(true);
    expect(isOrgAdmin({ organization_id: "org-1", org_role: "admin" })).toBe(true);
  });

  it("招待で admin になったユーザー (roles に org_admin なし) も管理者", () => {
    expect(isOrgAdmin({ organization_id: "org-1", org_role: "admin", roles: ["user"] })).toBe(true);
  });

  it("roles に org_admin が残っていても、org_role が member なら管理者ではない", () => {
    expect(isOrgAdmin({ organization_id: "org-1", org_role: "member", roles: ["user", "org_admin"] })).toBe(false);
  });

  it("roles に org_admin が残っていても、組織に所属していなければ管理者ではない", () => {
    expect(isOrgAdmin({ organization_id: null, org_role: null, roles: ["org_admin"] })).toBe(false);
  });

  it("org_role が admin でも organization_id が無い不整合データは管理者ではない", () => {
    expect(isOrgAdmin({ organization_id: null, org_role: "admin" })).toBe(false);
  });

  it("運営のグローバル admin でも org_role が無ければ組織の管理者ではない", () => {
    expect(isOrgAdmin({ organization_id: "org-1", org_role: "member", roles: ["admin", "super_admin"] })).toBe(false);
  });

  it("プロフィールが取れない場合は管理者ではない", () => {
    expect(isOrgAdmin(null)).toBe(false);
    expect(isOrgAdmin(undefined)).toBe(false);
  });
});

describe("運営コンソールのロール変更 (RoleChangeBodySchema)", () => {
  it("org_admin は付与できるロールに含まれない", () => {
    expect(ALLOWED_ROLES).not.toContain("org_admin");
    expect(RoleChangeBodySchema.safeParse({ roles: ["user", "org_admin"] }).success).toBe(false);
  });

  it("他のロールは従来どおり付与できる", () => {
    expect(RoleChangeBodySchema.safeParse({ roles: ["user", "support"] }).success).toBe(true);
    expect(RoleChangeBodySchema.safeParse({ roles: ["admin"] }).success).toBe(true);
  });
});
