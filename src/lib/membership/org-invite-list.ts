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

/** 一覧の読み出しで select する列 (role 列は読まない) */
export const ORG_INVITE_LIST_COLUMNS = `
        id,
        email,
        invited_role,
        status,
        department_id,
        token,
        expires_at,
        accepted_at,
        created_at,
        departments(name)
      `;

/** ORG_INVITE_LIST_COLUMNS で読んだ 1 行 */
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
  departments: { name: string } | null;
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
    departmentName: row.departments?.name ?? null,
    token: row.token,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    isExpired: isOrgInviteExpired(row.expires_at, now),
    isAccepted: !!row.accepted_at,
  };
}
