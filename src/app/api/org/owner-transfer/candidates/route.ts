// GET /api/org/owner-transfer/candidates — オーナーの譲渡の候補 (#2073 S4)
//
// オーナーの譲渡の画面 (src/app/(org)/org/settings/owner-transfer/page.tsx) が呼ぶ。
// user_profiles の SELECT の RLS は本人の行だけなので、ログイン中の利用者のクライアントで読むと候補が 1 人も返らなかった。
// そこで、次の順に確かめてから、確かめた組織のメンバーだけを service_role で読む:
//   1. JWT の本人 (requireOrgAdmin の getUser。無ければ 401)
//   2. 本人の所属組織と、そこでの役割が owner であること (本人の行は RLS で読める。管理者 (admin)・一般メンバー・組織に属していない人は 403)
//   3. service_role の読みは 2 で確かめた organization_id で絞り、自分とオーナーを除く (画面の以前の問い合わせと同じ条件)
// 返すのは id・表示名・組織内の役割・参加した日の 4 つだけ (プライバシーポリシー第9条 5 項。ORG_MEMBER_NAME_COLUMNS)。
// 失敗の本文の形は、一覧の取得の route (GET /api/org/members・/api/org/invites・/api/org/challenges) と同じ flat
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { ORG_API_INTERNAL_ERROR_MESSAGE, orgAuthFailureFlat } from '@/lib/org-api-errors';
import {
  ORG_MEMBER_NAME_COLUMNS,
  OrgMemberNameSchema,
  type OwnerTransferCandidatesResponse,
} from '@/schemas/membership/organization-member-name';

/** 譲渡を提案できる役割 (POST /api/org/owner-transfer/propose と同じ。候補はこの役割の人を除く) */
const OWNER_ROLE = 'owner';

export async function GET(_request: Request) {
  try {
    const { user, profile } = await requireOrgAdmin();
    // 管理者 (admin) は譲渡を提案できないので、候補も返さない
    if (profile.org_role !== OWNER_ROLE) {
      throw new ForbiddenError('PERM_DENIED');
    }

    // service_role の client は、上の確認を通ったあとの読みにだけ使う
    const { data: rows, error } = await getSupabaseAdmin()
      .from('user_profiles')
      .select(ORG_MEMBER_NAME_COLUMNS)
      .eq('organization_id', profile.organization_id)
      .neq('id', user.id)
      .neq('org_role', OWNER_ROLE)
      .order('joined_org_at', { ascending: true });

    if (error) throw new Error(error.message);

    // 4 つのキーだけにそろえる (select の列を誤って足しても応答には出さない)。形が違えば 500
    const body: OwnerTransferCandidatesResponse = { candidates: OrgMemberNameSchema.array().parse(rows ?? []) };
    return NextResponse.json(body);
  } catch (error) {
    // 401 / 403 は日本語の固定の文 (src/lib/org-api-errors.ts)。例外の文面は本文に入れない
    const authFailure = orgAuthFailureFlat(error);
    if (authFailure) return authFailure;
    // 500 の本文は汎用メッセージだけ (#1172)。詳細は db-logger にだけ残す
    createLogger('GET /api/org/owner-transfer/candidates', generateRequestId()).error('オーナーの譲渡の候補の取得に失敗しました', error);
    return NextResponse.json({ error: ORG_API_INTERNAL_ERROR_MESSAGE }, { status: 500 });
  }
}
