// src/lib/auth/org-admin.ts
// 組織 (テナント) の管理者判定 (Issue #1235)。
//
// 組織の管理者は、その組織に所属し user_profiles.org_role が 'owner' / 'admin' のユーザーだけ。
// roles 配列の 'org_admin' はどの組織で付与されたかを区別せず、脱退・除名でも消えないため、
// 組織の管理者判定には使わない (別組織で管理者だったユーザーが、無関係な組織に一般メンバーとして
// 加入しただけでその組織の管理者になれていた)。
// 組織テーブルの RLS (supabase/migrations/20261007022126_org_role_tenant_scoped_org_admin.sql) も
// 同じ判定にそろえている。

export const ORG_ADMIN_ROLES = ['owner', 'admin'] as const;

export type OrgAdminRole = (typeof ORG_ADMIN_ROLES)[number];

interface OrgMembership {
  organization_id?: string | null;
  org_role?: string | null;
}

/**
 * プロフィールが所属組織の管理者 (org_role が owner / admin) かどうか。
 * true のとき organization_id は string に絞り込まれる。
 */
export function isOrgAdmin<T extends OrgMembership>(
  profile: T | null | undefined,
): profile is T & { organization_id: string; org_role: OrgAdminRole } {
  return (
    !!profile?.organization_id &&
    (ORG_ADMIN_ROLES as readonly string[]).includes(profile.org_role ?? '')
  );
}
