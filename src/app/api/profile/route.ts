import { createClient } from '@/lib/supabase/server'
import { createLogger, generateRequestId } from '@/lib/db-logger'
import { internalError } from '@/lib/api/errors'
import { NextResponse } from 'next/server'
import { fromUserProfile } from '@/lib/converter'
import { calculateNutritionTargets } from '@homegohan/core'
import { buildNutritionCalculatorInput } from '@/lib/build-nutrition-input'
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character'
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses'

/**
 * プロフィールAPI
 * 
 * 栄養目標に影響するフィールドの更新時は自動で再計算を行う
 * （auto_calculate=true のユーザーのみ）
 */

// 栄養目標の再計算をトリガーするフィールド
const NUTRITION_TRIGGER_FIELDS = [
  'age', 'gender', 'height', 'weight',
  'work_style', 'exercise_intensity', 'exercise_frequency', 'exercise_duration_per_session',
  'nutrition_goal', 'weight_change_rate',
  'health_conditions', 'medications', 'pregnancy_status',
];

// snake_case → camelCase のマッピング
const FIELD_MAP: Record<string, string> = {
  nutritionGoal: 'nutrition_goal',
  weightChangeRate: 'weight_change_rate',
  exerciseFrequency: 'exercise_frequency',
  exerciseIntensity: 'exercise_intensity',
  exerciseDurationPerSession: 'exercise_duration_per_session',
  workStyle: 'work_style',
  healthConditions: 'health_conditions',
  pregnancyStatus: 'pregnancy_status',
};

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (error) {
      return internalError('GET /api/profile', error, { userId: user.id, table: 'user_profiles' })
    }

    return NextResponse.json(data)
  } catch (error: unknown) {
    return internalError('GET /api/profile', error)
  }
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request)
  if (nullCharacterRejection) return nullCharacterRejection
  const requestId = generateRequestId()
  const logger = createLogger('POST /api/profile', requestId)
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 })
    }
    
    // マッピング
    const updates: Record<string, unknown> = {
      id: user.id,
      updated_at: new Date().toISOString(),
    };

    if (body.nickname) updates.nickname = body.nickname;
    if (body.gender) updates.gender = body.gender;
    if (body.lifestyle) updates.lifestyle = body.lifestyle;
    if (body.goal) updates.goal_text = body.goal;
    
    // 追加項目
    if (body.age) updates.age = parseInt(body.age);
    if (body.age) updates.age_group = `${Math.floor(parseInt(body.age) / 10) * 10}s`;
    if (body.occupation) updates.occupation = body.occupation;
    if (body.height) updates.height = parseFloat(body.height);
    if (body.weight) updates.weight = parseFloat(body.weight);

    // 栄養目標・運動関連
    if (body.nutritionGoal) updates.nutrition_goal = body.nutritionGoal;
    if (body.weightChangeRate) updates.weight_change_rate = body.weightChangeRate;
    if (body.exerciseTypes) updates.exercise_types = body.exerciseTypes;
    if (body.exerciseFrequency) updates.exercise_frequency = parseInt(body.exerciseFrequency);
    if (body.exerciseIntensity) updates.exercise_intensity = body.exerciseIntensity;
    if (body.exerciseDurationPerSession) updates.exercise_duration_per_session = parseInt(body.exerciseDurationPerSession);
    if (body.workStyle) updates.work_style = body.workStyle;
    if (body.healthConditions) updates.health_conditions = body.healthConditions;
    if (body.medications) updates.medications = body.medications;
    if (body.pregnancyStatus) updates.pregnancy_status = body.pregnancyStatus;
    if (body.fitnessGoals) updates.fitness_goals = body.fitnessGoals;
    if (body.dietFlags) updates.diet_flags = body.dietFlags;
    if (body.cookingExperience) updates.cooking_experience = body.cookingExperience;
    if (body.weekdayCookingMinutes) updates.weekday_cooking_minutes = parseInt(body.weekdayCookingMinutes);
    if (body.cuisinePreferences) updates.cuisine_preferences = body.cuisinePreferences;
    if (body.familySize) updates.family_size = parseInt(body.familySize);
    if (body.servingsConfig) updates.servings_config = body.servingsConfig;
    if (body.radarChartNutrients) updates.radar_chart_nutrients = body.radarChartNutrients;

    // デフォルト値の補完（必須カラムエラー回避）
    if (!updates.nickname) updates.nickname = 'Guest'; 
    if (!updates.age_group && !updates.age) updates.age_group = 'unspecified';
    if (!updates.gender) updates.gender = 'unspecified';

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert(updates)
      .select()
      .single()

    if (error) {
      return internalError('POST /api/profile', error, { userId: user.id, requestId, table: 'user_profiles' })
    }

    // 栄養目標に影響するフィールドが更新された場合、再計算を試みる
    const shouldRecalculate = checkShouldRecalculateNutrition(body);
    if (shouldRecalculate) {
      await recalculateNutritionTargetsIfNeeded(supabase, user.id, data, logger);
    }

    return NextResponse.json(data)
  } catch (error: unknown) {
    return internalError('POST /api/profile', error, { requestId })
  }
}

