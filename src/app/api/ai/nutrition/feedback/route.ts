import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getNutrientDefinition, calculateDriPercentage } from '@homegohan/shared';
import crypto from 'crypto';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_NUTRITION_FEEDBACK_INPUT_REQUIRED_MESSAGE, AI_NUTRITION_FEEDBACK_QUERY_REQUIRED_MESSAGE, aiInvalidDateMessage } from '@/lib/ai/ai-api-messages';
import { isUuid } from '@/lib/http-params';
import { isCalendarDate } from '@/lib/date-utils';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 栄養データと週間データからハッシュを生成（変更検知用）
function generateHash(nutrition: any, weekData: any): string {
  const nutritionStr = JSON.stringify({
    cal: Math.round(nutrition.caloriesKcal || 0),
    prot: Math.round(nutrition.proteinG || 0),
    fat: Math.round(nutrition.fatG || 0),
    carb: Math.round(nutrition.carbsG || 0),
  });
  
  const weekStr = (weekData || [])
    .map((d: any) => `${d.date}:${d.meals?.map((m: any) => m.title).join(',') || ''}`)
    .join('|');
  
  return crypto.createHash('md5').update(nutritionStr + weekStr).digest('hex');
}

// LLMで褒めコメント＋アドバイスを生成する関数
interface NutritionFeedbackResult {
  praiseComment: string;  // 褒めコメント（絵文字あり、ポジティブ）
  advice: string;         // 改善アドバイス
  nutritionTip: string;   // 栄養豆知識
}

