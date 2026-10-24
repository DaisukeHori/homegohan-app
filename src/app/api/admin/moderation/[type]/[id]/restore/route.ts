/**
 * POST /api/admin/moderation/{type}/{id}/restore — 運営が隠したコンテンツを戻す (#1538 の項目 4)
 * 設計: docs/design/operator/13-hidden-content-restore.md
 * 権限: admin, super_admin, content_moderator (隠す操作 POST / PUT /api/admin/moderation/{type}/{id} と同じ)
 *
 * - {id} は通報 (moderation_flags / recipe_flags) の id。通報が指すコンテンツ本体 (meals / recipes) の hidden_at / hidden_by /
 *   hidden_reason を NULL に戻し、本人以外にも再び見えるようにする。食事は、同じまとまり (paste_group_id) で同じ操作で隠した複製
 *   (同じ hidden_at) と、あとから同じ中身のまま隠れた複製もまとめて戻す (src/lib/admin/hidden-content-restore.ts の listRowsHiddenTogether)。
 *   戻した行は、完全削除のジョブ purge-hidden-content (隠してから 90 日) の対象から外れる
 * - 戻せるのは、隠されていて、隠してから 89 日 (HIDDEN_CONTENT_RESTORE_WINDOW_DAYS) 以内の行だけ。行が無い (持ち主が消した・完全削除された)
 *   → 410 OP_CONTENT_GONE、隠れていない → 409 OP_CONTENT_NOT_HIDDEN、89 日を過ぎた → 409 OP_CONTENT_RESTORE_WINDOW_EXPIRED
 * - 順は「通報 (rejected → approved) → 行 (hidden_* を NULL)」。通報の更新に失敗したら何も変えず 500 INTERNAL_ERROR。通報を approved に
 *   したあとで行の更新に失敗したら 500 OP_CONTENT_RESTORE_FAILED (行は隠れたまま。画面の「非表示の解除」の欄からやり直せる)
 * - 通報された行の更新が 0 行 (読んでから書くまでに別の操作が戻した・消した・隠し直した・期限の境を越えた) なら、読み直して 409 / 410 を返す
 * - 戻す理由 (restore_note) は必須。監査ログ admin.moderation.restore (本人の権限の client・fail-open) に、通報・コンテンツ・持ち主・理由・
 *   隠していたときの 3 列の値・対象と戻した行・approved にした通報・各段の成否を残す。残すのは状態を変えた操作 (成功 info・0 行でも
 *   何かを書いていれば warn) と DB の失敗 (warn)。何も書かずに断った 409 / 410 は残さない
 * - BAN (user_profiles.frozen_at) には触らない (解除は DELETE /api/admin/users/{id}/freeze)
 * - 本文の NULL 文字は、認証・DB に触れる前に 400 INVALID_CHARACTER (#1657。src/__tests__/api/null-character-routes.test.ts)
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { operatorForbiddenMessageOf } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import {
  MODERATION_RESTORE_AUDIT_ACTION,
  MODERATION_TYPES,
  MODERATION_TYPE_INVALID_MESSAGE,
  ModerationRestoreBodySchema,
  type ModerationType,
} from '@/lib/admin/moderation-schemas';
import {
  AI_CONTENT_NOT_SUPPORTED_MESSAGE,
  fetchModerationSingle,
  isModerationBacked,
} from '@/lib/admin/moderation-backend';
import {
  HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
  HIDDEN_CONTENT_RETENTION_DAYS,
  HiddenContentRestoreStepError,
  restoreModeratedContent,
  type HiddenContentRestorability,
  type HiddenContentRestoreProgress,
  type HiddenContentRowHidden,
} from '@/lib/admin/hidden-content-restore';
import { notSupportedResponse } from '@/lib/admin/not-supported';
import { recordAdminAudit, type AdminAuditSeverity } from '@/lib/admin/audit';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { isUuid } from '@/lib/http-params';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ type: string; id: string }> };

const ROUTE_NAME = 'api/admin/moderation/[type]/[id]/restore POST';

/** 監査ログ用にエラーを文字列にする (supabase-js のエラーは Error とは限らない) */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : String(err);
}

function errorResponse(status: number, code: string, message: string, data?: Record<string, unknown>) {
  return NextResponse.json(data === undefined ? { error: { code, message } } : { error: { code, message }, data }, { status });
}

/**
 * 戻せない理由 (判定・または 0 行のあとの読み直し) を応答にする (§10.1.1 の P-9〜P-11・P-18〜P-21)。
 * restorable は「0 行のあとで読み直すと戻せる = 別の時刻で隠し直されていた」(P-21) なので 409 CONFLICT_STALE_DATA
 */
