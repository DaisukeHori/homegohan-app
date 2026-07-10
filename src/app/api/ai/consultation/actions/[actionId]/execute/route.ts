import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { TargetSlot } from '@/types/domain';
import {
  RECORD_DATE_PATTERN,
  sanitizeHealthGoalUpdate,
  sanitizeHealthRecordPayload,
  stripUndefined,
} from '@/lib/health-payloads';
import { updateHealthStreak } from '@/lib/health-streaks';
import { todayLocal } from '@/lib/date-utils';
import { invokeGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { loadFeatureFlags } from '@/lib/menu-generation-feature-flags';
import type { MealImageJobSeed } from '../../../../../../../lib/meal-image';
import {
  buildDishImagePayload,
  cancelPendingMealImageJobs,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../../../../lib/meal-image-jobs';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { createLogger } from '@/lib/db-logger';

// セキュリティ上禁止されたフィールド
const FORBIDDEN_PROFILE_FIELDS = ['email', 'avatar_url', 'is_banned', 'role', 'auth_provider'];

// #1048 F2-23: planned_meals.meal_type / meals.meal_type には
// CHECK (meal_type IN ('breakfast','lunch','dinner','snack')) が存在し、
// 'midnight_snack' を挿入すると DB 制約違反で 500 になる
// (supabase/migrations/20260430160000_db_audit_fixes.sql #221)。
// AI 生成アクション経由でこの不整合値が渡らないようホワイトリストで防御する。
const AI_ALLOWED_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

// ==================== mass assignment 対策: サニタイザ ====================
// AIが生成した action_params は信頼できない入力（プロンプトインジェクションの
// ターゲットになり得る）ため、DB更新に使用するキーは明示的なホワイトリストで
// 抽出し、非許可キーは fail-close で無条件に破棄する。

type PlainRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// nutrition_targets: daily_calories/protein_g/fat_g/carbs_g/fiber_g/sodium_g のみ許可。
// 範囲は DRI2020 の目標量レンジ（packages/core/src/nutrition/dri-tables.ts, calculate.ts）
// を大きく上回らない程度で、かつユーザーが自由に設定し得る範囲を許容する上限とした。
const NUTRITION_TARGET_RANGES: Record<string, { min: number; max: number }> = {
  daily_calories: { min: 500, max: 6000 },
  protein_g: { min: 0, max: 500 },
  fat_g: { min: 0, max: 300 },
  carbs_g: { min: 0, max: 800 },
  fiber_g: { min: 0, max: 100 },
  sodium_g: { min: 0, max: 30 },
};

function sanitizeNutritionTargetUpdate(input: unknown): { data: Record<string, number>; errors: string[] } {
  const data: Record<string, number> = {};
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { data, errors: ['targets must be an object'] };
  }

  for (const [key, range] of Object.entries(NUTRITION_TARGET_RANGES)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (!isFiniteNumber(value)) {
      errors.push(`${key} must be a finite number`);
      continue;
    }
    if (value < range.min || value > range.max) {
      errors.push(`${key} は ${range.min} 〜 ${range.max} の範囲で指定してください`);
      continue;
    }
    data[key] = value;
  }

  return { data, errors };
}

// planned_meals の update_meal: システムプロンプトで AI に許可しているフィールド
// （dish_name/calories_kcal/protein_g/fat_g/carbs_g/memo/mode/dishes）に加え、
// 既存コードが個別に参照している image_url のみ許可する。
function sanitizeMealUpdate(input: unknown): { data: PlainRecord; errors: string[] } {
  const data: PlainRecord = {};
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { data, errors: ['updates must be an object'] };
  }

  if (Object.prototype.hasOwnProperty.call(input, 'dish_name')) {
    const value = input.dish_name;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 200) {
      data.dish_name = value;
    } else {
      errors.push('dish_name must be a non-empty string (max 200 chars)');
    }
  }

  const numericFieldRanges: Record<string, { min: number; max: number }> = {
    calories_kcal: { min: 0, max: 5000 },
    protein_g: { min: 0, max: 500 },
    fat_g: { min: 0, max: 300 },
    carbs_g: { min: 0, max: 800 },
  };
  for (const [key, range] of Object.entries(numericFieldRanges)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (!isFiniteNumber(value) || value < range.min || value > range.max) {
      errors.push(`${key} は ${range.min} 〜 ${range.max} の範囲の数値で指定してください`);
      continue;
    }
    data[key] = value;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'memo')) {
    const value = input.memo;
    if (value === null) {
      data.memo = null;
    } else if (typeof value === 'string' && value.length <= 1000) {
      data.memo = value;
    } else {
      errors.push('memo must be a string (max 1000 chars) or null');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'mode')) {
    const value = input.mode;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 50) {
      data.mode = value;
    } else {
      errors.push('mode must be a non-empty string (max 50 chars)');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'dishes')) {
    const value = input.dishes;
    if (Array.isArray(value)) {
      data.dishes = value;
    } else {
      errors.push('dishes must be an array');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'image_url')) {
    const value = input.image_url;
    if (typeof value === 'string') {
      data.image_url = value;
    } else {
      errors.push('image_url must be a string');
    }
  }

  return { data, errors };
}

