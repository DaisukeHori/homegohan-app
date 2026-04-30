/**
 * #134 フリープランのレート制限ヘルパー
 *
 * フリープランユーザーに対して以下の制限を適用する:
 *   - 1 日あたり 3 食まで記録可能
 *   - 過去 30 日分のデータのみ閲覧可能（それ以前のデータは取得不可）
 *
 * 有料プラン (pro / premium / org_*) はすべてパス。
 * 制限超過時は 402 Payment Required + JSON エラーを返す。
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export type PlanType = 'free' | 'pro' | 'premium' | string;

export const FREE_PLAN_MAX_MEALS_PER_DAY = 3;
export const FREE_PLAN_HISTORY_DAYS = 30;

/** ユーザーのプランを取得する。取得失敗時は 'free' にフォールバック。 */
export async function getUserPlan(userId: string): Promise<PlanType> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('user_profiles')
    .select('plan')
    .eq('id', userId)
    .single();
  return (data?.plan as PlanType) ?? 'free';
}

/** プランが有料かどうかを判定する */
export function isPaidPlan(plan: PlanType): boolean {
  return plan !== 'free';
}

/**
 * 食事記録の日次上限チェック。
 * フリープランで 1 日 3 食を超えている場合、402 レスポンスを返す。
 * 問題なければ null を返す。
 */
export async function checkDailyMealLimit(
  userId: string,
  targetDate: string,
  plan: PlanType,
): Promise<NextResponse | null> {
  if (isPaidPlan(plan)) return null;

  const supabase = await createClient();

  // user_daily_meals → planned_meals の件数を取得
  const { data: daily } = await supabase
    .from('user_daily_meals')
    .select('id')
    .eq('user_id', userId)
    .eq('day_date', targetDate)
    .maybeSingle();

  if (!daily) return null; // その日のレコードがなければ 0 食 → OK

  const { count } = await supabase
    .from('planned_meals')
    .select('*', { count: 'exact', head: true })
    .eq('daily_meal_id', daily.id);

  if ((count ?? 0) >= FREE_PLAN_MAX_MEALS_PER_DAY) {
    return NextResponse.json(
      {
        error: 'rate_limit_exceeded',
        message: `フリープランでは 1 日 ${FREE_PLAN_MAX_MEALS_PER_DAY} 食まで記録できます。`,
        upgrade_url: '/settings?upgrade=true',
      },
      { status: 402 },
    );
  }

  return null;
}

/**
 * データ閲覧範囲チェック。
 * フリープランで 30 日以上前のデータを要求している場合、402 を返す。
 * 問題なければ null を返す。
 *
 * @param requestedDate  閲覧しようとしている日付 (YYYY-MM-DD)
 */
export function checkHistoryLimit(
  requestedDate: string,
  plan: PlanType,
): NextResponse | null {
  if (isPaidPlan(plan)) return null;

  const oldest = new Date();
  oldest.setDate(oldest.getDate() - FREE_PLAN_HISTORY_DAYS);
  const oldestStr = oldest.toISOString().split('T')[0];

  if (requestedDate < oldestStr) {
    return NextResponse.json(
      {
        error: 'history_limit_exceeded',
        message: `フリープランでは過去 ${FREE_PLAN_HISTORY_DAYS} 日分のデータのみ閲覧できます。`,
        upgrade_url: '/settings?upgrade=true',
        oldest_available: oldestStr,
      },
      { status: 402 },
    );
  }

  return null;
}
