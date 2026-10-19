/** /pricing に出す「買えるプラン」の読み取り (billing/01 §10.1) */
import { createLogger } from '@/lib/db-logger';
import { createClient } from '@/lib/supabase/server';
import { FREE_PLAN_KEY, PURCHASABLE_PLAN_TYPES, type PurchasablePlan } from '@/lib/billing/core';

const logger = createLogger('billing/public-plans');

const PLAN_COLUMNS = 'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id';

/**
 * /pricing に出す「買えるプラン」。月額の Price があるものだけ (年額は任意)。
 * 読み取りに失敗したら例外を投げずに空を返す (公開ページをエラーにせず、買えるプランが無いときと同じ表示を描く)。失敗は error ログに残す
 */
export async function listPurchasablePlans(): Promise<PurchasablePlan[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('subscription_plans')
    .select(PLAN_COLUMNS)
    .eq('status', 'public')
    .in('plan_type', [...PURCHASABLE_PLAN_TYPES])
    .neq('plan_key', FREE_PLAN_KEY)
    .not('stripe_price_id', 'is', null)
    .order('display_order', { ascending: true });
  if (error) {
    // 生のエラーは app_logs にだけ残す (ページには出さない)
    logger.error('公開のプランの一覧を読めませんでした (/pricing は買えるプランが無いときの表示を描く)', error);
    return [];
  }
  return (data ?? []) as PurchasablePlan[];
}
