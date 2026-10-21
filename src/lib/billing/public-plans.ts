/** 公開の面に出すプランの読み取り (billing/01 §10.1・billing/03 §8.6) */
import { createLogger } from '@/lib/db-logger';
import { createClient } from '@/lib/supabase/server';
import { FREE_PLAN_KEY, PURCHASABLE_PLAN_TYPES, type PublicPlan } from '@/lib/billing/core';

const logger = createLogger('billing/public-plans');

/** 読む列 (PublicPlan の列。max_members は家族の人数の表示に使う) */
const PLAN_COLUMNS =
  'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id, max_members';

/**
 * 公開の面に出すプラン (表示用。R2)。public・個人/家族・free でない・月額の金額が正。Stripe の Price の有無では絞らない
 * (鍵と Price が無い間も価格と内容を公開する。買えるかどうかは isPurchasable で間隔ごとに見る)。
 * 読み取りに失敗したら例外を投げずに空を返す (公開ページをエラーにしない)。失敗は error ログに残す
 */
export async function listPublicPlans(): Promise<PublicPlan[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('subscription_plans')
    .select(PLAN_COLUMNS)
    .eq('status', 'public')
    .in('plan_type', [...PURCHASABLE_PLAN_TYPES])
    .neq('plan_key', FREE_PLAN_KEY)
    .gt('monthly_price_jpy', 0)
    .order('display_order', { ascending: true });
  if (error) {
    logger.error('公開のプランの一覧を読めませんでした (/pricing はフリーのカードだけを描く)', error);
    return [];
  }
  return (data ?? []) as PublicPlan[];
}