function restorabilityErrorResponse(judged: HiddenContentRestorability) {
  switch (judged.kind) {
    case 'gone':
      return errorResponse(410, 'OP_CONTENT_GONE', 'コンテンツはすでに削除されています');
    case 'not_hidden':
      return errorResponse(409, 'OP_CONTENT_NOT_HIDDEN', 'このコンテンツはすでに表示されています', { content_hidden: false });
    case 'window_expired':
      return errorResponse(
        409,
        'OP_CONTENT_RESTORE_WINDOW_EXPIRED',
        `隠してから ${HIDDEN_CONTENT_RESTORE_WINDOW_DAYS} 日を過ぎたため戻せません (保管期間 ${HIDDEN_CONTENT_RETENTION_DAYS} 日で完全に削除されます)`,
        { content_hidden: true, hidden_at: judged.row.hidden_at },
      );
    case 'restorable':
      // 画面を開き直せば「非表示の解除」の欄が出て、やり直せる
      return errorResponse(409, 'CONFLICT_STALE_DATA', 'コンテンツの状態が変わりました。画面を開き直して、もう一度確認してください', {
        content_hidden: true,
      });
  }
}

/** 0 行のあとで読み直した判定ごとの、監査ログの restore_error (固定の文。応答には出さない) */
const RACED_RESTORE_ERROR: Record<HiddenContentRestorability['kind'], string> = {
  gone: 'raced: the content row was deleted before it was restored',
  not_hidden: 'raced: the content row was already restored by another operation',
  window_expired: 'raced: the restore window ended before the content row was updated',
  restorable: 'raced: the content row was hidden again by another operation',
};

