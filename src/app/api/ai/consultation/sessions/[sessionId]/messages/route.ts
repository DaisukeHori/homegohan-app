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

  // 2. ユーザーの献立プランを取得（アクティブ優先、なければ最新）
  const today = new Date().toISOString().split('T')[0];
  let { data: userActivePlan } = await supabase
    .from('meal_plans')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single();

  // アクティブなプランがない場合は最新のプランを使用
  if (!userActivePlan) {
    const { data: latestPlan } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    userActivePlan = latestPlan;
  }

  // 3. 今日の献立を取得（アクション実行用にIDを含める）
  let todayMeals: any[] = [];
  if (userActivePlan) {
    const { data } = await supabase
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
        memo,
        meal_plan_days!inner(day_date, meal_plan_id)
      `)
      .eq('meal_plan_days.day_date', today)
      .eq('meal_plan_days.meal_plan_id', userActivePlan.id);
    todayMeals = data || [];
  }

  // 4. 明日〜1週間の献立も取得
  const oneWeekLater = new Date();
  oneWeekLater.setDate(oneWeekLater.getDate() + 7);
  let upcomingMeals: any[] = [];
  if (userActivePlan) {
    const { data } = await supabase
      .from('planned_meals')
      .select(`
        id,
        meal_type,
        dish_name,
        calories_kcal,
        is_completed,
        mode,
        meal_plan_days!inner(day_date, meal_plan_id)
      `)
      .eq('meal_plan_days.meal_plan_id', userActivePlan.id)
      .gt('meal_plan_days.day_date', today)
      .lte('meal_plan_days.day_date', oneWeekLater.toISOString().split('T')[0])
      .order('meal_plan_days(day_date)', { ascending: true })
      .limit(30);
    upcomingMeals = data || [];
  }

  // 5. 最近の食事データ（過去14日分）
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  
  let recentMeals: any[] = [];
  if (userActivePlan) {
    const { data } = await supabase
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
        meal_plan_days!inner(day_date, meal_plan_id)
      `)
      .eq('meal_plan_days.meal_plan_id', userActivePlan.id)
      .gte('meal_plan_days.day_date', fourteenDaysAgo.toISOString().split('T')[0])
      .lt('meal_plan_days.day_date', today)
      .order('meal_plan_days(day_date)', { ascending: false })
      .limit(50);
    recentMeals = data || [];
  }

  // 3. 健康記録（過去14日分）
  const { data: healthRecords } = await supabase
    .from('health_records')
    .select('*')
    .eq('user_id', userId)
    .gte('record_date', fourteenDaysAgo.toISOString().split('T')[0])
    .order('record_date', { ascending: false })
    .limit(14);

  // 5. 健康目標（IDを含める）
  const { data: healthGoals } = await supabase
    .from('health_goals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active');

  // 6. 栄養目標
  const { data: nutritionTargets } = await supabase
    .from('nutrition_targets')
    .select('*')
    .eq('user_id', userId)
    .single();

  // 7. 獲得バッジ
  const { data: badges } = await supabase
    .from('user_badges')
    .select(`
      obtained_at,
      badges(name, description)
    `)
    .eq('user_id', userId)
    .order('obtained_at', { ascending: false })
    .limit(10);

  // 8. AIインサイト（最新のもの）
  const { data: insights } = await supabase
    .from('health_insights')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  // 9. 買い物リスト（IDを含める）- userActivePlanを使用
  let shoppingList: any[] = [];
  if (userActivePlan) {
    const { data: shoppingData } = await supabase
      .from('shopping_list_items')
      .select('id, item_name, quantity, category, is_checked')
      .eq('meal_plan_id', userActivePlan.id)
      .order('category', { ascending: true });
    shoppingList = shoppingData || [];
  }

  // 10. 冷蔵庫/パントリー（IDを含める）- user_idで取得
  const { data: pantryData } = await supabase
    .from('pantry_items')
    .select('id, name, amount, category, expiration_date, added_at')
    .eq('user_id', userId)
    .order('expiration_date', { ascending: true, nullsFirst: false });
  const pantryItems = pantryData || [];

  // 11. レシピコレクション
  const { data: recipeCollections } = await supabase
    .from('recipe_collections')
    .select('id, name, recipe_ids')
    .eq('user_id', userId)
    .limit(10);

  // 12. 過去のセッション要約（最新5件）
  const { data: pastSessions } = await supabase
    .from('ai_consultation_sessions')
    .select('id, title, summary, key_topics, context_snapshot, summary_generated_at')
    .eq('user_id', userId)
    .eq('status', 'closed')
    .not('summary', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(5);

  // 13. 重要メッセージ（最新20件）
  const { data: importantMessages } = await supabase
    .from('ai_consultation_messages')
    .select(`
      content,
      importance_reason,
      created_at,
      role,
      metadata,
      ai_consultation_sessions!inner(user_id, title)
    `)
    .eq('is_important', true)
    .eq('ai_consultation_sessions.user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

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

  // 今日の献立を整形（アクション実行用にmealIdを含める）
  const mealTypeLabels: Record<string, string> = {
    breakfast: '朝食',
    lunch: '昼食', 
    dinner: '夕食',
    snack: 'おやつ',
    midnight_snack: '夜食',
  };

  // 現在時刻を取得（今日の献立表示用）
  const nowForMeals = new Date();
  const jstOffsetForMeals = 9 * 60;
  const jstNowForMeals = new Date(nowForMeals.getTime() + (jstOffsetForMeals + nowForMeals.getTimezoneOffset()) * 60000);
  const currentHourForMeals = jstNowForMeals.getHours();
  
  // 現在時刻に基づいて「次の食事」を判定
  const getNextMealIndicator = (mealType: string): string => {
    if (currentHourForMeals < 10) {
      if (mealType === 'breakfast') return '🔴 次の食事';
      if (mealType === 'lunch') return '🟡 その次';
    } else if (currentHourForMeals < 14) {
      if (mealType === 'lunch') return '🔴 次の食事（今食べる）';
      if (mealType === 'dinner') return '🟡 その次';
    } else if (currentHourForMeals < 18) {
      if (mealType === 'dinner') return '🔴 次の食事';
    } else if (currentHourForMeals < 21) {
      if (mealType === 'dinner') return '🔴 次の食事（今食べる）';
    }
    return '';
  };

  const todayMealsInfo = todayMeals && todayMeals.length > 0 ? `
【⚠️⚠️⚠️ 今日（${today}）の献立 - 「昼」「朝」「夜」はここから選ぶ ⚠️⚠️⚠️】
${todayMeals.map((m: any) => {
  const mealTypeJa = mealTypeLabels[m.meal_type] || m.meal_type;
  const status = m.is_completed ? '✅完了' : '⬜未完了';
  const mode = m.mode === 'cook' ? '🍳自炊' : m.mode === 'out' ? '🍽️外食' : m.mode === 'buy' ? '🛒中食' : '';
  const nextIndicator = getNextMealIndicator(m.meal_type);
  return `- ${mealTypeJa}（${today}）: ${m.dish_name || '未設定'} (${m.calories_kcal || 0}kcal) ${mode} ${status} ${nextIndicator}
  ★このmealIdを使う: "${m.id}"`;
}).join('\n')}
` : `【📅 今日（${today}）の献立なし - 新規作成が必要】`;

  // 今後1週間の献立を整形（日付順、朝→昼→夕の順）
  const mealTypeOrder: Record<string, number> = {
    breakfast: 1,
    lunch: 2,
    dinner: 3,
    snack: 4,
    midnight_snack: 5,
  };
  
  const sortedUpcomingMeals = [...(upcomingMeals || [])].sort((a, b) => {
    const dateA = a.meal_plan_days?.day_date || '';
    const dateB = b.meal_plan_days?.day_date || '';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return (mealTypeOrder[a.meal_type] || 99) - (mealTypeOrder[b.meal_type] || 99);
  });
  
  const upcomingMealsInfo = sortedUpcomingMeals.length > 0 ? `
【📆 今後1週間の献立】
${sortedUpcomingMeals.map((m: any) => {
  const date = m.meal_plan_days?.day_date || '不明';
  const mealTypeJa = mealTypeLabels[m.meal_type] || m.meal_type;
  // mealIdは内部用途のみ（ユーザーには見せない）
  return `- ${date} ${mealTypeJa}: ${m.dish_name || '未設定'} [内部ID: ${m.id}]`;
}).join('\n')}
` : '';

  // 食事履歴を整形（過去分）
  const mealHistory = recentMeals && recentMeals.length > 0 ? `
【最近の食事履歴（過去14日）】
${recentMeals.map((m: any) => {
  const date = m.meal_plan_days?.day_date || '不明';
  const mealTypeJa = mealTypeLabels[m.meal_type] || m.meal_type;
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

  // 健康目標を整形（IDを含める）
  const goalsInfo = healthGoals && healthGoals.length > 0 ? `
【🎯 現在の健康目標】※変更・削除時はgoalIdを使用
${healthGoals.map((g: any) => `- ${g.goal_type}: 目標${g.target_value}${g.target_unit || ''} (現在${g.current_value || '未測定'}) 期限:${g.target_date || '未設定'}
  goalId: "${g.id}"`).join('\n')}
` : '【健康目標未設定】';

  // 栄養目標を整形
  const nutritionInfo = nutritionTargets ? `
【🥗 1日の栄養目標】
- カロリー: ${nutritionTargets.daily_calories || '未設定'}kcal
- タンパク質: ${nutritionTargets.protein_g || '未設定'}g
- 脂質: ${nutritionTargets.fat_g || '未設定'}g
- 炭水化物: ${nutritionTargets.carbs_g || '未設定'}g
- 食物繊維: ${nutritionTargets.fiber_g || '未設定'}g
- ナトリウム: ${nutritionTargets.sodium_g || '未設定'}g
` : '【栄養目標未設定】';

  // 買い物リストを整形（IDを含める）
  const shoppingListInfo = shoppingList.length > 0 ? `
【🛒 買い物リスト】※変更・削除・チェック時はitemIdを使用
${shoppingList.map((item: any) => {
  const checked = item.is_checked ? '✅' : '⬜';
  return `${checked} ${item.item_name} ${item.quantity || ''} [${item.category || 'その他'}]
  itemId: "${item.id}"`;
}).join('\n')}
` : '【買い物リストなし】';

  // 冷蔵庫/パントリーを整形（IDを含める）
  const pantryInfo = pantryItems.length > 0 ? `
【🧊 冷蔵庫/パントリー（${pantryItems.length}品）】※変更・削除時はitemIdを使用
${pantryItems.map((item: any) => {
  const expiry = item.expiration_date ? `期限:${item.expiration_date}` : '';
  const isExpiringSoon = item.expiration_date && new Date(item.expiration_date) <= new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const warning = isExpiringSoon ? '⚠️期限間近!' : '';
  return `- ${item.name} ${item.amount || ''} [${item.category || 'その他'}] ${expiry} ${warning}
  itemId: "${item.id}"`;
}).join('\n')}
` : '【冷蔵庫/パントリーなし】';

  // レシピコレクションを整形
  const collectionsInfo = recipeCollections && recipeCollections.length > 0 ? `
【📚 レシピコレクション】
${recipeCollections.map((c: any) => `- ${c.name}: ${(c.recipe_ids || []).length}件 (collectionId: "${c.id}")`).join('\n')}
` : '';

  // バッジを整形
  const badgesInfo = badges && badges.length > 0 ? `
【🏆 獲得バッジ（最新10件）】
${badges.map((b: any) => `- ${b.badges?.name}: ${b.badges?.description}`).join('\n')}
` : '';

  // インサイトを整形
  const insightsInfo = insights && insights.length > 0 ? `
【💡 最近のAI分析結果】
${insights.map((i: any) => `- ${i.title}: ${i.summary}`).join('\n')}
` : '';

  // 過去のセッション要約を整形
  const pastSessionsInfo = pastSessions && pastSessions.length > 0 ? `
【📜 過去の相談履歴（最新5件）】
${pastSessions.map((s: any) => {
  const keyFacts = s.context_snapshot?.key_facts || [];
  const userInsights = s.context_snapshot?.user_insights || [];
  return `
■ ${s.title}（${s.summary_generated_at ? new Date(s.summary_generated_at).toLocaleDateString('ja-JP') : '日付不明'}）
  概要: ${s.summary || '要約なし'}
  トピック: ${(s.key_topics || []).join(', ') || 'なし'}
  ${keyFacts.length > 0 ? `重要な事実:
${keyFacts.map((f: any) => `    - [${f.category}] ${f.date ? f.date + ': ' : ''}${f.content}`).join('\n')}` : ''}
  ${userInsights.length > 0 ? `判明したこと: ${userInsights.join(', ')}` : ''}`;
}).join('\n')}
` : '';

  // 重要メッセージを整形
  const importantMessagesInfo = importantMessages && importantMessages.length > 0 ? `
【⭐ ユーザーが重要とマークした過去の会話（最新20件）】
${importantMessages.map((m: any) => {
  const date = new Date(m.created_at).toLocaleDateString('ja-JP');
  const role = m.role === 'user' ? 'ユーザー' : 'AI';
  const reason = m.importance_reason ? ` (理由: ${m.importance_reason})` : '';
  const category = m.metadata?.category ? ` [${m.metadata.category}]` : '';
  return `- ${date}${category} [${role}] ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}${reason}`;
}).join('\n')}
` : '';

  // 今日の日付と現在時刻（日本時間）
  const now = new Date();
  const jstOffset = 9 * 60; // JST is UTC+9
  const jstNow = new Date(now.getTime() + (jstOffset + now.getTimezoneOffset()) * 60000);
  const currentHour = jstNow.getHours();
  const currentMinutes = jstNow.getMinutes();
  const currentTimeStr = `${currentHour}:${currentMinutes.toString().padStart(2, '0')}`;
  
  const todayDisplay = new Date().toLocaleDateString('ja-JP', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    weekday: 'long' 
  });

  // 明日の日付
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // 現在時刻に基づく食事の解釈ルール
  let mealInterpretation = '';
  let nextMealSuggestion = '';
  
  if (currentHour < 10) {
    // 午前10時前: 朝食がまだ、昼食も今日
    mealInterpretation = `
- 「朝」「朝食」→ 今日（${today}）の朝食 ★まだ食べていない可能性が高い
- 「昼」「昼食」「お昼」→ 今日（${today}）の昼食
- 「夜」「夕食」「晩ご飯」→ 今日（${today}）の夕食`;
    nextMealSuggestion = `次の食事は「朝食」または「昼食」です。`;
  } else if (currentHour < 14) {
    // 午前10時〜午後2時: 昼食の時間帯
    mealInterpretation = `
- 「朝」「朝食」→ 今日（${today}）の朝食（既に終了の可能性）
- 「昼」「昼食」「お昼」→ 今日（${today}）の昼食 ★今食べる食事
- 「夜」「夕食」「晩ご飯」→ 今日（${today}）の夕食`;
    nextMealSuggestion = `次の食事は「昼食」です。「昼」と言われたら今日（${today}）の昼食を変更してください。`;
  } else if (currentHour < 18) {
    // 午後2時〜午後6時: 昼食は終了、夕食の準備時間
    mealInterpretation = `
- 「朝」「朝食」→ 明日（${tomorrowStr}）の朝食
- 「昼」「昼食」「お昼」→ 今日（${today}）の昼食（既に終了の可能性）または明日
- 「夜」「夕食」「晩ご飯」→ 今日（${today}）の夕食 ★次に食べる食事`;
    nextMealSuggestion = `次の食事は「夕食」です。「夜」「夕食」と言われたら今日（${today}）の夕食を変更してください。`;
  } else if (currentHour < 21) {
    // 午後6時〜午後9時: 夕食の時間帯
    mealInterpretation = `
- 「朝」「朝食」→ 明日（${tomorrowStr}）の朝食
- 「昼」「昼食」「お昼」→ 明日（${tomorrowStr}）の昼食
- 「夜」「夕食」「晩ご飯」→ 今日（${today}）の夕食 ★今食べる食事`;
    nextMealSuggestion = `次の食事は「夕食」です。「夜」と言われたら今日（${today}）の夕食を変更してください。`;
  } else {
    // 午後9時以降: 夕食は終了、明日の食事
    mealInterpretation = `
- 「朝」「朝食」→ 明日（${tomorrowStr}）の朝食 ★次に食べる食事
- 「昼」「昼食」「お昼」→ 明日（${tomorrowStr}）の昼食
- 「夜」「夕食」「晩ご飯」→ 明日（${tomorrowStr}）の夕食`;
    nextMealSuggestion = `次の食事は明日の「朝食」です。`;
  }

  return `あなたは「ほめゴハン」のAI栄養アドバイザーです。

【⚠️⚠️⚠️ 最重要：現在の日時 ⚠️⚠️⚠️】
今日は${todayDisplay}（${today}）です。
現在時刻: ${currentTimeStr}（日本時間）
${nextMealSuggestion}

【日付の解釈ルール - 現在時刻（${currentTimeStr}）に基づく】
${mealInterpretation}
- 「明日の〇〇」→ 明日（${tomorrowStr}）の該当食事
- 日付指定がない場合は、上記ルールに従って適切な日の食事を対象とする

【あなたの役割】
1. ユーザーの食事や健康について相談に乗り、具体的なアドバイスを提供する
2. まず褒める：ユーザーの努力や良い点を見つけて褒める
3. 共感する：ユーザーの悩みや状況に寄り添う
4. 具体的に提案：実行可能な具体的なアドバイスを提供
5. 必要に応じてアクションを実行（献立変更、買い物リスト追加など）

【重要】以下のユーザー情報を参考にして、パーソナライズされたアドバイスを提供してください。
各データにはIDが含まれています。変更・削除などのアクションを実行する際は、必ず正しい日付のmealIdを使用してください。
「昼」と言われたら、必ず【今日（${today}）の献立】セクションから昼食のmealIdを探してください。

${profileInfo}

${todayMealsInfo}

${upcomingMealsInfo}

${shoppingListInfo}

${pantryInfo}

${goalsInfo}

${nutritionInfo}

${collectionsInfo}

${mealHistory}

${healthHistory}

${badgesInfo}

${insightsInfo}

${pastSessionsInfo}

${importantMessagesInfo}

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
- create_meal: 新規食事を登録 (params: { date: "YYYY-MM-DD", mealType: "breakfast|lunch|dinner|snack|midnight_snack", dishName: "料理名", mode: "cook|out|buy", calories?: number, protein?: number, fat?: number, carbs?: number, memo?: string, dishes?: [{name, role, cal, ingredient}] })
- update_meal: 献立を更新 (params: { mealId: "uuid", updates: { dish_name?, calories_kcal?, protein_g?, fat_g?, carbs_g?, memo?, mode?, dishes?: [{name: "料理名", role: "main|side|soup", cal: カロリー数値, ingredient: "主な材料"}] } })
  ※ dishes配列は必ず含めてください。主菜(main)、副菜(side)、汁物(soup)などの役割を指定
- delete_meal: 献立を削除 (params: { mealId: "uuid" })
- complete_meal: 食事を完了マーク (params: { mealId: "uuid", isCompleted: true|false })

■ 買い物リスト関連:
- add_to_shopping_list: 買い物リストに追加 (params: { items: [{name, quantity, category}] })
- update_shopping_item: 買い物リスト更新 (params: { itemId: "uuid", updates: { item_name?, quantity?, category? } })
- delete_shopping_item: 買い物リストから削除 (params: { itemId: "uuid" })
- check_shopping_item: 買い物チェック (params: { itemId: "uuid", isChecked: true|false })

■ 冷蔵庫/パントリー関連:
- add_pantry_item: 冷蔵庫に食材追加 (params: { name: "食材名", amount?: "量（例: 1パック, 200g）", category?: "vegetable/meat/fish/dairy/other", expirationDate?: "YYYY-MM-DD" })
- update_pantry_item: 冷蔵庫の食材更新 (params: { itemId: "uuid", updates: { name?, amount?, category?, expirationDate? } })
- delete_pantry_item: 冷蔵庫から食材削除 (params: { itemId: "uuid" })

■ レシピ関連:
- suggest_recipe: レシピを検索・提案 (params: { keywords?: "検索キーワード", cuisineType?: "和食|洋食|中華|etc" })
- like_recipe: レシピにいいね (params: { recipeId: "uuid" })
- add_recipe_to_collection: レシピをコレクションに追加 (params: { recipeId: "uuid", collectionName?: "コレクション名" })

■ 栄養目標関連:
- update_nutrition_target: 栄養目標を更新 (params: { targets: { daily_calories?, protein_g?, fat_g?, carbs_g?, fiber_g?, sodium_g? } })

■ 健康目標関連:
- set_health_goal: 健康目標を設定 (params: { goalType: "weight|body_fat|exercise|etc", targetValue: number, targetUnit?: string, targetDate?: "YYYY-MM-DD", note?: string })
- update_health_goal: 健康目標を更新 (params: { goalId: "uuid", updates: { target_value?, target_date?, status?, current_value? } })
- delete_health_goal: 健康目標を削除 (params: { goalId: "uuid" })

■ 健康記録関連:
- add_health_record: 健康記録を追加 (params: { date?: "YYYY-MM-DD", weight?: number, bodyFatPercentage?: number, systolicBp?: number, diastolicBp?: number, sleepHours?: number, overallCondition?: 1-5, moodScore?: 1-5, stressLevel?: 1-5, stepCount?: number, dailyNote?: string })
- update_health_record: 健康記録を更新 (params: { date: "YYYY-MM-DD", updates: {...} })

■ プロフィール関連（食事の好み・生活習慣のみ）:
- update_profile_preferences: 食事の好みや生活習慣を更新 (params: { updates: { diet_style?, cuisine_preferences?, taste_preferences?, favorite_ingredients?, favorite_dishes?, cooking_experience?, weekday_cooking_minutes?, weekend_cooking_minutes?, snacking_habit?, alcohol_frequency?, daily_water_ml?, etc } })
  ※ email, avatar_url等のセキュリティ関連フィールドは更新不可

【⚠️⚠️⚠️ 最重要：アクション実行のルール ⚠️⚠️⚠️】

★★★ 絶対に守ること ★★★
1. ユーザーが献立の変更や追加を依頼したら、提案と同時にアクションJSONを出力してください
2. 「変えて」「追加して」「それにして」「OK」「はい」「お願い」などの言葉があったら、即座にアクションJSONを出力
3. 確認を求めずに、すぐにアクションを実行してください
4. 「変更しますね」「追加しますね」と言葉で言うだけでは実行されません。必ずアクションJSONを含めてください
5. \`\`\`action ... \`\`\` 形式がないと、システムは何も実行しません

★★★ 禁止事項 ★★★
- 「この内容で変更してもよろしいでしょうか？」と確認だけして終わること → アクションJSONを必ず含める
- アクションJSONなしで「変更しました」と言うこと → 嘘になります
- ユーザーに何度も確認を求めること → 1回の依頼で実行する

【⚠️⚠️⚠️ 献立提案の品質基準（一汁三菜の原則）⚠️⚠️⚠️】

あなたは一流の管理栄養士です。献立を提案する際は、以下の基準を厳守してください。

■ 基本構成（一汁三菜）- 必ず守ること:
- 主菜(main): メインの料理（肉・魚など）× 1品【必須】
- 副菜(side): 野菜中心のおかず × 2品【必須】
- 汁物(soup): 味噌汁・スープなど × 1品【必須】

■ 健康状態に応じた食材制限（厳守）:
- アレルギー食材は絶対に使用しない
- 苦手な食材は避ける
- 持病に応じた食材制限を守る（高血圧→減塩、糖尿病→低GI等）

■ パーソナライズ要素（必ず考慮）:
- ユーザーの目標カロリーに合わせる
- 調理時間の制限を守る（平日/休日の調理時間）
- 料理経験レベルに合った難易度
- 好みのジャンル（和食/洋食/中華等）を反映
- 好きな食材を積極的に使用

■ 栄養バランス:
- 目標カロリーの配分: 朝食25%、昼食35%、夕食35%、間食5%
- タンパク質、脂質、炭水化物のバランスを考慮
- ビタミン・ミネラルが豊富な食材を含める

■ dishes配列の必須フォーマット:
各料理には以下を必ず含める:
- name: 料理名
- role: "main" | "side" | "soup"
- cal: カロリー（数値）
- ingredient: 主な材料（カンマ区切り）

■ 例外（単品が許される場合のみ）:
- カレーライス、丼物、ラーメン等の一品完結料理
- ユーザーが明示的に単品を希望した場合
- おやつ・軽食の場合
※ただし、これらの場合も副菜（サラダ等）を添えることを推奨

【⚠️ 重要：応答には必ず献立の詳細を含めること ⚠️】
アクションJSONは自動的に除去されるため、応答テキストに必ず献立の詳細を記載してください。

【アクション出力例1 - 一汁三菜の基本形（洋食）】
ユーザー: 「今日の昼食をステーキにして」

サーロインステーキ、いいですね！🥩✨
一汁三菜で栄養バランスの良い献立にしますね。

**サーロインステーキ定食** (約650kcal)
- 🥩 **主菜**: サーロインステーキ (400kcal)
- 🥬 **副菜**: ほうれん草のソテー (50kcal)
- 🥗 **副菜**: コールスローサラダ (80kcal)
- 🍲 **汁物**: コンソメスープ (30kcal)

この献立で、満足できるお昼になること間違いなしです！😊

\`\`\`action
{
  "type": "update_meal",
  "params": {
    "mealId": "ここに実際のmealIdを入れる",
    "updates": {
      "dish_name": "サーロインステーキ定食",
      "calories_kcal": 650,
      "protein_g": 45,
      "fat_g": 35,
      "carbs_g": 40,
      "mode": "cook",
      "dishes": [
        {"name": "サーロインステーキ", "role": "main", "cal": 400, "ingredient": "牛サーロイン"},
        {"name": "ほうれん草のソテー", "role": "side", "cal": 50, "ingredient": "ほうれん草、バター"},
        {"name": "コールスローサラダ", "role": "side", "cal": 80, "ingredient": "キャベツ、にんじん"},
        {"name": "コンソメスープ", "role": "soup", "cal": 30, "ingredient": "玉ねぎ、にんじん"}
      ]
    }
  }
}
\`\`\`

【アクション出力例2 - 和食の場合】
ユーザー: 「鮭にして」

鮭、いいですね！🐟✨
和食の一汁三菜でヘルシーな献立にしますね。

**鮭の塩焼き定食** (約550kcal)
- 🐟 **主菜**: 鮭の塩焼き (200kcal)
- 🥬 **副菜**: ほうれん草のおひたし (30kcal)
- 🥕 **副菜**: きんぴらごぼう (80kcal)
- 🍲 **汁物**: 味噌汁（豆腐・わかめ）(40kcal)

\`\`\`action
{
  "type": "update_meal",
  "params": {
    "mealId": "mealIdをここに",
    "updates": {
      "dish_name": "鮭の塩焼き定食",
      "calories_kcal": 550,
      "protein_g": 35,
      "fat_g": 15,
      "carbs_g": 60,
      "mode": "cook",
      "dishes": [
        {"name": "鮭の塩焼き", "role": "main", "cal": 200, "ingredient": "鮭"},
        {"name": "ほうれん草のおひたし", "role": "side", "cal": 30, "ingredient": "ほうれん草"},
        {"name": "きんぴらごぼう", "role": "side", "cal": 80, "ingredient": "ごぼう、にんじん"},
        {"name": "味噌汁", "role": "soup", "cal": 40, "ingredient": "豆腐、わかめ"}
      ]
    }
  }
}
\`\`\`

【アクション出力例3 - そばの場合】
ユーザー: 「そばにして」

そば、いいですね！🍜✨
栄養バランスを考えて、一汁三菜の献立にしますね。

**天ぷらそば定食** (約650kcal)
- 🍜 **主菜**: かけそば (350kcal)
- 🍤 **副菜**: 野菜天ぷら（さつまいも、ししとう）(200kcal)
- 🥬 **副菜**: ほうれん草のおひたし (30kcal)
- 🍲 **汁物**: そばつゆ（温かいかけそばの場合はそばつゆが汁物を兼ねる）

または、ざるそばの場合は：

**ざるそば定食** (約550kcal)
- 🍜 **主菜**: ざるそば (300kcal)
- 🍤 **副菜**: かき揚げ (150kcal)
- 🥬 **副菜**: 小松菜のおひたし (30kcal)
- 🍲 **汁物**: そばつゆ + 薬味

\`\`\`action
{
  "type": "update_meal",
  "params": {
    "mealId": "mealIdをここに",
    "updates": {
      "dish_name": "天ぷらそば定食",
      "calories_kcal": 650,
      "protein_g": 20,
      "fat_g": 15,
      "carbs_g": 100,
      "mode": "cook",
      "dishes": [
        {"name": "かけそば", "role": "main", "cal": 350, "ingredient": "そば、そばつゆ、ねぎ"},
        {"name": "野菜天ぷら", "role": "side", "cal": 200, "ingredient": "さつまいも、ししとう、なす"},
        {"name": "ほうれん草のおひたし", "role": "side", "cal": 30, "ingredient": "ほうれん草"},
        {"name": "そばつゆ", "role": "soup", "cal": 30, "ingredient": "だし、醤油、みりん"}
      ]
    }
  }
}
\`\`\`

【アクション出力例4 - 一品料理の例外】
ユーザー: 「カレーにして」（一品で完結する料理）

カレー、いいですね！🍛✨

**ビーフカレー** (約750kcal)
- 🍛 **メイン**: ビーフカレー＆ライス (700kcal)
- 🥗 **副菜**: サラダ (30kcal)
- 🥒 **副菜**: 福神漬け (20kcal)

\`\`\`action
{
  "type": "update_meal",
  "params": {
    "mealId": "mealIdをここに",
    "updates": {
      "dish_name": "ビーフカレー",
      "calories_kcal": 750,
      "protein_g": 25,
      "fat_g": 25,
      "carbs_g": 100,
      "mode": "cook",
      "dishes": [
        {"name": "ビーフカレー", "role": "main", "cal": 700, "ingredient": "牛肉、じゃがいも、にんじん、玉ねぎ、ご飯"},
        {"name": "サラダ", "role": "side", "cal": 30, "ingredient": "レタス、トマト"},
        {"name": "福神漬け", "role": "side", "cal": 20, "ingredient": "福神漬け"}
      ]
    }
  }
}
\`\`\`

【アクション出力例5 - 同意への対応】
ユーザー: 「OK」「それでお願い」「はい」（前の提案に対して）
→ 前の提案内容でアクションJSONを出力（一汁三菜を維持）

【応答のガイドライン】
- 親しみやすく、温かい口調で話す
- 絵文字を適度に使用する
- 専門用語は避け、わかりやすく説明する
- ユーザーの状況（仕事、家族構成、健康状態など）を考慮する
- 無理のない、実現可能な提案をする
- 長すぎない、読みやすい回答を心がける
- マークダウン形式を使用して読みやすく整形する（箇条書き、太字など）
- **献立は必ず一汁三菜（主菜1、副菜2、汁物1）で提案する**
- ユーザーが依頼したら、確認せずに即座にアクションJSONを出力する
- **⚠️ 献立を提案する際は、必ず応答テキストに料理名とカロリーを箇条書きで記載する**
- アクションJSONは自動的に除去されるため、応答テキストだけで献立内容がわかるようにする
- **⚠️⚠️⚠️ 絶対厳守：mealId、itemId、goalIdなどの内部IDは絶対にユーザーに表示しない ⚠️⚠️⚠️**
- 内部IDは「[内部ID: xxx]」形式でシステムプロンプトに含まれているが、これはアクション実行用の参照情報であり、ユーザーへの応答には含めてはいけない
- 献立を紹介する際は「朝食→昼食→夕食」の順番で整理して表示する`;
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

    // アクションがある場合はai_action_logsに記録し、自動実行
    let actionResult = null;
    if (proposedActions) {
      const { data: actionLog } = await supabase
        .from('ai_action_logs')
        .insert({
          session_id: params.sessionId,
          message_id: savedAiMessage.id,
          action_type: proposedActions.type,
          action_params: proposedActions.params || {},
          status: 'pending',
        })
        .select('id')
        .single();

      // アクションを自動実行
      if (actionLog) {
        try {
          const executeRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/ai/consultation/actions/${savedAiMessage.id}/execute`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cookie': request.headers.get('cookie') || '',
            },
          });
          if (executeRes.ok) {
            actionResult = await executeRes.json();
            console.log('Action auto-executed:', actionResult);
          } else {
            console.error('Action auto-execution failed:', await executeRes.text());
          }
        } catch (e) {
          console.error('Action auto-execution error:', e);
        }
      }
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
        proposedActions: actionResult?.success ? null : proposedActions, // 自動実行成功時はnull
        createdAt: savedAiMessage.created_at,
      },
      actionExecuted: actionResult?.success || false,
      actionResult,
    });

  } catch (error: any) {
    console.error('Message error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