export async function PUT(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request)
  if (nullCharacterRejection) return nullCharacterRejection
  const requestId = generateRequestId()
  const logger = createLogger('PUT /api/profile', requestId)
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    // JSON としては読めてもオブジェクトでない本文 (null・配列・数・文字列) も 400 (#1917 の続き。null は下の body.age の読み出しで
    // 例外になり 500 に、配列は項目の無い更新になっていた)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }

    // fromUserProfile を使用して camelCase -> snake_case 変換
    const updates = fromUserProfile(body);

    // 年齢から年代を自動計算
    if (body.age && !body.ageGroup) {
      const age = typeof body.age === 'number' ? body.age : parseInt(String(body.age));
      if (!isNaN(age)) {
        updates.age_group = `${Math.floor(age / 10) * 10}s`;
      }
    }
    
    // プロファイル完成度を計算
    updates.profile_completeness = calculateProfileCompleteness(body);
    updates.last_profile_update = new Date().toISOString();

    const { data, error } = await supabase
      .from('user_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select()
      .single()

    if (error) {
      return internalError('PUT /api/profile', error, { userId: user.id, requestId, table: 'user_profiles' })
    }

    // 栄養目標に影響するフィールドが更新された場合、再計算を試みる
    const shouldRecalculate = checkShouldRecalculateNutrition(body);
    if (shouldRecalculate) {
      await recalculateNutritionTargetsIfNeeded(supabase, user.id, data, logger);
    }

    return NextResponse.json(data)
  } catch (error: unknown) {
    return internalError('PUT /api/profile', error, { requestId })
  }
}

/**
 * リクエストボディに栄養目標に影響するフィールドが含まれているかチェック
 */
function checkShouldRecalculateNutrition(body: Record<string, unknown>): boolean {
  for (const key of Object.keys(body)) {
    const snakeKey = FIELD_MAP[key] || key;
    if (NUTRITION_TRIGGER_FIELDS.includes(snakeKey)) {
      return true;
    }
  }
  return false;
}

/**
 * 栄養目標を再計算する（auto_calculate=true の場合のみ）
 */
async function recalculateNutritionTargetsIfNeeded(
  supabase: any,
  userId: string,
  profile: any,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    // 現在の栄養目標を取得
    const { data: targets } = await supabase
      .from('nutrition_targets')
      .select('auto_calculate')
      .eq('user_id', userId)
      .single();

    // auto_calculate=false（手動編集）の場合はスキップ
    if (targets && targets.auto_calculate === false) {
      return;
    }

    // 共通ヘルパーで入力を組み立て（4ルート一致保証）
    const calculatorInput = buildNutritionCalculatorInput(profile, userId);
    const { targetData } = calculateNutritionTargets(calculatorInput);

    // 既存レコードがあるか確認
    const { data: existing } = await supabase
      .from('nutrition_targets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (existing) {
      await supabase
        .from('nutrition_targets')
        .update(targetData)
        .eq('user_id', userId);
    } else {
      await supabase
        .from('nutrition_targets')
        .insert(targetData);
    }
  } catch (error) {
    // エラーはログのみ（プロフィール更新自体は成功させる）
    logger.error('Nutrition targets recalculation error', error);
  }
}

// プロファイル完成度を計算
function calculateProfileCompleteness(profile: any): number {
  const fields = [
    // 基本情報 (20%)
    { key: 'nickname', weight: 4 },
    { key: 'age', weight: 4 },
    { key: 'gender', weight: 4 },
    { key: 'height', weight: 4 },
    { key: 'weight', weight: 4 },
    
    // 目標 (15%)
    { key: 'goalText', weight: 5 },
    { key: 'fitnessGoals', weight: 5, isArray: true },
    { key: 'targetWeight', weight: 5 },
    
    // 仕事・生活 (15%)
    { key: 'occupation', weight: 5 },
    { key: 'workStyle', weight: 5 },
    { key: 'weeklyExerciseMinutes', weight: 5 },
    
    // 健康 (15%)
    { key: 'healthConditions', weight: 5, isArray: true },
    { key: 'sleepQuality', weight: 5 },
    { key: 'stressLevel', weight: 5 },
    
    // 食事制限 (15%)
    { key: 'dietFlags', weight: 5, isObject: true },
    { key: 'dietStyle', weight: 5 },
    { key: 'dislikedCookingMethods', weight: 5, isArray: true },
    
    // 調理環境 (10%)
    { key: 'cookingExperience', weight: 5 },
    { key: 'weekdayCookingMinutes', weight: 5 },
    
    // 嗜好 (10%)
    { key: 'cuisinePreferences', weight: 5, isObject: true },
    { key: 'favoriteIngredients', weight: 5, isArray: true },
  ];
  
  let totalWeight = 0;
  let earnedWeight = 0;
  
  for (const field of fields) {
    totalWeight += field.weight;
    const value = profile[field.key];
    
    if (field.isArray) {
      if (Array.isArray(value) && value.length > 0) {
        earnedWeight += field.weight;
      }
    } else if (field.isObject) {
      if (value && typeof value === 'object' && Object.keys(value).length > 0) {
        earnedWeight += field.weight;
      }
    } else {
      if (value !== null && value !== undefined && value !== '' && value !== 'unspecified') {
        earnedWeight += field.weight;
      }
    }
  }
  
  return Math.round((earnedWeight / totalWeight) * 100);
}
