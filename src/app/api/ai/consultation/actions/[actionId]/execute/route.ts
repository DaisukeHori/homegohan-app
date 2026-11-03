import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiChatDisabledResponse } from '@/lib/ai/ai-chat-gate';
import { AI_SENDING_ACTION_TYPES, runConsultationAction, type ConsultationActionExecutionResult } from '@/lib/ai/consultation-action-executor';
import { aiDailyLimitResponse } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';
import { API_UNAUTHENTICATED_MESSAGE, API_FORBIDDEN_MESSAGE } from '@/lib/api/error-responses';
import { AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, AI_CONSULTATION_ACTION_UNKNOWN_TYPE_MESSAGE } from '@/lib/ai/ai-api-messages';
import {
  AI_ACTION_LOG_STATUS,
  PROPOSED_ACTION_NOT_EXECUTABLE_REASON,
  aiActionLogStatusAfterFailure,
  aiActionLogStatusAfterRun,
  notExecutableReasonAfterRun,
  proposedActionNotExecutableReasonOfStatus,
  proposedActionNotExecutableReasonOfStatuses,
  type ProposedActionNotExecutableReason,
} from '@/lib/ai/consultation-action-lifecycle';
import { writeBackAiActionLog } from '@/lib/ai/consultation-action-log-writes';

// 指定日付の user_daily_meals を取得または作成するヘルパー関数
// NOTE: 現状このファイル内では未使用（resolveExistingTargetSlots が同等の処理を担う）。
// 将来の直接呼び出しに備えて残置。
async function getOrCreateDailyMeal(supabase: any, userId: string, dayDate: string): Promise<{ id: string } | null> {
  // 既存のレコードを探す
  let { data: dailyMeal, error } = await supabase
    .from('user_daily_meals')
    .select('id')
    .eq('user_id', userId)
    .eq('day_date', dayDate)
    .maybeSingle();

  if (error) return null;
  if (dailyMeal) return dailyMeal;

  // なければ新規作成
  const { data: newDailyMeal, error: createError } = await supabase
    .from('user_daily_meals')
    .insert({
      user_id: userId,
      day_date: dayDate,
      is_cheat_day: false,
    })
    .select('id')
    .single();

  if (createError) return null;
  return newDailyMeal;
}

const EXECUTE_ROUTE_NAME = 'POST /api/ai/consultation/actions/[actionId]/execute';

/**
 * 実行できない提案の応答 (400 / 404) に、「実行する」を出さない理由を添える (#2195 V2)。
 * 画面は理由で案内の文を分ける (実行済み・いま実行中は『実行中か実行済みです』、実行中の印のまま (書き戻せなかった) は
 * 『実行できたかを確かめられませんでした…』(#2201 U3)、失敗・記録なしは『もう一度 AI に頼んでください』)
 */
function notExecutableResponse(
  error: string,
  status: 400 | 404,
  reason: ProposedActionNotExecutableReason | null,
): NextResponse {
  return NextResponse.json({ error, ...(reason ? { notExecutableReason: reason } : {}) }, { status });
}

/**
 * メッセージ ID で実行を待っている (pending の) 行が見つからなかったとき、そのメッセージの行の状態から「実行する」を出さない理由を決める。
 * Web の提案のカードはメッセージ ID で実行の API を呼ぶので、別の画面・自動実行が実行中か実行済みの提案を押すとここに来る。
 * 自分の相談の行だけを見る (ほかの人の行の有無は返さない)。読めなかった・行が無いときは null (理由を添えない)
 */
async function notExecutableReasonOfMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  messageId: string,
  userId: string,
): Promise<ProposedActionNotExecutableReason | null> {
  const { data, error } = await supabase
    .from('ai_action_logs')
    .select('status, ai_consultation_sessions!inner(user_id)')
    .eq('message_id', messageId)
    .eq('ai_consultation_sessions.user_id', userId);
  if (error || !Array.isArray(data)) return null;
  return proposedActionNotExecutableReasonOfStatuses((data as Array<{ status: unknown }>).map((row) => row.status));
}

