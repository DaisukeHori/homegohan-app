import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// メッセージ一覧取得
export async function GET(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // セッション所有者確認
  const { data: session } = await supabase
    .from('ai_consultation_sessions')
    .select('user_id')
    .eq('id', params.sessionId)
    .single();

  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('ai_consultation_messages')
    .select('*')
    .eq('session_id', params.sessionId)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = (data || [])
    .filter((m: any) => !m.metadata?.isSystemPrompt)
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      proposedActions: m.proposed_actions,
      isImportant: m.is_important || false,
      importanceReason: m.importance_reason,
      createdAt: m.created_at,
    }));

  return NextResponse.json({ messages });
}

// ユーザーの詳細情報を取得してシステムプロンプトを構築
async function buildSystemPrompt(supabase: any, userId: string): Promise<string> {
  // 1. ユーザープロフィール取得
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();

  // 2. 最近の食事データ（過去14日分）
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  
  const { data: recentMeals } = await supabase
    .from('planned_meals')
    .select(`
      id,
      meal_type,
      dish_name,
      dishes,
      calories_kcal,
      protein_g,
      fat_g,
      carbs_g,
      is_completed,
      mode,
      meal_plan_days!inner(day_date)
    `)
    .gte('meal_plan_days.day_date', fourteenDaysAgo.toISOString().split('T')[0])
    .order('meal_plan_days(day_date)', { ascending: false })
    .limit(50);

  // 3. 健康記録（過去14日分）
  const { data: healthRecords } = await supabase
    .from('health_records')
    .select('*')
    .eq('user_id', userId)
    .gte('record_date', fourteenDaysAgo.toISOString().split('T')[0])
    .order('record_date', { ascending: false })
    .limit(14);

  // 4. 健康目標
  const { data: healthGoals } = await supabase
    .from('health_goals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active');

  // 5. 栄養目標
  const { data: nutritionTargets } = await supabase
    .from('nutrition_targets')
    .select('*')
    .eq('user_id', userId)
    .single();

  // 6. 獲得バッジ
  const { data: badges } = await supabase
    .from('user_badges')
    .select(`
      obtained_at,
      badges(name, description)
    `)
    .eq('user_id', userId)
    .order('obtained_at', { ascending: false })
    .limit(10);

  // 7. AIインサイト（最新のもの）
  const { data: insights } = await supabase
    .from('health_insights')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  // プロフィール情報を整形
  const profileInfo = profile ? `
【ユーザープロフィール】
- ニックネーム: ${profile.nickname || '未設定'}
- 年齢: ${profile.age || '未設定'}歳
- 性別: ${profile.gender === 'male' ? '男性' : profile.gender === 'female' ? '女性' : '未設定'}
- 身長: ${profile.height || '未設定'}cm
- 体重: ${profile.weight || '未設定'}kg
- 目標体重: ${profile.target_weight || '未設定'}kg
- 体脂肪率: ${profile.body_fat_percentage || '未設定'}%
- 目標体脂肪率: ${profile.target_body_fat || '未設定'}%

【健康状態】
- 持病・健康上の注意点: ${(profile.health_conditions || []).join(', ') || 'なし'}
- 服用中の薬: ${(profile.medications || []).join(', ') || 'なし'}
- フィットネス目標: ${(profile.fitness_goals || []).join(', ') || '未設定'}
- 睡眠の質: ${profile.sleep_quality || '未設定'}
- ストレスレベル: ${profile.stress_level || '未設定'}
- 便通: ${profile.bowel_movement || '未設定'}
- 冷え性: ${profile.cold_sensitivity ? 'あり' : 'なし'}
- むくみやすい: ${profile.swelling_prone ? 'あり' : 'なし'}

【仕事・ライフスタイル】
- 職業: ${profile.occupation || '未設定'}
- 業界: ${profile.industry || '未設定'}
- 勤務形態: ${profile.work_style || '未設定'}
- デスクワーク時間: ${profile.desk_hours_per_day || '未設定'}時間/日
- 残業頻度: ${profile.overtime_frequency || '未設定'}
- 出張頻度: ${profile.business_trip_frequency || '未設定'}
- 接待頻度: ${profile.entertainment_frequency || '未設定'}
- 週間運動時間: ${profile.weekly_exercise_minutes || 0}分

【食事スタイル】
- 食事スタイル: ${profile.diet_style || 'normal'}
- 宗教的制限: ${profile.religious_restrictions || 'なし'}
- アレルギー・苦手な食材: ${JSON.stringify(profile.diet_flags) || 'なし'}
- 好きな料理ジャンル: ${JSON.stringify(profile.cuisine_preferences) || '未設定'}
- 味の好み: ${JSON.stringify(profile.taste_preferences) || '未設定'}
- 好きな食材: ${(profile.favorite_ingredients || []).join(', ') || '未設定'}
- 好きな料理: ${(profile.favorite_dishes || []).join(', ') || '未設定'}

【料理スキル】
- 料理経験: ${profile.cooking_experience || 'beginner'}
- 得意な料理: ${(profile.specialty_cuisines || []).join(', ') || '未設定'}
- 苦手な調理法: ${(profile.disliked_cooking || []).join(', ') || 'なし'}
- 平日の調理時間: ${profile.weekday_cooking_minutes || 30}分
- 休日の調理時間: ${profile.weekend_cooking_minutes || 60}分
- 作り置きOK: ${profile.meal_prep_ok ? 'はい' : 'いいえ'}
- キッチン家電: ${(profile.kitchen_appliances || []).join(', ') || '未設定'}

【生活習慣】
- 起床時間: ${profile.wake_time || '未設定'}
- 就寝時間: ${profile.sleep_time || '未設定'}
- 食事時間: ${JSON.stringify(profile.meal_times) || '未設定'}
- 間食習慣: ${profile.snacking_habit || '未設定'}
- 飲酒頻度: ${profile.alcohol_frequency || '未設定'}
- 喫煙: ${profile.smoking ? 'あり' : 'なし'}
- カフェイン摂取: ${profile.caffeine_intake || '未設定'}
- 1日の水分摂取量: ${profile.daily_water_ml || '未設定'}ml

【家族構成】
- 家族人数: ${profile.family_size || 1}人
- 子供: ${profile.has_children ? `あり（${(profile.children_ages || []).join(', ')}歳）` : 'なし'}
- 高齢者: ${profile.has_elderly ? 'あり' : 'なし'}

【買い物】
- 週間食費予算: ${profile.weekly_food_budget || '未設定'}円
- 買い物頻度: ${profile.shopping_frequency || '未設定'}
- よく使う店: ${(profile.preferred_stores || []).join(', ') || '未設定'}
- ネットスーパー利用: ${profile.online_grocery ? 'あり' : 'なし'}
- オーガニック志向: ${profile.organic_preference || '未設定'}

【趣味・その他】
- 趣味: ${(profile.hobbies || []).join(', ') || '未設定'}
- 休日の過ごし方: ${profile.weekend_activity || '未設定'}
- アウトドア活動: ${(profile.outdoor_activities || []).join(', ') || '未設定'}
` : '【プロフィール未設定】';

  // 食事履歴を整形
  const mealHistory = recentMeals && recentMeals.length > 0 ? `
【最近の食事履歴（過去14日）】
${recentMeals.map((m: any) => {
  const date = m.meal_plan_days?.day_date || '不明';
  const mealTypeJa = m.meal_type === 'breakfast' ? '朝食' : m.meal_type === 'lunch' ? '昼食' : m.meal_type === 'dinner' ? '夕食' : m.meal_type === 'snack' ? 'おやつ' : '夜食';
  const status = m.is_completed ? '✓完了' : '未完了';
  const mode = m.mode === 'cook' ? '自炊' : m.mode === 'out' ? '外食' : m.mode === 'buy' ? '中食' : m.mode === 'skip' ? 'スキップ' : '';
  return `- ${date} ${mealTypeJa}: ${m.dish_name || '未設定'} (${m.calories_kcal || 0}kcal, P:${m.protein_g || 0}g) [${mode}] ${status}`;
}).join('\n')}
` : '【食事履歴なし】';

  // 健康記録を整形
  const healthHistory = healthRecords && healthRecords.length > 0 ? `
【最近の健康記録（過去14日）】
${healthRecords.map((r: any) => {
  const items = [];
  if (r.weight) items.push(`体重:${r.weight}kg`);
  if (r.body_fat_percentage) items.push(`体脂肪:${r.body_fat_percentage}%`);
  if (r.systolic_bp && r.diastolic_bp) items.push(`血圧:${r.systolic_bp}/${r.diastolic_bp}`);
  if (r.sleep_hours) items.push(`睡眠:${r.sleep_hours}h`);
  if (r.overall_condition) items.push(`体調:${r.overall_condition}/5`);
  if (r.mood_score) items.push(`気分:${r.mood_score}/5`);
  if (r.stress_level) items.push(`ストレス:${r.stress_level}/5`);
  if (r.step_count) items.push(`歩数:${r.step_count}`);
  return `- ${r.record_date}: ${items.join(', ') || '記録なし'}`;
}).join('\n')}
` : '【健康記録なし】';

  // 健康目標を整形
  const goalsInfo = healthGoals && healthGoals.length > 0 ? `
【現在の健康目標】
${healthGoals.map((g: any) => `- ${g.goal_type}: 目標${g.target_value}${g.target_unit} (現在${g.current_value || '未測定'}) 期限:${g.target_date || '未設定'}`).join('\n')}
` : '【健康目標未設定】';

  // 栄養目標を整形
  const nutritionInfo = nutritionTargets ? `
【1日の栄養目標】
- カロリー: ${nutritionTargets.daily_calories || '未設定'}kcal
- タンパク質: ${nutritionTargets.protein_g || '未設定'}g
- 脂質: ${nutritionTargets.fat_g || '未設定'}g
- 炭水化物: ${nutritionTargets.carbs_g || '未設定'}g
- 食物繊維: ${nutritionTargets.fiber_g || '未設定'}g
- ナトリウム: ${nutritionTargets.sodium_g || '未設定'}g
` : '【栄養目標未設定】';

  // バッジを整形
  const badgesInfo = badges && badges.length > 0 ? `
【獲得バッジ（最新10件）】
${badges.map((b: any) => `- ${b.badges?.name}: ${b.badges?.description}`).join('\n')}
` : '';

  // インサイトを整形
  const insightsInfo = insights && insights.length > 0 ? `
【最近のAI分析結果】
${insights.map((i: any) => `- ${i.title}: ${i.summary}`).join('\n')}
` : '';

  // 今日の日付
  const today = new Date().toLocaleDateString('ja-JP', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    weekday: 'long' 
  });

  return `あなたは「ほめゴハン」のAI栄養アドバイザーです。
今日は${today}です。

【あなたの役割】
1. ユーザーの食事や健康について相談に乗り、具体的なアドバイスを提供する
2. まず褒める：ユーザーの努力や良い点を見つけて褒める
3. 共感する：ユーザーの悩みや状況に寄り添う
4. 具体的に提案：実行可能な具体的なアドバイスを提供
5. 必要に応じてアクションを提案（献立作成、買い物リスト追加など）

【重要】以下のユーザー情報を参考にして、パーソナライズされたアドバイスを提供してください。

${profileInfo}

${mealHistory}

${healthHistory}

${goalsInfo}

${nutritionInfo}

${badgesInfo}

${insightsInfo}

【アクション提案について】
必要に応じて以下のアクションを提案できます。提案する場合は、以下の形式でJSONを含めてください：

\`\`\`action
{
  "type": "アクション種類",
  "params": { パラメータ }
}
\`\`\`

■ 献立関連:
- generate_day_menu: 1日の献立を作成 (params: { date: "YYYY-MM-DD" })
- generate_week_menu: 1週間の献立を作成 (params: { startDate: "YYYY-MM-DD" })
- create_meal: 新規食事を登録 (params: { date: "YYYY-MM-DD", mealType: "breakfast|lunch|dinner|snack|midnight_snack", dishName: "料理名", mode: "cook|out|buy", calories?: number, protein?: number, fat?: number, carbs?: number, memo?: string })
- update_meal: 献立を更新 (params: { mealId: "uuid", updates: { dish_name?, calories_kcal?, protein_g?, fat_g?, carbs_g?, memo?, mode? } })
- delete_meal: 献立を削除 (params: { mealId: "uuid" })
- complete_meal: 食事を完了マーク (params: { mealId: "uuid", isCompleted: true|false })

■ 買い物リスト関連:
- add_to_shopping_list: 買い物リストに追加 (params: { items: [{name, quantity, category}] })
- update_shopping_item: 買い物リスト更新 (params: { itemId: "uuid", updates: { item_name?, quantity?, category? } })
- delete_shopping_item: 買い物リストから削除 (params: { itemId: "uuid" })
- check_shopping_item: 買い物チェック (params: { itemId: "uuid", isChecked: true|false })

■ 冷蔵庫/パントリー関連:
- add_pantry_item: 冷蔵庫に食材追加 (params: { name: "食材名", quantity?: string, unit?: string, category?: string, expiryDate?: "YYYY-MM-DD" })
- update_pantry_item: 冷蔵庫の食材更新 (params: { itemId: "uuid", updates: { item_name?, quantity?, unit?, category?, expiry_date? } })
- delete_pantry_item: 冷蔵庫から食材削除 (params: { itemId: "uuid" })

■ レシピ関連:
- suggest_recipe: レシピを検索・提案 (params: { keywords?: "検索キーワード", cuisineType?: "和食|洋食|中華|etc" })
- like_recipe: レシピにいいね (params: { recipeId: "uuid" })
- add_recipe_to_collection: レシピをコレクションに追加 (params: { recipeId: "uuid", collectionName?: "コレクション名" })

■ 栄養目標関連:
- update_nutrition_target: 栄養目標を更新 (params: { targets: { daily_calories?, protein_g?, fat_g?, carbs_g?, fiber_g?, sodium_g? } })

■ 健康目標関連:
- set_health_goal: 健康目標を設定 (params: { goalType: "weight|body_fat|exercise|etc", targetValue: number, targetUnit?: string, targetDate?: "YYYY-MM-DD", description?: string })
- update_health_goal: 健康目標を更新 (params: { goalId: "uuid", updates: { target_value?, target_date?, status?, current_value? } })
- delete_health_goal: 健康目標を削除 (params: { goalId: "uuid" })

■ 健康記録関連:
- add_health_record: 健康記録を追加 (params: { date?: "YYYY-MM-DD", weight?: number, bodyFatPercentage?: number, systolicBp?: number, diastolicBp?: number, sleepHours?: number, overallCondition?: 1-5, moodScore?: 1-5, stressLevel?: 1-5, stepCount?: number, notes?: string })
- update_health_record: 健康記録を更新 (params: { date: "YYYY-MM-DD", updates: {...} })

■ プロフィール関連（食事の好み・生活習慣のみ）:
- update_profile_preferences: 食事の好みや生活習慣を更新 (params: { updates: { diet_style?, cuisine_preferences?, taste_preferences?, favorite_ingredients?, favorite_dishes?, cooking_experience?, weekday_cooking_minutes?, weekend_cooking_minutes?, snacking_habit?, alcohol_frequency?, daily_water_ml?, etc } })
  ※ email, avatar_url等のセキュリティ関連フィールドは更新不可

【応答のガイドライン】
- 親しみやすく、温かい口調で話す
- 絵文字を適度に使用する
- 専門用語は避け、わかりやすく説明する
- ユーザーの状況（仕事、家族構成、健康状態など）を考慮する
- 無理のない、実現可能な提案をする
- 長すぎない、読みやすい回答を心がける`;
}

