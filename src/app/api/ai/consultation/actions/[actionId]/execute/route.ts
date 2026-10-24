import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiChatDisabledResponse } from '@/lib/ai/ai-chat-gate';
import { AI_SENDING_ACTION_TYPES, runConsultationAction } from '@/lib/ai/consultation-action-executor';
import { aiDailyLimitResponse } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';
import { API_UNAUTHENTICATED_MESSAGE, API_FORBIDDEN_MESSAGE } from '@/lib/api/error-responses';
import { AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, AI_CONSULTATION_ACTION_UNKNOWN_TYPE_MESSAGE } from '@/lib/ai/ai-api-messages';

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
      return internalError('POST /api/ai/consultation/actions/[actionId]/execute', actionError, { userId: user.id, table: 'ai_action_logs' });
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
        .eq('status', 'pending')
        .maybeSingle();
      
      if (msgError) {
        return internalError('POST /api/ai/consultation/actions/[actionId]/execute', msgError, { userId: user.id, table: 'ai_action_logs' });
      }
      if (!actionByMessage) {
        return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
      }
      action = actionByMessage;
    }

    if (!action) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    if (action.ai_consultation_sessions.user_id !== user.id) {
      return NextResponse.json({ error: API_FORBIDDEN_MESSAGE }, { status: 403 });
    }

    if (action.status !== 'pending') {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE }, { status: 400 });
    }

    // 献立の生成のアクションは、利用者のデータを外国の AI 事業者へ送る。同意が無ければ送らずに止める
    // (T15 / #1154。403 AI_CONSENT_REQUIRED)。アクションは pending のまま残すので、同意したあとにもう一度実行できる
    if (AI_SENDING_ACTION_TYPES.has(action.action_type)) {
      const aiConsentDenied = await requireAiConsent(supabase, user.id);
      if (aiConsentDenied) return aiConsentDenied;
    }

    // #1047 F2-21: アクション実行の中核ロジックは src/lib/ai/consultation-action-executor.ts
    // に抽出済み（messages/route.ts からも self-fetch ではなく直接呼び出す）。
    const executionResult = await runConsultationAction(supabase, user, action);

    if (executionResult.unknownActionType) {
      return NextResponse.json({ error: AI_CONSULTATION_ACTION_UNKNOWN_TYPE_MESSAGE }, { status: 400 });
    }

    // 今日の AI の利用回数の上限 (#1149) に達して、献立の生成をしなかった。アクションは pending のまま残す
    // (明日もう一度実行できる。同意が無くて止めたときと同じ扱い)
    if (executionResult.aiDailyLimit) {
      return aiDailyLimitResponse(executionResult.aiDailyLimit);
    }

    const { success, result } = executionResult;

    // アクションステータスを更新
    await supabase
      .from('ai_action_logs')
      .update({
        status: success ? 'executed' : 'failed',
        result,
        executed_at: new Date().toISOString(),
      })
      .eq('id', action.id);

    return NextResponse.json({
      success,
      result,
      actionType: action.action_type,
    });

  } catch (error: any) {
    return internalError('POST /api/ai/consultation/actions/[actionId]/execute', error, { userId: user.id });
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
      .eq('status', 'pending')
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
        .eq('status', 'pending')
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
      .update({ status: 'rejected' })
      .eq('id', action.id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return internalError('DELETE /api/ai/consultation/actions/[actionId]/execute', error, { userId: user.id });
  }
}