// shopping_list_items の update_shopping_item: システムプロンプトで AI に許可
// している item_name/quantity/category のみ許可する。
function sanitizeShoppingItemUpdate(input: unknown): { data: PlainRecord; errors: string[] } {
  const data: PlainRecord = {};
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { data, errors: ['updates must be an object'] };
  }

  if (Object.prototype.hasOwnProperty.call(input, 'item_name')) {
    const value = input.item_name;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 200) {
      data.item_name = value;
    } else {
      errors.push('item_name must be a non-empty string (max 200 chars)');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'quantity')) {
    const value = input.quantity;
    if (value === null) {
      data.quantity = null;
    } else if (typeof value === 'string' && value.length <= 100) {
      data.quantity = value;
    } else {
      errors.push('quantity must be a string (max 100 chars) or null');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'category')) {
    const value = input.category;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 100) {
      data.category = value;
    } else {
      errors.push('category must be a non-empty string (max 100 chars)');
    }
  }

  return { data, errors };
}

// 指定日付の user_daily_meals を取得または作成するヘルパー関数
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

// ユーザーのアクティブな買い物リストを取得または作成するヘルパー関数
async function getOrCreateActiveShoppingList(supabase: any, userId: string): Promise<{ id: string } | null> {
  // アクティブな買い物リストを探す
  let { data: shoppingList, error } = await supabase
    .from('shopping_lists')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) return null;
  if (shoppingList) return shoppingList;

  // なければ新規作成
  const today = new Date().toISOString().slice(0, 10);
  const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: newList, error: createError } = await supabase
    .from('shopping_lists')
    .insert({
      user_id: userId,
      status: 'active',
      name: '買い物リスト',
      start_date: today,
      end_date: weekLater,
    })
    .select('id')
    .single();

  if (createError) return null;
  return newList;
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

    let result: any = null;
    let success = false;

    // V5フラグ判定
    const featureFlags = await loadFeatureFlags(supabase);
    const useV5 = Boolean(featureFlags.menu_generation_v5_wrapped);
    const engineLabel = useV5 ? 'generate-menu-v5' : 'generate-menu-v4';

    // アクションタイプに応じて実行
    switch (action.action_type) {
      // ==================== 献立関連 ====================
      case 'generate_day_menu': {
        // 1日分の献立を生成（generate-menu-v4を使用）
        const { date, ultimateMode } = action.action_params;

        if (!date) {
          result = { error: 'date は必須です' };
          break;
        }

        // 1日分のスロット（朝・昼・夜）を生成
        const targetSlots = await resolveExistingTargetSlots({
          supabase,
          userId: user.id,
          targetSlots: [
            { date, mealType: 'breakfast' },
            { date, mealType: 'lunch' },
            { date, mealType: 'dinner' },
          ],
        });

        // リクエストを記録
        const { data: requestData, error: requestError } = await supabase
          .from('weekly_menu_requests')
          .insert({
            user_id: user.id,
            start_date: date,
            mode: engineLabel.replace('generate-menu-', ''),
            status: 'processing',
            target_slots: targetSlots.map((s) => ({
              date: s.date,
              meal_type: s.mealType,
              planned_meal_id: s.plannedMealId,
            })),
            progress: {
              currentStep: 0,
              totalSteps: 3,
              message: '1日分の献立を生成中...',
            },
          })
          .select('id')
          .single();

        if (requestError) {
          console.error('Failed to create request:', requestError);
          result = { error: 'リクエストの作成に失敗しました' };
          break;
        }

        // ユーザープロフィールから家族人数を取得
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('family_size')
          .eq('id', user.id)
          .single();

        const invokeResult = await invokeGenerateMenuV4WithRetry({
          invoke: () => supabase.functions.invoke(engineLabel, {
            body: {
              userId: user.id,
              requestId: requestData.id,
              targetSlots,
              existingMenus: [],
              fridgeItems: [],
              userProfile: {},
              seasonalContext: {},
              constraints: {},
              familySize: profile?.family_size || 1,
              ultimateMode: ultimateMode ?? false,
            },
          }),
        });

        if (!invokeResult.ok) {
          console.error(`Failed to invoke ${engineLabel}:`, invokeResult.errorMessage);
          await markWeeklyMenuRequestFailed({
            supabase,
            requestId: requestData.id,
            errorMessage: invokeResult.errorMessage,
          });
        }

        success = invokeResult.ok;
        result = { date, requestId: requestData.id, status: success ? 'processing' : 'failed' };
        break;
      }

      case 'generate_week_menu': {
        // 1週間分の献立を生成
        const { startDate, ultimateMode } = action.action_params;

        if (!startDate) {
          result = { error: 'startDate は必須です' };
          break;
        }

        // 1週間分のスロットを生成
        const baseTargetSlots: TargetSlot[] = [];
        const start = new Date(startDate);
        for (let i = 0; i < 7; i++) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const dateStr = d.toISOString().split('T')[0];
          baseTargetSlots.push({ date: dateStr, mealType: 'breakfast' });
          baseTargetSlots.push({ date: dateStr, mealType: 'lunch' });
          baseTargetSlots.push({ date: dateStr, mealType: 'dinner' });
        }
        const targetSlots = await resolveExistingTargetSlots({
          supabase,
          userId: user.id,
          targetSlots: baseTargetSlots,
        });

        // リクエストを記録
        const { data: requestData, error: requestError } = await supabase
          .from('weekly_menu_requests')
          .insert({
            user_id: user.id,
            start_date: startDate,
            mode: engineLabel.replace('generate-menu-', ''),
            status: 'processing',
            target_slots: targetSlots.map((s) => ({
              date: s.date,
              meal_type: s.mealType,
              planned_meal_id: s.plannedMealId,
            })),
            progress: {
              currentStep: 0,
              totalSteps: 21,
              message: '1週間分の献立を生成中...',
            },
          })
          .select('id')
          .single();

        if (requestError) {
          console.error('Failed to create request:', requestError);
          result = { error: 'リクエストの作成に失敗しました' };
          break;
        }

        // ユーザープロフィールから家族人数を取得
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('family_size')
          .eq('id', user.id)
          .single();

        const invokeResult = await invokeGenerateMenuV4WithRetry({
          invoke: () => supabase.functions.invoke(engineLabel, {
            body: {
              userId: user.id,
              requestId: requestData.id,
              targetSlots,
              existingMenus: [],
              fridgeItems: [],
              userProfile: {},
              seasonalContext: {},
              constraints: {},
              familySize: profile?.family_size || 1,
              ultimateMode: ultimateMode ?? false,
            },
          }),
        });

        if (!invokeResult.ok) {
          console.error(`Failed to invoke ${engineLabel}:`, invokeResult.errorMessage);
          await markWeeklyMenuRequestFailed({
            supabase,
            requestId: requestData.id,
            errorMessage: invokeResult.errorMessage,
          });
        }

        success = invokeResult.ok;
        result = { startDate, requestId: requestData.id, status: success ? 'processing' : 'failed' };
        break;
      }

      case 'generate_single_meal': {
        // AIが栄養計算付きで1食を生成
        const {
          date,
          mealType,
          specificDish,
          recipeId,           // レシピDBのUUID（search_recipesで取得）
          recipeExternalId,   // レシピDBの外部ID
          excludeIngredients,
          preferIngredients,
          note,
          ultimateMode
        } = action.action_params;

        if (!date || !mealType) {
          result = { error: 'date と mealType は必須です' };
          break;
        }

        // #1048 F2-23: DB CHECK 制約と矛盾する mealType(例: 'midnight_snack')を
        // 拒否する。プロンプトからは既に除去済みだが、AI 出力は信頼できないため
        // 実行時にも二重で防御する。
        if (!AI_ALLOWED_MEAL_TYPES.includes(mealType)) {
          result = { error: `mealType は ${AI_ALLOWED_MEAL_TYPES.join('/')} のいずれかである必要があります` };
          break;
        }

        const targetSlots = await resolveExistingTargetSlots({
          supabase,
          userId: user.id,
          targetSlots: [{ date, mealType }],
        });

        // 1. weekly_menu_requests に記録
        const { data: requestData, error: requestError } = await supabase
          .from('weekly_menu_requests')
          .insert({
            user_id: user.id,
            start_date: date,
            mode: engineLabel.replace('generate-menu-', ''),
            status: 'processing',
            target_slots: targetSlots.map((slot) => ({
              date: slot.date,
              meal_type: slot.mealType,
              planned_meal_id: slot.plannedMealId,
            })),
            constraints: { specificDish, recipeId, recipeExternalId, excludeIngredients, preferIngredients },
            prompt: note || '',
            progress: {
              currentStep: 0,
              totalSteps: 1,
              message: '献立を生成中...',
            },
          })
          .select('id')
          .single();

        if (requestError) {
          console.error('Failed to create request:', requestError);
          result = { error: 'リクエストの作成に失敗しました' };
          break;
        }

        // 2. ユーザープロフィールから家族人数を取得
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('family_size')
          .eq('id', user.id)
          .single();
        const familySize = profile?.family_size || 1;

        // 3. Edge Functionを呼び出し
        const invokeResult = await invokeGenerateMenuV4WithRetry({
          invoke: () => supabase.functions.invoke(engineLabel, {
            body: {
              userId: user.id,
              requestId: requestData.id,
              targetSlots,
              existingMenus: [], // v4内部で取得
              fridgeItems: [], // v4内部で取得
              userProfile: {}, // v4内部で取得
              seasonalContext: {}, // v4内部で計算
              constraints: {
                specificDish,
                recipeId,
                recipeExternalId,
                excludeIngredients,
                preferIngredients,
              },
              note,
              familySize,
              ultimateMode: ultimateMode ?? false,
            },
          }),
        });

        if (!invokeResult.ok) {
          console.error('Failed to invoke generate-menu-v4:', invokeResult.errorMessage);
          await markWeeklyMenuRequestFailed({
            supabase,
            requestId: requestData.id,
            errorMessage: invokeResult.errorMessage,
          });
          result = { error: '献立生成の開始に失敗しました' };
          break;
        }

        success = true;
        result = {
          requestId: requestData.id,
          status: 'processing',
          message: `${date}の${mealType}を生成中...`,
        };
        break;
      }

      case 'update_meal': {
        const { mealId, updates } = action.action_params;
        console.log('update_meal action:', { mealId, updates });
        
        if (!mealId) {
          result = { error: 'mealIdが指定されていません' };
          break;
        }
        
        // セキュリティ: 自分の献立のみ更新可能 (user_daily_meals JOIN 経由でユーザー確認)
        const { data: meal, error: mealFetchError } = await supabase
          .from('planned_meals')
          .select('id, dish_name, dishes, image_url, user_daily_meals!inner(user_id)')
          .eq('id', mealId)
          .eq('user_daily_meals.user_id', user.id)
          .maybeSingle();

        if (mealFetchError) {
          console.error('Failed to fetch meal for update:', mealFetchError);
          result = { error: `食事の取得に失敗: ${mealFetchError.message}` };
          break;
        }

        if (!meal) {
          result = { error: '権限がありません' };
          break;
        }

        // mass assignment対策: 許可キーのみ抽出（プロンプトインジェクション経由の任意列書き込みを防止）
        const { data: safeMealUpdates, errors: mealUpdateErrors } = sanitizeMealUpdate(updates);
        if (mealUpdateErrors.length > 0) {
          result = { error: mealUpdateErrors.join(', ') };
          break;
        }
        if (Object.keys(safeMealUpdates).length === 0) {
          result = { error: '更新可能な項目がありません' };
          break;
        }

        // updated_atを明示的に追加
        const updateData: Record<string, any> = {
          ...safeMealUpdates,
          updated_at: new Date().toISOString(),
        };

        // dishesの処理
        if (safeMealUpdates.dishes && Array.isArray(safeMealUpdates.dishes) && safeMealUpdates.dishes.length > 0) {
          // AIからdishes配列が提供された場合はそのまま使用
          updateData.dishes = safeMealUpdates.dishes;
          updateData.is_simple = safeMealUpdates.dishes.length === 1;
          console.log('Using AI-provided dishes:', safeMealUpdates.dishes);
        }

        const triggerSource = `consultation:update_meal:${action.id}`;
        const manualImageUrl = typeof safeMealUpdates.image_url === 'string' ? safeMealUpdates.image_url : undefined;
        const hasImageManagedDishes =
          (Array.isArray(meal.dishes) && meal.dishes.length > 0) ||
          (Array.isArray(updateData.dishes) && updateData.dishes.length > 0);
        let jobs: MealImageJobSeed[] = [];

        if (hasImageManagedDishes) {
          const { dishes: reconciledDishes, jobs: nextJobs, mealCoverImageUrl } = await buildDishImagePayload({
            previousDishes: Array.isArray(meal.dishes) ? meal.dishes : null,
            nextDishes: updateData.dishes ?? undefined,
            dishName: updateData.dish_name ?? undefined,
            triggerSource,
            imageUrlOverride: manualImageUrl,
            imageModel: process.env.GEMINI_IMAGE_MODEL ?? undefined,
            existingCover: meal.image_url ?? null,
            fallbackMealImageUrl: meal.image_url ?? null,
          });
          updateData.dishes = reconciledDishes;
          updateData.image_url = mealCoverImageUrl;
          jobs = nextJobs;
        } else if (safeMealUpdates.image_url !== undefined) {
          updateData.image_url = safeMealUpdates.image_url;
        }

        const { data: updatedMeal, error: updateError } = await supabase
          .from('planned_meals')
          .update(updateData)
          .eq('id', mealId)
          .select('id, dish_name, calories_kcal, dishes')
          .single();
        
        if (updateError) {
          console.error('Failed to update meal:', updateError);
          result = { error: `更新に失敗: ${updateError.message}` };
          break;
        }

        let imageGenerationThrottled = false;
        if (jobs.length > 0) {
          // #1022 execute の update_meal も他の4 meal route と同じく image カテゴリで制限する
          // （relayチャットの連打で image の1min/20day上限をバイパスされないようにする）。
          // 画像副作用（enqueue + trigger）は update_meal 本体の成否から独立させる（詳細は meals/route.ts 参照）。
          let imageAllowed = false;
          try {
            const rl = await checkRateLimit(user.id, 'image');
            imageAllowed = rl.success;
          } catch (rlError) {
            createLogger('api/ai/consultation/actions/execute').warn(
              'Image rate-limit check failed; skipping image generation',
              {
                userId: user.id,
                plannedMealId: mealId,
                error: rlError instanceof Error ? rlError.message : String(rlError),
              },
            );
            imageAllowed = false;
          }

          if (imageAllowed) {
            await enqueueMealImageJobs({
              supabase,
              plannedMealId: mealId,
              userId: user.id,
              triggerSource,
              jobSeeds: jobs,
              requestId: action.id,
            });
            await triggerMealImageJobProcessing({ plannedMealId: mealId, limit: jobs.length });
          } else {
            imageGenerationThrottled = true;
            console.warn('[consultation/actions/execute] Image generation skipped due to rate limit', {
              userId: user.id,
              plannedMealId: mealId,
            });
          }
        }

        console.log('Meal updated successfully:', updatedMeal);
        success = true;
        result = {
          mealId,
          updated: true,
          newDishName: updatedMeal?.dish_name,
          // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
          ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
        };
        break;
      }

      case 'delete_meal': {
        const { mealId } = action.action_params;
        // セキュリティチェック - user_daily_meals JOIN 経由でユーザー確認
        const { data: meal } = await supabase
          .from('planned_meals')
          .select('id, user_daily_meals!inner(user_id)')
          .eq('id', mealId)
          .eq('user_daily_meals.user_id', user.id)
          .maybeSingle();

        if (!meal) {
          result = { error: '権限がありません' };
          break;
        }

        await cancelPendingMealImageJobs({
          supabase,
          plannedMealId: mealId,
          reason: 'meal deleted',
        });

        const { error: deleteError } = await supabase
          .from('planned_meals')
          .delete()
          .eq('id', mealId);
        success = !deleteError;
        result = { mealId, deleted: success };
        break;
      }

      case 'complete_meal': {
        const { mealId, isCompleted } = action.action_params;
        // セキュリティチェック - user_daily_meals JOIN 経由でユーザー確認
        const { data: meal } = await supabase
          .from('planned_meals')
          .select('id, user_daily_meals!inner(user_id)')
          .eq('id', mealId)
          .eq('user_daily_meals.user_id', user.id)
          .maybeSingle();

        if (!meal) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('planned_meals')
          .update({ is_completed: isCompleted !== false })
          .eq('id', mealId);
        success = !updateError;
        result = { mealId, completed: isCompleted !== false };
        break;
      }

      // ==================== 買い物リスト関連 ====================
      case 'add_to_shopping_list': {
        const { items } = action.action_params;
        
        // アクティブな買い物リストを取得または作成
        const shoppingList = await getOrCreateActiveShoppingList(supabase, user.id);
        if (!shoppingList) {
          result = { error: '買い物リストの作成に失敗しました' };
          break;
        }

        if (items?.length > 0) {
          const insertData = items.map((item: any) => ({
            shopping_list_id: shoppingList.id,
            item_name: item.name,
            normalized_name: item.name, // 手動追加は item_name をそのまま使用
            quantity: item.quantity,
            quantity_variants: item.quantity ? [{ display: item.quantity, unit: '', value: null }] : [],
            selected_variant_index: 0,
            source: 'manual',
            category: item.category || 'その他',
            is_checked: false,
          }));
          const { error: insertError } = await supabase
            .from('shopping_list_items')
            .insert(insertData);
          success = !insertError;
        }
        result = { itemsAdded: items?.length || 0 };
        break;
      }

      case 'update_shopping_item': {
        const { itemId, updates } = action.action_params;
        // セキュリティチェック - shopping_lists経由でuser_idを確認
        const { data: item } = await supabase
          .from('shopping_list_items')
          .select('shopping_list_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: shoppingList } = await supabase
            .from('shopping_lists')
            .select('user_id')
            .eq('id', item.shopping_list_id)
            .single();
          
          if (!shoppingList || shoppingList.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        // mass assignment対策: 許可キーのみ抽出（プロンプトインジェクション経由の任意列書き込みを防止）
        const { data: safeShoppingItemUpdates, errors: shoppingItemUpdateErrors } = sanitizeShoppingItemUpdate(updates);
        if (shoppingItemUpdateErrors.length > 0) {
          result = { error: shoppingItemUpdateErrors.join(', ') };
          break;
        }
        if (Object.keys(safeShoppingItemUpdates).length === 0) {
          result = { error: '更新可能な項目がありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('shopping_list_items')
          .update(safeShoppingItemUpdates)
          .eq('id', itemId);
        success = !updateError;
        result = { itemId, updated: success };
        break;
      }

      case 'delete_shopping_item': {
        const { itemId } = action.action_params;
        // セキュリティチェック - shopping_lists経由でuser_idを確認
        const { data: item } = await supabase
          .from('shopping_list_items')
          .select('shopping_list_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: shoppingList } = await supabase
            .from('shopping_lists')
            .select('user_id')
            .eq('id', item.shopping_list_id)
            .single();
          
          if (!shoppingList || shoppingList.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('shopping_list_items')
          .delete()
          .eq('id', itemId);
        success = !deleteError;
        result = { itemId, deleted: success };
        break;
      }

      case 'check_shopping_item': {
        const { itemId, isChecked } = action.action_params;
        // セキュリティチェック - shopping_lists経由でuser_idを確認
        const { data: item } = await supabase
          .from('shopping_list_items')
          .select('shopping_list_id')
          .eq('id', itemId)
          .single();

        if (item) {
          const { data: shoppingList } = await supabase
            .from('shopping_lists')
            .select('user_id')
            .eq('id', item.shopping_list_id)
            .single();
          
          if (!shoppingList || shoppingList.user_id !== user.id) {
            result = { error: '権限がありません' };
            break;
          }
        } else {
          result = { error: 'アイテムが見つかりません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('shopping_list_items')
          .update({ is_checked: isChecked !== false })
          .eq('id', itemId);
        success = !updateError;
        result = { itemId, checked: isChecked !== false };
        break;
      }

      // ==================== 冷蔵庫/パントリー関連 ====================
      // pantry_itemsはuser_idで紐づく（meal_plan_idではない）
      // カラム: name, amount, category, expiration_date
      case 'add_pantry_item': {
        const { name, amount, category, expirationDate } = action.action_params;
        
        const { data: newItem, error: insertError } = await supabase
          .from('pantry_items')
          .insert({
            user_id: user.id,
            name,
            amount: amount || null,
            category: category || 'other',
            expiration_date: expirationDate || null,
          })
          .select('id')
          .single();
        success = !insertError;
        result = { itemId: newItem?.id, created: success };
        if (insertError) {
          console.error('add_pantry_item error:', insertError);
          result = { error: insertError.message };
        }
        break;
      }

      case 'update_pantry_item': {
        const { itemId, updates } = action.action_params;
        // セキュリティチェック - user_idで確認
        const { data: item } = await supabase
          .from('pantry_items')
          .select('user_id')
          .eq('id', itemId)
          .single();

        if (!item) {
          result = { error: 'アイテムが見つかりません' };
          break;
        }
        
        if (item.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        // カラム名をDBスキーマに合わせて変換
        const dbUpdates: any = {};
        if (updates.name !== undefined) dbUpdates.name = updates.name;
        if (updates.amount !== undefined) dbUpdates.amount = updates.amount;
        if (updates.category !== undefined) dbUpdates.category = updates.category;
        if (updates.expirationDate !== undefined) dbUpdates.expiration_date = updates.expirationDate;
        // 後方互換性のため古いパラメータ名もサポート
        if (updates.item_name !== undefined) dbUpdates.name = updates.item_name;
        if (updates.quantity !== undefined) dbUpdates.amount = updates.quantity;
        if (updates.expiry_date !== undefined) dbUpdates.expiration_date = updates.expiry_date;

        const { error: updateError } = await supabase
          .from('pantry_items')
          .update(dbUpdates)
          .eq('id', itemId);
        success = !updateError;
        result = { itemId, updated: success };
        if (updateError) {
          console.error('update_pantry_item error:', updateError);
          result = { error: updateError.message };
        }
        break;
      }

      case 'delete_pantry_item': {
        const { itemId } = action.action_params;
        // セキュリティチェック - user_idで確認
        const { data: item } = await supabase
          .from('pantry_items')
          .select('user_id')
          .eq('id', itemId)
          .single();

        if (!item) {
          result = { error: 'アイテムが見つかりません' };
          break;
        }
        
        if (item.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('pantry_items')
          .delete()
          .eq('id', itemId);
        success = !deleteError;
        result = { itemId, deleted: success };
        if (deleteError) {
          console.error('delete_pantry_item error:', deleteError);
          result = { error: deleteError.message };
        }
        break;
      }

      // ==================== レシピ関連 ====================
      case 'suggest_recipe': {
        const { keywords, cuisineType } = action.action_params;
        let query = supabase
          .from('recipes')
          .select('id, name, description, image_url, cooking_time_minutes')
          .eq('is_public', true);
        
        if (keywords) {
          query = query.ilike('name', `%${keywords}%`);
        }
        if (cuisineType) {
          query = query.eq('cuisine_type', cuisineType);
        }

        const { data: recipes, error: recipeError } = await query.limit(5);
        success = !recipeError;
        result = { recipes: recipes || [] };
        break;
      }

      case 'like_recipe': {
        const { recipeId } = action.action_params;
        
        // 既にいいね済みかチェック
        const { data: existing } = await supabase
          .from('recipe_likes')
          .select('id')
          .eq('recipe_id', recipeId)
          .eq('user_id', user.id)
          .single();

        if (existing) {
          result = { alreadyLiked: true };
          success = true;
        } else {
          const { error: insertError } = await supabase
            .from('recipe_likes')
            .insert({ recipe_id: recipeId, user_id: user.id });
          success = !insertError;
          result = { liked: success };
        }
        break;
      }

      case 'add_recipe_to_collection': {
        const { recipeId, collectionName } = action.action_params;
        
        // コレクションを取得または作成
        let { data: collection } = await supabase
          .from('recipe_collections')
          .select('id')
          .eq('user_id', user.id)
          .eq('name', collectionName || 'お気に入り')
          .single();

        if (!collection) {
          const { data: newCollection } = await supabase
            .from('recipe_collections')
            .insert({
              user_id: user.id,
              name: collectionName || 'お気に入り',
            })
            .select('id')
            .single();
          collection = newCollection;
        }

        if (collection) {
          const { error: updateError } = await supabase
            .from('recipe_collections')
            .update({
              recipe_ids: supabase.rpc('array_append_unique', {
                arr: [],
                elem: recipeId,
              }),
            })
            .eq('id', collection.id);
          // 簡易的に配列に追加（RPCがない場合の代替）
          const { data: currentCollection } = await supabase
            .from('recipe_collections')
            .select('recipe_ids')
            .eq('id', collection.id)
            .single();
          
          const currentIds = currentCollection?.recipe_ids || [];
          if (!currentIds.includes(recipeId)) {
            const { error: appendError } = await supabase
              .from('recipe_collections')
              .update({ recipe_ids: [...currentIds, recipeId] })
              .eq('id', collection.id);
            success = !appendError;
          } else {
            success = true;
          }
          result = { collectionId: collection.id, added: success };
        }
        break;
      }

      // ==================== 栄養目標関連 ====================
      case 'update_nutrition_target': {
        const { targets } = action.action_params;
        // mass assignment対策: 許可キーのみ抽出し、user_idはspreadの後に固定して
        // targets.user_id による上書き（他人の栄養目標の改ざん）を防止する
        const { data: safeTargets, errors: targetErrors } = sanitizeNutritionTargetUpdate(targets);
        if (targetErrors.length > 0) {
          result = { error: targetErrors.join(', ') };
          break;
        }
        if (Object.keys(safeTargets).length === 0) {
          result = { error: '更新可能な栄養目標項目がありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('nutrition_targets')
          .upsert({
            ...safeTargets,
            user_id: user.id,
          }, { onConflict: 'user_id' });
        success = !updateError;
        result = { updated: success };
        break;
      }

      // ==================== 健康目標関連 ====================
      // health_goalsカラム: note (descriptionではない)
      case 'set_health_goal': {
        const { goalType, targetValue, targetUnit, targetDate, note, description } = action.action_params;
        const { data: newGoal, error: insertError } = await supabase
          .from('health_goals')
          .insert({
            user_id: user.id,
            goal_type: goalType,
            target_value: targetValue,
            target_unit: targetUnit,
            target_date: targetDate,
            note: note || description, // 後方互換性のためdescriptionもサポート
            status: 'active',
          })
          .select('id')
          .single();
        success = !insertError;
        if (insertError) {
          console.error('set_health_goal error:', insertError);
          result = { error: insertError.message };
        } else {
          result = { goalId: newGoal?.id, created: success };
        }
        break;
      }

      case 'update_health_goal': {
        const { goalId, updates } = action.action_params;
        // セキュリティチェック
        const { data: goal } = await supabase
          .from('health_goals')
          .select('user_id')
          .eq('id', goalId)
          .single();

        if (!goal || goal.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { data: safeUpdates, errors } = sanitizeHealthGoalUpdate(updates);
        if (errors.length > 0) {
          result = { error: errors.join(', ') };
          break;
        }
        if (Object.keys(safeUpdates).length === 0) {
          result = { error: '更新可能な目標項目がありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('health_goals')
          .update(safeUpdates)
          .eq('id', goalId);
        success = !updateError;
        result = { goalId, updated: success };
        break;
      }

      case 'delete_health_goal': {
        const { goalId } = action.action_params;
        // セキュリティチェック
        const { data: goal } = await supabase
          .from('health_goals')
          .select('user_id')
          .eq('id', goalId)
          .single();

        if (!goal || goal.user_id !== user.id) {
          result = { error: '権限がありません' };
          break;
        }

        const { error: deleteError } = await supabase
          .from('health_goals')
          .delete()
          .eq('id', goalId);
        success = !deleteError;
        result = { goalId, deleted: success };
        break;
      }

      // ==================== 健康記録関連 ====================
      // health_recordsカラム: daily_note (notesではない)
      case 'add_health_record': {
        const { date, weight, bodyFatPercentage, systolicBp, diastolicBp, sleepHours,
                overallCondition, moodScore, stressLevel, stepCount, dailyNote, notes } = action.action_params;

        const recordDate = typeof date === 'string' && date.trim() ? date.trim() : todayLocal();
        if (!RECORD_DATE_PATTERN.test(recordDate)) {
          result = { error: 'date must be in YYYY-MM-DD format' };
          break;
        }

        // #1048 F2-08: AI が生成した値をそのまま保存すると、レンジ検証（体重の異常値等）や
        // streak・user_profiles 同期がバイパスされる（update_health_record は既に
        // sanitizeHealthRecordPayload を通しているが、こちらは未対応だった）。
        // stripUndefined で未送信キーを除去してから既存のサニタイザに通す。
        const { data: safeRecord, errors: recordErrors } = sanitizeHealthRecordPayload(
          stripUndefined({
            weight,
            body_fat_percentage: bodyFatPercentage,
            systolic_bp: systolicBp,
            diastolic_bp: diastolicBp,
            sleep_hours: sleepHours,
            overall_condition: overallCondition,
            mood_score: moodScore,
            stress_level: stressLevel,
            step_count: stepCount,
            daily_note: dailyNote,
            notes,
          }),
          { acceptLegacyNotes: true },
        );

        if (recordErrors.length > 0) {
          result = { error: recordErrors.join(', ') };
          break;
        }
        if (Object.keys(safeRecord).length === 0) {
          result = { error: '保存可能な健康記録項目がありません' };
          break;
        }

        // 既存レコードがあればupsert
        const { error: upsertError } = await supabase
          .from('health_records')
          .upsert({
            user_id: user.id,
            record_date: recordDate,
            ...safeRecord,
          }, { onConflict: 'user_id,record_date' });
        success = !upsertError;
        if (upsertError) {
          console.error('add_health_record error:', upsertError);
          result = { error: upsertError.message };
        } else {
          // #1048 F2-08: update_health_record 同様、streak・user_profiles も同期する
          await updateHealthStreak(supabase, user.id, recordDate);
          if (typeof safeRecord.weight === 'number') {
            const today = todayLocal();
            if (recordDate === today) {
              await supabase
                .from('user_profiles')
                .update({ weight: safeRecord.weight })
                .eq('id', user.id);
            }
          }
          result = { date: recordDate, saved: success };
        }
        break;
      }

      case 'update_health_record': {
        const { date, updates } = action.action_params;
        const { data: safeUpdates, errors } = sanitizeHealthRecordPayload(updates, {
          acceptLegacyNotes: true,
        });
        if (errors.length > 0) {
          result = { error: errors.join(', ') };
          break;
        }
        if (Object.keys(safeUpdates).length === 0) {
          result = { error: '更新可能な健康記録項目がありません' };
          break;
        }

        // セキュリティチェック（user_idで自動的に制限）
        const { error: updateError } = await supabase
          .from('health_records')
          .update(safeUpdates)
          .eq('user_id', user.id)
          .eq('record_date', date);
        success = !updateError;
        result = { date, updated: success };
        break;
      }

      // ==================== プロフィール関連（制限付き） ====================
      case 'update_profile_preferences': {
        const { updates } = action.action_params;
        
        // 禁止フィールドを除外
        const safeUpdates: Record<string, any> = {};
        const allowedFields = [
          'nickname', 'age', 'gender', 'height', 'weight', 'target_weight',
          'body_fat_percentage', 'target_body_fat', 'muscle_mass',
          'health_conditions', 'medications', 'fitness_goals',
          'sleep_quality', 'stress_level', 'bowel_movement', 'skin_condition',
          'cold_sensitivity', 'swelling_prone',
          'occupation', 'industry', 'work_style', 'desk_hours_per_day',
          'overtime_frequency', 'business_trip_frequency', 'entertainment_frequency',
          'weekly_exercise_minutes', 'exercise_types',
          'diet_style', 'religious_restrictions', 'diet_flags',
          'cuisine_preferences', 'taste_preferences', 'favorite_ingredients', 'favorite_dishes',
          'cooking_experience', 'specialty_cuisines', 'disliked_cooking',
          'weekday_cooking_minutes', 'weekend_cooking_minutes',
          'meal_prep_ok', 'kitchen_appliances',
          'wake_time', 'sleep_time', 'meal_times',
          'snacking_habit', 'alcohol_frequency', 'smoking', 'caffeine_intake', 'daily_water_ml',
          'family_size', 'has_children', 'children_ages', 'has_elderly',
          'weekly_food_budget', 'shopping_frequency', 'preferred_stores',
          'online_grocery', 'organic_preference',
          'hobbies', 'weekend_activity', 'outdoor_activities',
        ];

        for (const key of Object.keys(updates)) {
          if (allowedFields.includes(key) && !FORBIDDEN_PROFILE_FIELDS.includes(key)) {
            safeUpdates[key] = updates[key];
          }
        }

        if (Object.keys(safeUpdates).length === 0) {
          result = { error: '更新可能なフィールドがありません' };
          break;
        }

        const { error: updateError } = await supabase
          .from('user_profiles')
          .update(safeUpdates)
          .eq('id', user.id);
        success = !updateError;
        result = { updated: success, fields: Object.keys(safeUpdates) };
        break;
      }

      default:
        return NextResponse.json({ error: 'Unknown action type' }, { status: 400 });
    }

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
