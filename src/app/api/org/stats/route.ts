/**
 * GET /api/org/stats — 組織ダッシュボード統計 API
 * 所属組織の org_role が owner / admin のユーザーのみ (#1235)。判定は共通の requireOrgAdmin() (#1161)
 *
 * 返すのはメンバー数だけ。日次の集計 (活力スコアなど) は、オーナー判断 (#1325) で止めている。
 */
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';

export async function GET() {
  try {
    const { profile } = await requireOrgAdmin();
    const orgId = profile.organization_id;

    // メンバー数。user_profiles は RLS で本人の行しか見えず、利用者本人の権限で数えると、組織の人数に関わらず
    // 常に 1 (管理者自身) になる。そのため、認可 (上の requireOrgAdmin) を通したあとで service_role を使って数える。
    // 数える範囲は、確認済みのプロフィールの organization_id (呼び出した管理者の所属組織) だけ。
    const { count: memberCount, error } = await getSupabaseAdmin()
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId);
    if (error) throw new Error(error.message);

    return NextResponse.json({
      stats: {
        member_count: memberCount ?? 0,
        organization_id: orgId,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    // 500 の本文は汎用メッセージだけ (#1172)。詳細は db-logger にだけ残す
    createLogger('GET /api/org/stats', generateRequestId()).error('組織統計の取得に失敗しました', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
