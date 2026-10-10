import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { generateGeminiJson } from '@/lib/ai/gemini-json';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { clampIntParam } from '@/lib/http-params';
import { fetchRecentMealDays, formatMealDaysForPrompt } from '@/lib/health-insight-meals';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import {
  buildHealthInsightRows,
  calculateHealthInsightPeriod,
  GENERATED_INSIGHT_TYPES,
  HEALTH_INSIGHT_PRIORITIES,
  MAX_INSIGHT_RECOMMENDATIONS,
  type GeneratedInsight,
} from '@/lib/health-insight-rows';

type UserLogger = ReturnType<ReturnType<typeof createLogger>['withUser']>;

/**
 * クエリの失敗を、どのクエリかと PostgreSQL のエラーコード付きでサーバーログ (app_logs) に残す。
 * 生のエラー文 (テーブル名・列名・制約名を含み得る) はクライアントに返さない (#1172 の方針)。
 * PostgREST のエラーは Error とは限らない { code, message, details, hint } なので、ログ用に Error へ包む。
 */
function logQueryError(
  logger: UserLogger,
  message: string,
  query: string,
  error: { message?: string; code?: string },
) {
  logger.error(
    message,
    error instanceof Error ? error : new Error(String(error.message ?? 'Unknown query error')),
    { query, pg_code: typeof error.code === 'string' ? error.code : undefined },
  );
}

// AI分析結果の取得
export async function GET(request: NextRequest) {
  const logger = createLogger('GET /api/health/insights', generateRequestId());
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userLogger = logger.withUser(user.id);

  const { searchParams } = new URL(request.url);
  // #1048 F2-16: limit が未クランプで DoS/意図しない大量取得が可能だった。
  const limit = clampIntParam(searchParams.get('limit'), { min: 1, max: 200, default: 20 });
  const unreadOnly = searchParams.get('unread') === 'true';
  const alertsOnly = searchParams.get('alerts') === 'true';

  let query = supabase
    .from('health_insights')
    .select('*')
    .eq('user_id', user.id)
    .eq('is_dismissed', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }
  if (alertsOnly) {
    query = query.eq('is_alert', true);
  }

  const { data, error } = await query;

  if (error) {
    logQueryError(userLogger, 'Health insights list query failed', 'health_insights', error);
    return NextResponse.json({ error: 'インサイトの取得に失敗しました' }, { status: 500 });
  }

  // 未読数・アラート数は一覧の補助情報。失敗しても一覧は返す (件数は 0 扱い) が、握りつぶさずに記録する。
  // 未読数もカウント
  const { count: unreadCount, error: unreadError } = await supabase
    .from('health_insights')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_read', false)
    .eq('is_dismissed', false);
  if (unreadError) {
    logQueryError(userLogger, 'Health insights unread count query failed', 'health_insights (unread count)', unreadError);
  }

  // アラート数もカウント
  const { count: alertCount, error: alertError } = await supabase
    .from('health_insights')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_alert', true)
    .eq('is_dismissed', false);
  if (alertError) {
    logQueryError(userLogger, 'Health insights alert count query failed', 'health_insights (alert count)', alertError);
  }

  return NextResponse.json({
    insights: data,
    unreadCount: unreadCount || 0,
    alertCount: alertCount || 0,
  });
}

