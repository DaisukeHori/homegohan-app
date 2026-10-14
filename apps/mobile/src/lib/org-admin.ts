/**
 * 組織の管理者判定 (#1235)
 *
 * Web の src/lib/auth/org-admin.ts と同じ規則:
 * 所属組織があり、org_role が owner / admin のユーザーだけを組織の管理者とする。
 * roles 配列の 'org_admin' はどの組織で付与されたかを区別せず、脱退・除名でも消えないため、
 * 組織の管理者判定に使わない。
 */
export const ORG_ADMIN_ROLES = ['owner', 'admin'] as const;

export type OrgAdminRole = (typeof ORG_ADMIN_ROLES)[number];

interface OrgMembership {
  organizationId?: string | null;
  orgRole?: string | null;
}

export function isOrgAdmin(profile: OrgMembership | null | undefined): boolean {
  return !!profile?.organizationId && (ORG_ADMIN_ROLES as readonly string[]).includes(profile.orgRole ?? '');
}