async function generateFeedbackWithLLM(
  date: string,
  nutrition: any,
  mealCount: number,
  weekData: any[]
): Promise<NutritionFeedbackResult> {
  const mainNutrients = [
    'caloriesKcal', 'proteinG', 'fatG', 'carbsG', 'fiberG',
    'sodiumG', 'vitaminCMg', 'calciumMg', 'ironMg', 'vitaminAUg',
    'vitaminB1Mg', 'vitaminB2Mg', 'vitaminDUg', 'zincMg', 'magnesiumMg'
  ];

  const nutrientAnalysis = mainNutrients.map(key => {
    const def = getNutrientDefinition(key);
    const value = nutrition[key] ?? 0;
    const percentage = calculateDriPercentage(key, value);
    return {
      name: def?.label ?? key,
      value: value.toFixed(def?.decimals ?? 1),
      unit: def?.unit ?? '',
      percentage,
      status: percentage >= 80 && percentage <= 120 ? '適正' : percentage < 50 ? '不足' : percentage > 150 ? '過剰' : '目標に近い',
    };
  });

  const deficient = nutrientAnalysis.filter(n => n.percentage < 50);
  const excess = nutrientAnalysis.filter(n => n.percentage > 150);
  const good = nutrientAnalysis.filter(n => n.percentage >= 80 && n.percentage <= 120);

  const weekSummary = weekData?.map((d: any) => {
    const dayMeals = d.meals?.map((m: any) => `${m.title}(${m.calories || '?'}kcal)`).join(', ') || '献立なし';
    return `${d.date}: ${dayMeals}`;
  }).join('\n') || '';

  // 今日の献立を抽出
  const todayMeals = weekData?.find((d: any) => d.date === date)?.meals || [];
  const todayDishes = todayMeals.flatMap((m: any) => m.dishes || [m.title]).filter(Boolean).join('、');

  const prompt = `あなたは「ほめゴハン」のAI栄養士です。ユーザーの1日の栄養データを分析し、以下の3つを生成してください。

## 対象日: ${date}
## 食事数: ${mealCount}食
## 今日の献立: ${todayDishes || '献立情報なし'}

## 主要栄養素の摂取状況:
${nutrientAnalysis.map(n => `- ${n.name}: ${n.value}${n.unit} (推奨量の${n.percentage}% - ${n.status})`).join('\n')}

## 栄養バランスサマリー:
- 適正範囲(80-120%): ${good.length}項目 (${good.map(n => n.name).join('、') || 'なし'})
- 不足傾向(<50%): ${deficient.length}項目 (${deficient.map(n => n.name).join('、') || 'なし'})
- 過剰傾向(>150%): ${excess.length}項目 (${excess.map(n => n.name).join('、') || 'なし'})

## 今週の献立:
${weekSummary}

## 出力形式（必ず以下のJSON形式で出力）:
\`\`\`json
{
  "praiseComment": "褒めコメント（80-120文字）。良い点を見つけて褒める。絵文字1-2個使用。批判は含めない。",
  "advice": "改善アドバイス（200-300文字）。不足栄養素を補う具体的な食材・料理名を挙げ、どの食事（朝食/昼食/夕食）で取り入れるべきかを提案。例：「カルシウム不足を補うため、朝食にヨーグルト、夕食に小松菜の炒め物を追加しましょう」のように実践的に。",
  "nutritionTip": "栄養豆知識（40-60文字）。今日の献立や不足栄養素に関連したミニ知識。"
}
\`\`\`

## 重要なルール:
- praiseCommentは**必ず褒める**。どんな献立でも良い点を見つける
- adviceは**具体的な食材名・料理名・タイミング**を含める（献立改善AIへの指示として使用される）
- JSONのみを出力（説明文は不要）`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      messages: [
        {
          role: 'system',
          content: 'あなたは「ほめゴハン」のAI栄養士です。ユーザーの食事を褒めて、やる気を引き出すことが大切です。必ずJSON形式で出力してください。',
        },
        { role: 'user', content: prompt },
      ],
      max_completion_tokens: 800,
      reasoning_effort: 'none',
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('OpenAI API error:', errorData);
    throw new Error('AI分析に失敗しました');
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  // JSONをパース
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        praiseComment: parsed.praiseComment || 'バランスの良い食事を心がけていますね✨',
        advice: parsed.advice || '',
        nutritionTip: parsed.nutritionTip || '',
      };
    } catch (e) {
      console.warn('Failed to parse feedback JSON:', e);
    }
  }

  // フォールバック
  return {
    praiseComment: 'お食事の記録ありがとうございます！毎日の食事管理、素晴らしいですね✨',
    advice: content || '',
    nutritionTip: '',
  };
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    const rateLimitResult = await checkRateLimit(user.id, 'analysis');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { date, nutrition, mealCount, weekData, forceRefresh } = body;

    if (!nutrition || !date) {
      return NextResponse.json({ error: AI_NUTRITION_FEEDBACK_INPUT_REQUIRED_MESSAGE }, { status: 400 });
    }
    // 実在しない日付は DB に渡さず 400 (date 型の列に渡すと失敗する。下のキャッシュの読み込みの失敗を 500 にしたので、ここで先に断る。#1917 の続き)
    if (!isCalendarDate(date)) {
      return NextResponse.json({ error: aiInvalidDateMessage('日付') }, { status: 400 });
    }

    const nutritionHash = generateHash(nutrition, weekData);

    // キャッシュを確認（forceRefreshでない場合）
    if (!forceRefresh) {
      // 行が無いときだけ「キャッシュなし」にする。読めなかった (DB の失敗) ときは 500 (#1917 の続き。以前は .single() の失敗を捨て、
      // 失敗でもキャッシュなしとして AI の回数を数えて生成へ進んでいた)。(user_id, target_date) は一意なので 2 行にはならない
      const { data: cached, error: cachedError } = await supabase
        .from('nutrition_feedback_cache')
        .select('id, feedback, nutrition_hash, status')
        .eq('user_id', user.id)
        .eq('target_date', date)
        .maybeSingle();

      if (cachedError) {
        return internalError('POST /api/ai/nutrition/feedback', cachedError, { userId: user.id, table: 'nutrition_feedback_cache' });
      }

      // キャッシュがあり、ハッシュが一致し、完了状態ならキャッシュを返す
      if (cached && cached.nutrition_hash === nutritionHash && cached.status === 'completed') {
        // JSONとしてパースを試みる（新形式）、失敗したら旧形式として扱う
        let feedbackData;
        try {
          feedbackData = JSON.parse(cached.feedback);
        } catch {
          // 旧形式の文字列フィードバック
          feedbackData = {
            praiseComment: '',
            advice: cached.feedback,
            nutritionTip: '',
          };
        }
        return NextResponse.json({
          ...feedbackData,
          feedback: feedbackData.advice || cached.feedback, // 後方互換性
          cached: true,
          status: 'completed'
        });
      }

      // 生成中の場合はステータスのみ返す
      if (cached && cached.status === 'generating') {
        return NextResponse.json({ 
          feedback: null, 
          cached: false,
          status: 'generating',
          cacheId: cached.id
        });
      }
    }

    // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)。
    // 作成済みのコメント (キャッシュ) を返すだけなら AI へは送らないので、上で返している
    const aiConsentDenied = await requireAiConsent(supabase, user.id);
    if (aiConsentDenied) return aiConsentDenied;

    // 新規生成または再生成が必要 (ここから先は AI を呼ぶ)
    // キャッシュを返す・生成中のステータスを返すだけの経路と、同意が無く止めた経路では AI を呼ばないので、ここまでは数えない
    // #1149 AI の利用回数の上限の判定と記録 (#1177。判定に失敗したときは止めない):
    //   - 栄養の詳細を開いたときの自動の取得 (forceRefresh なし) は、利用者が押した操作ではないので 1 日の上限の回数に数えない
    //     ('nutrition_advice_auto'。開くだけで今日の回数が減らないように)。ただし forceRefresh も nutrition もクライアントが送る値で、
    //     API を直接呼べばキャッシュに当てずに何度でも AI を呼べるので、自動の分だけの安全弁 (DB の ai_unmetered_daily_caps。
    //     既定は 1 日 30 回) がある。達していれば 429 AI_DAILY_LIMIT (画面は固定の文を出す)
    //   - 「再分析」を押した取得 (forceRefresh) は上限に数え、達していれば数えずに 429 AI_DAILY_LIMIT
    const aiUsage = forceRefresh
      ? await consumeAiUsage(user.id, 'nutrition_advice')
      : await consumeAiUsage(user.id, 'nutrition_advice_auto');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    // まずpendingステータスでレコードを作成/更新
    const { data: cacheRecord, error: upsertError } = await supabase
      .from('nutrition_feedback_cache')
      .upsert({
        user_id: user.id,
        target_date: date,
        feedback: '',
        nutrition_hash: nutritionHash,
        week_hash: nutritionHash,
        status: 'generating',
      }, {
        onConflict: 'user_id,target_date'
      })
      .select('id')
      .single();

    if (upsertError) {
      console.error('Failed to create cache record:', upsertError);
      // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
      await refundAiUsage(user.id, forceRefresh ? 'nutrition_advice' : 'nutrition_advice_auto', aiUsage);
      return NextResponse.json({ error: 'キャッシュの作成に失敗しました' }, { status: 500 });
    }

    const cacheId = cacheRecord.id;

    // バックグラウンドでLLM処理を実行（レスポンスは先に返す）
    // Next.jsのwaitUntilを使用
    const backgroundTask = (async () => {
      try {
        const feedbackResult = await generateFeedbackWithLLM(date, nutrition, mealCount, weekData);

        // 完了したらDBを更新（Realtimeで自動通知される）
        // 新形式: JSONとして保存
        await supabase
          .from('nutrition_feedback_cache')
          .update({
            feedback: JSON.stringify(feedbackResult),
            status: 'completed',
          })
          .eq('id', cacheId);

        console.log(`Nutrition feedback generated for ${date}`);
      } catch (error) {
        console.error('Background LLM task failed:', error);

        // エラー時もDBを更新
        const errorFeedback = {
          praiseComment: '',
          advice: '分析中にエラーが発生しました。再分析をお試しください。',
          nutritionTip: '',
        };
        await supabase
          .from('nutrition_feedback_cache')
          .update({
            feedback: JSON.stringify(errorFeedback),
            status: 'error',
          })
          .eq('id', cacheId);
      }
    })();

    // waitUntilが利用可能な場合はバックグラウンドで実行
    // @ts-ignore - Next.js edge runtime specific
    if (typeof globalThis.waitUntil === 'function') {
      // @ts-ignore
      globalThis.waitUntil(backgroundTask);
    } else {
      // waitUntilが使えない場合は同期的に実行
      await backgroundTask;
    }

    // 即座にレスポンスを返す（フロントエンドはRealtimeで更新を受け取る）
    return NextResponse.json({ 
      feedback: null, 
      cached: false,
      status: 'generating',
      cacheId
    });
  } catch (error: any) {
    return internalError('POST /api/ai/nutrition/feedback', error);
  }
}

