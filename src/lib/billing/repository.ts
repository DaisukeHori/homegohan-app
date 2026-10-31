/**
 * BillingRepository の実装 (billing/01 §8.5)。service_role の client で RPC と SELECT を行う。
 * 呼ぶ側は必ず認証のあと (route) か、Webhook の署名のあと。
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';
import {
  FREE_PLAN_KEY,
  STRIPE_EVENT_STUCK_MINUTES,
  LIVE_SUBSCRIPTION_STATUSES,
  isStripeEventClaim,
  type ApplySubscriptionResult,
  type BillingAuditEntry,
  type BillingCustomerRow,
  type BillingRepository,
  type PlanFeatures,
  type PurchasablePlan,
  type StoredStripeEventPayload,
  type StripeEventClaim,
  type SubscriptionRowView,
  type SubscriptionSnapshot,
} from '@/lib/billing/core';

/** DB の RPC が RAISE EXCEPTION '<コード>' USING ERRCODE='P0001' で返す業務エラー (apply_coupon と同じ流儀) */
export class BillingRpcError extends Error {
  readonly code:
    | 'BILL_UNKNOWN_USER'
    | 'BILL_UNKNOWN_PLAN'
    | 'BILL_UNKNOWN_STRIPE_STATUS'
    | 'BILL_UNKNOWN_IAP_STATUS'
    | 'BILL_LIVE_ROW_CONFLICT';
  readonly detail: string | null;
  constructor(code: BillingRpcError['code'], detail: string | null) {
    super(code);
    this.name = 'BillingRpcError';
    this.code = code;
    this.detail = detail;
  }
}
const BILLING_RPC_ERROR_CODES = new Set([
  'BILL_UNKNOWN_USER',
  'BILL_UNKNOWN_PLAN',
  'BILL_UNKNOWN_STRIPE_STATUS',
  'BILL_UNKNOWN_IAP_STATUS',
  'BILL_LIVE_ROW_CONFLICT',
]);
function toBillingRpcError(error: { code?: string; message?: string; details?: string | null }): BillingRpcError | null {
  if (error.code !== 'P0001' || typeof error.message !== 'string' || !BILLING_RPC_ERROR_CODES.has(error.message)) return null;
  return new BillingRpcError(error.message as BillingRpcError['code'], typeof error.details === 'string' ? error.details : null);
}

const PLAN_COLUMNS = 'plan_key, display_name, plan_type, status, monthly_price_jpy, yearly_price_jpy, trial_days, stripe_price_id, stripe_yearly_price_id';
const SUBSCRIPTION_VIEW_COLUMNS = 'id, plan_key, status, stripe_subscription_id, billing_interval, current_period_end, trial_ends_at, cancel_at_period_end, cancel_at, iap_store, iap_synced_at';

type Admin = ReturnType<typeof getSupabaseAdmin>;

