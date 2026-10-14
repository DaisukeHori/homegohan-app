// #1040 (F2-02) / #1306: 健康インサイト (POST /api/health/insights) の LLM プロンプトに渡す「直近の食事」の取得と整形。
//
// planned_meals には user_id / planned_date 列が無い。食事の所有者は daily_meal_id → user_daily_meals.user_id、
// 日付は user_daily_meals.day_date で決まる。以前は planned_meals に `.eq('user_id', ...)` や
// `.select('planned_date,...')` を発行しており、PostgREST が 42703 で拒否するのに戻り値の error を見ていなかったため、
// 食事の文脈は常に「データなし」だった。
// そこで user_daily_meals を本人で絞り、planned_meals をネストして取得する
// (見本: src/app/api/export/meals/route.ts、src/hooks/useHomeData.ts)。
//
// 呼び出し元: src/app/api/health/insights/route.ts
// 実 DB に対する確認: tests/integration/security/health-insights-meals.test.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { MEAL_LABELS, MEAL_ORDER, type MealType } from '@homegohan/shared';
import { todayLocal } from '@/lib/date-utils';

/** プロンプトに渡す直近の食事の日数 */
export const RECENT_MEAL_DAYS = 7;

/** PostgREST は numeric を数値で返すが、文字列で来ても壊れないように両方受ける */
type NumericLike = number | string | null;

export interface InsightMeal {
  meal_type: string | null;
  calories_kcal: NumericLike;
  protein_g: NumericLike;
  fat_g: NumericLike;
  carbs_g: NumericLike;
}

/** user_daily_meals の 1 行 (= 1 日分) と、その日の食事 */
export interface InsightMealDay {
  day_date: string;
  planned_meals: InsightMeal[] | null;
}

/**
 * 本人の直近 RECENT_MEAL_DAYS 日分の食事を、新しい日から順に取得する。
 *
 * - planned_meals!inner: 食事が 1 件も無い日 (空の user_daily_meals) は除く。limit が「食事のある直近の日」になる
 * - is_sandbox = false: ハンズオンツアーが入れるダミーの献立 (最大 90 日残る) は食事の記録ではない
 * - day_date <= 今日: 先の予定 (まだ食べていない献立) は「直近の食事」ではない。「今日」は JST 基準
 *
 * `today` は YYYY-MM-DD。省略すると JST の今日。失敗しても throw せず、PostgREST の error をそのまま返す
 * (呼び出し側で必ず確認し、ログに残すこと)。
 */
export async function fetchRecentMealDays(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
  today: string = todayLocal(),
) {
  const { data, error } = await supabase
    .from('user_daily_meals')
    .select('day_date, planned_meals!inner(meal_type, calories_kcal, protein_g, fat_g, carbs_g)')
    .eq('user_id', userId)
    .eq('is_sandbox', false)
    .lte('day_date', today)
    .order('day_date', { ascending: false })
    .limit(RECENT_MEAL_DAYS);

  return { data: (data ?? null) as unknown as InsightMealDay[] | null, error };
}

function toNumber(value: NumericLike | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 値の無い項目 (null) は飛ばして合計する。1 つも値が無ければ null (0 と区別する) */
function sumOrNull(values: NumericLike[]): number | null {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    const n = toNumber(value);
    if (n === null) continue;
    total += n;
    hasValue = true;
  }
  return hasValue ? total : null;
}

/** kcal は整数、g は小数 1 桁に丸める。値が無ければ '-' */
function formatAmount(value: number | null, fractionDigits: 0 | 1): string {
  if (value === null) return '-';
  const factor = fractionDigits === 0 ? 1 : 10;
  return String(Math.round(value * factor) / factor);
}

function mealOrderIndex(mealType: string | null): number {
  const index = MEAL_ORDER.indexOf(mealType as MealType);
  return index === -1 ? MEAL_ORDER.length : index;
}

/** 未知の食事区分は、生の文字列をプロンプトに入れず「その他」にする */
function mealTypeLabel(mealType: string | null): string {
  const index = MEAL_ORDER.indexOf(mealType as MealType);
  return index === -1 ? 'その他' : MEAL_LABELS[MEAL_ORDER[index]];
}

/**
 * 食事を day_date ごとの合計 (kcal / タンパク質 / 脂質 / 炭水化物) と食事区分の 1 行にまとめる。
 * 渡された順 (新しい日が先) のまま出力する。食事の無い日は出さない。1 日も無ければ空文字。
 *
 * 食事区分も添えるのは、1 食しか無い日の合計 (例: 昼食だけの 600kcal) を、AI が一日の摂取不足と
 * 取り違えて警告 (is_alert) を出さないようにするため。
 */
export function formatMealDaysForPrompt(days: InsightMealDay[] | null | undefined): string {
  const lines: string[] = [];
  for (const day of days ?? []) {
    const meals = day.planned_meals ?? [];
    if (meals.length === 0) continue;

    const kcal = formatAmount(sumOrNull(meals.map((m) => m.calories_kcal)), 0);
    const protein = formatAmount(sumOrNull(meals.map((m) => m.protein_g)), 1);
    const fat = formatAmount(sumOrNull(meals.map((m) => m.fat_g)), 1);
    const carbs = formatAmount(sumOrNull(meals.map((m) => m.carbs_g)), 1);
    const labels = [...meals]
      .sort((a, b) => mealOrderIndex(a.meal_type) - mealOrderIndex(b.meal_type))
      .map((m) => mealTypeLabel(m.meal_type))
      .join('・');

    lines.push(`- ${day.day_date}: ${kcal}kcal, タンパク${protein}g, 脂質${fat}g, 炭水化物${carbs}g（${labels}）`);
  }
  return lines.join('\n');
}
