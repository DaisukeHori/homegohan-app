/**
 * GET    /api/super-admin/exports/[id]  — エクスポートステータス確認
 * DELETE /api/super-admin/exports/[id]  — エクスポートキャンセル
 * operator/02-api-spec.md §16 準拠
 *
 * エクスポートは gdpr_deletion_requests テーブルを代用している (専用テーブルは未作成)。
 * このテーブルに status / deletion_type / request_details / created_at 列は無い (#1306)。
 *   - 状態は cancelled_at / executed_at から導く (deriveExportStatus)。作成日時は requested_at。
 *   - 以前の DELETE は存在しない status 列を select しており、PostgREST の 42703 を error も見ずに
 *     「行が無い」として扱っていたため、どの id でも 404 だった (キャンセルは一度も成功していない)。
 *     GET は select('*') だったので失敗はせず、status は常に pending、created_at は欠けた形で返っていた。
 *   - 行の実体は本人の GDPR 削除要求なので、DELETE (キャンセル) は cancelled_at を入れてその要求を取り消す。
 *     誰がどの本人の要求を取り消したかは、監査ログの details.subject_user_id に残す。
 * 列の有無は tests/integration/security/select-columns-exist.test.ts で本番スキーマと突き合わせる。
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { recordAdminAudit } from '@/lib/admin/audit';
import { isUuid } from '@/lib/admin/users-search';
import { deriveExportStatus } from '@/lib/super-admin/exports-schemas';
import type { Tables } from '@/types/database.types';

type Params = { params: { id: string } };

type GdprRequestRow = Pick<
  Tables<'gdpr_deletion_requests'>,
  'id' | 'user_id' | 'requested_at' | 'cancelled_at' | 'executed_at'
>;

function notFoundResponse() {
  return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'エクスポートが見つかりません' } }, { status: 404 });
}

function internalErrorResponse(message: string) {
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
}

/** requireRole の認証・認可エラーは 401 / 403 に、それ以外は記録して 500 にする (DB の生のエラー文は返さない) */
function errorResponse(err: unknown, logger: ReturnType<typeof createLogger>) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
  }
  logger.error('エクスポート API で予期しないエラー', err);
  return internalErrorResponse('サーバーエラーが発生しました');
}

export async function GET(_request: NextRequest, { params }: Params) {
  const logger = createLogger('GET /api/super-admin/exports/[id]', generateRequestId());
  try {
    const user = await requireRole(['super_admin']);

    // UUID の形でない id は存在し得ない。そのまま DB に渡すと 22P02 で失敗するので、先に 404 にする
    if (!isUuid(params.id)) return notFoundResponse();

    const supabase = await createClient();

    const { data, error } = await supabase
      .from('gdpr_deletion_requests')
      .select('id, user_id, requested_at, cancelled_at, executed_at')
      .eq('id', params.id)
      .maybeSingle();

    // DB のエラーを「見つからない」にしない (存在しない列を読んだ失敗が 404 に見えていた)
    if (error) {
      logger.withUser(user.id).error('エクスポートの取得に失敗', error, { exportId: params.id, pg_code: error.code });
      return internalErrorResponse('エクスポートの取得に失敗しました');
    }
    if (!data) return notFoundResponse();

    const row = data as GdprRequestRow;
    return NextResponse.json({
      data: {
        id: row.id,
        // このテーブルの行は GDPR 削除要求なので種別は gdpr。形式を保存する列は無いため従来と同じ csv の固定値
        export_type: 'gdpr',
        format: 'csv',
        status: deriveExportStatus(row),
        requested_by: row.user_id,
        created_at: row.requested_at,
        file_url: null,
      },
    });
  } catch (err) {
    return errorResponse(err, logger);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const logger = createLogger('DELETE /api/super-admin/exports/[id]', generateRequestId());
  try {
    const user = await requireRole(['super_admin']);

    if (!isUuid(params.id)) return notFoundResponse();

    const supabase = await createClient();

    const { data, error: readError } = await supabase
      .from('gdpr_deletion_requests')
      .select('id, user_id, cancelled_at, executed_at')
      .eq('id', params.id)
      .maybeSingle();

    if (readError) {
      logger.withUser(user.id).error('キャンセル対象のエクスポートの取得に失敗', readError, {
        exportId: params.id,
        pg_code: readError.code,
      });
      return internalErrorResponse('エクスポートのキャンセルに失敗しました');
    }
    if (!data) return notFoundResponse();

    const existing = data as Pick<GdprRequestRow, 'id' | 'user_id' | 'cancelled_at' | 'executed_at'>;
    const status = deriveExportStatus(existing);

    if (status === 'completed') {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '完了済みのエクスポートはキャンセルできません' } },
        { status: 422 },
      );
    }

    // すでにキャンセル済みなら何もしない (cancelled_at を上書きして記録を変えず、監査ログも重ねない)
    if (status === 'cancelled') {
      return NextResponse.json({ data: { id: params.id, deleted: true } });
    }

    // 状態の確認から更新までの間にバッチが実行したり、別の操作でキャンセルされたりしても上書きしないよう、
    // 確認したのと同じ条件を更新にも付ける。更新できた行が無ければ状態が変わっている。
    const { data: updated, error: updateError } = await supabase
      .from('gdpr_deletion_requests')
      .update({ cancelled_at: new Date().toISOString() })
      .eq('id', params.id)
      .is('cancelled_at', null)
      .is('executed_at', null)
      .select('id');

    if (updateError) {
      logger.withUser(user.id).error('エクスポートのキャンセルに失敗', updateError, {
        exportId: params.id,
        pg_code: updateError.code,
      });
      return internalErrorResponse('エクスポートのキャンセルに失敗しました');
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        {
          error: {
            code: 'CONFLICT_STALE_DATA',
            message: 'エクスポートの状態が変わったため、キャンセルできませんでした。画面を読み込み直してください',
          },
        },
        { status: 409 },
      );
    }

    // 監査ログ。キャンセルは済んでいて取り消せないので、記録に失敗しても成功として返す
    // (recordAdminAudit は例外を投げず、失敗は db-logger で app_logs に error として残す)。
    // details.subject_user_id は、取り消された要求の本人 (誰の要求をキャンセルしたかを後から引けるようにする)
    await recordAdminAudit({
      supabase,
      actorId: user.id,
      actionType: 'admin.export.request',
      targetId: params.id,
      targetType: 'export',
      details: { action: 'cancel', subject_user_id: existing.user_id },
      request,
      routeName: 'DELETE /api/super-admin/exports/[id]',
    });

    return NextResponse.json({ data: { id: params.id, deleted: true } });
  } catch (err) {
    return errorResponse(err, logger);
  }
}