// health_insights を LLM で生成・挿入する
export async function POST(request: NextRequest) {
  const logger = createLogger('POST /api/health/insights', generateRequestId());
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userLogger = logger.withUser(user.id);

  // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
  const aiConsentDenied = await requireAiConsent(supabase, user.id);
  if (aiConsentDenied) return aiConsentDenied;

  // #1022 LLM でインサイトを生成するため generation カテゴリで制限する
  const rateLimitResult = await checkRateLimit(user.id, 'generation');
  if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

  // 分析する期間 (JST の暦日)。health_records はこの期間で絞り、保存する行の analysis_date / period_start /
  // period_end / period_type にも同じ値を入れる (#1432。Edge Function generate-health-insights と同じ組み立て)。
  // 日付をまたいでも絞り込みと保存の日付が食い違わないよう、時刻は 1 回だけ取る。
  const now = new Date();
  const period = calculateHealthInsightPeriod(now);

  // ユーザーの最近の health_records, health_checkups, 食事 (user_daily_meals → planned_meals) を集約
  // 食事は planned_meals を直接引かない: planned_meals には user_id / planned_date 列が無い (#1040 F2-02 / #1306)
  const [recordsResult, checkupsResult, mealsResult] = await Promise.all([
    supabase
      .from('health_records')
      .select('record_date,weight,body_fat_percentage,systolic_bp,diastolic_bp,sleep_hours,step_count')
      .eq('user_id', user.id)
      .gte('record_date', period.periodStart)
      .lte('record_date', period.periodEnd)
      .order('record_date', { ascending: false })
      .limit(30),
    supabase
      .from('health_checkups')
      .select('checkup_date,weight,blood_pressure_systolic,blood_pressure_diastolic,hba1c,total_cholesterol,ldl_cholesterol,hdl_cholesterol,triglycerides,gamma_gtp,uric_acid,egfr')
      .eq('user_id', user.id)
      .order('checkup_date', { ascending: false })
      .limit(5),
    fetchRecentMealDays(supabase, user.id),
  ]);

  // 1 本でも失敗したまま続行すると、「データが無い」と区別できないまま欠けた文脈でインサイトを生成し、
  // しかも health_insights に保存してしまう (以前は食事が常に取れていなかったのに、誰も気付けなかった)。
  // 握りつぶさず、失敗した全クエリを記録して 500 を返す。
  const queryResults = [
    ['health_records', recordsResult.error],
    ['health_checkups', checkupsResult.error],
    ['user_daily_meals', mealsResult.error],
  ] as const;
  let hasQueryError = false;
  for (const [query, queryError] of queryResults) {
    if (!queryError) continue;
    hasQueryError = true;
    logQueryError(userLogger, `Health insights input query failed: ${query}`, query, queryError);
  }
  if (hasQueryError) {
    return NextResponse.json(
      { error: 'インサイトの生成に必要なデータを取得できませんでした。時間をおいて再試行してください。' },
      { status: 500 },
    );
  }

  const records = recordsResult.data ?? [];
  const checkups = checkupsResult.data ?? [];
  const mealDays = mealsResult.data ?? [];

  if (records.length === 0 && checkups.length === 0) {
    return NextResponse.json({ error: 'データが不足しています。健康記録を追加してから再試行してください。' }, { status: 400 });
  }

  const insightSchema = {
    type: 'object',
    required: ['insights'],
    properties: {
      insights: {
        type: 'array',
        items: {
          type: 'object',
          // health_insights の列 (summary / recommendations / priority) に合わせる (#1432)
          required: ['title', 'summary', 'insight_type', 'is_alert', 'priority'],
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            insight_type: { type: 'string', enum: [...GENERATED_INSIGHT_TYPES] },
            is_alert: { type: 'boolean' },
            priority: { type: 'string', enum: [...HEALTH_INSIGHT_PRIORITIES] },
            recommendations: { type: 'array', items: { type: 'string' }, maxItems: MAX_INSIGHT_RECOMMENDATIONS },
          },
        },
      },
    },
  };

  const prompt = `あなたは栄養士・健康アドバイザーです。以下のデータを分析し、ユーザーへの健康インサイトを3〜5件生成してください。

## 最近の健康記録（${period.periodStart}〜${period.periodEnd}、新→旧）
${records.slice(0, 10).map((r: any) => `- ${r.record_date}: 体重${r.weight ?? '-'}kg, 血圧${r.systolic_bp ?? '-'}/${r.diastolic_bp ?? '-'}, 睡眠${r.sleep_hours ?? '-'}h, 歩数${r.step_count ?? '-'}`).join('\n') || 'データなし'}

## 健康診断（最新）
${checkups.slice(0, 2).map((c: any) => `- ${c.checkup_date}: HbA1c${c.hba1c ?? '-'}%, LDL${c.ldl_cholesterol ?? '-'}, HDL${c.hdl_cholesterol ?? '-'}, 中性脂肪${c.triglycerides ?? '-'}, γ-GTP${c.gamma_gtp ?? '-'}, 尿酸${c.uric_acid ?? '-'}`).join('\n') || 'データなし'}

## 食事記録（直近の献立・1日ごとの合計）
${formatMealDaysForPrompt(mealDays) || 'データなし'}

インサイトは日本語で、具体的かつ行動に繋がるものにしてください。
各インサイトの summary は 2〜3 文の本文、recommendations は具体的な行動 (3 件まで) にしてください。
priority は low / medium / high / critical のいずれかで、医師への相談を勧めるほどの逸脱だけを critical にしてください。
is_alert は基準値逸脱や急激な変化がある場合のみ true にしてください。`;

  let generatedInsights: GeneratedInsight[] = [];
  try {
    const { data } = await generateGeminiJson<{ insights?: GeneratedInsight[] }>({
      prompt,
      schema: insightSchema,
      temperature: 0.3,
      maxOutputTokens: 2048,
      signal: AbortSignal.timeout(30_000),
    });
    generatedInsights = data.insights ?? [];
  } catch (err) {
    userLogger.error('Health insight generation failed', err, {
      records: records.length,
      checkups: checkups.length,
      meal_days: mealDays.length,
    });
    return NextResponse.json({ error: 'AIによるインサイト生成に失敗しました' }, { status: 500 });
  }

  // 現行の health_insights の列に合わせて組み立てる (#1432)。本文が空のものは保存しない
  const rows = buildHealthInsightRows(user.id, Array.isArray(generatedInsights) ? generatedInsights : [], now);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'インサイトを生成できませんでした' }, { status: 500 });
  }

  // health_insights には利用者向けの INSERT ポリシーが無い (SELECT / UPDATE だけ。supabase/baseline/prod_schema.sql)。
  // 利用者のセッションのクライアントで insert すると RLS で必ず拒否される。
  // そこで、本人確認 (getUser) と回数制限を通ったあとで、service_role のクライアントで保存する。
  // user_id は必ずセッションの user.id (buildHealthInsightRows が入れる) で、リクエストからは受け取らない。
  let inserted: unknown[] | null = null;
  try {
    const { data, error: insertError } = await getSupabaseAdmin()
      .from('health_insights')
      .insert(rows)
      .select();
    if (insertError) {
      logQueryError(userLogger, 'Health insights insert failed', 'health_insights', insertError);
      return NextResponse.json({ error: 'インサイトの保存に失敗しました' }, { status: 500 });
    }
    inserted = data;
  } catch (err) {
    // getSupabaseAdmin() の環境変数欠落など。生のエラー文は返さない (#1172)
    userLogger.error('Health insights insert threw', err, { query: 'health_insights' });
    return NextResponse.json({ error: 'インサイトの保存に失敗しました' }, { status: 500 });
  }

  return NextResponse.json({ insights: inserted, count: inserted?.length ?? 0 });
}