export function createBillingRepository(admin: Admin = getSupabaseAdmin()): BillingRepository {
  return {
    async findPlan(planKey) {
      const { data, error } = await admin.from('subscription_plans').select(PLAN_COLUMNS).eq('plan_key', planKey).maybeSingle();
      if (error) throw error;
      return (data as PurchasablePlan | null) ?? null;
    },
    async findPlanKeyByPriceId(priceId) {
      const { data, error } = await admin
        .from('subscription_plans')
        .select('plan_key')
        .or(`stripe_price_id.eq.${priceId},stripe_yearly_price_id.eq.${priceId}`)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.plan_key ?? null;
    },
    async findLiveSubscription(userId) {
      const { data, error } = await orderListBy(
        admin.from('personal_subscriptions').select(SUBSCRIPTION_VIEW_COLUMNS).eq('user_id', userId).in('status', [...LIVE_SUBSCRIPTION_STATUSES]),
        LIST_ORDERS.billingLiveSubscription,
      )
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as SubscriptionRowView | null) ?? null;
    },
    async hasUsedTrial(userId, planKey) {
      const { count, error } = await admin
        .from('personal_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('plan_key', planKey)
        .not('trial_started_at', 'is', null);
      if (error) throw error;
      return (count ?? 0) > 0;
    },
    async findPlanFeatures(planKey: string): Promise<PlanFeatures> {
      // 1 日の上限: プランの行、無ければ free の行 (consume_ai_usage_at の「そのプランの行。無ければ 'free' の行 (それも無ければ NULL =
      // 無制限)」と同じ。行があって daily_limit が NULL なら無制限のまま)
      const { data: limitRows, error: limitError } = await admin
        .from('ai_daily_limits')
        .select('plan_key, daily_limit')
        .in('plan_key', [planKey, FREE_PLAN_KEY]);
      if (limitError) throw limitError;
      const ownLimit = (limitRows ?? []).find((row) => row.plan_key === planKey);
      const freeLimit = (limitRows ?? []).find((row) => row.plan_key === FREE_PLAN_KEY);
      // 機能ごとの上限: そのプランの行だけ。free の行には倒さない (consume_ai_usage_at と ai_plan_feature_daily_cap は c.plan_key = いまのプランだけを
      // 見るので、行の無いプランは機能ごとの上限なし。組織の plan (standard など) の究極モードは環境変数の既定で使える。S26)
      const { data: capRows, error: capError } = await admin
        .from('ai_plan_feature_caps')
        .select('feature, daily_cap')
        .eq('plan_key', planKey);
      if (capError) throw capError;
      const aiFeatureCaps: Record<string, number | null> = {};
      for (const row of capRows ?? []) aiFeatureCaps[row.feature] = row.daily_cap;
      return { ai_daily_limit: (ownLimit ?? freeLimit)?.daily_limit ?? null, ai_feature_caps: aiFeatureCaps };
    },
    async findCustomer(userId) {
      const { data, error } = await admin.from('billing_customers').select('stripe_customer_id, user_id, anonymized_at').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return (data as BillingCustomerRow | null) ?? null;
    },
    async saveCustomer(userId, stripeCustomerId) {
      // 同時の 2 本: 負けた側は何も入らず、勝った側の行を読む (Stripe の Idempotency-Key で顧客も同じものになっている)
      const { error: insertError } = await admin.from('billing_customers').insert({ user_id: userId, stripe_customer_id: stripeCustomerId });
      if (insertError && insertError.code !== '23505') throw insertError;
      const { data, error } = await admin.from('billing_customers').select('stripe_customer_id, user_id, anonymized_at').eq('user_id', userId).single();
      if (error) throw error;
      return data as BillingCustomerRow;
    },
    async markCustomerAnonymized(stripeCustomerId, anonymizedAtIso) {
      const { error } = await admin.from('billing_customers').update({ anonymized_at: anonymizedAtIso }).eq('stripe_customer_id', stripeCustomerId);
      if (error) throw error;
    },
    async listStripeBackedSubscriptions(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select('stripe_subscription_id, status')
        .eq('user_id', userId)
        .not('stripe_subscription_id', 'is', null)
        .neq('status', 'cancelled');
      if (error) throw error;
      return (data ?? []) as Array<{ stripe_subscription_id: string; status: string }>;
    },
    async applyStripeSubscription({ snapshot, fetchedAt, source }) {
      const { data, error } = await admin.rpc('billing_apply_stripe_subscription', {
        // SubscriptionSnapshot は type のオブジェクト型 (§8.1) なので、生成された型 Json にそのまま代入できる
        p_snapshot: snapshot,
        p_fetched_at: fetchedAt.toISOString(),
        p_source: source,
      });
      if (error) throw toBillingRpcError(error) ?? error;
      return data as ApplySubscriptionResult;
    },
    async claimStripeEvent(payload: StoredStripeEventPayload) {
      // payload は minimizeStripeEventPayload の写し (§8.1)。イベントの JSON 全体は受け取らない
      const { data, error } = await admin.rpc('billing_claim_stripe_event', {
        p_event_id: payload.id,
        p_event_type: payload.type,
        p_payload: payload,
        p_stuck_after: `${STRIPE_EVENT_STUCK_MINUTES} minutes`,
      });
      if (error) throw error;
      if (!isStripeEventClaim(data)) throw new Error('billing_claim_stripe_event が想定外の結果を返しました');
      return data satisfies StripeEventClaim;
    },
    async finishStripeEvent(eventId, outcome) {
      // p_error は既定値 (NULL) のある引数で、生成された型は省略可の string (null を受けない。§8.0)。成功のときは渡さない
      const args = outcome.ok
        ? { p_event_id: eventId, p_ok: true }
        : { p_event_id: eventId, p_ok: false, p_error: outcome.errorCode };
      const { error } = await admin.rpc('billing_finish_stripe_event', args);
      if (error) throw error;
    },
    async recordAudit(entry) {
      // service_role なので RLS (actor_id = auth.uid()) を通らない。呼ぶ側は必ず認証のあと (route) か Webhook の署名のあと。
      // details の型は §8.1 の 3 通り (どれも JSON の値だけ) なので、生成された型 Json にそのまま入る
      const { error } = await admin.from('admin_audit_logs').insert({
        actor_id: entry.actor_id,
        action_type: entry.action_type,
        target_id: entry.target_id,
        target_type: entry.target_type,
        severity: entry.severity,
        details: entry.details,
      });
      if (error) throw error;
    },
  };
}
