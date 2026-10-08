/**
 * POST /api/org/stats/refresh — 組織ダッシュボードの「Refresh Data」 (#1167)
 * 自分の組織の日次統計 (org_daily_stats) を、今すぐ集計し直す。
 * 権限: 所属組織の org_role が owner / admin のユーザーのみ (#1235)。集計できるのは自分の組織だけ。
 *
 * 以前は、ブラウザが Edge Function aggregate-org-stats を直接呼んでいた。
 * この関数はバッチ専用 (service role / CRON_SECRET の認証) で、ログイン中の利用者の JWT では 401 になるため、
 * ボタンは押しても常に失敗していた。かといって、ブラウザから呼べるように関数へ CORS を開けるのは危険なので、
 * ここで権限を確認したあと、サーバーから service role key を付けて呼ぶ。
 *
 * 集計する組織は、リクエストの内容ではなく、確認済みのプロフィールの organization_id だけを使う
 * (リクエストに組織 ID を載せても無視する。他の組織を集計させられないように)。
 * 集計する日付も送らず、Edge Function の既定 (JST の今日。#1210) に任せる。
 * ブラウザの時計や、UTC の暦日 (JST の早朝は前日になる) には頼らない。
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { isOrgAdmin } from '@/lib/auth/org-admin';
import { createLogger, generateRequestId } from '@/lib/db-logger';

export const dynamic = 'force-dynamic';
// 下の待ち時間の上限 (25 秒) より先に、Vercel の実行時間の上限で打ち切られないようにする
export const maxDuration = 30;

// Edge Function の応答を待つ上限 (ミリ秒)。1 組織分の集計なので通常は数秒で終わる
const EDGE_FUNCTION_TIMEOUT_MS = 25_000;

export async function POST() {
  const logger = createLogger('POST /api/org/stats/refresh', generateRequestId());

  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new AuthError('AUTH_UNAUTHENTICATED');
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id, org_role')
      .eq('id', user.id)
      .single();
    if (!isOrgAdmin(profile)) {
      throw new ForbiddenError('PERM_DENIED', 'owner/admin role required');
    }

    const userLogger = logger.withUser(user.id);
    const organizationId = profile.organization_id;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      // 呼び出せないのに成功を装わず、明示的にサービス利用不可を返す (fail-closed)
      userLogger.error(
        '組織統計を更新できません (Supabase の接続情報が不足しています)',
        new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'),
        { organizationId },
      );
      return NextResponse.json(
        {
          error: {
            code: 'ORG_STATS_REFRESH_UNAVAILABLE',
            message: '統計の更新サービスが設定されていません',
          },
        },
        { status: 503 },
      );
    }

    let edgeRes: Response;
    try {
      edgeRes = await fetch(`${supabaseUrl}/functions/v1/aggregate-org-stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({ organizationId }),
        signal: AbortSignal.timeout(EDGE_FUNCTION_TIMEOUT_MS),
      });
    } catch (fetchErr) {
      userLogger.error('aggregate-org-stats の呼び出しに失敗しました', fetchErr, { organizationId });
      return NextResponse.json(
        {
          error: {
            code: 'ORG_STATS_REFRESH_FAILED',
            message: '統計の更新に失敗しました。しばらくしてからもう一度お試しください',
          },
        },
        { status: 502 },
      );
    }

    if (!edgeRes.ok) {
      // 関数のエラー文 (DB の内部情報を含みうる) はクライアントへ返さず、ログにだけ残す
      const detail = await edgeRes.text().catch(() => '');
      userLogger.error(
        'aggregate-org-stats がエラーを返しました',
        new Error(`HTTP ${edgeRes.status}`),
        { organizationId, status: edgeRes.status, detail: detail.slice(0, 500) },
      );
      return NextResponse.json(
        {
          error: {
            code: 'ORG_STATS_REFRESH_FAILED',
            message: '統計の更新に失敗しました。しばらくしてからもう一度お試しください',
          },
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    logger.error('組織統計の更新で予期しないエラーが発生しました', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '統計の更新に失敗しました' } },
      { status: 500 },
    );
  }
}
