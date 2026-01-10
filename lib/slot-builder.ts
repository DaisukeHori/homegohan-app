/**
 * V4献立生成エンジン用 スロットビルダーヘルパー
 * 
 * UIの生成モードに応じて targetSlots 配列を構築するユーティリティ
 * 
 * 使用例:
 * - 「空欄を埋める」→ buildEmptySlots()
 * - 「選択したところだけ」→ buildSelectedSlots()
 * - 「期間を指定」→ buildRangeSlots()
 * - 「全部作り直す」→ buildAllFutureSlots()
 */

import type { TargetSlot, MealType, PlannedMeal } from '@/types/domain';

// 日付ベースモデル対応: MealPlanDay と DailyMeal の両方と互換性のある最小インターフェース
export interface MealDay {
  dayDate: string;
  meals?: PlannedMeal[];
}

// 基本の食事タイプ（V4.0ではこの3つを主要対象）
export const BASE_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];

// 日付を YYYY-MM-DD 形式で返す
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// 今日の日付文字列
function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 日付を加算
function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

// 日付範囲を生成
function generateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

export interface SlotBuilderParams {
  /** 既存の日次献立データ（planned_meals を含む） */
  mealPlanDays: MealDay[];
  /** 対象とする食事タイプ（デフォルト: breakfast, lunch, dinner） */
  mealTypes?: MealType[];
}

/**
 * 指定された日付・mealTypeが空欄かどうかを判定
 * 空欄の定義: planned_meals レコードが存在しない状態
 * (mode='skip' は空欄ではない)
 */
export function isSlotEmpty(
  date: string,
  mealType: MealType,
  mealPlanDays: MealDay[]
): boolean {
  const day = mealPlanDays.find(d => d.dayDate === date);
  if (!day || !day.meals) return true;
  
  // 該当する mealType のレコードが存在しない = 空欄
  const existingMeal = day.meals.find(m => m.mealType === mealType);
  return !existingMeal;
}

/**
 * 指定された日付・mealTypeの PlannedMeal を取得
 */
export function getMealAtSlot(
  date: string,
  mealType: MealType,
  mealPlanDays: MealDay[]
): PlannedMeal | null {
  const day = mealPlanDays.find(d => d.dayDate === date);
  if (!day || !day.meals) return null;
  
  return day.meals.find(m => m.mealType === mealType) ?? null;
}

/**
 * モード: 空欄を埋める
 * 
 * 今日以降の空いているスロットのみを targetSlots として返す
 */
export function buildEmptySlots(params: SlotBuilderParams & {
  /** 開始日（デフォルト: 今日） */
  startDate?: string;
  /** 終了日（デフォルト: 開始日から6日後 = 1週間） */
  endDate?: string;
}): TargetSlot[] {
  const {
    mealPlanDays,
    mealTypes = BASE_MEAL_TYPES,
    startDate = getTodayStr(),
    endDate = addDays(startDate, 6),
  } = params;

  const dates = generateDateRange(startDate, endDate);
  const slots: TargetSlot[] = [];

  for (const date of dates) {
    for (const mealType of mealTypes) {
      if (isSlotEmpty(date, mealType, mealPlanDays)) {
        slots.push({ date, mealType });
      }
    }
  }

  return slots;
}

/**
 * モード: 選択したところだけ
 * 
 * ユーザーが明示的に選択したスロットを targetSlots として返す
 * 既存スロットを上書きする場合は plannedMealId を付与
 */
export function buildSelectedSlots(params: SlotBuilderParams & {
  /** 選択されたスロット（date + mealType） */
  selectedSlots: Array<{ date: string; mealType: MealType }>;
}): TargetSlot[] {
  const { mealPlanDays, selectedSlots } = params;

  return selectedSlots.map(slot => {
    const existingMeal = getMealAtSlot(slot.date, slot.mealType, mealPlanDays);
    
    return {
      date: slot.date,
      mealType: slot.mealType,
      // 既存のレコードがある場合は plannedMealId を付与（上書き）
      plannedMealId: existingMeal?.id,
    };
  });
}

/**
 * モード: 期間を指定
 * 
 * 指定された期間の空欄スロットを targetSlots として返す
 * includeExisting=true の場合は既存スロットも含める
 */
export function buildRangeSlots(params: SlotBuilderParams & {
  /** 開始日 */
  startDate: string;
  /** 終了日 */
  endDate: string;
  /** 既存スロットも含めるか（デフォルト: false = 空欄のみ） */
  includeExisting?: boolean;
}): TargetSlot[] {
  const {
    mealPlanDays,
    mealTypes = BASE_MEAL_TYPES,
    startDate,
    endDate,
    includeExisting = false,
  } = params;

  // 最大31日チェック
  const daysDiff = Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 31) {
    throw new Error('期間は最大31日までです');
  }

  const dates = generateDateRange(startDate, endDate);
  const slots: TargetSlot[] = [];

  for (const date of dates) {
    for (const mealType of mealTypes) {
      const isEmpty = isSlotEmpty(date, mealType, mealPlanDays);
      
      if (isEmpty) {
        slots.push({ date, mealType });
      } else if (includeExisting) {
        const existingMeal = getMealAtSlot(date, mealType, mealPlanDays);
        slots.push({
          date,
          mealType,
          plannedMealId: existingMeal?.id,
        });
      }
    }
  }

  return slots;
}

