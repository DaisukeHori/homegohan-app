import { createClient } from '@/lib/supabase/server';
import { getFastLLMClient, getFastLLMModel } from '@/lib/ai/fast-llm';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

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
  // 日付計算を先に行う
  const today = new Date().toISOString().split('T')[0];
  const oneWeekLater = new Date();
  oneWeekLater.setDate(oneWeekLater.getDate() + 7);
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  // ===== 並列クエリ実行（レイテンシー改善） =====
  const [
    profileResult,
    dailyMealResult,
    upcomingResult,
    recentResult,
    healthRecordsResult,
    healthGoalsResult,
    nutritionTargetsResult,
    badgesResult,
    insightsResult,
    shoppingListResult,
    pantryResult,
    collectionsResult,
    pastSessionsResult,
    importantMessagesResult,
  ] = await Promise.all([
    // 1. ユーザープロフィール
    supabase.from('user_profiles').select('*').eq('id', userId).single(),

    // 2. 今日のdaily_meal ID
    supabase.from('user_daily_meals').select('id').eq('user_id', userId).eq('day_date', today).single(),

    // 3. 明日〜1週間の献立
    supabase.from('planned_meals').select(`
      id, meal_type, dish_name, calories_kcal, is_completed, mode,
      user_daily_meals!inner(day_date)
    `).eq('user_id', userId)
      .gt('user_daily_meals.day_date', today)
      .lte('user_daily_meals.day_date', oneWeekLater.toISOString().split('T')[0])
      .limit(30),

    // 4. 過去14日の食事
    supabase.from('planned_meals').select(`
      id, meal_type, dish_name, dishes, calories_kcal, protein_g, fat_g, carbs_g, is_completed, mode,
      user_daily_meals!inner(day_date)
    `).eq('user_id', userId)
      .gte('user_daily_meals.day_date', fourteenDaysAgo.toISOString().split('T')[0])
      .lt('user_daily_meals.day_date', today)
      .limit(50),

    // 5. 健康記録（過去14日）
    supabase.from('health_records').select('*')
      .eq('user_id', userId)
      .gte('record_date', fourteenDaysAgo.toISOString().split('T')[0])
      .order('record_date', { ascending: false })
      .limit(14),

    // 6. 健康目標
    supabase.from('health_goals').select('*').eq('user_id', userId).eq('status', 'active'),

    // 7. 栄養目標
    supabase.from('nutrition_targets').select('*').eq('user_id', userId).single(),

    // 8. 獲得バッジ
    supabase.from('user_badges').select('obtained_at, badges(name, description)')
      .eq('user_id', userId)
      .order('obtained_at', { ascending: false })
      .limit(10),

    // 9. AIインサイト
    supabase.from('health_insights').select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5),

    // 10. アクティブな買い物リスト
    supabase.from('shopping_lists').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle(),

    // 11. 冷蔵庫/パントリー
    supabase.from('pantry_items').select('id, name, amount, category, expiration_date, added_at')
      .eq('user_id', userId)
      .order('expiration_date', { ascending: true, nullsFirst: false }),

    // 12. レシピコレクション
    supabase.from('recipe_collections').select('id, name, recipe_ids').eq('user_id', userId).limit(10),

    // 13. 過去のセッション要約
    supabase.from('ai_consultation_sessions').select('id, title, summary, key_topics, context_snapshot, summary_generated_at')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .not('summary', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(5),

    // 14. 重要メッセージ
    supabase.from('ai_consultation_messages').select(`
      content, importance_reason, created_at, role, metadata,
      ai_consultation_sessions!inner(user_id, title)
    `).eq('is_important', true)
      .eq('ai_consultation_sessions.user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  // 結果を変数に展開
  const profile = profileResult.data;
  const dailyMeal = dailyMealResult.data;
  const upcomingMeals = upcomingResult.data || [];
  const recentMeals = recentResult.data || [];
  const healthRecords = healthRecordsResult.data;
  const healthGoals = healthGoalsResult.data;
  const nutritionTargets = nutritionTargetsResult.data;
  const badges = badgesResult.data;
  const insights = insightsResult.data;
  const activeShoppingList = shoppingListResult.data;
  const pantryItems = pantryResult.data || [];
  const recipeCollections = collectionsResult.data;
  const pastSessions = pastSessionsResult.data;
  const importantMessages = importantMessagesResult.data;

  // ===== 依存クエリ（並列実行後） =====
  // 今日の献立（daily_meal IDが必要）
  let todayMeals: any[] = [];
  // 買い物リストアイテム（shopping_list IDが必要）
  let shoppingList: any[] = [];

  const dependentQueries = [];

  if (dailyMeal) {
    dependentQueries.push(
      supabase.from('planned_meals').select(`
        id, meal_type, dish_name, dishes, calories_kcal, protein_g, fat_g, carbs_g, is_completed, mode, memo,
        user_daily_meals!inner(day_date)
      `).eq('daily_meal_id', dailyMeal.id).then((r: any) => { todayMeals = r.data || []; })
    );
  }

  if (activeShoppingList) {
    dependentQueries.push(
      supabase.from('shopping_list_items').select('id, item_name, quantity, category, is_checked')
        .eq('shopping_list_id', activeShoppingList.id)
        .order('category', { ascending: true })
        .then((r: any) => { shoppingList = r.data || []; })
    );
  }

  // 依存クエリを並列実行
  if (dependentQueries.length > 0) {
    await Promise.all(dependentQueries);
  }

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
    const dateA = a.user_daily_meals?.day_date || '';
    const dateB = b.user_daily_meals?.day_date || '';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return (mealTypeOrder[a.meal_type] || 99) - (mealTypeOrder[b.meal_type] || 99);
  });
  
  const upcomingMealsInfo = sortedUpcomingMeals.length > 0 ? `
【📆 今後1週間の献立】
${sortedUpcomingMeals.map((m: any) => {
  const date = m.user_daily_meals?.day_date || '不明';
  const mealTypeJa = mealTypeLabels[m.meal_type] || m.meal_type;
  // mealIdは内部用途のみ（ユーザーには見せない）
  return `- ${date} ${mealTypeJa}: ${m.dish_name || '未設定'} [内部ID: ${m.id}]`;
}).join('\n')}
` : '';

  // 食事履歴を整形（過去分）
  const mealHistory = recentMeals && recentMeals.length > 0 ? `
【最近の食事履歴（過去14日）】
${recentMeals.map((m: any) => {
  const date = m.user_daily_meals?.day_date || '不明';
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
- generate_single_meal: AIが栄養計算付きで1食を生成（推奨）
  params: {
    date: "YYYY-MM-DD",
    mealType: "breakfast|lunch|dinner|snack|midnight_snack",
    specificDish?: "希望の料理名（例: 肉じゃが、カレー）",
    recipeId?: "uuid",              // レシピDB検索結果のUUID（search_recipesで取得）
    recipeExternalId?: "external_id", // レシピDBの外部ID（search_recipesで取得）
    excludeIngredients?: ["除外食材（例: 卵, 乳製品）"],
    preferIngredients?: ["優先食材（冷蔵庫にある食材など）"],
    note?: "その他のリクエスト（例: 辛めにして）",
    ultimateMode?: true  // 栄養最適化モード
  }
  ※ このアクションはAIが正確な栄養計算を行い、一汁三菜の献立を生成します
  ※ recipeId/recipeExternalIdを指定すると、レシピDBの正確な栄養データを使用します

- generate_day_menu: 1日分の献立を一括作成 (params: { date: "YYYY-MM-DD", ultimateMode?: true })
- generate_week_menu: 1週間分の献立を一括作成 (params: { startDate: "YYYY-MM-DD", ultimateMode?: true })

- update_meal: 献立を更新（メモ追加・モード変更など微調整用）
  params: { mealId: "uuid", updates: { dish_name?, calories_kcal?, protein_g?, fat_g?, carbs_g?, memo?, mode?, dishes?: [{name: "料理名", role: "main|side|soup", calories_kcal: カロリー数値, ingredient: "主な材料"}] } }
  ※ dishes配列は必ず含めてください。主菜(main)、副菜(side)、汁物(soup)などの役割を指定

- delete_meal: 献立を削除 (params: { mealId: "uuid" })
- complete_meal: 食事を完了マーク (params: { mealId: "uuid", isCompleted: true|false })

【⚠️ generate_single_meal と update_meal の使い分け】
- ユーザーが「〇〇にして」「肉じゃがにして」と**新しい料理を指定**した場合 → generate_single_meal
- ユーザーが「カロリーを減らして」「メモを追加して」など**既存献立の微調整**をした場合 → update_meal

【⚠️ 重要：栄養計算について】
generate_single_meal は内部で栄養計算を行うため、正確な栄養データが保存されます。
update_meal は入力された値をそのまま保存するため、栄養値の正確性は保証されません。
「〇〇にして」という料理変更の場合は、必ず generate_single_meal を使用してください。

【🔍 レシピDB検索ツール（search_recipes）について】
あなたは search_recipes ツールを使ってレシピデータベースを検索できます。
ユーザーが特定の料理を希望した場合（「肉じゃがにして」「今日はカレーがいい」など）、
このツールで候補を検索し、栄養情報付きで提示することで、より正確な献立を提案できます。

■ 使い方:
1. search_recipes({ query: "肉じゃが" }) で検索
2. 検索結果を栄養情報と一緒にユーザーに提示
3. ユーザーが選択したら generate_single_meal({ recipeId: "..." }) でアクション実行

■ 検索結果の形式:
[
  { id: "uuid", externalId: "外部ID", name: "料理名", nutrition: { calories, protein, fat, carbs }, ingredients: "主な材料" }
]

【推奨フロー例】
ユーザー：「肉じゃがにして」
→ search_recipes({ query: "肉じゃが" }) で検索
→ 候補を提示：「肉じゃが（豚肉）287kcal」「肉じゃが（牛肉）312kcal」
→ ユーザー選択：「1番で」
→ generate_single_meal({ date: "...", mealType: "dinner", recipeId: "選択したレシピのUUID" })

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

【アクション出力例1 - 料理変更（generate_single_meal を使用）】
ユーザー: 「今日の昼食をステーキにして」

サーロインステーキ、いいですね！🥩✨
AIが最適な一汁三菜の献立を生成しますね。

\`\`\`action
{
  "type": "generate_single_meal",
  "params": {
    "date": "${today}",
    "mealType": "lunch",
    "specificDish": "サーロインステーキ"
  }
}
\`\`\`

【アクション出力例2 - 冷蔵庫の食材を使う場合】
ユーザー: 「鮭が余ってるから使って」

鮭を使った献立を作りますね！🐟✨

\`\`\`action
{
  "type": "generate_single_meal",
  "params": {
    "date": "${today}",
    "mealType": "dinner",
    "preferIngredients": ["鮭"]
  }
}
\`\`\`

【アクション出力例3 - 除外食材がある場合】
ユーザー: 「卵アレルギーなので卵なしで」

卵を使わない献立を生成しますね！🍳❌

\`\`\`action
{
  "type": "generate_single_meal",
  "params": {
    "date": "${today}",
    "mealType": "dinner",
    "excludeIngredients": ["卵"]
  }
}
\`\`\`

【アクション出力例4 - 特定の料理 + 追加リクエスト】
ユーザー: 「カレーにして。辛めでお願い」

カレー、いいですね！🍛✨ 辛めで作りますね。

\`\`\`action
{
  "type": "generate_single_meal",
  "params": {
    "date": "${today}",
    "mealType": "dinner",
    "specificDish": "カレー",
    "note": "辛めにして"
  }
}
\`\`\`

【アクション出力例5 - 微調整（update_meal を使用）】
ユーザー: 「昼食にメモを追加して」

メモを追加しますね！📝

\`\`\`action
{
  "type": "update_meal",
  "params": {
    "mealId": "ここに実際のmealIdを入れる",
    "updates": {
      "memo": "ユーザーからのメモ内容"
    }
  }
}
\`\`\`

【アクション出力例6 - 1日分の献立を一括生成】
ユーザー: 「明日の献立を作って」

明日の献立を一括で生成しますね！📅✨

\`\`\`action
{
  "type": "generate_day_menu",
  "params": {
    "date": "${tomorrowStr}"
  }
}
\`\`\`

【アクション出力例7 - 栄養最適化モード】
ユーザー: 「栄養バランスを最高にしたい」

究極モードで栄養最適化された献立を生成しますね！💪✨

\`\`\`action
{
  "type": "generate_single_meal",
  "params": {
    "date": "${today}",
    "mealType": "dinner",
    "ultimateMode": true
  }
}
\`\`\`

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
    const openai = getFastLLMClient();
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

    // ストリーミングモードかどうかを確認
    const url = new URL(request.url);
    const useStreaming = url.searchParams.get('stream') === 'true';

    // knowledge-gpt（ナレッジベース付きAI）で応答生成
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    // ストリーミングモード
    if (useStreaming) {
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          let aiContent = '';

          try {
            // knowledge-gptをストリーミングで呼び出し（25秒タイムアウト）
            const knowledgeGptRes = await fetch(`${supabaseUrl}/functions/v1/knowledge-gpt`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${serviceRoleKey}`,
              },
              body: JSON.stringify({
                messages,
                mode: 'chat',
                stream: true,
              }),
              signal: AbortSignal.timeout(25000),
            });

            if (!knowledgeGptRes.ok || !knowledgeGptRes.body) {
              throw new Error('knowledge-gpt streaming failed');
            }

            // SSEを読み取って転送
            const reader = knowledgeGptRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                    continue;
                  }
                  try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) {
                      aiContent += content;
                      // クライアントに転送（フロントエンドが期待する形式）
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        choices: [{ delta: { content } }]
                      })}\n\n`));
                    }
                  } catch {
                    // JSON parse error, skip
                  }
                }
              }
            }

            // ストリーミング完了後、DB保存とアクション実行
            const actionMatch = aiContent.match(/```action\s*([\s\S]*?)```/);
            let proposedActions = null;
            if (actionMatch) {
              try {
                proposedActions = JSON.parse(actionMatch[1]);
              } catch {
                // parse error
              }
            }

            // 重要度チェック（非同期）
            const checkImportanceAsync = async () => {
              try {
                const importanceCheck = await openai.chat.completions.create({
                  model: getFastLLMModel(),
                  messages: [
                    { role: 'system', content: 'ユーザーメッセージが重要かどうかをJSON形式で判断: {"isImportant": true/false, "reason": "理由", "category": "カテゴリ"}' },
                    { role: 'user', content: userMessage }
                  ],
                  max_completion_tokens: 200,
                  response_format: { type: 'json_object' },
                } as any);
                const result = JSON.parse(importanceCheck.choices[0]?.message?.content || '{}');
                if (result.isImportant) {
                  await supabase.from('ai_consultation_messages').update({
                    is_important: true,
                    importance_reason: result.reason,
                    metadata: { autoMarked: true, category: result.category },
                  }).eq('id', savedUserMessage.id);
                }
              } catch { /* ignore */ }
            };
            checkImportanceAsync();

            // AI応答を保存
            const { data: savedAiMessage } = await supabase
              .from('ai_consultation_messages')
              .insert({
                session_id: params.sessionId,
                role: 'assistant',
                content: aiContent.replace(/```action[\s\S]*?```/g, '').trim(),
                proposed_actions: proposedActions,
              })
              .select()
              .single();

            // アクション自動実行
            let actionResult = null;
            if (proposedActions && savedAiMessage) {
              await supabase.from('ai_action_logs').insert({
                session_id: params.sessionId,
                message_id: savedAiMessage.id,
                action_type: proposedActions.type,
                action_params: proposedActions.params || {},
                status: 'pending',
              });

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
                }
              } catch { /* ignore */ }
            }

            // セッション更新
            await supabase.from('ai_consultation_sessions').update({ updated_at: new Date().toISOString() }).eq('id', params.sessionId);

            // 完了メッセージを送信（フロントエンドが期待する形式）
            const finalData = {
              userMessage: {
                id: savedUserMessage.id,
                content: savedUserMessage.content,
                isImportant: savedUserMessage.is_important || false,
                createdAt: savedUserMessage.created_at,
              },
              aiMessage: {
                id: savedAiMessage?.id,
                content: aiContent.replace(/```action[\s\S]*?```/g, '').trim(),
                proposedActions: proposedActions,
                createdAt: savedAiMessage?.created_at,
              },
              actionExecuted: actionResult?.success || false,
              actionResult,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalData)}\n\n`));

          } catch (error: any) {
            console.error('Streaming error:', error);
            // エラー時でも必ずassistantメッセージをDBに書き込んでユーザーに通知する
            const errorContent = 'すみません、応答の生成中にエラーが発生しました。しばらく待ってから再度お試しください。';
            try {
              const { data: errorAiMsg } = await supabase
                .from('ai_consultation_messages')
                .insert({
                  session_id: params.sessionId,
                  role: 'assistant',
                  content: errorContent,
                })
                .select()
                .single();
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                userMessage: {
                  id: savedUserMessage.id,
                  content: savedUserMessage.content,
                  isImportant: false,
                  createdAt: savedUserMessage.created_at,
                },
                aiMessage: {
                  id: errorAiMsg?.id,
                  content: errorContent,
                  proposedActions: null,
                  createdAt: errorAiMsg?.created_at,
                },
                actionExecuted: false,
                actionResult: null,
                error: error.message,
              })}\n\n`));
            } catch (dbError) {
              console.error('Failed to write error message to DB:', dbError);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`));
            }
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // 非ストリーミングモード（従来通り）
    let aiContent = 'すみません、応答を生成できませんでした。';

    try {
      // NOTE:
      // - `/functions/v1/...` の "v1" は Supabase Edge Functions のHTTPパスのバージョンです。
      //   これは献立生成ロジックの v1/v2（legacy/dataset）とは別の概念です。
      const knowledgeGptRes = await fetch(`${supabaseUrl}/functions/v1/knowledge-gpt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          messages,
          mode: 'chat', // チャットモード（自然言語での応答）
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (knowledgeGptRes.ok) {
        const result = await knowledgeGptRes.json();
        aiContent = result.choices?.[0]?.message?.content || aiContent;
      } else {
        // knowledge-gptが失敗した場合、フォールバックで直接OpenAI APIを呼び出す
        console.error('knowledge-gpt failed, falling back to OpenAI:', await knowledgeGptRes.text());
        const completion = await openai.chat.completions.create({
          model: getFastLLMModel(),
          messages,
          max_completion_tokens: 2000,
          signal: AbortSignal.timeout(25000),
        } as any);
        aiContent = completion.choices[0]?.message?.content || aiContent;
      }
    } catch (kgError) {
      // タイムアウト・エラー時はエラーメッセージをそのままDBに書き込む
      const isTimeout = kgError instanceof Error && (kgError.name === 'TimeoutError' || kgError.name === 'AbortError');
      console.error(isTimeout ? 'knowledge-gpt timeout:' : 'knowledge-gpt error:', kgError);
      aiContent = 'すみません、応答の生成中にエラーが発生しました。しばらく待ってから再度お試しください。';
    }

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

    // ユーザーメッセージの重要度をAIに判断させる（非同期・バックグラウンド実行）
    // レスポンス時間を改善するため、重要度チェックはawaitしない
    const checkImportanceAsync = async () => {
      try {
        const importanceCheck = await openai.chat.completions.create({
          model: getFastLLMModel(),
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
          max_completion_tokens: 200,
          response_format: { type: 'json_object' },
        } as any);

        const importanceResult = JSON.parse(importanceCheck.choices[0]?.message?.content || '{}');
        if (importanceResult.isImportant) {
          await supabase
            .from('ai_consultation_messages')
            .update({
              is_important: true,
              importance_reason: importanceResult.reason || null,
              metadata: {
                ...savedUserMessage.metadata,
                autoMarked: true,
                category: importanceResult.category || null,
              },
            })
            .eq('id', savedUserMessage.id);
        }
      } catch (e) {
        console.error('Importance check failed (async):', e);
      }
    };

    // バックグラウンドで実行（awaitしない）
    checkImportanceAsync();

    // AI応答を保存
    const { data: savedAiMessage, error: aiMsgError } = await supabase
      .from('ai_consultation_messages')
      .insert({
        session_id: params.sessionId,
        role: 'assistant',
        content: aiContent.replace(/```action[\s\S]*?```/g, '').trim(),
        proposed_actions: proposedActions,
        tokens_used: null, // knowledge-gptではトークン数が取得できないのでnull
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
        isImportant: false, // 重要度チェックは非同期で後から更新される
        importanceReason: null,
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
