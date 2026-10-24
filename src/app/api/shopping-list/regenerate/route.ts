import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { addDaysToDate, isCalendarDate } from '@/lib/date-utils';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { CALENDAR_DATE_RANGE_PARAMS_LABEL, invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';

/** 400: 開始日・終了日が無い */
const DATE_RANGE_REQUIRED_MESSAGE = '開始日 (startDate) と終了日 (endDate) を指定してください';
/** 400: 開始日が終了日より後 */
const DATE_RANGE_ORDER_MESSAGE = '開始日 (startDate) は終了日 (endDate) 以前の日付にしてください';

const ROUTE_NAME = 'POST /api/shopping-list/regenerate';

/**
 * 買い物リストを作り直す期間の長さの上限 (終了日 − 開始日の日数)。#261 で入れた上限 (2 週間) のまま。
 * 期間の献立をまとめて AI (Edge Function regenerate-shopping-list-v2) へ送るので、長すぎる期間は受け付けない
 */
const MAX_RANGE_DAYS = 14;

/**
 * 買い物リスト再生成API（日付ベースモデル）
 * - リクエストレコードを作成して即座にrequestIdを返す
 * - Edge Functionで非同期処理
 * - クライアントはSupabase Realtimeで進捗を購読
 */
export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });

  // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
  const aiConsentDenied = await requireAiConsent(supabase, user.id);
  if (aiConsentDenied) return aiConsentDenied;

  // #1022 regenerate-shopping-list-v2 Edge Function が内部で OpenAI を呼ぶため generation カテゴリで制限する
  const rateLimitResult = await checkRateLimit(user.id, 'generation');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { startDate, endDate, servingsConfig } = requestBody;

    if (!startDate || !endDate) {
      return NextResponse.json({ error: DATE_RANGE_REQUIRED_MESSAGE }, { status: 400 });
    }

    // #261: 日付フォーマット・範囲 validation
    // YYYY-MM-DD の実在する日付 (受け付ける範囲の中) だけを通す。以前は new Date で確かめていたので、2026-02-30 が 3/2 に
    // 繰り上がって通り、リクエストの行 (start_date / end_date は date 型) を作るところで 500 になっていた (#1463)
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) {
      return NextResponse.json({ error: invalidCalendarDateMessage(CALENDAR_DATE_RANGE_PARAMS_LABEL) }, { status: 400 });
    }
    // 4 桁の年の YYYY-MM-DD どうしは、文字列の大小が日付の前後と同じ
    if (startDate > endDate) {
      return NextResponse.json({ error: DATE_RANGE_ORDER_MESSAGE }, { status: 400 });
    }
    // 開始日から MAX_RANGE_DAYS 日後より後の終了日は、期間が長すぎる (日数は暦の計算で数える)
    if (endDate > addDaysToDate(startDate, MAX_RANGE_DAYS)) {
      return NextResponse.json({ error: `期間は ${MAX_RANGE_DAYS} 日以内にしてください` }, { status: 400 });
    }

    // Edge Function を呼ぶための接続情報は、DB に書き込む前 (AI 利用回数の記録・リクエストの行の作成より前) に
    // env-required の getter で取り出す (#1434)。欠けていれば MissingEnvError → 下の catch で汎用の 500。
    // 書き込んだあとで気づくと、Edge Function を呼べないまま status 'processing' の行が残り続ける
    // (processing の行を片付ける仕組みは無い)。未ログイン・レート制限超過の呼び出しには設定の不足を教えない
    const { url: supabaseUrl, serviceRoleKey: supabaseServiceKey } = getSupabaseServiceConfig();

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回数える。
    // 上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)
    const aiUsage = await consumeAiUsage(user.id, 'shopping_list');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

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
      // 作り直しを始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
      await refundAiUsage(user.id, 'shopping_list', aiUsage);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    const requestId = requestData.id;

    // Edge Functionに処理を委譲（fire-and-forget。レスポンスを待たない）
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
