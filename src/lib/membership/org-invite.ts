/**
 * 組織への招待を作り、招待メールを送る (POST /api/org/invites と POST /api/org/members で共通)
 *
 * - 招待は create_org_invite RPC で作る。RPC は呼び出し元 (auth.uid()) が組織の owner / admin かを確認し、
 *   同じメールアドレスへの pending の招待があれば取り消してから作り直す。
 * - 招待メールは Resend で送る。送信に失敗しても招待は有効なまま (警告ログのみ)。
 * - アカウントは作らない。招待された本人が、自分でメールを確認したアカウントで /invite/<token> から承諾する。
 * - #1163 RPC の前に送信回数を判定する (invite-throttle.ts)。2 つの route が共有するこの関数に置くことで、
 *   どちらの入口からも回避できないようにしている。
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodError } from 'zod';
import { ErrorStatusMap, MembershipErrorCode, mapPgErrorToHttp } from '@/lib/errors/membership-errors';
import { sendEmail } from '@/lib/emails/send';
import { isEmailFailure } from '@/lib/emails/send-result';
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';
import { checkInviteEmailLimits, inviteThrottleFailureFromRpcError } from '@/lib/membership/invite-throttle';
import { buildOrgInviteUrl } from '@/lib/membership/urls';

export type OrgInviteRole = 'admin' | 'member';

export interface CreateOrgInviteParams {
  /** 招待する人 (組織の owner / admin) のセッションのクライアント */
  supabase: SupabaseClient;
  /** id は認証で確定した招待者の user.id (送信回数制限の鍵) */
  inviter: { id: string; email?: string | null; nickname?: string | null };
  /** 呼び出し元のプロフィールから取った所属組織の ID。リクエストの body の値を渡さないこと */
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

export type CreateOrgInviteFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  /** 送信回数の上限 (429) のときだけ付く。何秒後に再試行できるか */
  retryAfterSec?: number;
};

export type CreateOrgInviteResult = { ok: true; invite: OrgInviteSummary } | CreateOrgInviteFailure;

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
  const email = params.email.trim().toLowerCase();

  // #1163 送信回数の制限。最初の副作用 (RPC) の前に、招待者 → 組織 → 宛先の順で判定する。
  // 判定できない (Redis 障害など) ときは例外がそのまま伝播し、RPC もメールも実行されない (fail-closed)。
  const throttle = await checkInviteEmailLimits({
    flow: 'org-invite',
    userId: inviter.id,
    scopeId: organizationId,
    recipientEmail: email,
  });
  if (throttle) {
    return {
      ok: false,
      status: ErrorStatusMap[MembershipErrorCode.RATE_LIMITED],
      code: MembershipErrorCode.RATE_LIMITED,
      message: throttle.message,
      retryAfterSec: throttle.retryAfterSec,
    };
  }

  // create_org_invite RPC 呼び出し (既存 pending は RPC 内で revoke)
  const { data: invite, error: rpcError } = await supabase.rpc('create_org_invite', {
    p_organization_id: organizationId,
    p_email: email,
    p_role: role,
    p_custom_message: customMessage ?? undefined,
  });

  if (rpcError) {
    // #1163 DB の 24 時間上限 (enforce_membership_daily_cap) に達したときは、アプリ層の上限と同じ形の 429
    // (利用者向けの文言と Retry-After) にする。DB が返す生の文字列 'RATE_LIMITED' は見せない。
    const dbThrottle = inviteThrottleFailureFromRpcError(rpcError, { flow: 'org-invite', userId: inviter.id });
    if (dbThrottle) {
      return {
        ok: false,
        status: ErrorStatusMap[MembershipErrorCode.RATE_LIMITED],
        code: MembershipErrorCode.RATE_LIMITED,
        message: dbThrottle.message,
        retryAfterSec: dbThrottle.retryAfterSec,
      };
    }
    const { code, status } = mapPgErrorToHttp(rpcError.message);
    return { ok: false, status, code, message: rpcError.message };
  }
  if (!invite) {
    return { ok: false, status: 500, code: 'RPC_FAILED', message: '招待の作成に失敗しました' };
  }

  const inviteRow = invite as InviteRow;
  // 招待 URL の基点は urls.ts に 1 つだけある (#1194)。ここで環境変数を読み直さない
  const inviteUrl = buildOrgInviteUrl(inviteRow.token);

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
    const sent = await sendEmail(envelope);
    // sendEmail は配信の失敗で例外を投げず、結果で返す。失敗も下の catch で、他の失敗と同じように警告に残す
    if (isEmailFailure(sent)) throw sent.error;
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

/**
 * createOrgInviteWithEmail の失敗を HTTP レスポンスにする (POST /api/org/invites と POST /api/org/members で共通)。
 * 送信回数の上限 (429) のときだけ Retry-After ヘッダーと error.retryAfter を付ける。
 */
export function orgInviteFailureResponse(failure: CreateOrgInviteFailure): NextResponse {
  const hasRetryAfter = failure.retryAfterSec !== undefined;
  return NextResponse.json(
    {
      error: {
        code: failure.code,
        message: failure.message,
        ...(hasRetryAfter ? { retryAfter: failure.retryAfterSec } : {}),
      },
    },
    {
      status: failure.status,
      ...(hasRetryAfter ? { headers: { 'Retry-After': String(failure.retryAfterSec) } } : {}),
    },
  );
}

// リクエストボディのどの項目が不正だったかで出し分ける UI 向けの文言
const INVALID_BODY_MESSAGES: Record<string, string> = {
  email: 'メールアドレスを正しい形式で入力してください',
  role: 'role は admin または member のみ指定できます',
  custom_message: 'メッセージは 500 文字以内の文字列で入力してください',
  nickname: 'ニックネームは 50 文字以内の文字列で入力してください',
};

/** 招待のリクエストボディが不正なときの 400 (code は既存と同じ INVALID_BODY) */
export function invalidOrgInviteBodyResponse(error: ZodError): NextResponse {
  const field = error.issues[0]?.path[0];
  const message =
    (typeof field === 'string' ? INVALID_BODY_MESSAGES[field] : undefined) ?? 'リクエストボディが不正です';
  return NextResponse.json({ error: { code: 'INVALID_BODY', message } }, { status: 400 });
}
