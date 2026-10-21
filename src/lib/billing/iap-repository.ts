/** IapRepository の実装 (billing/03 §8.3)。service_role の client で RPC と SELECT を行う。呼ぶ側は必ず認証のあとか署名のあと */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { BillingRpcError } from '@/lib/billing/repository';
import {
  REVENUECAT_EVENT_STUCK_MINUTES,
  isIapStore,
  isRevenueCatEventClaim,
  type ApplyStoreSubscriptionResult,
  type IapAuditEntry,
  type IapRepository,
  type PlanStoreProductRow,
  type RevenueCatEventClaim,
  type StoreSubscriptionRow,
  type StoredRevenueCatEventPayload,
} from '@/lib/billing/iap-core';

/** DB の RPC が P0001 で返す業務エラーのうち本冊の写像が足すもの (核の BillingRpcError の code の集合に足す。§13.3) */
const STORE_RPC_ERROR_CODES = new Set(['BILL_UNKNOWN_PLAN', 'BILL_UNKNOWN_IAP_STATUS', 'BILL_LIVE_ROW_CONFLICT']);

const isBillingInterval = (value: string | null): value is 'month' | 'year' => value === 'month' || value === 'year';

type Admin = ReturnType<typeof getSupabaseAdmin>;

export function createIapRepository(admin: Admin = getSupabaseAdmin()): IapRepository {
  return {
    async listStoreProducts() {
      // offered = false の行も読む (購入の履歴の商品の plan_key・間隔を引くため。カタログに出すかは buildIapCatalog が offered で決める)
      const { data, error } = await admin.from('plan_store_products').select('plan_key, store, billing_interval, product_id, offered');
      if (error) throw error;
      return (data ?? []).filter((row): row is PlanStoreProductRow => isIapStore(row.store) && isBillingInterval(row.billing_interval));
    },
    async listStoreSubscriptions(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select('iap_store, iap_product_id, plan_key, status, billing_interval, iap_is_sandbox, current_period_start, starts_at')
        .eq('user_id', userId)
        .not('iap_store', 'is', null);
      if (error) throw error;
      const rows: StoreSubscriptionRow[] = [];
      for (const row of data ?? []) {
        if (row.iap_store === null || !isIapStore(row.iap_store) || row.iap_product_id === null) continue;
        rows.push({
          iap_store: row.iap_store,
          iap_product_id: row.iap_product_id,
          plan_key: row.plan_key,
          status: row.status,
          billing_interval: row.billing_interval !== null && isBillingInterval(row.billing_interval) ? row.billing_interval : null,
          iap_is_sandbox: row.iap_is_sandbox,
          current_period_start: row.current_period_start,
          starts_at: row.starts_at,
        });
      }
      return rows;
    },
    async applyStoreSubscription({ snapshot, fetchedAt, source }) {
      const { data, error } = await admin.rpc('billing_apply_store_subscription', {
        p_snapshot: snapshot,
        p_fetched_at: fetchedAt.toISOString(),
        p_source: source,
      });
      if (error) {
        if (error.code === 'P0001' && typeof error.message === 'string' && STORE_RPC_ERROR_CODES.has(error.message)) {
          throw new BillingRpcError(error.message as BillingRpcError['code'], typeof error.details === 'string' ? error.details : null);
        }
        throw error;
      }
      return data as ApplyStoreSubscriptionResult;
    },
    async claimRevenueCatEvent(payload: StoredRevenueCatEventPayload) {
      const { data, error } = await admin.rpc('billing_claim_revenuecat_event', {
        p_event_id: payload.id,
        p_event_type: payload.type,
        p_payload: payload,
        p_stuck_after: `${REVENUECAT_EVENT_STUCK_MINUTES} minutes`,
      });
      if (error) throw error;
      if (!isRevenueCatEventClaim(data)) throw new Error('billing_claim_revenuecat_event が想定外の結果を返しました');
      return data satisfies RevenueCatEventClaim;
    },
    async finishRevenueCatEvent(eventId, outcome) {
      const args = outcome.ok ? { p_event_id: eventId, p_ok: true } : { p_event_id: eventId, p_ok: false, p_error: outcome.errorCode };
      const { error } = await admin.rpc('billing_finish_revenuecat_event', args);
      if (error) throw error;
    },
    async recordIapAudit(entry: IapAuditEntry) {
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