// メッセージ送信（AI応答を含む）
export async function POST(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // セッション所有者確認
    const { data: session } = await supabase
      .from('ai_consultation_sessions')
      .select('*')
      .eq('id', params.sessionId)
      .single();

    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json();
    const userMessage = body.message?.trim();

    if (!userMessage) {
      return NextResponse.json({ error: 'メッセージを入力してください' }, { status: 400 });
    }

    // ユーザーメッセージを保存
    const { data: savedUserMessage, error: userMsgError } = await supabase
      .from('ai_consultation_messages')
      .insert({
        session_id: params.sessionId,
        role: 'user',
        content: userMessage,
      })
      .select()
      .single();

    if (userMsgError) throw userMsgError;

    // システムプロンプトを構築（ユーザー情報を含む）
    const systemPrompt = await buildSystemPrompt(supabase, user.id);

    // 過去のメッセージを取得（システムプロンプト以外）- 50件まで
    const { data: historyData } = await supabase
      .from('ai_consultation_messages')
      .select('role, content, metadata, is_important')
      .eq('session_id', params.sessionId)
      .order('created_at', { ascending: true })
      .limit(50);

    // メッセージを構築
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(historyData || [])
        .filter((m: any) => !m.metadata?.isSystemPrompt)
        .map((m: any) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
    ];

    // OpenAI APIで応答生成
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_tokens: 2000,
    });

    const aiContent = completion.choices[0]?.message?.content || 'すみません、応答を生成できませんでした。';

    // アクション提案を抽出
    const actionMatch = aiContent.match(/```action\s*([\s\S]*?)```/);
    let proposedActions = null;
    if (actionMatch) {
      try {
        proposedActions = JSON.parse(actionMatch[1]);
      } catch (e) {
        console.error('Failed to parse action:', e);
      }
    }

    // ユーザーメッセージの重要度をAIに判断させる
    const importanceCheck = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `あなたはユーザーのメッセージが「重要な情報」を含むかどうかを判断するアシスタントです。

以下の情報は「重要」と判断してください：
1. 具体的な数値データ（体重、カロリー、血圧、目標値など）
2. 健康状態の変化（体調の変化、症状、改善など）
3. 食事の好み・アレルギー・制限の新情報
4. 目標の設定・変更
5. 重要な決定事項（ダイエット開始、食事制限など）
6. 特定の日付に関連する情報
7. 生活習慣の変化

以下は「重要でない」と判断してください：
- 一般的な挨拶や雑談
- 単なる質問（具体的な情報を含まない）
- 感謝の言葉
- 曖昧な表現

JSONで回答してください：
{
  "isImportant": true/false,
  "reason": "重要と判断した理由（重要な場合のみ）",
  "category": "体重|カロリー|目標|健康状態|好み|決定事項|その他"
}`
        },
        {
          role: 'user',
          content: userMessage
        }
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });

    let userMessageImportance = { isImportant: false, reason: null as string | null, category: null as string | null };
    try {
      const importanceResult = JSON.parse(importanceCheck.choices[0]?.message?.content || '{}');
      userMessageImportance = {
        isImportant: importanceResult.isImportant || false,
        reason: importanceResult.reason || null,
        category: importanceResult.category || null,
      };
    } catch (e) {
      console.error('Failed to parse importance check:', e);
    }

    // ユーザーメッセージが重要な場合、更新
    if (userMessageImportance.isImportant) {
      await supabase
        .from('ai_consultation_messages')
        .update({
          is_important: true,
          importance_reason: userMessageImportance.reason,
          metadata: { 
            ...savedUserMessage.metadata,
            autoMarked: true,
            category: userMessageImportance.category,
          },
        })
        .eq('id', savedUserMessage.id);
    }

    // AI応答を保存
    const { data: savedAiMessage, error: aiMsgError } = await supabase
      .from('ai_consultation_messages')
      .insert({
        session_id: params.sessionId,
        role: 'assistant',
        content: aiContent.replace(/```action[\s\S]*?```/g, '').trim(),
        proposed_actions: proposedActions,
        tokens_used: completion.usage?.total_tokens,
      })
      .select()
      .single();

    if (aiMsgError) throw aiMsgError;

    // アクションがある場合はai_action_logsに記録
    if (proposedActions) {
      await supabase
        .from('ai_action_logs')
        .insert({
          session_id: params.sessionId,
          message_id: savedAiMessage.id,
          action_type: proposedActions.type,
          action_params: proposedActions.params || {},
          status: 'pending',
        });
    }

    // セッションのupdated_atを更新
    await supabase
      .from('ai_consultation_sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', params.sessionId);

    return NextResponse.json({
      success: true,
      userMessage: {
        id: savedUserMessage.id,
        role: 'user',
        content: userMessage,
        isImportant: userMessageImportance.isImportant,
        importanceReason: userMessageImportance.reason,
        createdAt: savedUserMessage.created_at,
      },
      aiMessage: {
        id: savedAiMessage.id,
        role: 'assistant',
        content: savedAiMessage.content,
        proposedActions,
        createdAt: savedAiMessage.created_at,
      },
    });

  } catch (error: any) {
    console.error('Message error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
