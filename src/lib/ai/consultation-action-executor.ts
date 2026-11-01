// #1047 F2-21: AI相談チャットのアクション自動実行部（旧: execute/route.ts の POST 内 switch 文）。
// 以前は messages/route.ts からこのロジックを HTTP self-fetch
// (`${NEXT_PUBLIC_APP_URL}/api/ai/consultation/actions/.../execute`) 経由で呼び出していたが、
// serverless 環境で NEXT_PUBLIC_APP_URL 未設定時に `http://localhost:3000` へ fetch してしまい、
// 到達不能で静かに失敗する問題があった。
// アクション実行の中核ロジックをここに抽出し、execute route と messages route の両方から
// 直接関数呼び出しする（self-fetch を撤廃）。

import type { TargetSlot } from '@/types/domain';
import { isMealType, MEAL_ORDER, type MealType } from '@homegohan/shared';
import { addDaysToDate } from '@/lib/date-utils';
import { isCalendarDate } from '@/lib/jst-day-ranges';
import {
  AI_ACTION_COMPLETE_MEAL_FAILED_MESSAGE,
  AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE,
  AI_CONSULTATION_DATE_AND_MEAL_TYPE_REQUIRED_MESSAGE,
  AI_CONSULTATION_DATE_REQUIRED_MESSAGE,
  AI_CONSULTATION_DISHES_NOT_ARRAY_MESSAGE,
  AI_CONSULTATION_IMAGE_URL_NOT_STRING_MESSAGE,
  AI_CONSULTATION_MEAL_ID_REQUIRED_MESSAGE,
  AI_CONSULTATION_START_DATE_REQUIRED_MESSAGE,
  aiConsultationNonEmptyTextMaxMessage,
  aiConsultationNumberMessage,
  aiConsultationNumberRangeMessage,
  aiConsultationOptionalTextMaxMessage,
  aiConsultationRangeMessage,
  aiConsultationSingleMealStartedMessage,
  aiInvalidDateMessage,
} from '@/lib/ai/ai-api-messages';
import {
  HEALTH_GOAL_TARGET_UNIT_NULL_MESSAGE,
  HEALTH_GOAL_TARGET_VALUE_NULL_MESSAGE,
} from '@/lib/health-api-messages';
import {
  sanitizeHealthGoalCreate,
  sanitizeHealthGoalUpdate,
  sanitizeHealthRecordPayload,
  stripUndefined,
} from '@/lib/health-payloads';
import { updateHealthStreak } from '@/lib/health-streaks';
import { setPlannedMealCompleted } from '@/modules/planned-meals-integrity/server';
import { todayLocal } from '@/lib/date-utils';
import { invokeGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  countMealImageJobsToProcess,
  isCatalogProductMeal,
  markDishImagesSkipped,
  mealImageSkipReasonOf,
  type MealImageJobSeed,
} from '@/lib/meal-image';
import {
  buildDishImagePayload,
  cancelPendingMealImageJobs,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '@/lib/meal-image-jobs';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  aiUsageRecordedHeaders,
  consumeAiUsage,
  refundAiUsage,
  type AiUsageDenied,
  type AiUsageResult,
} from '@/lib/plan/entitlements';
import {
  AI_DAILY_LIMIT_CODE,
  AI_FEATURE_NOT_IN_PLAN_CODE,
  aiDailyLimitMessageOfDenied,
  aiDailyLimitSkippedField,
} from '../../../supabase/functions/_shared/ai-daily-limit';
import { checkUserAiConsent } from '@/lib/ai/consent-guard';
import { isUltimateModeRequested } from '@/lib/ai/ultimate-mode';
import { weeklyMenuRequestUltimateModeData } from '@/lib/ai/weekly-menu-request-ultimate';
import { weeklyMenuRequestWeeklyOriginDataForDates } from '@/lib/ai/weekly-menu-request-origin';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { createLogger } from '@/lib/db-logger';
import { errorCodeOf, toLoggableError } from '@/lib/api/errors';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';
import { MEAL_TYPE_MESSAGE, PLANNED_MEAL_NUTRIENT_LIMITS } from '@/lib/planned-meal-validation';
import { getOrCreateActiveShoppingList } from '@/lib/shopping-list/active-list';

// セキュリティ上禁止されたフィールド
const FORBIDDEN_PROFILE_FIELDS = ['email', 'avatar_url', 'is_banned', 'role', 'auth_provider'];

/** generate_week_menu で作る日数 (startDate から 1 週間) */
const WEEK_MENU_DAYS = 7;

// #1048 F2-23 / #1103: AI 生成アクション (generate_single_meal) が扱う meal_type。
// 朝食・昼食・夕食・おやつ・夜食 (midnight_snack) の 5 値。UI・献立生成の Edge Function
// (supabase/functions/_shared/meal-generator.ts の ALLOWED_MEAL_TYPES)・DB の検査
// (planned_meals: trg_planned_meals_validate_values、meals: trg_meals_validate_meal_type) と同じ値。
// AI の出力は信頼できないため、実行時にもホワイトリストで防御する。
// 以前は夜食を除く 4 値だった。理由は「planned_meals.meal_type には 4 値の CHECK (#221) があり、
// 'midnight_snack' を入れると 500 になる」だったが、その CHECK は本番に存在しなかった (#1205)。
// #1103 (項目 9) で夜食を正式な食事区分とし、DB の検査とこの許可リストを 5 値にそろえた。
// システムプロンプト (api/ai/consultation/sessions/[sessionId]/messages/route.ts) の mealType もこの配列から作る。
// 値と並びの正本は @homegohan/shared の MEAL_ORDER。ここでは手書きせず、それをそのまま使う (#1631)。
// PLANNED_MEAL_TYPES (src/lib/planned-meal-validation.ts) も同じ MEAL_ORDER から作る。値を足す・減らすときは
// MEAL_ORDER と DB のトリガーを合わせる (tests/consultation-meal-type-actions.test.ts が PLANNED_MEAL_TYPES・MEAL_ORDER と
// 同じであることを確かめる)。
export const AI_ALLOWED_MEAL_TYPES: readonly MealType[] = MEAL_ORDER;