// キャッシュのステータスを確認するGETエンドポイント
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');
    const cacheId = searchParams.get('cacheId');

    if (!date && !cacheId) {
      return NextResponse.json({ error: AI_NUTRITION_FEEDBACK_QUERY_REQUIRED_MESSAGE }, { status: 400 });
    }

    // 形の違う値 (UUID でない cacheId・実在しない日付) は DB に渡さず、行が無いときと同じ not_found
    // (uuid・date 型の列に渡すと失敗し、下の「DB の失敗は 500」に入るため。#1917 の続き)。cacheId があれば cacheId で引く
    if (cacheId ? !isUuid(cacheId) : !isCalendarDate(date)) {
      return NextResponse.json({ status: 'not_found' });
    }

    let query = supabase
      .from('nutrition_feedback_cache')
      .select('id, feedback, status, nutrition_hash')
      .eq('user_id', user.id);

    if (cacheId) {
      query = query.eq('id', cacheId);
    } else if (date) {
      query = query.eq('target_date', date);
    }

    // 行が無いときだけ not_found。読めなかった (DB の失敗) ときは 500 (#1917 の続き。以前は失敗も 200 の not_found にしていて、
    // 「まだ無い」と見分けられなかった)。id は主キー・(user_id, target_date) は一意なので 2 行にはならない
    const { data, error } = await query.maybeSingle();

    if (error) {
      return internalError('GET /api/ai/nutrition/feedback', error, { userId: user.id, table: 'nutrition_feedback_cache' });
    }
    if (!data) {
      return NextResponse.json({ status: 'not_found' });
    }

    if (data.status === 'completed' && data.feedback) {
      // JSONとしてパースを試みる（新形式）
      let feedbackData;
      try {
        feedbackData = JSON.parse(data.feedback);
      } catch {
        // 旧形式の文字列フィードバック
        feedbackData = {
          praiseComment: '',
          advice: data.feedback,
          nutritionTip: '',
        };
      }
      return NextResponse.json({
        ...feedbackData,
        feedback: feedbackData.advice || data.feedback, // 後方互換性
        status: data.status,
        cacheId: data.id
      });
    }

    return NextResponse.json({
      feedback: null,
      praiseComment: null,
      advice: null,
      nutritionTip: null,
      status: data.status,
      cacheId: data.id
    });
  } catch (error: any) {
    return internalError('GET /api/ai/nutrition/feedback', error);
  }
}
