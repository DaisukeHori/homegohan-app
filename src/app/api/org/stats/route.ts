/**
 * GET /api/org/stats — 組織ダッシュボード統計 API
 * 所属組織の org_role が owner / admin のユーザーのみ (#1235)。判定は共通の requireOrgAdmin() (#1161)
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';

export async function GET() {
  try {
    const { profile } = await requireOrgAdmin();
    const orgId = profile.organization_id;

    // メンバー数
    const supabase = await createClient();
    const { count: memberCount } = await supabase
      .from('user_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId);

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
