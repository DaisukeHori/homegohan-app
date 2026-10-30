import { createClient as createServerClient, getSupabaseAdmin } from '@/lib/supabase/server';
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
import { AddOrgMemberRequestBodySchema } from '@/schemas/membership/organization-invite';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { ORG_API_INTERNAL_ERROR_MESSAGE, ORG_API_INVITE_ADMIN_ONLY_MESSAGE, orgAuthFailureFlat } from '@/lib/org-api-errors';
import {
  ORG_MEMBER_NAME_COLUMNS,
  OrgMemberNameSchema,
  type OrgMemberNamesResponse,
} from '@/schemas/membership/organization-member-name';
import { orderOrgMemberList } from '@/lib/membership/org-member-list-order';
// メンバー一覧取得 (所属組織の owner / admin のみ。判定は共通の requireOrgAdmin()、#1161)
//
// 組織のメンバーの一覧の画面 (src/app/(org)/org/members/page.tsx) が呼ぶ (#2073 S4)。
// user_profiles の SELECT の RLS は本人の行だけなので、ログイン中の利用者のクライアントで読むと自分の行しか返らなかった。
// そこで、次の順に確かめてから、確かめた組織のメンバーだけを service_role で読む:
//   1. JWT の本人 (requireOrgAdmin の getUser。無ければ 401)
//   2. 本人の所属組織と、そこでの役割が owner / admin であること (本人の行は RLS で読める。違えば 403。一般メンバーも 403)
//   3. service_role の読みは 2 で確かめた organization_id で絞る (ほかの組織の行は読まない)
// 返すのは id・表示名・組織内の役割・参加した日の 4 つだけ (プライバシーポリシー第9条 5 項。ORG_MEMBER_NAME_COLUMNS)。
// 並びは参加した日の古い順 (画面の以前の問い合わせと同じ)。同じ日はオーナー → 管理者 → メンバー、その中は id の順で、
// 参加した日が空の行は最後 (#2128 V3。orderOrgMemberList)
export async function GET(_request: Request) {
  try {
    const { profile: adminProfile } = await requireOrgAdmin();

    // service_role の client は、上の確認を通ったあとの読みにだけ使う
    const { data: rows, error } = await orderOrgMemberList(
      getSupabaseAdmin()
        .from('user_profiles')
        .select(ORG_MEMBER_NAME_COLUMNS)
        .eq('organization_id', adminProfile.organization_id),
    );

    if (error) throw new Error(error.message);

    // 4 つのキーだけにそろえる (select の列を誤って足しても応答には出さない)。形が違えば 500
    const body: OrgMemberNamesResponse = { members: OrgMemberNameSchema.array().parse(rows ?? []) };
    return NextResponse.json(body);

  } catch (error) {
    // 401 / 403 は日本語の固定の文 (src/lib/org-api-errors.ts)。例外の文面は本文に入れない
    const authFailure = orgAuthFailureFlat(error);
    if (authFailure) return authFailure;
    // 500 の本文は汎用メッセージだけ (#1172)。詳細は db-logger にだけ残す
    createLogger('GET /api/org/members', generateRequestId()).error('組織メンバー一覧の取得に失敗しました', error);
    return NextResponse.json({ error: ORG_API_INTERNAL_ERROR_MESSAGE }, { status: 500 });
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
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
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
        { error: { code: 'INSUFFICIENT_PERMISSION', message: ORG_API_INVITE_ADMIN_ONLY_MESSAGE } },
        { status: 403 },
      );
    }
    createLogger('POST /api/org/members', generateRequestId()).error('組織管理者の確認に失敗しました', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: ORG_API_INTERNAL_ERROR_MESSAGE } },
      { status: 500 },
    );
  }
  const { user: actor, profile: adminProfile } = admin;

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: { code: 'INVALID_BODY', message: 'リクエストボディが不正です' } }, { status: 400 });
  }

  // #1163 メールアドレスは前後の空白を除いて小文字にし、形式と長さを確かめる。nickname は 50 文字まで。
  // password など未知のキーは取り除かれる (受け取っても使わない)
  const parsed = AddOrgMemberRequestBodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return invalidOrgInviteBodyResponse(parsed.error);
  }
  const { email } = parsed.data;
  // 未入力 (空文字) は宛名なしにする
  const nickname = parsed.data.nickname ? parsed.data.nickname : null;

  // 招待を作り、招待メールを送る (POST /api/org/invites と共通。送信回数の制限もこの中で判定するので、
  // この入口からも回避できない)
  const supabase = await createServerClient();
  const result = await createOrgInviteWithEmail({
    supabase,
    inviter: { id: actor.id, email: actor.email, nickname: adminProfile.nickname },
    organizationId: adminProfile.organization_id,
    email,
    role: 'member',
    displayName: nickname,
  });
  if (!result.ok) {
    return orgInviteFailureResponse(result, { routeName: 'POST /api/org/members', userId: actor.id });
  }

  return NextResponse.json({ ok: true, invite: result.invite }, { status: 201 });
}