// ==================== mass assignment 対策: サニタイザ ====================
// AIが生成した action_params は信頼できない入力（プロンプトインジェクションの
// ターゲットになり得る）ため、DB更新に使用するキーは明示的なホワイトリストで
// 抽出し、非許可キーは fail-close で無条件に破棄する。

type PlainRecord = Record<string, unknown>;

/**
 * AI 相談の更新 (update_meal / update_shopping_item) で受け付ける文字列の項目の長さの上限 (文字数)。
 * 以前からこの下の関数の条件に直接書いていた値を名前にしたもの (値は変えていない)。検証の失敗の文にも同じ値を入れる
 */
const CONSULTATION_TEXT_FIELD_MAX_LENGTH = {
  dish_name: 200,
  memo: 1000,
  mode: 50,
  item_name: 200,
  quantity: 100,
  category: 100,
} as const;

/*
 * 検証の失敗の文 (errors) と、この下の result.error は、応答の本文 (execute の { result }・messages の actionResult) と
 * ai_action_logs.result に入る (#1917)。文は日本語の固定の文にし、項目は「日本語の名前 (キー)」の形で出す
 * (src/lib/ai/ai-api-messages.ts の aiConsultation* の関数と AI_CONSULTATION_* の定数。英字のキーを括弧の外に出さない。#1917 の続き)
 */

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
    return { data, errors: ['栄養目標の指定が正しくありません'] };
  }

  for (const [key, range] of Object.entries(NUTRITION_TARGET_RANGES)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (!isFiniteNumber(value)) {
      errors.push(aiConsultationNumberMessage(key));
      continue;
    }
    if (value < range.min || value > range.max) {
      errors.push(aiConsultationRangeMessage(key, range.min, range.max));
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
    return { data, errors: ['更新する内容の指定が正しくありません'] };
  }

  if (Object.prototype.hasOwnProperty.call(input, 'dish_name')) {
    const value = input.dish_name;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= CONSULTATION_TEXT_FIELD_MAX_LENGTH.dish_name) {
      data.dish_name = value;
    } else {
      errors.push(aiConsultationNonEmptyTextMaxMessage('dish_name', CONSULTATION_TEXT_FIELD_MAX_LENGTH.dish_name));
    }
  }

  // 範囲は HTTP 経由の食事登録・更新 (src/lib/planned-meal-validation.ts) と共有する (#1205)。
  const numericFieldRanges: Record<string, { min: number; max: number }> = PLANNED_MEAL_NUTRIENT_LIMITS;
  for (const [key, range] of Object.entries(numericFieldRanges)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (!isFiniteNumber(value) || value < range.min || value > range.max) {
      errors.push(aiConsultationNumberRangeMessage(key, range.min, range.max));
      continue;
    }
    data[key] = value;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'memo')) {
    const value = input.memo;
    if (value === null) {
      data.memo = null;
    } else if (typeof value === 'string' && value.length <= CONSULTATION_TEXT_FIELD_MAX_LENGTH.memo) {
      data.memo = value;
    } else {
      errors.push(aiConsultationOptionalTextMaxMessage('memo', CONSULTATION_TEXT_FIELD_MAX_LENGTH.memo));
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'mode')) {
    const value = input.mode;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= CONSULTATION_TEXT_FIELD_MAX_LENGTH.mode) {
      data.mode = value;
    } else {
      errors.push(aiConsultationNonEmptyTextMaxMessage('mode', CONSULTATION_TEXT_FIELD_MAX_LENGTH.mode));
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'dishes')) {
    const value = input.dishes;
    if (Array.isArray(value)) {
      data.dishes = value;
    } else {
      errors.push(AI_CONSULTATION_DISHES_NOT_ARRAY_MESSAGE);
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'image_url')) {
    const value = input.image_url;
    if (typeof value === 'string') {
      data.image_url = value;
    } else {
      errors.push(AI_CONSULTATION_IMAGE_URL_NOT_STRING_MESSAGE);
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
    return { data, errors: ['更新する内容の指定が正しくありません'] };
  }

  if (Object.prototype.hasOwnProperty.call(input, 'item_name')) {
    const value = input.item_name;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= CONSULTATION_TEXT_FIELD_MAX_LENGTH.item_name) {
      data.item_name = value;
    } else {
      errors.push(aiConsultationNonEmptyTextMaxMessage('item_name', CONSULTATION_TEXT_FIELD_MAX_LENGTH.item_name));
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'quantity')) {
    const value = input.quantity;
    if (value === null) {
      data.quantity = null;
    } else if (typeof value === 'string' && value.length <= CONSULTATION_TEXT_FIELD_MAX_LENGTH.quantity) {
      data.quantity = value;
    } else {
      errors.push(aiConsultationOptionalTextMaxMessage('quantity', CONSULTATION_TEXT_FIELD_MAX_LENGTH.quantity));
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'category')) {
    const value = input.category;
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= CONSULTATION_TEXT_FIELD_MAX_LENGTH.category) {
      data.category = value;
    } else {
      errors.push(aiConsultationNonEmptyTextMaxMessage('category', CONSULTATION_TEXT_FIELD_MAX_LENGTH.category));
    }
  }

  return { data, errors };
}

