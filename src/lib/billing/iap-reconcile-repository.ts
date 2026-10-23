/**
 * IapReconcileRepository の実装 (billing/04 §8.2)。service_role の client で候補を読む RPC と印を書く RPC を呼ぶ (書くのは順番の印の表
 * iap_reconcile_attempts だけ。権利の表への書き込みは billing/03 の iap-repository.ts の applyStoreSubscription が唯一)。
 * 呼ぶ側は必ず cron の認証 (requireCronAuth) のあと
 */
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { IapReconcileCandidatesSchema, type IapReconcileRepository } from '@/lib/billing/iap-reconcile-core';

type Admin = ReturnType<typeof getSupabaseAdmin>;

/** PostgreSQL の interval の入力 ('6 hours')。p_recheck_after に渡す */
const hoursInterval = (hours: number): string => `${hours} hours`;

export function createIapReconcileRepository(admin: Admin = getSupabaseAdmin()): IapReconcileRepository {
  return {
    async listReconcileCandidates({ now, recheckHours, limit }) {
      const { data, error } = await admin.rpc('billing_iap_reconcile_candidates', {
        p_now: now.toISOString(),
        p_recheck_after: hoursInterval(recheckHours),
        p_limit: limit,
      });
      if (error) throw error;
      const parsed = IapReconcileCandidatesSchema.safeParse(data);
      if (!parsed.success) throw new Error('billing_iap_reconcile_candidates が想定外の結果を返しました');
      return parsed.data;
    },
    async markReconcileAttempted({ userIds, attemptedAt }) {
      const { error } = await admin.rpc('billing_iap_reconcile_mark_attempted', {
        p_user_ids: userIds,
        p_attempted_at: attemptedAt.toISOString(),
      });
      if (error) throw error;
    },
  };
}
