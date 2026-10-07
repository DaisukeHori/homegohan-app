/**
 * 組織への招待を作り、招待メールを送る (POST /api/org/invites と POST /api/org/members で共通)
 *
 * - 招待は create_org_invite RPC で作る。RPC は呼び出し元 (auth.uid()) が組織の owner / admin かを確認し、
 *   同じメールアドレスへの pending の招待があれば取り消してから作り直す。
 * - 招待メールは Resend で送る。送信に失敗しても招待は有効なまま (警告ログのみ)。
 * - アカウントは作らない。招待された本人が、自分でメールを確認したアカウントで /invite/<token> から承諾する。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';

export type OrgInviteRole = 'admin' | 'member';

export interface CreateOrgInviteParams {
  /** 招待する人 (組織の owner / admin) のセッションのクライアント */
  supabase: SupabaseClient;
  inviter: { email?: string | null; nickname?: string | null };
  organizationId: string;
  email: string;
  role: OrgInviteRole;
  customMessage?: string | null;
  /** 招待メールの宛名 (任意) */
  displayName?: string | null;
}

export interface OrgInviteSummary {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  invite_url: string;
}

export type CreateOrgInviteResult =
  | { ok: true; invite: OrgInviteSummary }
  | { ok: false; status: number; code: string; message: string };

interface InviteRow {
  id: string;
  token: string;
  email: string;
  invited_role: string;
  status: string;
  expires_at: string;
  custom_message: string | null;
  organization_id: string | null;
}

export async function createOrgInviteWithEmail(params: CreateOrgInviteParams): Promise<CreateOrgInviteResult> {
  const { supabase, inviter, organizationId, role, customMessage, displayName } = params;
  const email = params.email.toLowerCase();

  // create_org_invite RPC 呼び出し (既存 pending は RPC 内で revoke)
  const { data: invite, error: rpcError } = await supabase.rpc('create_org_invite', {
    p_organization_id: organizationId,
    p_email: email,
    p_role: role,
    p_custom_message: customMessage ?? undefined,
  });

  if (rpcError) {
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return { ok: false, status, code, message: rpcError.message };
  }
  if (!invite) {
    return { ok: false, status: 500, code: 'RPC_FAILED', message: '招待の作成に失敗しました' };
  }

  const inviteRow = invite as InviteRow;
  const baseUrl = process.env.NEXT_PUBLIC_INVITE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const inviteUrl = `${baseUrl}/invite/${inviteRow.token}`;

  // 組織名を取得
  const { data: orgData } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', organizationId)
    .single();

  // 既存ユーザー判定: auth.admin.listUsers は service_role 専用のため
  // get_invite_details の is_existing_user フィールドを使用
  const { data: inviteDetails } = await supabase.rpc('get_invite_details', {
    p_token: inviteRow.token,
  });
  const isExistingUser = (inviteDetails as Record<string, unknown> | null)?.is_existing_user === true;

  const emailVars: InviteEmailVars = {
    display_name: displayName ?? null,
    email_address: email,
    inviter_name: inviter.nickname ?? inviter.email?.split('@')[0] ?? '招待者',
    scope_name: orgData?.name ?? '組織',
    invite_url: inviteUrl,
    expires_at: inviteRow.expires_at.substring(0, 10), // 'YYYY-MM-DD'
    custom_message: customMessage ?? null,
  };

  // Resend 送信 (失敗時は warn のみ — 招待 row は残す)
  try {
    const envelope = isExistingUser ? renderOrgInviteExistingEmail(emailVars) : renderOrgInviteNewEmail(emailVars);
    await sendEmail(envelope);
  } catch (emailErr) {
    console.warn('[org-invite] メール送信失敗 (招待は有効):', emailErr);
  }

  return {
    ok: true,
    invite: {
      id: inviteRow.id,
      email: inviteRow.email,
      role: inviteRow.invited_role,
      status: inviteRow.status,
      expires_at: inviteRow.expires_at,
      invite_url: inviteUrl,
    },
  };
}