/**
 * 実行すると、利用者のデータを外国の AI 事業者へ送るアクション (献立の生成。Edge Function generate-menu-v4 / v5 を呼ぶ)。
 * 実行の API は、これらの前に同意を確かめる (T15 / #1154。同意が無ければ 403 AI_CONSENT_REQUIRED で、アクションは pending のまま残す)。
 * Edge Function の側でも同じ判定で止まる。
 */
export const AI_SENDING_ACTION_TYPES: ReadonlySet<string> = new Set([
  'generate_day_menu',
  'generate_week_menu',
  'generate_single_meal',
]);

/** add_recipe_to_collection で AI がコレクションの名前を渡さなかったときの足し先の名前 */
const DEFAULT_RECIPE_COLLECTION_NAME = 'お気に入り';

/** 構造化ログ (app_logs) の function_name。アクションの DB 操作の失敗はここに残す */
const ACTION_EXECUTOR_LOG_NAME = 'lib/ai/consultation-action-executor';

/**
 * アクションの DB 操作の失敗を構造化ログに残す (#1172)。
 *
 * runConsultationAction の result は、そのまま応答の本文に入る
 * (POST /api/ai/consultation/actions/[actionId]/execute の { result } / messages route の SSE と JSON の actionResult)。
 * ai_action_logs.result にも保存される。そのため result.error には DB の生のエラー文 (テーブル名・列名・制約名・衝突した値) を入れず、
 * 固定の文を入れる。元のエラーはここでログにだけ残す。
 * 保存された result を読むのはアカウントのデータ書き出しで、この変更より前に保存された行 (生のエラー文が入っている) があるため、
 * そちらでも result.error を固定の文にしている (src/lib/account-export-tables.ts の aiActionLogResultForExport)。
 */
