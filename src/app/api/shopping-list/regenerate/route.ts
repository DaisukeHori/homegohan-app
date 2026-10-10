import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { recordAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';

const ROUTE_NAME = 'POST /api/shopping-list/regenerate';

/**
 * 買い物リスト再生成API（日付ベースモデル）
 * - リクエストレコードを作成して即座にrequestIdを返す
 * - Edge Functionで非同期処理
 * - クライアントはSupabase Realtimeで進捗を購読
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
  const aiConsentDenied = await requireAiConsent(supabase, user.id);
  if (aiConsentDenied) return aiConsentDenied;

  // #1022 regenerate-shopping-list-v2 Edge Function が内部で OpenAI を呼ぶため generation カテゴリで制限する
  const rateLimitResult = await checkRateLimit(user.id, 'generation');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  try {
    const { startDate, endDate, servingsConfig } = await request.json();

    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 });
    }

    // #261: 日付フォーマット・範囲 validation
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return NextResponse.json({ error: 'startDate and endDate must be in YYYY-MM-DD format' }, { status: 400 });
    }
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
      return NextResponse.json({ error: 'Invalid date value' }, { status: 400 });
    }
    if (s > e) {
      return NextResponse.json({ error: 'startDate must be before or equal to endDate' }, { status: 400 });
    }
    const diffDays = (e.getTime() - s.getTime()) / 86400000;
    if (diffDays > 14) {
      return NextResponse.json({ error: 'Date range must be 14 days or less' }, { status: 400 });
    }

    // #1177 AI 利用回数の記録。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回記録する
    // (記録に失敗しても止めない)
    await recordAiUsage(user.id, 'shopping_list');

    // リクエストレコードを作成（日付ベースモデル対応）
    const { data: requestData, error: insertError } = await supabase
      .from('shopping_list_requests')
      .insert({
        user_id: user.id,
        status: 'processing',
        start_date: startDate,
        end_date: endDate,
        progress: {
          phase: 'starting',
          message: '開始中...',
          percentage: 0,
        },
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    const requestId = requestData.id;

    // Edge Functionを非同期で呼び出し（fire-and-forget）
    // 接続情報は env-required の getter で取り出す (#1434)。欠けていれば MissingEnvError → 下の catch で汎用の 500
    const { url: supabaseUrl, serviceRoleKey: supabaseServiceKey } = getSupabaseServiceConfig();

    // Edge Functionに処理を委譲（レスポンスを待たない）
    fetch(`${supabaseUrl}/functions/v1/regenerate-shopping-list-v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        requestId,
        userId: user.id,
        startDate,
        endDate,
        // 人数設定（渡されない場合はEdge Functionでプロフィールから取得）
        servingsConfig: servingsConfig || null,
      }),
    }).catch((err) => {
      console.error('Edge Function call failed:', err);
    });

    // 即座にrequestIdを返す
    return NextResponse.json({ 
      requestId,
      message: '再生成を開始しました',
    });
  } catch (error) {
    // 本文は汎用メッセージだけにし、元のエラーは構造化ログに残す (#1172)
    return internalError(ROUTE_NAME, error, { userId: user.id });
  }
}