// アクション実行
export async function POST(request: Request, props: { params: Promise<{ actionId: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // #1148: AI 相談の緊急停止スイッチ (feature_flags の ai_chat_enabled。通常は ON)。回数の枠を使わせないよう、レート制限より前に見る
  const unavailable = await aiChatDisabledResponse(user.id);
  if (unavailable) return unavailable;

  const rateLimitResult = await checkRateLimit(user.id, 'generation');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  // #1177 AI 利用回数は、ここ (アクションの実行) では記録しない。AI を使うアクション (献立の生成・料理画像) だけを、
  // runConsultationAction (src/lib/ai/consultation-action-executor.ts) が AI へ送る直前に記録する
  // (献立の削除・買い物リストの操作など、AI を使わないアクションは記録しない)

  try {
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.actionId)) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // actionIdはメッセージIDまたはアクションログIDの可能性がある
    let { data: action, error: actionError } = await supabase
      .from('ai_action_logs')
      .select(`
        *,
        ai_consultation_sessions!inner(user_id)
      `)
      .eq('id', params.actionId)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ、メッセージ ID として探し直す。#1917)
    if (actionError) {
      return internalError(EXECUTE_ROUTE_NAME, actionError, { userId: user.id, table: 'ai_action_logs' });
    }

    // 見つからない場合はメッセージIDとして検索
    if (!action) {
      const { data: actionByMessage, error: msgError } = await supabase
        .from('ai_action_logs')
        .select(`
          *,
          ai_consultation_sessions!inner(user_id)
        `)
        .eq('message_id', params.actionId)
        .eq('status', AI_ACTION_LOG_STATUS.pending)
        .maybeSingle();
      
      if (msgError) {
        return internalError(EXECUTE_ROUTE_NAME, msgError, { userId: user.id, table: 'ai_action_logs' });
      }
      if (!actionByMessage) {
        // 実行を待っている行が無い。実行中・実行済みなら、画面は頼み直しを勧めない案内にする (#2195 V2)
        return notExecutableResponse(
          AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE,
          404,
          await notExecutableReasonOfMessage(supabase, params.actionId, user.id),
        );
      }
      action = actionByMessage;
    }

    if (!action) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    if (action.ai_consultation_sessions.user_id !== user.id) {
      return NextResponse.json({ error: API_FORBIDDEN_MESSAGE }, { status: 403 });
    }

    if (action.status !== AI_ACTION_LOG_STATUS.pending) {
      return notExecutableResponse(
        AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE,
        400,
        proposedActionNotExecutableReasonOfStatus(action.status),
      );
    }

    // 献立の生成のアクションは、利用者のデータを外国の AI 事業者へ送る。同意が無ければ送らずに止める
    // (T15 / #1154。403 AI_CONSENT_REQUIRED)。アクションは pending のまま残すので、同意したあとにもう一度実行できる
    if (AI_SENDING_ACTION_TYPES.has(action.action_type)) {
      const aiConsentDenied = await requireAiConsent(supabase, user.id);
      if (aiConsentDenied) return aiConsentDenied;
    }

    // 実行中の印を付ける (#2189 W1-a)。pending から approved への条件つきの 1 文で、書けた 1 本だけが実行する
    // (2 つの画面から同時に押す・自動実行の最中に押すと、同じ提案を二重に実行していた。失敗した提案を pending のまま残して
    // やり直せるようにしたので、二重の実行を DB の 1 文で防ぐ)
    const { data: claimed, error: claimError } = await supabase
      .from('ai_action_logs')
      .update({ status: AI_ACTION_LOG_STATUS.running })
      .eq('id', action.id)
      .eq('status', AI_ACTION_LOG_STATUS.pending)
      .select('id')
      .maybeSingle();

    if (claimError) {
      return internalError(EXECUTE_ROUTE_NAME, claimError, { userId: user.id, table: 'ai_action_logs' });
    }
    if (!claimed) {
      // 読んだあとに別の画面・自動実行が先に取った (実行中か実行済み)
      return notExecutableResponse(
        AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE,
        400,
        PROPOSED_ACTION_NOT_EXECUTABLE_REASON.runningOrDone,
      );
    }

    const writeBackCtx = { userId: user.id, actionLogId: action.id, actionType: action.action_type };

    // #1047 F2-21: アクション実行の中核ロジックは src/lib/ai/consultation-action-executor.ts
    // に抽出済み（messages/route.ts からも self-fetch ではなく直接呼び出す）。
    let executionResult: ConsultationActionExecutionResult;
    try {
      executionResult = await runConsultationAction(supabase, user, action);
    } catch (runError) {
      // 実行中の印のまま残さない。やり直せる種類は pending に戻し、やり直させない種類は failed にする
      const status = aiActionLogStatusAfterFailure(action.action_type);
      const { error: revertError } = await writeBackAiActionLog(supabase, EXECUTE_ROUTE_NAME, writeBackCtx, {
        status,
        executed_at: status === AI_ACTION_LOG_STATUS.pending ? null : new Date().toISOString(),
      });
      // 500 の本文に、もう一度押せるか (行が pending に戻った) を添える (#2195 V2)。献立の生成 (failed にした) と、
      // 書き戻せなかった (実行中の印のまま) ときは false で、画面は「実行する」を出さずに案内にする
      // (以前は「実行する」が残り、押すと 400 になってから案内に変わった)。案内の理由は、書き戻せなかったときは
      // 開き直したときの GET と同じ unconfirmed、failed にしたときは failed (#2201 U3)
      const errorResponse = internalError(EXECUTE_ROUTE_NAME, runError, { userId: user.id });
      const retryable = !revertError && status === AI_ACTION_LOG_STATUS.pending;
      return NextResponse.json(
        {
          ...(await errorResponse.json()),
          retryable,
          ...(retryable ? {} : { notExecutableReason: notExecutableReasonAfterRun(!!revertError) }),
        },
        { status: errorResponse.status },
      );
    }

    // 行の状態は src/lib/ai/consultation-action-lifecycle.ts の決まり (成功は executed・今日の上限は pending・
    // 失敗はやり直せる種類なら pending、やり直させない種類・対応していない種類・やり直しても直らない失敗は failed)
    const status = aiActionLogStatusAfterRun(action.action_type, executionResult);

    // 今日の AI の利用回数の上限 (#1149) に達して、献立の生成をしなかった。アクションは pending に戻す
    // (明日もう一度実行できる。同意が無くて止めたときと同じ扱い。結果は書き換えない)。
    // 戻せなかった (実行中の印のまま) ときは、明日押しても実行できないので、本文に retryable: false を添える (#2195 V2)。
    // 理由は開き直したときの GET と同じ unconfirmed (#2201 U3。『もう一度 AI に頼んでください』は全画面の『明日また』の文と並んでいた)
    if (executionResult.aiDailyLimit) {
      const { error: revertError } = await writeBackAiActionLog(supabase, EXECUTE_ROUTE_NAME, writeBackCtx, { status });
      const limitResponse = aiDailyLimitResponse(executionResult.aiDailyLimit);
      if (!revertError) return limitResponse;
      return NextResponse.json(
        { ...(await limitResponse.json()), retryable: false, notExecutableReason: notExecutableReasonAfterRun(true) },
        { status: limitResponse.status, headers: limitResponse.headers },
      );
    }

    const unknownActionType = executionResult.unknownActionType === true;
    const success = unknownActionType ? false : executionResult.success;
    const result = unknownActionType ? { error: AI_CONSULTATION_ACTION_UNKNOWN_TYPE_MESSAGE } : executionResult.result;

    // アクションステータスを更新 (実行した日時は、実行が終わった executed / failed のときだけ。pending (やり直せる) は空のまま)。
    // 書き戻せなかったら 1 回だけ書き直す (#2195 V2。成功したのに実行中の印のまま残ると、開き直すたびにカードが出ていた)
    const { error: finalizeError } = await writeBackAiActionLog(supabase, EXECUTE_ROUTE_NAME, writeBackCtx, {
      status,
      result,
      executed_at: status === AI_ACTION_LOG_STATUS.pending ? null : new Date().toISOString(),
    });

    if (unknownActionType) {
      // 書き戻せなかった (実行中の印のまま) ときは、開き直したときの GET と同じ unconfirmed (#2201 U3)
      return notExecutableResponse(AI_CONSULTATION_ACTION_UNKNOWN_TYPE_MESSAGE, 400, notExecutableReasonAfterRun(!!finalizeError));
    }

    // 失敗したとき、提案のカードの「実行する」でもう一度実行できるか (行が pending に戻った)。
    // false なら画面は「実行する」を出さずに「もう一度頼んでください」の案内を出す (#2189 W1-a)
    // 書き換えに失敗したら行は実行中の印のまま (もう一度押しても実行しない) なので、やり直せるとは返さない。
    // そのときの理由は開き直したときの GET と同じ unconfirmed (#2201 U3)
    const retryable = !finalizeError && status === AI_ACTION_LOG_STATUS.pending;
    return NextResponse.json({
      success,
      result,
      actionType: action.action_type,
      ...(success
        ? {}
        : { retryable, ...(retryable ? {} : { notExecutableReason: notExecutableReasonAfterRun(!!finalizeError) }) }),
    });

  } catch (error: any) {
    return internalError(EXECUTE_ROUTE_NAME, error, { userId: user.id });
  }
}

