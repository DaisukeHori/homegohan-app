/**
 * クーポン適用ロジック
 * operator/04-plan-management.md §4.1 「新クーポン適用フロー」準拠 (canonical source)
 *
 * #1041 (F4-07) 修正: クーポンは作成 (coupons テーブルへの INSERT) のみが実装されており、
 * 実際に契約へ適用して coupon_redemptions を作成する処理・uses_count や
 * per_user_limit の上限強制が全く存在しなかった (偽成功: クーポン管理画面で
 * 「作成できた」ことが「使える」ことを意味しなかった)。
 *
 * 本モジュールは super_admin による遡及適用 (POST /api/super-admin/coupons/[id]/apply)
 * から呼び出される。将来的にセルフサーブ決済フローが実装された場合も、同じ検証・
 * 適用ロジックを再利用できるよう subscriptionId ベースの API として設計している。
 *
 * #1224 修正: 検証 (有効性・applicable_plans・per_user_limit / 組織上限・max_uses) から
 * uses_count の加算・旧 redemption の終了・新規 redemption の作成・personal_subscriptions の
 * 参照更新までを、DB 関数 `public.apply_coupon` (migration 20261007160700) の 1 トランザクションで行う。
 * 以前はここで PostgREST を何度も呼んでおり、per_user_limit / 組織上限が「COUNT -> JS で比較 -> INSERT」の
 * check-then-act で、同時に 2 本来ると上限を超えて適用できた。また「旧 redemption の終了」と
 * 「新規 INSERT」が別々の呼び出しで、INSERT が失敗すると旧 redemption だけが終了したまま残った。
 * 本モジュールは RPC の呼び出しと、RPC が返す業務エラーを CouponApplyError に戻す処理だけを持つ。
 * 割引額の計算を含む業務ルールは DB 関数が持つ (真実の源は supabase/migrations/20261007160700_apply_coupon_rpc.sql)。
 *
 * #1041 round-2 (E) 修正: `apply_coupon` は service_role だけが実行できる
 * (`coupon_redemptions` は SELECT ポリシーのみで INSERT/UPDATE ポリシーが無い)。呼び出し元 (route) は
 * 必ず authz (requireRole(['super_admin']) 等) を通した後に service-role
 * クライアント (`getSupabaseAdmin()`) を渡すこと。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type SubscriptionTarget = 'personal' | 'org';

export class CouponApplyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CouponApplyError';
  }
}

export interface ApplyCouponParams {
  couponId: string;
  subscriptionTarget: SubscriptionTarget;
  subscriptionId: string;
  approvedBy: string;
}

export interface ApplyCouponResult {
  redemptionId: string;
  discountAmountJpy: number;
  durationMonths: number | null;
}

interface BusinessErrorSpec {
  /** DETAIL が無い・未知のときの文言 */
  message: string;
  /** DETAIL (種別) ごとの文言。同じコードで文言が分かれるものだけ */
  byDetail?: Record<string, string>;
}

/**
 * apply_coupon が `RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001', DETAIL = '<種別>'` で返す業務エラー。
 * 従来の applyCoupon が投げていた CouponApplyError (コードと文言) と同じものに戻す。
 * HTTP ステータスへの対応付けは route 側 (OP_SUBSCRIPTION_NOT_FOUND / OP_COUPON_NOT_FOUND は 404、それ以外は 422)。
 */
const BUSINESS_ERRORS: ReadonlyMap<string, BusinessErrorSpec> = new Map<string, BusinessErrorSpec>([
  ['OP_COUPON_NOT_FOUND', { message: 'クーポンが見つかりません' }],
  ['OP_COUPON_INVALID', { message: 'クーポンが有効な状態ではありません' }],
  ['OP_COUPON_NOT_YET_VALID', { message: 'クーポンの有効開始日前です' }],
  ['OP_COUPON_EXPIRED', { message: 'クーポンの有効期限が切れています' }],
  [
    'OP_COUPON_NOT_APPLICABLE',
    {
      message: 'このクーポンは指定の契約種別には適用できません', // DETAIL = 'target'
      byDetail: { plan: 'このクーポンは対象プランに適用できません' },
    },
  ],
  [
    'OP_SUBSCRIPTION_NOT_FOUND',
    {
      message: '契約が見つかりません', // DETAIL = 'personal'
      byDetail: { org: '契約 (組織) が見つかりません' },
    },
  ],
  [
    'OP_PLAN_NOT_FOUND',
    {
      message: '契約先プランが見つかりません', // DETAIL = 'plan'
      byDetail: { org_plan_unset: '組織に契約プランが設定されていません' },
    },
  ],
  [
    'OP_COUPON_LIMIT_REACHED',
    {
      message: 'クーポンの利用上限に達しています', // DETAIL = 'max_uses'
      byDetail: {
        per_user: 'このユーザーはクーポンの利用上限に達しています',
        per_organization: 'この組織はクーポンの利用上限に達しています',
      },
    },
  ],
]);

interface RpcError {
  code?: string;
  message?: string;
  details?: string | null;
}

/** RPC のエラーが業務エラー (P0001 + 既知のコード) なら CouponApplyError にする。それ以外は null */
function toCouponApplyError(error: RpcError): CouponApplyError | null {
  if (error.code !== 'P0001' || typeof error.message !== 'string') return null;
  const spec = BUSINESS_ERRORS.get(error.message);
  if (!spec) return null;
  const byDetail = typeof error.details === 'string' ? spec.byDetail?.[error.details] : undefined;
  return new CouponApplyError(error.message, byDetail ?? spec.message);
}

/**
 * クーポンを契約 (personal_subscriptions / organizations) に適用する。
 * 実体は DB 関数 `apply_coupon` (1 トランザクション。coupons 行と対象の契約行をロックして直列化する)。
 *
 * @param supabase service-role クライアント (apply_coupon は service_role のみ実行可)
 * @throws CouponApplyError 業務ルール違反 (呼び出し側で 4xx にマッピングすること)
 * @throws Error DB エラー等 (外部キー違反・関数が無い等。呼び出し側で 500 にマッピングすること)
 */
export async function applyCoupon(supabase: SupabaseClient<any>, params: ApplyCouponParams): Promise<ApplyCouponResult> {
  const { couponId, subscriptionTarget, subscriptionId, approvedBy } = params;

  const { data, error } = await supabase.rpc('apply_coupon', {
    p_coupon_id: couponId,
    p_target: subscriptionTarget,
    p_subscription_id: subscriptionId,
    p_approved_by: approvedBy,
  });
  if (error) {
    throw toCouponApplyError(error) ?? error;
  }

  const row = data as { redemption_id?: unknown; discount_amount_jpy?: unknown; duration_months?: unknown } | null;
  if (!row || typeof row.redemption_id !== 'string' || typeof row.discount_amount_jpy !== 'number') {
    throw new Error('apply_coupon が想定外の結果を返しました');
  }

  return {
    redemptionId: row.redemption_id,
    discountAmountJpy: row.discount_amount_jpy,
    durationMonths: typeof row.duration_months === 'number' ? row.duration_months : null,
  };
}