export async function POST(request: Request, props: Params) {
  // 本文の NULL 文字は、認証・DB に触れる前に 400 で断る (#1657)
  const nullCharacterRejection = await rejectNullCharacterBody(request, { shape: 'nested' });
  if (nullCharacterRejection) return nullCharacterRejection;
  const params = await props.params;

  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(401, 'AUTH_UNAUTHENTICATED', '認証が必要です');
    }
    if (err instanceof ForbiddenError) {
      return errorResponse(403, 'OP_PERMISSION_DENIED', operatorForbiddenMessageOf(err));
    }
    throw err;
  }

  const { type, id } = params;
  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    return errorResponse(400, 'VALIDATION_ERROR', MODERATION_TYPE_INVALID_MESSAGE);
  }
  const moderationType = type as ModerationType;
  // ai_content は準備中 (未対応)。本文の検証より前に 501 (#1128)
  if (!isModerationBacked(moderationType)) {
    return notSupportedResponse(AI_CONTENT_NOT_SUPPORTED_MESSAGE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'リクエストボディが不正です');
  }
  const parseResult = ModerationRestoreBodySchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'バリデーションエラー', details: parseResult.error.flatten() } },
      { status: 400 },
    );
  }
  const { restore_note } = parseResult.data;

  // 通報の読み取り・通報と行の更新は service_role (hidden_* を書けるのは service_role だけ: guard_hidden_content_columns)。
  // 監査ログだけ本人の権限の client (RLS audit_logs_insert_admins)
  const supabaseAdmin = getSupabaseAdmin();
  const supabase = await createClient();

  // UUID の形でない id は DB に渡さず、通報が無いときと同じ 404 (moderation_flags.id / recipe_flags.id は uuid の列。
  // 渡すと 22P02 で失敗し、下の catch の 500 に入る。#1917 の続き)
  if (!isUuid(id)) {
    return errorResponse(404, 'NOT_FOUND', 'モデレーションアイテムが見つかりません');
  }

  let item;
  try {
    item = await fetchModerationSingle(supabaseAdmin, moderationType, id);
  } catch (err) {
    console.error('[api/admin/moderation/[type]/[id]/restore] fetch error:', describeError(err));
    return errorResponse(500, 'INTERNAL_ERROR', '内部エラーが発生しました');
  }
  if (!item) {
    return errorResponse(404, 'NOT_FOUND', 'モデレーションアイテムが見つかりません');
  }
  const contentId = item.content_id;
  if (contentId === null) {
    // 通報にコンテンツが紐づいていない (meal_id / recipe_id を NULL のまま作った通報。行を消すと通報も外部キーの CASCADE で消えるので、行の消滅では起きない)。戻す対象が無い
    return errorResponse(410, 'OP_CONTENT_GONE', 'コンテンツはすでに削除されています');
  }

  /**
   * 監査ログ (admin_audit_logs) に 1 行入れる。状態を変えた操作 (通報を approved にした・行を戻した) と DB の失敗で、同じ形で残す。
   * 何も書かずに断ったとき (判定の 409 / 410・0 行で何も書いていないとき) は呼ばない (§6.6)
   */
  const insertAuditLog = async (outcome: {
    before: HiddenContentRowHidden | null;
    /** 戻す対象の行・approved にした通報・戻した行 */
    progress: HiddenContentRestoreProgress;
    /** 通報の状態 (rejected → approved) を更新できたか */
    statusSaved: boolean;
    statusError: string | null;
    /** 通報された行を戻せたか */
    restored: boolean;
    restoreError: string | null;
    severity: AdminAuditSeverity;
  }) => {
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: MODERATION_RESTORE_AUDIT_ACTION,
      targetId: id,
      targetType: `moderation_item:${type}`,
      details: {
        moderation_type: type,
        flag_id: id,
        content_id: contentId,
        content_user_id: item.user_id,
        restore_note,
        // 隠していたときの値 (通報された行の値。3 列とも NULL に戻すので、行には残らない)
        hidden_at_before: outcome.before?.hidden_at ?? null,
        hidden_by_before: outcome.before?.hidden_by ?? null,
        hidden_reason_before: outcome.before?.hidden_reason ?? null,
        // 戻す対象の行 (D-5) と、実際に戻した行
        target_ids: [...outcome.progress.targetIds],
        restored_ids: [...outcome.progress.restoredIds],
        restored: outcome.restored,
        restore_error: outcome.restoreError,
        // approved にした通報と、通報の更新の成否
        approved_flag_ids: [...outcome.progress.approvedFlagIds],
        status_saved: outcome.statusSaved,
        status_error: outcome.statusError,
        restore_window_days: HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
      },
      severity: outcome.severity,
      request,
      routeName: ROUTE_NAME,
    });
  };

  const now = new Date();
  let outcome;
  try {
    outcome = await restoreModeratedContent(supabaseAdmin, moderationType, contentId, {
      restoredBy: actor.id,
      restoreNote: restore_note,
      now,
    });
  } catch (err) {
    if (!(err instanceof HiddenContentRestoreStepError)) {
      console.error('[api/admin/moderation/[type]/[id]/restore] unexpected error:', describeError(err));
      return errorResponse(500, 'INTERNAL_ERROR', '内部エラーが発生しました');
    }
    // 元のエラー文は構造化ログと監査ログにだけ残し、応答には固定の文を返す (#1172)
    const reasonText = describeError(err.reason);
    createLogger(ROUTE_NAME, generateRequestId())
      .withUser(actor.id)
      .error('隠したコンテンツを戻せませんでした', err.reason, {
        moderation_type: type,
        flag_id: id,
        content_id: contentId,
        step: err.step,
      });
    if (err.step === 'rows' || err.step === 'reread') {
      // 通報は approved にできた (または 0 行)。通報された行は隠れたまま (その組は最後に書く)。画面の「非表示の解除」の欄からやり直せる
      await insertAuditLog({
        before: err.before,
        progress: err.progress,
        statusSaved: true,
        statusError: null,
        restored: false,
        restoreError: reasonText,
        severity: 'warn',
      });
      return errorResponse(
        500,
        'OP_CONTENT_RESTORE_FAILED',
        'コンテンツを表示に戻せませんでした。通報の状態は承認済みにしました。もう一度同じ操作を実行してください。',
        { content_hidden: true, approved_flag_ids: [...err.progress.approvedFlagIds] },
      );
    }
    // read / flags: 何も変えていない
    await insertAuditLog({
      before: err.before,
      progress: err.progress,
      statusSaved: false,
      statusError: err.step === 'flags' ? reasonText : null,
      restored: false,
      restoreError: err.step === 'read' ? reasonText : null,
      severity: 'warn',
    });
    // 読み取りの段 (read) の失敗では、隠れているかどうかも分からないので data を付けない
    return errorResponse(
      500,
      'INTERNAL_ERROR',
      err.step === 'flags'
        ? '通報の状態を更新できませんでした。コンテンツはまだ非表示のままです。もう一度同じ操作を実行してください。'
        : 'コンテンツの状態を読み取れませんでした。もう一度同じ操作を実行してください。',
      err.step === 'flags' ? { content_hidden: true } : undefined,
    );
  }

  switch (outcome.kind) {
    case 'gone':
    case 'not_hidden':
    case 'window_expired':
      // 判定で戻せない (何も書いていない。監査ログは残さない: 状態を変えていない)
      return restorabilityErrorResponse(outcome);
    case 'raced':
      // 通報された行の UPDATE が 0 行 (P-18〜P-21)。この操作が何かを書いていれば (通報を approved にした・先の組の行を戻した)、
      // それを warn で残す。何も書いていなければ残さない (§6.6)
      if (outcome.approvedFlagIds.length > 0 || outcome.restoredIds.length > 0) {
        await insertAuditLog({
          before: outcome.before,
          progress: outcome,
          statusSaved: true,
          statusError: null,
          restored: false,
          restoreError: RACED_RESTORE_ERROR[outcome.again.kind],
          severity: 'warn',
        });
      }
      return restorabilityErrorResponse(outcome.again);
    case 'restored':
      break;
  }

  await insertAuditLog({
    before: outcome.before,
    progress: outcome,
    statusSaved: true,
    statusError: null,
    restored: true,
    restoreError: null,
    severity: 'info',
  });

  return NextResponse.json({
    data: {
      success: true,
      content_hidden: false,
      restored_ids: outcome.restoredIds,
      approved_flag_ids: outcome.approvedFlagIds,
    },
  });
}
