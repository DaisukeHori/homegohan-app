import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin, type OrgAdminContext } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { readJsonBody } from '@/lib/http-params';
import {
  createOrgInviteWithEmail,
  invalidOrgInviteBodyResponse,
  orgInviteFailureResponse,
} from '@/lib/membership/org-invite';
import { ORG_INVITE_LIST_COLUMNS, toOrgInviteListItem } from '@/lib/membership/org-invite-list';
import {
  CreateOrgInviteRequestBodySchema,
  type OrgInviteListResponse,
} from '@/schemas/membership/organization-invite';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

// 権限: 所属組織の org_role が owner / admin。判定は共通の requireOrgAdmin() (#1161)

/**
 * GET / DELETE の失敗応答。認可エラー (401 / 403) はそのまま返し、それ以外は 500 の汎用メッセージにする。
 * 生のエラー文は返さず (#1172)、詳細は db-logger (app_logs) にだけ残す。
 */
function handleError(method: string, error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  createLogger(`${method} /api/org/invites`, generateRequestId()).error('組織の招待の処理に失敗しました', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// 招待一覧取得
// 役割は invited_role (create_org_invite が書く列)・状態は status (期限切れの pending は 'expired') を返す。
// 旧い role 列は書かれない (既定 'member') ので読まない。行の形は src/lib/membership/org-invite-list.ts
export async function GET(request: Request) {
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();

    const { data: invites, error } = await supabase
      .from('organization_invites')
      .select(ORG_INVITE_LIST_COLUMNS)
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const now = new Date();
    const body: OrgInviteListResponse = {
      invites: (invites ?? []).map((row) => toOrgInviteListItem(row, now)),
    };
    return NextResponse.json(body);

  } catch (error) {
    return handleError('GET', error);
  }
}

// 招待作成 (RPC create_org_invite + Resend 送信)
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  let admin: OrgAdminContext;
  try {
    admin = await requireOrgAdmin();
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ招待可能です' } },
        { status: 403 },
      );
    }
    createLogger('POST /api/org/invites', generateRequestId()).error('組織管理者の確認に失敗しました', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
  const { user, profile } = admin;

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'リクエストボディが不正です' } }, { status: 400 });
  }

  // #1163 メールアドレスは前後の空白を除いて小文字にし、形式と長さを確かめる (不正なアドレスでは招待を作らない)。
  // role に owner は指定できない。未知のキーは取り除く。
  const parsed = CreateOrgInviteRequestBodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return invalidOrgInviteBodyResponse(parsed.error);
  }
  const { email, role, custom_message } = parsed.data;

  // 招待を作り、招待メールを送る (POST /api/org/members と共通。送信回数の制限もこの中で判定する)
  const supabase = await createClient();
  const result = await createOrgInviteWithEmail({
    supabase,
    inviter: { id: user.id, email: user.email, nickname: profile.nickname },
    organizationId: profile.organization_id,
    email,
    role,
    customMessage: custom_message,
  });
  if (!result.ok) {
    return orgInviteFailureResponse(result, { routeName: 'POST /api/org/invites', userId: user.id });
  }

  return NextResponse.json({ ok: true, invite: result.invite });
}

// 招待削除
export async function DELETE(request: Request) {
  try {
    const { profile } = await requireOrgAdmin();
    const supabase = await createClient();

    const { searchParams } = new URL(request.url);
    const inviteId = searchParams.get('id');

    if (!inviteId) {
      return NextResponse.json({ error: 'Invite ID is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('organization_invites')
      .delete()
      .eq('id', inviteId)
      .eq('organization_id', profile.organization_id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error) {
    return handleError('DELETE', error);
  }
}
