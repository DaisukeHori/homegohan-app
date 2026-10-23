// ManualGrantRepository の実装 (billing/02 §8.2)。service_role の client で RPC と SELECT を行う。
// 呼ぶ側は必ず認可 (requireRole(['super_admin'])) のあと。DB の型は §6 の migration を当てて再生成したもの (段 A)。
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { LIVE_SUBSCRIPTION_STATUSES, isSubscriptionStatus } from '@/lib/billing/core';
import {
  GRANTABLE_PLAN_STATUSES,
  GRANTABLE_PLAN_TYPES,
  MANUAL_GRANT_AUDIT_ACTION_VALUES,
  MANUAL_GRANT_HISTORY_LIMIT,
  ManualGrantAuditDetailsSchema,
  ManualPlanGrantResultSchema,
  ManualPlanRevokeResultSchema,
  isGrantablePlan,
  isManualGrantRpcCode,
  type GrantablePlanView,
  type ManualGrantHistoryEntry,
  type ManualGrantRpcCode,
  type ManualPlanCurrentView,
  type ManualPlanGrantResult,
  type ManualPlanRevokeResult,
} from '@/lib/billing/manual-grant';

/** DB の RPC が RAISE EXCEPTION '<コード>' USING ERRCODE='P0001' で返す業務エラー (billing/01 の BillingRpcError と同じ流儀。コードの集合が違うので別のクラス) */
export class ManualGrantRpcError extends Error {
  readonly code: ManualGrantRpcCode;
  readonly detail: string | null;
  constructor(code: ManualGrantRpcCode, detail: string | null) {
    super(code);
    this.name = 'ManualGrantRpcError';
    this.code = code;
    this.detail = detail;
  }
}
function toManualGrantRpcError(error: { code?: string; message?: string; details?: string | null }): ManualGrantRpcError | null {
  if (error.code !== 'P0001' || !isManualGrantRpcCode(error.message)) return null;
  return new ManualGrantRpcError(error.message, typeof error.details === 'string' ? error.details : null);
}

const PLAN_COLUMNS = 'plan_key, display_name, plan_type, status, max_members';
const SUBSCRIPTION_COLUMNS = 'id, plan_key, status, stripe_subscription_id, iap_store, starts_at, current_period_end';
const HISTORY_COLUMNS = 'id, action_type, actor_id, created_at, details';

export interface ManualGrantRepository {
  /** 対象の利用者が user_profiles にあるか (無ければ route は 404) */
  userExists(userId: string): Promise<boolean>;
  /** 付与できるプラン (free でなく personal / family で public)。display_order 順 */
  listGrantablePlans(): Promise<GrantablePlanView[]>;
  /** live な行 (S でも M でも。利用者ごとに最大 1 行) */
  findLiveSubscription(userId: string): Promise<ManualPlanCurrentView | null>;
  /** 本冊の 3 つの action_type の監査 (新しい順・MANUAL_GRANT_HISTORY_LIMIT 件) */
  listHistory(userId: string): Promise<ManualGrantHistoryEntry[]>;
  /** billing_grant_manual_subscription。業務エラーは ManualGrantRpcError */
  grant(input: { userId: string; planKey: string; expiresAt: string | null }): Promise<ManualPlanGrantResult>;
  /** billing_revoke_manual_subscription。業務エラーは ManualGrantRpcError */
  revoke(userId: string): Promise<ManualPlanRevokeResult>;
}

type Admin = ReturnType<typeof getSupabaseAdmin>;

export function createManualGrantRepository(admin: Admin = getSupabaseAdmin()): ManualGrantRepository {
  return {
    async userExists(userId) {
      const { data, error } = await admin.from('user_profiles').select('id').eq('id', userId).maybeSingle();
      if (error) throw error;
      return data !== null;
    },
    async listGrantablePlans() {
      const { data, error } = await admin
        .from('subscription_plans')
        .select(PLAN_COLUMNS)
        .in('plan_type', [...GRANTABLE_PLAN_TYPES])
        .in('status', [...GRANTABLE_PLAN_STATUSES])
        .order('display_order', { ascending: true });
      if (error) throw error;
      // free は plan_type が personal なので SELECT では落ちない。isGrantablePlan (DB 関数の 2. と同じ条件) で落とす
      return (data ?? [])
        .filter((row) => isGrantablePlan(row))
        .map((row) => ({
          plan_key: row.plan_key,
          display_name: row.display_name,
          plan_type: row.plan_type as GrantablePlanView['plan_type'],
          max_members: row.max_members,
        }));
    },
    async findLiveSubscription(userId) {
      const { data, error } = await admin
        .from('personal_subscriptions')
        .select(SUBSCRIPTION_COLUMNS)
        .eq('user_id', userId)
        .in('status', [...LIVE_SUBSCRIPTION_STATUSES])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data === null) return null;
      if (!isSubscriptionStatus(data.status)) throw new Error('personal_subscriptions.status が想定外の値です');
      return {
        subscription_id: data.id,
        plan_key: data.plan_key,
        status: data.status,
        // ストアの契約 (アプリ内課金の I 行。billing/03 §8.6) は手動付与 (M 行) と見分ける
        source: data.stripe_subscription_id === null ? (data.iap_store === null ? 'manual' : 'store') : 'stripe',
        starts_at: data.starts_at,
        expires_at: data.current_period_end,
      };
    },
    async listHistory(userId) {
      const { data, error } = await admin
        .from('admin_audit_logs')
        .select(HISTORY_COLUMNS)
        .eq('target_id', userId)
        .in('action_type', [...MANUAL_GRANT_AUDIT_ACTION_VALUES])
        .order('created_at', { ascending: false })
        .limit(MANUAL_GRANT_HISTORY_LIMIT);
      if (error) throw error;
      return (data ?? []).map((row) => {
        const details = ManualGrantAuditDetailsSchema.safeParse(row.details);
        return {
          id: row.id,
          action_type: row.action_type as ManualGrantHistoryEntry['action_type'],
          actor_id: row.actor_id,
          created_at: row.created_at ?? '',
          plan_key: details.success ? (details.data.plan_key ?? null) : null,
          expires_at: details.success ? (details.data.expires_at ?? null) : null,
          reason: details.success ? (details.data.reason ?? null) : null,
        };
      });
    },
    async grant({ userId, planKey, expiresAt }) {
      // p_expires_at は既定値 (NULL) のある引数で、生成された型は省略可 (null を受けない。billing/01 §8.0 の p_error と同じ)。期限なしのときは渡さない
      const args = expiresAt === null ? { p_user_id: userId, p_plan_key: planKey } : { p_user_id: userId, p_plan_key: planKey, p_expires_at: expiresAt };
      const { data, error } = await admin.rpc('billing_grant_manual_subscription', args);
      if (error) throw toManualGrantRpcError(error) ?? error;
      const parsed = ManualPlanGrantResultSchema.safeParse(data);
      if (!parsed.success) throw new Error('billing_grant_manual_subscription が想定外の結果を返しました');
      return parsed.data;
    },
    async revoke(userId) {
      const { data, error } = await admin.rpc('billing_revoke_manual_subscription', { p_user_id: userId });
      if (error) throw toManualGrantRpcError(error) ?? error;
      const parsed = ManualPlanRevokeResultSchema.safeParse(data);
      if (!parsed.success) throw new Error('billing_revoke_manual_subscription が想定外の結果を返しました');
      return parsed.data;
    },
  };
}