// アクション拒否
export async function DELETE(request: Request, props: { params: Promise<{ actionId: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  try {
    // UUID の形でない id は DB に渡さず 404 (uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る)
    if (!isUuid(params.actionId)) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // actionIdはメッセージIDまたはアクションログIDの可能性がある（POSTと同じ探索順・同じ所有権検証）
    // idパスもmessage_idパスと同様にpending限定（両パスの対称性を確保し、処理済みactionの再却下を防止）
    let { data: action, error: actionError } = await supabase
      .from('ai_action_logs')
      .select(`
        *,
        ai_consultation_sessions!inner(user_id)
      `)
      .eq('id', params.actionId)
      .eq('status', AI_ACTION_LOG_STATUS.pending)
      .maybeSingle();

    // 読めなかったときは 404 にしない (行が無いときだけ、メッセージ ID として探し直す。#1917)
    if (actionError) {
      return internalError('DELETE /api/ai/consultation/actions/[actionId]/execute', actionError, { userId: user.id, table: 'ai_action_logs' });
    }

    // 見つからない場合はメッセージIDとして検索
    if (!action) {
      const { data: actionByMessage, error: msgError } = await supabase
        .from('ai_action_logs')
        .select(`
          *,
          ai_consultation_sessions!inner(user_id)
        `)
        .eq('message_id', params.actionId)
        .eq('status', AI_ACTION_LOG_STATUS.pending)
        .maybeSingle();

      if (msgError) {
        return internalError('DELETE /api/ai/consultation/actions/[actionId]/execute', msgError, { userId: user.id, table: 'ai_action_logs' });
      }
      if (!actionByMessage) {
        return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
      }
      action = actionByMessage;
    }

    if (!action) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    // セキュリティ: 却下対象アクションが自分のセッションに属することを確認
    // （不一致/不存在いずれも404とし、他ユーザーのactionId存在有無を推測させない）
    if (action.ai_consultation_sessions.user_id !== user.id) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const { error } = await supabase
      .from('ai_action_logs')
      .update({ status: AI_ACTION_LOG_STATUS.rejected })
      .eq('id', action.id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return internalError('DELETE /api/ai/consultation/actions/[actionId]/execute', error, { userId: user.id });
  }
}