/**
 * モード: 全部作り直す
 * 
 * 今日以降の全スロットを targetSlots として返す
 * ⚠️ 破壊的操作のため、UIで確認ダイアログを表示すること
 */
export function buildAllFutureSlots(params: SlotBuilderParams & {
  /** 開始日（デフォルト: 今日） */
  startDate?: string;
  /** 終了日 */
  endDate: string;
}): TargetSlot[] {
  const {
    mealPlanDays,
    mealTypes = BASE_MEAL_TYPES,
    startDate = getTodayStr(),
    endDate,
  } = params;

  // 最大31日チェック
  const daysDiff = Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 31) {
    throw new Error('期間は最大31日までです');
  }

  const dates = generateDateRange(startDate, endDate);
  const slots: TargetSlot[] = [];

  for (const date of dates) {
    for (const mealType of mealTypes) {
      const existingMeal = getMealAtSlot(date, mealType, mealPlanDays);
      
      slots.push({
        date,
        mealType,
        // 既存があれば上書き
        plannedMealId: existingMeal?.id,
      });
    }
  }

  return slots;
}

/**
 * モード: 単一スロット生成
 * 
 * 1つのスロットのみを生成対象とする
 */
export function buildSingleSlot(params: {
  date: string;
  mealType: MealType;
  mealPlanDays: MealDay[];
}): TargetSlot[] {
  const { date, mealType, mealPlanDays } = params;
  const existingMeal = getMealAtSlot(date, mealType, mealPlanDays);
  
  return [{
    date,
    mealType,
    plannedMealId: existingMeal?.id,
  }];
}

/**
 * スロット数の検証
 * 
 * V4 API の制限（最大93件）をチェック
 */
export function validateSlotCount(slots: TargetSlot[]): { valid: boolean; message?: string } {
  if (slots.length === 0) {
    return { valid: false, message: '生成対象のスロットがありません' };
  }
  
  if (slots.length > 93) {
    return { valid: false, message: `スロット数が上限を超えています（${slots.length}/93）` };
  }
  
  return { valid: true };
}

/**
 * 空欄スロットの数をカウント
 */
export function countEmptySlots(params: SlotBuilderParams & {
  startDate: string;
  endDate: string;
}): number {
  const slots = buildEmptySlots(params);
  return slots.length;
}

/**
 * スロットの日付範囲を取得
 */
export function getSlotDateRange(slots: TargetSlot[]): { start: string; end: string } | null {
  if (slots.length === 0) return null;

  const dates = slots.map(s => s.date).sort();
  return {
    start: dates[0],
    end: dates[dates.length - 1],
  };
}

/**
 * AI生成献立かどうかを判定
 * mode が 'ai_creative' または 'ai' で始まる場合は AI 生成
 */
export function isAiGeneratedMeal(meal: PlannedMeal | null | undefined): boolean {
  if (!meal) return false;
  // mode は型定義より広い値を持つことがあるため string として扱う
  const mode = (meal.mode || '') as string;
  return mode === 'ai_creative' || mode.startsWith('ai');
}

/**
 * モード: AI生成のみ変更
 *
 * 今日以降のAI生成献立スロットのみを targetSlots として返す
 */
export function buildAiOnlySlots(params: SlotBuilderParams & {
  /** 開始日（デフォルト: 今日） */
  startDate?: string;
  /** 終了日（デフォルト: 開始日から6日後 = 1週間） */
  endDate?: string;
}): TargetSlot[] {
  const {
    mealPlanDays,
    mealTypes = BASE_MEAL_TYPES,
    startDate = getTodayStr(),
    endDate = addDays(startDate, 6),
  } = params;

  const dates = generateDateRange(startDate, endDate);
  const slots: TargetSlot[] = [];

  for (const date of dates) {
    for (const mealType of mealTypes) {
      const existingMeal = getMealAtSlot(date, mealType, mealPlanDays);
      // AI生成の献立のみを対象
      if (existingMeal && isAiGeneratedMeal(existingMeal)) {
        slots.push({
          date,
          mealType,
          plannedMealId: existingMeal.id,
        });
      }
    }
  }

  return slots;
}

/**
 * AI生成献立の数をカウント
 */
export function countAiSlots(params: SlotBuilderParams & {
  startDate: string;
  endDate: string;
}): number {
  const slots = buildAiOnlySlots(params);
  return slots.length;
}
