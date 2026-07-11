import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { runConsultationAction } from '@/lib/ai/consultation-action-executor';

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
export async function POST(
  request: Request,
  { params }: { params: { actionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimitResult = await checkRateLimit(user.id, 'generation');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  try {
    // actionIdはメッセージIDまたはアクションログIDの可能性がある
    let { data: action, error: actionError } = await supabase
      .from('ai_action_logs')
      .select(`
        *,
        ai_consultation_sessions!inner(user_id)
      `)
      .eq('id', params.actionId)
      .single();

    // 見つからない場合はメッセージIDとして検索
    if (actionError || !action) {
      const { data: actionByMessage, error: msgError } = await supabase
        .from('ai_action_logs')
        .select(`
          *,
          ai_consultation_sessions!inner(user_id)
        `)
        .eq('message_id', params.actionId)
        .eq('status', 'pending')
        .single();
      
      if (msgError || !actionByMessage) {
        return NextResponse.json({ error: 'Action not found' }, { status: 404 });
      }
      action = actionByMessage;
    }

    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 });
    }

    if (action.ai_consultation_sessions.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (action.status !== 'pending') {
      return NextResponse.json({ error: 'Action already processed' }, { status: 400 });
    }

    // #1047 F2-21: アクション実行の中核ロジックは src/lib/ai/consultation-action-executor.ts
    // に抽出済み（messages/route.ts からも self-fetch ではなく直接呼び出す）。
    const executionResult = await runConsultationAction(supabase, user, action);

    if (executionResult.unknownActionType) {
      return NextResponse.json({ error: 'Unknown action type' }, { status: 400 });
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
    console.error('Action execution error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// アクション拒否
export async function DELETE(
  request: Request,
  { params }: { params: { actionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
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
      .single();

    // 見つからない場合はメッセージIDとして検索
    if (actionError || !action) {
      const { data: actionByMessage, error: msgError } = await supabase
        .from('ai_action_logs')
        .select(`
          *,
          ai_consultation_sessions!inner(user_id)
        `)
        .eq('message_id', params.actionId)
        .eq('status', 'pending')
        .single();

      if (msgError || !actionByMessage) {
        return NextResponse.json({ error: 'Action not found' }, { status: 404 });
      }
      action = actionByMessage;
    }

    if (!action) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 });
    }

    // セキュリティ: 却下対象アクションが自分のセッションに属することを確認
    // （不一致/不存在いずれも404とし、他ユーザーのactionId存在有無を推測させない）
    if (action.ai_consultation_sessions.user_id !== user.id) {
      return NextResponse.json({ error: 'Action not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('ai_action_logs')
      .update({ status: 'rejected' })
      .eq('id', action.id);

    if (error) throw error;

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('Action rejection error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
