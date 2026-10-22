/**
 * 組織の招待の一覧 (GET /api/org/invites) の 1 行を、画面 (src/app/(org)/org/invites/page.tsx) に返す形にする。
 *
 * - 役割は invited_role (create_org_invite が書く列) を返す。旧い role 列は既定 'member' のまま書かれないので読まない。
 * - 状態は DB の status を返す。ただし期限を過ぎた pending は 'expired' にする
 *   (DB の status が 'expired' になるのは承諾を試みたときだけで、それまでは pending のまま残るため)。
 *   取り消した招待 (revoke_org_invite)・退会で伏せた招待 (prepare_account_deletion) は 'revoked'、拒否は 'rejected' のまま返し、
 *   画面はその状態のときにリンクのコピーと取り消しのボタンを出さない。
 */
import type { OrgInviteListItem, OrgRole } from '@/schemas/membership/organization-invite';

/** GET /api/org/invites の select で読んだ 1 行 (role 列は読まない。select の列は tests/legal-text-1901.test.ts T-32 が固定している) */
export interface OrgInviteListRow {
  id: string;
  email: string;
  invited_role: OrgRole;
  status: string;
  department_id: string | null;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string | null;
  /**
   * 部署の埋め込み。PostgREST は外部キー (to-one) の埋め込みを 1 件のオブジェクトで返すが、
   * 型を持たない client の select の型推論は配列とみなすので、両方を受ける
   */
  departments: OrgInviteDepartmentEmbed | OrgInviteDepartmentEmbed[] | null;
}

interface OrgInviteDepartmentEmbed {
  name: string;
}

/** 部署の埋め込みから部署名を取り出す (無ければ null) */
function departmentNameOf(departments: OrgInviteListRow['departments']): string | null {
  if (!departments) return null;
  const embed = Array.isArray(departments) ? departments[0] : departments;
  return embed?.name ?? null;
}

/** 期限を過ぎているか (expires_at が now より前) */
export function isOrgInviteExpired(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() < now.getTime();
}

/** 表示用の状態: 期限を過ぎた pending は 'expired'、それ以外は DB の status */
export function displayOrgInviteStatus(status: string, expiresAt: string, now: Date): string {
  if (status === 'pending' && isOrgInviteExpired(expiresAt, now)) return 'expired';
  return status;
}

export function toOrgInviteListItem(row: OrgInviteListRow, now: Date): OrgInviteListItem {
  return {
    id: row.id,
    email: row.email,
    role: row.invited_role,
    status: displayOrgInviteStatus(row.status, row.expires_at, now),
    departmentId: row.department_id,
    departmentName: departmentNameOf(row.departments),
    token: row.token,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    isExpired: isOrgInviteExpired(row.expires_at, now),
    isAccepted: !!row.accepted_at,
  };
}
