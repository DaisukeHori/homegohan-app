import { createClient as createServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { isOrgAdmin } from '@/lib/auth/org-admin';
import {
  createOrgInviteWithEmail,
  invalidOrgInviteBodyResponse,
  orgInviteFailureResponse,
} from '@/lib/membership/org-invite';
import { AddOrgMemberRequestBodySchema } from '@/schemas/membership/organization-invite';

// メンバー一覧取得
export async function GET(_request: Request) {
  const supabase = await createServerClient();

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: adminProfile } = await supabase
      .from('user_profiles')
      .select('organization_id, org_role')
      .eq('id', user.id)
      .single();

    if (!isOrgAdmin(adminProfile)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: members, error } = await supabase
      .from('user_profiles')
      .select('id, nickname, roles, created_at, updated_at, organization_id')
      .eq('organization_id', adminProfile.organization_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ members });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// メンバーの追加 = 組織への招待 (所属組織の owner / admin のみ) (#1235)
//
// 以前はここで、管理者が指定したメールアドレスとパスワードで「メール確認済み」のアカウントを作っていた。
// メールの持ち主の確認無しに使えるアカウントを作れると、アカウント事前乗っ取り (pre-hijacking) の原因になるうえ、
// 本当の持ち主がそのアドレスで登録できなくなる。2026-10-07 のオーナー判断で招待メール方式に変更し、
// Web の「メンバーを招待」(POST /api/org/invites) と同じ組織招待 (役割は member) を送る。
// アカウントは作らない。リクエストの password は受け取っても使わない (古いモバイルアプリが送ってくるため無視する)。
export async function POST(request: Request) {
  const supabase = await createServerClient();

  const { data: { user: actor } } = await supabase.auth.getUser();
  if (!actor) {
    return NextResponse.json({ error: { code: 'NOT_AUTHENTICATED', message: '認証が必要です' } }, { status: 401 });
  }

  const { data: adminProfile } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role, nickname')
    .eq('id', actor.id)
    .single();

  if (!isOrgAdmin(adminProfile)) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_PERMISSION', message: 'owner/admin のみ招待可能です' } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'リクエストボディが不正です' } }, { status: 400 });
  }

  // #1163 メールアドレスは前後の空白を除いて小文字にし、形式と長さを確かめる。nickname は 50 文字まで。
  // password など未知のキーは取り除かれる (受け取っても使わない)
  const parsed = AddOrgMemberRequestBodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidOrgInviteBodyResponse(parsed.error);
  }
  const { email } = parsed.data;
  // 未入力 (空文字) は宛名なしにする
  const nickname = parsed.data.nickname ? parsed.data.nickname : null;

  // 招待を作り、招待メールを送る (POST /api/org/invites と共通。送信回数の制限もこの中で判定するので、
  // この入口からも回避できない)
  const result = await createOrgInviteWithEmail({
    supabase,
    inviter: { id: actor.id, email: actor.email, nickname: adminProfile.nickname },
    organizationId: adminProfile.organization_id,
    email,
    role: 'member',
    displayName: nickname,
  });
  if (!result.ok) {
    return orgInviteFailureResponse(result);
  }

  return NextResponse.json({ ok: true, invite: result.invite }, { status: 201 });
}
