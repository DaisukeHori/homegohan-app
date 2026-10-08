/**
 * POST /api/org/stats/refresh — 組織統計の再集計 (停止中。常に 410)
 *
 * オーナー判断 (#1325): 組織の統計の集計は「止める」。組織ダッシュボードの「Refresh Data」ボタンは取り除いた。
 * このルートは、古い画面 (ボタンがまだ残っている、開きっぱなしのタブなど) から呼ばれたときに
 * 「停止している」とはっきり答えるために残している。集計はしない。
 *
 * 認可は停止前と同じ (#1167 / #1235)。未ログインは 401、所属組織の owner / admin 以外は 403。
 * 共通の requireOrgAdmin() (#1161) を通ったあとに 410 を返す。
 * Edge Function aggregate-org-stats は呼ばない (関数も 410 を返すだけで、何も集計しない)。
 * 集計を再開するには、新しいオーナー判断が要る。
 */

import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireOrgAdmin } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';

export const dynamic = 'force-dynamic';

export async function POST() {
  const logger = createLogger('POST /api/org/stats/refresh', generateRequestId());

  try {
    // 未ログインは AuthError (401)、所属組織の owner / admin でなければ ForbiddenError (403)
    await requireOrgAdmin();

    return NextResponse.json(
      { error: { code: 'DISABLED', message: '組織の集計は停止しています' } },
      { status: 410 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    logger.error('組織統計の再集計の認可で予期しないエラーが発生しました', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: '統計の更新に失敗しました' } },
      { status: 500 },
    );
  }
}