function logActionDbFailure(
  user: { id: string },
  action: Pick<ConsultationActionRow, 'id' | 'action_type'>,
  operation: string,
  dbError: unknown,
): void {
  const errorCode = errorCodeOf(dbError);
  createLogger(ACTION_EXECUTOR_LOG_NAME)
    .withUser(user.id)
    .error('AI 相談のアクションの DB 操作に失敗しました', toLoggableError(dbError), {
      action_id: action.id,
      action_type: action.action_type,
      operation,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
}

/** 日本語の文字 (ひらがな・カタカナ・漢字・全角の記号) を含む文か (tests/helpers/api-error-text-scan.ts の JAPANESE と同じ範囲) */
const JAPANESE_TEXT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;

/**
 * 検証 (サニタイザ) が返した失敗の文 (errors) から、result.error を作る (#1917)。
 *
 * result.error は応答の本文 (execute の { result }・messages の SSE と JSON の actionResult) と ai_action_logs.result に入る。
 * 健康の記録・健康の目標の検証 (src/lib/health-payloads.ts。/api/health/** と共有) は、以前は 'weight must be a finite number or null'
 * のような英語の文を返していた。#1983 (health) の直しで今は日本語の文 (src/lib/health-api-messages.ts) を返すが、
 * 検証に英語の文が入り直しても本文に出ないよう、守りとしてこの置き換えを残す。日本語の文 (範囲の文など) はそのまま残し、
 * 日本語でない文は 1 つの固定の文 (AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE) に置き換える。元の文は構造化ログにだけ残す
 * (守りの道は tests/consultation-action-validation-messages.test.ts が英語の文を返すスタブで確かめる)
 */
function validationFailureResult(
  user: { id: string },
  action: Pick<ConsultationActionRow, 'id' | 'action_type'>,
  errors: readonly string[],
): { error: string } {
  const shown: string[] = [];
  const rawNonJapanese: string[] = [];
  for (const text of errors) {
    if (JAPANESE_TEXT_PATTERN.test(text)) {
      shown.push(text);
    } else {
      rawNonJapanese.push(text);
    }
  }
  if (rawNonJapanese.length > 0) {
    createLogger(ACTION_EXECUTOR_LOG_NAME).warn('AI 相談のアクションの値が検証を通りませんでした', {
      userId: user.id,
      action_id: action.id,
      action_type: action.action_type,
      validation_errors: rawNonJapanese,
    });
    shown.push(AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE);
  }
  return { error: shown.join(', ') };
}

export interface ConsultationActionRow {
  id: string;
  action_type: string;
  action_params: Record<string, any>;
  ai_consultation_sessions: { user_id: string };
}

export interface ConsultationActionExecutionResult {
  success: boolean;
  result: any;
  /** action_type がどのケースにも一致しなかった場合 true（呼び出し元で 400/failed 等に変換する） */
  unknownActionType?: boolean;
  /**
   * AI を使うアクション (献立の生成) を、今日の AI の利用回数の上限 (#1149) に達したので実行しなかったとき。
   * execute の route は 429 AI_DAILY_LIMIT を返し、アクションを pending のまま残す (明日もう一度実行できる)
   */
  aiDailyLimit?: AiUsageDenied;
}

/** 上限 (#1149) に達して生成しなかったときの結果 (ai_action_logs.result と、会話の中の自動実行の結果に残る。人向けの文) */
function dailyLimitResult(denied: AiUsageDenied): {
  error: string;
  code: typeof AI_DAILY_LIMIT_CODE | typeof AI_FEATURE_NOT_IN_PLAN_CODE;
} {
  // 究極モードの 1 日の上限 (#1142) で止めたときは、究極モードの文 (1 日の上限の文と同じ形)。
  // ご利用中のプランでは使えない機能 (planLocked。billing/03 §8.8) は、使えない機能の文と AI_FEATURE_NOT_IN_PLAN
  return {
    error: aiDailyLimitMessageOfDenied(denied),
    code: denied.planLocked === true ? AI_FEATURE_NOT_IN_PLAN_CODE : AI_DAILY_LIMIT_CODE,
  };
}

export async function runConsultationAction(
  supabase: any,
  user: { id: string },
  action: ConsultationActionRow,
): Promise<ConsultationActionExecutionResult> {
  let result: any = null;
  let success = false;
  let aiDailyLimit: AiUsageDenied | undefined;

  // V5フラグ判定 (#1148: feature_flags。運営画面で切り替える)
  const useV5 = await isFeatureEnabled('menu_generation_v5_wrapped', user.id);
  const engineLabel = useV5 ? 'generate-menu-v5' : 'generate-menu-v4';

  // アクションタイプに応じて実行
  switch (action.action_type) {
    // ==================== 献立関連 ====================
    case 'generate_day_menu': {
      // 1日分の献立を生成（generate-menu-v4を使用）
      const { date, ultimateMode } = action.action_params;

      if (!date) {
        result = { error: AI_CONSULTATION_DATE_REQUIRED_MESSAGE };
        break;
      }

      // 日付は YYYY-MM-DD の実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを受け付ける (#1433。generate_week_menu の startDate と同じ確認)。
      // AI が 2026/10/10 などを返すと、献立生成 (Edge Function) が日付を前後にずらすところで RangeError になる
      if (!isCalendarDate(date)) {
        result = { error: aiInvalidDateMessage('日付') };
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

      // #1149 AI の利用回数の上限の判定と記録 (#1177。生成 1 回につき 1 回。究極モードも 1 回。AI へ送る直前 = 引数の検証のあと・
      // 生成のリクエストの行を作る前)。AI 相談の会話そのもの (consultation) は呼び出し元の route が数える。
      // 生成は別の AI の呼び出しなので、ここで別に数える。同意の判定は呼び出し元の route がアクションの実行の前に済ませる。
      // 上限に達していれば、数えずに生成しない (aiDailyLimit を返す。execute の route は 429、会話の中の自動実行は失敗の結果として残る)。
      // 判定に失敗したときは止めない
      // AI のキュー (weekly_menu_requests) は利用者 (authenticated) から書けない (#1465)。service role で書く (数える前に作る)
      const queueDb = getAiQueueWriter();
      // 究極モード (#1142) は 'menu_generation_ultimate' で数える (1 日の上限に 1 回 + 究極モードの 1 日の上限 (既定 1 回) に 1 回)。
      // 究極モードかどうかはアクションの引数の ultimateMode が true のときだけ。生成に渡す値も同じ判定の結果にする
      const ultimate = isUltimateModeRequested(ultimateMode);
      const usageFeature = ultimate ? 'menu_generation_ultimate' : 'menu_generation';
      const aiUsage = ultimate
        ? await consumeAiUsage(user.id, 'menu_generation_ultimate')
        : await consumeAiUsage(user.id, 'menu_generation');
      if (!aiUsage.allowed) {
        aiDailyLimit = aiUsage;
        result = dailyLimitResult(aiUsage);
        break;
      }

      // リクエストを記録
      const { data: requestData, error: requestError } = await queueDb
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
          // 究極モードの生成かを、行を作った時点から行に残す (#1582。生成中の行の確認 (weekly/pending) が読む)
          generated_data: weeklyMenuRequestUltimateModeData(ultimate),
        })
        .select('id')
        .single();

      if (requestError) {
        console.error('Failed to create request:', requestError);
        // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
        await refundAiUsage(user.id, usageFeature, aiUsage);
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
        invoke: async () => supabase.functions.invoke(engineLabel, {
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
            ultimateMode: ultimate,
          },
          // #1177 Edge Function (generate-menu) はユーザーの JWT で呼ばれたときに利用回数を記録する。
          // この生成は上 (consumeAiUsage) で数え済みなので、二重に数えないよう、署名つきの印を付ける
          headers: await aiUsageRecordedHeaders(user.id),
        }),
      });

      if (!invokeResult.ok) {
        console.error(`Failed to invoke ${engineLabel}:`, invokeResult.errorMessage);
        await markWeeklyMenuRequestFailed({
          supabase: queueDb,
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
        result = { error: AI_CONSULTATION_START_DATE_REQUIRED_MESSAGE };
        break;
      }
      // 日付は暦の計算 (addDaysToDate) でずらすので、YYYY-MM-DD の実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを受け付ける (#1433)
      if (typeof startDate !== 'string' || !isCalendarDate(startDate)) {
        result = { error: aiInvalidDateMessage('開始日') };
        break;
      }

      // 1週間分のスロットを生成 (日付は暦の計算で進める。#1433。以前の new Date(startDate) + setDate (ローカル時刻)
      // + toISOString (UTC) は、実行環境のタイムゾーンで結果が変わった)
      const baseTargetSlots: TargetSlot[] = [];
      for (let i = 0; i < WEEK_MENU_DAYS; i++) {
        const dateStr = addDaysToDate(startDate, i);
        baseTargetSlots.push({ date: dateStr, mealType: 'breakfast' });
        baseTargetSlots.push({ date: dateStr, mealType: 'lunch' });
        baseTargetSlots.push({ date: dateStr, mealType: 'dinner' });
      }
      const targetSlots = await resolveExistingTargetSlots({
        supabase,
        userId: user.id,
        targetSlots: baseTargetSlots,
      });

      // #1149 AI の利用回数の上限の判定と記録 (#1177。生成 1 回につき 1 回。究極モードも 1 回。AI へ送る直前 = 引数の検証のあと・
      // 生成のリクエストの行を作る前)。AI 相談の会話そのもの (consultation) は呼び出し元の route が数える。
      // 生成は別の AI の呼び出しなので、ここで別に数える。同意の判定は呼び出し元の route がアクションの実行の前に済ませる。
      // 上限に達していれば、数えずに生成しない (aiDailyLimit を返す。execute の route は 429、会話の中の自動実行は失敗の結果として残る)。
      // 判定に失敗したときは止めない
      // AI のキュー (weekly_menu_requests) は利用者 (authenticated) から書けない (#1465)。service role で書く (数える前に作る)
      const queueDb = getAiQueueWriter();
      // 究極モード (#1142) は 'menu_generation_ultimate' で数える (1 日の上限に 1 回 + 究極モードの 1 日の上限 (既定 1 回) に 1 回)。
      // 究極モードかどうかはアクションの引数の ultimateMode が true のときだけ。生成に渡す値も同じ判定の結果にする
      const ultimate = isUltimateModeRequested(ultimateMode);
      const usageFeature = ultimate ? 'menu_generation_ultimate' : 'menu_generation';
      const aiUsage = ultimate
        ? await consumeAiUsage(user.id, 'menu_generation_ultimate')
        : await consumeAiUsage(user.id, 'menu_generation');
      if (!aiUsage.allowed) {
        aiDailyLimit = aiUsage;
        result = dailyLimitResult(aiUsage);
        break;
      }

      // リクエストを記録
      const { data: requestData, error: requestError } = await queueDb
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
          // 究極モードの生成かを、行を作った時点から行に残す (#1582。生成中の行の確認 (weekly/pending) が読む)
          // #1867: 1 週間分の生成なので、週の献立の生成の印 (weeklyRequest: true) も書く。行が completed になった時点で
          // DB のトリガー (weekly_menu_requests_award_planner) がこの印を見て planner を付ける (src/lib/ai/weekly-menu-request-origin.ts)
          generated_data: {
            ...weeklyMenuRequestUltimateModeData(ultimate),
            ...weeklyMenuRequestWeeklyOriginDataForDates(targetSlots.map((s) => s.date)),
          },
        })
        .select('id')
        .single();

      if (requestError) {
        console.error('Failed to create request:', requestError);
        // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
        await refundAiUsage(user.id, usageFeature, aiUsage);
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
        invoke: async () => supabase.functions.invoke(engineLabel, {
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
            ultimateMode: ultimate,
          },
          // #1177 Edge Function (generate-menu) はユーザーの JWT で呼ばれたときに利用回数を記録する。
          // この生成は上 (consumeAiUsage) で数え済みなので、二重に数えないよう、署名つきの印を付ける
          headers: await aiUsageRecordedHeaders(user.id),
        }),
      });

      if (!invokeResult.ok) {
        console.error(`Failed to invoke ${engineLabel}:`, invokeResult.errorMessage);
        await markWeeklyMenuRequestFailed({
          supabase: queueDb,
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
        result = { error: AI_CONSULTATION_DATE_AND_MEAL_TYPE_REQUIRED_MESSAGE };
        break;
      }

      // 日付は YYYY-MM-DD の実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを受け付ける (#1433。generate_week_menu の startDate と同じ確認)
      if (!isCalendarDate(date)) {
        result = { error: aiInvalidDateMessage('日付') };
        break;
      }

      // #1048 F2-23 / #1103: 許可リスト (AI_ALLOWED_MEAL_TYPES。夜食 midnight_snack を含む 5 値) にない
      // mealType を拒否する。プロンプトには同じリストから作った値だけを提示しているが、
      // AI 出力は信頼できないため実行時にも二重で防御する。
      // 判定は MEAL_ORDER (= AI_ALLOWED_MEAL_TYPES) の型ガード isMealType で行う (#1631)
      if (typeof mealType !== 'string' || !isMealType(mealType)) {
        // 文は食事の入力の検証と同じ「食事の区分 (mealType) は次のいずれかを…」(MEAL_TYPE_MESSAGE。値の並びは同じ MEAL_ORDER。#1917 の続き)
        result = { error: MEAL_TYPE_MESSAGE };
        break;
      }

      const targetSlots = await resolveExistingTargetSlots({
        supabase,
        userId: user.id,
        targetSlots: [{ date, mealType }],
      });

      // #1149 AI の利用回数の上限の判定と記録 (#1177。生成 1 回につき 1 回。究極モードも 1 回。AI へ送る直前 = 引数の検証のあと・
      // 生成のリクエストの行を作る前)。AI 相談の会話そのもの (consultation) は呼び出し元の route が数える。
      // 生成は別の AI の呼び出しなので、ここで別に数える。同意の判定は呼び出し元の route がアクションの実行の前に済ませる。
      // 上限に達していれば、数えずに生成しない (aiDailyLimit を返す。execute の route は 429、会話の中の自動実行は失敗の結果として残る)。
      // 判定に失敗したときは止めない
      // AI のキュー (weekly_menu_requests) は利用者 (authenticated) から書けない (#1465)。service role で書く (数える前に作る)
      const queueDb = getAiQueueWriter();
      // 究極モード (#1142) は 'menu_generation_ultimate' で数える (1 日の上限に 1 回 + 究極モードの 1 日の上限 (既定 1 回) に 1 回)。
      // 究極モードかどうかはアクションの引数の ultimateMode が true のときだけ。生成に渡す値も同じ判定の結果にする
      const ultimate = isUltimateModeRequested(ultimateMode);
      const usageFeature = ultimate ? 'menu_generation_ultimate' : 'menu_generation';
      const aiUsage = ultimate
        ? await consumeAiUsage(user.id, 'menu_generation_ultimate')
        : await consumeAiUsage(user.id, 'menu_generation');
      if (!aiUsage.allowed) {
        aiDailyLimit = aiUsage;
        result = dailyLimitResult(aiUsage);
        break;
      }

      // 1. weekly_menu_requests に記録
      const { data: requestData, error: requestError } = await queueDb
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
          // 究極モードの生成かを、行を作った時点から行に残す (#1582。生成中の行の確認 (weekly/pending) が読む)
          generated_data: weeklyMenuRequestUltimateModeData(ultimate),
        })
        .select('id')
        .single();

      if (requestError) {
        console.error('Failed to create request:', requestError);
        // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
        await refundAiUsage(user.id, usageFeature, aiUsage);
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
        invoke: async () => supabase.functions.invoke(engineLabel, {
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
            ultimateMode: ultimate,
          },
          // #1177 Edge Function (generate-menu) はユーザーの JWT で呼ばれたときに利用回数を記録する。
          // この生成は上 (consumeAiUsage) で数え済みなので、二重に数えないよう、署名つきの印を付ける
          headers: await aiUsageRecordedHeaders(user.id),
        }),
      });

      if (!invokeResult.ok) {
        console.error('Failed to invoke generate-menu-v4:', invokeResult.errorMessage);
        await markWeeklyMenuRequestFailed({
          supabase: queueDb,
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
        // 食事の区分は日本語の名前で出す (英字の値 'dinner' を文に出さない。#1917 の続き)
        message: aiConsultationSingleMealStartedMessage(date, mealType),
      };
      break;
    }

    case 'update_meal': {
      const { mealId, updates } = action.action_params;
      console.log('update_meal action:', { mealId, updates });

      if (!mealId) {
        result = { error: AI_CONSULTATION_MEAL_ID_REQUIRED_MESSAGE };
        break;
      }

      // セキュリティ: 自分の献立のみ更新可能 (user_daily_meals JOIN 経由でユーザー確認)
      const { data: meal, error: mealFetchError } = await supabase
        .from('planned_meals')
        .select('id, dish_name, dishes, image_url, catalog_product_id, source_type, user_daily_meals!inner(user_id)')
        .eq('id', mealId)
        .eq('user_daily_meals.user_id', user.id)
        .maybeSingle();

      if (mealFetchError) {
        logActionDbFailure(user, action, 'planned_meals.select', mealFetchError);
        result = { error: '食事の取得に失敗しました' };
        break;
      }

      if (!meal) {
        result = { error: '権限がありません' };
        break;
      }

      // mass assignment対策: 許可キーのみ抽出（プロンプトインジェクション経由の任意列書き込みを防止）
      const { data: safeMealUpdates, errors: mealUpdateErrors } = sanitizeMealUpdate(updates);
      if (mealUpdateErrors.length > 0) {
        result = validationFailureResult(user, action, mealUpdateErrors);
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
          // 商品の献立 (update_meal は商品とのつながりを外さない) の古い商品の料理を、AI の画像で置き換えない (#1487 の整合ゲート)
          previousMealIsCatalog: isCatalogProductMeal(meal),
        });
        updateData.dishes = reconciledDishes;
        updateData.image_url = mealCoverImageUrl;
        jobs = nextJobs;
      } else if (safeMealUpdates.image_url !== undefined) {
        updateData.image_url = safeMealUpdates.image_url;
      }

      // 料理画像のジョブを積むかを、料理 (dishes) を保存する前に決める (#1487)。
      // 見送るなら、対象の料理を見送りの状態 ('failed' + 理由) にしてから保存する
      // ('pending' のまま保存すると、処理するジョブが無いので「料理画像を生成中です」のまま残る)
      let imageGenerationThrottled = false;
      // #1149 AI の利用回数の上限の判定の結果 (画像を付けない・同意が無い・レート制限で止めたときは判定しないので null)
      let imageUsage: AiUsageResult | null = null;
      let imageAllowed = false;
      if (jobs.length > 0) {
        // #1022 execute の update_meal も他の4 meal route と同じく image カテゴリで制限する
        // （relayチャットの連打で image の1min/20day上限をバイパスされないようにする）。
        // 画像副作用（enqueue + trigger）は update_meal 本体の成否から独立させる（詳細は meals/route.ts 参照）。
        try {
          const rl = await checkRateLimit(user.id, 'image');
          imageAllowed = rl.success;
          if (imageAllowed) {
            // 同意が無ければ (判定に失敗した場合も)、画像の生成ジョブを処理する Edge Function (process-meal-image-jobs) が
            // AI へ送らずに止める (T15 / #1154。料理は 'failed' + 同意の理由になる)。AI へ送らない操作は数えない
            // (同意の判定 → 上限の判定と記録 → AI への送信の順)。ジョブを積むかどうかは、同意の有無では変えない (止めるのは処理する側)
            const imageConsent = await checkUserAiConsent(supabase, user.id);
            if (imageConsent.allowed) {
              // #1149 料理画像は更新の自動の副作用なので、明示の 1 日の上限には数えない ('meal_image_auto'。記録だけ。
              // 食事を記録するだけで AI 相談や写真の解析が止まらないように)。そのかわり料理画像だけの安全弁 (DB の ai_unmetered_daily_caps。
              // 既定は 1 日 20 回) があり、達していれば画像だけ見送る (ジョブを積まない。献立の更新はそのまま。結果の aiSkipped: AI_DAILY_LIMIT)。
              // 操作 1 回で 1 回 (積む画像のジョブの数によらない)。判定に失敗したときは止めない
              imageUsage = await consumeAiUsage(user.id, 'meal_image_auto');
              if (!imageUsage.allowed) imageAllowed = false;
            }
          }
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

        if (!imageAllowed) {
          const skipReason = mealImageSkipReasonOf(imageUsage);
          if (skipReason === 'rate_limit') {
            // レート制限で見送った (上限 #1149 で見送ったときは、結果の aiSkipped で知らせる)
            imageGenerationThrottled = true;
            console.warn('[consultation/actions/execute] Image generation skipped due to rate limit', {
              userId: user.id,
              plannedMealId: mealId,
            });
          }
          updateData.dishes = markDishImagesSkipped(updateData.dishes, jobs, skipReason);
          jobs = [];
        }
      }

      const { data: updatedMeal, error: updateError } = await supabase
        .from('planned_meals')
        .update(updateData)
        .eq('id', mealId)
        .select('id, dish_name, calories_kcal, dishes')
        .single();

      if (updateError) {
        logActionDbFailure(user, action, 'planned_meals.update', updateError);
        // 料理画像の 1 回を数えたあと、献立を更新できなかった (AI へは何も送っていない) ので数え戻す (#1149 の数え戻し)
        if (imageUsage?.allowed) await refundAiUsage(user.id, 'meal_image_auto', imageUsage);
        result = { error: '食事の更新に失敗しました' };
        break;
      }

      if (imageAllowed && jobs.length > 0) {
        // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。service role で積む。
        // 1 行も積めなかったとき (重複・書き込みの失敗) は、enqueueMealImageJobs が数えた 1 回を戻す (#1487)
        const queueDb = getAiQueueWriter();
        const enqueued = await enqueueMealImageJobs({
          supabase: queueDb,
          plannedMealId: mealId,
          userId: user.id,
          triggerSource,
          jobSeeds: jobs,
          requestId: action.id,
          usage: imageUsage,
        });
        // 積めた行と、同じ料理の待ちのジョブがあるときだけ処理を起こす (書き込みの失敗だけなら空振りの呼び出しを出さない。#1532)
        const jobsToProcess = countMealImageJobsToProcess(enqueued);
        if (jobsToProcess > 0) {
          await triggerMealImageJobProcessing({ plannedMealId: mealId, limit: jobsToProcess });
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
        // #1149 今日の AI の利用回数の上限に達して、料理画像だけを見送ったとき (ご利用中のプランで作らない planLocked は付けない。billing/03 §8.8)
        ...aiDailyLimitSkippedField(imageUsage),
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

      // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。本人の献立であることを確かめたので、service role で取り消す
      const queueDb = getAiQueueWriter();
      await cancelPendingMealImageJobs({
        supabase: queueDb,
        userId: user.id,
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
      // 本人の行かどうかは RPC (planned_meals_set_completed) が確かめる。他人の行・無い行・UUID の形でない id は not_found。
      // completed_at は DB が決める (planned_meals の is_completed / completed_at は利用者のセッションから直接書けない。#2025)
      const completion = await setPlannedMealCompleted(supabase, {
        mealId: typeof mealId === 'string' ? mealId : '',
        completed: isCompleted !== false,
      });
      if (!completion.ok) {
        if (completion.reason === 'not_found') {
          result = { error: '権限がありません' };
          break;
        }
        success = false;
        result = { mealId, error: AI_ACTION_COMPLETE_MEAL_FAILED_MESSAGE };
        break;
      }
      success = true;
      result = { mealId, completed: completion.row.is_completed };
      break;
    }

    // ==================== 買い物リスト関連 ====================
    case 'add_to_shopping_list': {
      const { items } = action.action_params;

      // アクティブな買い物リストを取得または作成 (add-recipe API と共通のヘルパー。DB 関数のロックで、
      // 同時の追加 (#1214) とも、買い物リストの再生成 (#1312) とも 23505 にならない)
      let shoppingList: { id: string } | null = null;
      try {
        shoppingList = await getOrCreateActiveShoppingList(supabase, user.id);
      } catch (listError) {
        // PostgREST のエラーは Error ではないプレーンオブジェクトなので、ログ用に Error へ包む
        const pgError = listError as { code?: unknown; message?: unknown } | null;
        createLogger('api/ai/consultation/actions/execute').withUser(user.id).error(
          'Failed to get or create active shopping list',
          listError instanceof Error ? listError : new Error(String(pgError?.message ?? listError)),
          { actionId: action.id, pg_code: typeof pgError?.code === 'string' ? pgError.code : undefined },
        );
      }
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
        result = validationFailureResult(user, action, shoppingItemUpdateErrors);
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
        logActionDbFailure(user, action, 'pantry_items.insert', insertError);
        result = { error: '冷蔵庫の食材の追加に失敗しました' };
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
        logActionDbFailure(user, action, 'pantry_items.update', updateError);
        result = { error: '冷蔵庫の食材の更新に失敗しました' };
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
        logActionDbFailure(user, action, 'pantry_items.delete', deleteError);
        result = { error: '冷蔵庫の食材の削除に失敗しました' };
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

      const targetCollectionName = collectionName || DEFAULT_RECIPE_COLLECTION_NAME;

      // コレクションを取得または作成 (#2166 X4)。
      // recipe_collections に (user_id, name) の一意の制約は無く、同じ名前のコレクションが 2 件以上ありうる。
      // 以前の .single() は 2 件以上で失敗 (data が null) し、そのたびに同じ名前のコレクションをもう 1 件作っていた。
      // いまは作った日時の古い順 (同じ日時は id の順) の先頭 1 行を maybeSingle で読み、
      // 0 行のときだけ作る。読み取りのエラーは 0 行と分け、作らずに失敗を返す。
      const { data: existingCollection, error: lookupError } = await orderListBy(
        supabase
          .from('recipe_collections')
          .select('id')
          .eq('user_id', user.id)
          .eq('name', targetCollectionName),
        LIST_ORDERS.aiConsultationCollectionByName,
      )
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        logActionDbFailure(user, action, 'recipe_collections.select', lookupError);
        result = { error: 'コレクションの取得に失敗しました' };
        break;
      }

      let collection: { id: string } | null = existingCollection;
      if (!collection) {
        const { data: newCollection, error: createError } = await supabase
          .from('recipe_collections')
          .insert({
            user_id: user.id,
            name: targetCollectionName,
          })
          .select('id')
          .single();
        if (createError) {
          logActionDbFailure(user, action, 'recipe_collections.insert', createError);
          result = { error: 'コレクションの作成に失敗しました' };
          break;
        }
        collection = newCollection;
      }

      if (collection) {
        // #1047 F2-22: 以前はここで
        // `.update({ recipe_ids: supabase.rpc('array_append_unique', {...}) })`
        // を実行していたが、update() の値にクエリビルダー（Promiseライクな
        // オブジェクト）をそのまま渡しており、recipe_ids 列に意図しない値が
        // 書き込まれる（少なくとも配列追加としては機能しない）実質的な死にコードだった。
        // 読み直し + 重複排除 append のみで recipe_ids を更新する。
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
        result = validationFailureResult(user, action, targetErrors);
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

      // #1229: AI が生成した値をそのまま INSERT すると、未知の goal_type や 0 以下・範囲外の目標値が
      // 保存できてしまう (POST /api/health/goals の検証をバイパスしていた)。API と同じ検証を通す。
      // targetUnit はプロンプト上 optional なので、省略されたら goal_type に合う単位を入れる。
      const { data: safeGoal, errors: goalErrors } = sanitizeHealthGoalCreate(
        {
          goal_type: goalType,
          target_value: targetValue,
          target_unit: targetUnit,
          target_date: targetDate,
          note: note || description, // 後方互換性のためdescriptionもサポート
        },
        { defaultUnit: true },
      );
      if (!safeGoal) {
        result = validationFailureResult(user, action, goalErrors);
        break;
      }

      const { data: newGoal, error: insertError } = await supabase
        .from('health_goals')
        .insert({
          ...safeGoal,
          user_id: user.id,
          status: 'active',
        })
        .select('id')
        .single();
      success = !insertError;
      if (insertError) {
        logActionDbFailure(user, action, 'health_goals.insert', insertError);
        result = { error: '健康目標の保存に失敗しました' };
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
        .select('user_id, goal_type')
        .eq('id', goalId)
        .single();

      if (!goal || goal.user_id !== user.id) {
        result = { error: '権限がありません' };
        break;
      }

      // #1229: 目標値の範囲は goal_type ごとに違うため、対象の行の goal_type を渡して検証する
      const { data: safeUpdates, errors } = sanitizeHealthGoalUpdate(updates, { goalType: goal.goal_type });
      if (errors.length > 0) {
        result = validationFailureResult(user, action, errors);
        break;
      }
      if (Object.keys(safeUpdates).length === 0) {
        result = { error: '更新可能な目標項目がありません' };
        break;
      }
      // target_value / target_unit は NOT NULL の列。null を送ると DB エラーになるので、先に弾く
      if (safeUpdates.target_value === null || safeUpdates.target_unit === null) {
        // 文は /api/health/goals の PATCH と同じ (空にしようとした項目の文だけを出す。#1917 の続き)
        result = {
          error: [
            ...(safeUpdates.target_value === null ? [HEALTH_GOAL_TARGET_VALUE_NULL_MESSAGE] : []),
            ...(safeUpdates.target_unit === null ? [HEALTH_GOAL_TARGET_UNIT_NULL_MESSAGE] : []),
          ].join(', '),
        };
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
      // 形だけを見ていると 2026-02-30 のような存在しない日付が通り、DB の date 型への変換で失敗する (#1482)。
      // 実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを受け付ける
      if (!isCalendarDate(recordDate)) {
        result = { error: aiInvalidDateMessage('日付') };
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
        result = validationFailureResult(user, action, recordErrors);
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
        logActionDbFailure(user, action, 'health_records.upsert', upsertError);
        result = { error: '健康記録の保存に失敗しました' };
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
      const { date: rawDate, updates } = action.action_params;
      // 日付を確かめずに渡すと、AI が返した 2026-02-30 や 2026/10/10 などが DB の date 型への変換で失敗する (#1482)。
      // add_health_record と同じく、前後の空白を除いた実在する日付 (isCalendarDate の範囲の中) だけを受け付ける
      const date = typeof rawDate === 'string' ? rawDate.trim() : '';
      if (!isCalendarDate(date)) {
        result = { error: aiInvalidDateMessage('日付') };
        break;
      }
      const { data: safeUpdates, errors } = sanitizeHealthRecordPayload(updates, {
        acceptLegacyNotes: true,
      });
      if (errors.length > 0) {
        result = validationFailureResult(user, action, errors);
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
      return { success: false, result: null, unknownActionType: true };
  }

  return { success, result, ...(aiDailyLimit ? { aiDailyLimit } : {}) };
}
