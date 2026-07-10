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
 * uses_count の原子的 increment は DB 関数 (migration) なしで実現するため、
 * 楽観的ロック (compare-and-swap: `.eq('uses_count', current)`) + リトライで代替する。
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

/** JPY は小数を持たないため常に floor し、価格を超えない割引額を計算する */
export function calculateDiscountAmount(
  coupon: { discount_type: string; discount_value: number },
  currentPriceJpy: number,
): number {
  if (currentPriceJpy <= 0) return 0;
  const raw =
    coupon.discount_type === 'percentage'
      ? (currentPriceJpy * coupon.discount_value) / 100
      : coupon.discount_value;
  return Math.max(0, Math.min(Math.floor(raw), currentPriceJpy));
}

/**
 * coupons.uses_count を楽観的ロックで原子的にインクリメントする。
 * max_uses に達している場合は false を返す (呼び出し側でエラーにすること)。
 */
async function incrementCouponUsesCount(
  supabase: SupabaseClient<any>,
  couponId: string,
  maxUses: number | null,
): Promise<boolean> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: current, error: fetchErr } = await supabase
      .from('coupons')
      .select('uses_count')
      .eq('id', couponId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentUses = current.uses_count as number;
    if (maxUses != null && currentUses >= maxUses) {
      return false;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('coupons')
      .update({ uses_count: currentUses + 1 })
      .eq('id', couponId)
      .eq('uses_count', currentUses)
      .select('id');
    if (updateErr) throw updateErr;
    if (updated && updated.length > 0) {
      return true;
    }
    // 楽観的ロック衝突 (他リクエストが先に uses_count を更新した): リトライ
  }
  throw new Error('クーポン利用回数の更新に失敗しました (競合状態が解消しませんでした)');
}

async function decrementCouponUsesCount(
  supabase: SupabaseClient<any>,
  couponId: string,
): Promise<void> {
  const { data: current } = await supabase.from('coupons').select('uses_count').eq('id', couponId).single();
  if (!current) return;
  await supabase
    .from('coupons')
    .update({ uses_count: Math.max(0, (current.uses_count as number) - 1) })
    .eq('id', couponId);
}

/**
 * クーポンを契約 (personal_subscriptions / org_license_pools) に適用する。
 *
 * @throws CouponApplyError 業務ルール違反 (呼び出し側で 4xx にマッピングすること)
 * @throws Error DB エラー等 (呼び出し側で 500 にマッピングすること)
 */
export async function applyCoupon(supabase: SupabaseClient<any>, params: ApplyCouponParams): Promise<ApplyCouponResult> {
  const { couponId, subscriptionTarget, subscriptionId, approvedBy } = params;

  // 1. クーポン取得・有効性チェック
  const { data: coupon, error: couponErr } = await supabase
    .from('coupons')
    .select('*')
    .eq('id', couponId)
    .maybeSingle();
  if (couponErr) throw couponErr;
  if (!coupon) throw new CouponApplyError('OP_COUPON_NOT_FOUND', 'クーポンが見つかりません');
  if (coupon.status !== 'active') {
    throw new CouponApplyError('OP_COUPON_INVALID', 'クーポンが有効な状態ではありません');
  }

  const now = new Date();
  if (now < new Date(coupon.valid_from)) {
    throw new CouponApplyError('OP_COUPON_NOT_YET_VALID', 'クーポンの有効開始日前です');
  }
  if (now > new Date(coupon.valid_until)) {
    throw new CouponApplyError('OP_COUPON_EXPIRED', 'クーポンの有効期限が切れています');
  }

  if (coupon.applicable_to !== 'all') {
    const compatible =
      subscriptionTarget === 'org'
        ? coupon.applicable_to === 'org'
        : coupon.applicable_to === 'personal' || coupon.applicable_to === 'family';
    if (!compatible) {
      throw new CouponApplyError('OP_COUPON_NOT_APPLICABLE', 'このクーポンは指定の契約種別には適用できません');
    }
  }

  // 2. 対象契約の取得 + 現在価格の解決
  let userId: string | null = null;
  let organizationId: string | null = null;
  let planId: string | null = null;
  let currentPriceJpy = 0;

  if (subscriptionTarget === 'personal') {
    const { data: sub, error: subErr } = await supabase
      .from('personal_subscriptions')
      .select('id, user_id, plan_key')
      .eq('id', subscriptionId)
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub) throw new CouponApplyError('OP_SUBSCRIPTION_NOT_FOUND', '契約が見つかりません');
    userId = sub.user_id;

    const { data: plan, error: planErr } = await supabase
      .from('subscription_plans')
      .select('id, monthly_price_jpy')
      .eq('plan_key', sub.plan_key)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!plan) throw new CouponApplyError('OP_PLAN_NOT_FOUND', '契約先プランが見つかりません');
    planId = plan.id;
    currentPriceJpy = plan.monthly_price_jpy ?? 0;
  } else {
    // org_license_pools は plan_key を持たない (ライセンス数のみ管理) ため、
    // 組織の契約プランは organizations.plan (plan_key 相当) を参照する。
    // subscriptionId には organizations.id を渡す。
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, plan')
      .eq('id', subscriptionId)
      .maybeSingle();
    if (orgErr) throw orgErr;
    if (!org) throw new CouponApplyError('OP_SUBSCRIPTION_NOT_FOUND', '契約 (組織) が見つかりません');
    if (!org.plan) throw new CouponApplyError('OP_PLAN_NOT_FOUND', '組織に契約プランが設定されていません');
    organizationId = org.id;

    const { data: plan, error: planErr } = await supabase
      .from('subscription_plans')
      .select('id, monthly_price_jpy')
      .eq('plan_key', org.plan)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!plan) throw new CouponApplyError('OP_PLAN_NOT_FOUND', '契約先プランが見つかりません');
    planId = plan.id;
    currentPriceJpy = plan.monthly_price_jpy ?? 0;
  }

  const applicablePlans = (coupon.applicable_plans as string[] | null) ?? [];
  if (applicablePlans.length > 0 && planId && !applicablePlans.includes(planId)) {
    throw new CouponApplyError('OP_COUPON_NOT_APPLICABLE', 'このクーポンは対象プランに適用できません');
  }

  // 3. per_user_limit / 組織単位の上限チェック
  if (subscriptionTarget === 'personal' && userId) {
    const { count, error: countErr } = await supabase
      .from('coupon_redemptions')
      .select('*', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('user_id', userId);
    if (countErr) throw countErr;
    if ((count ?? 0) >= coupon.per_user_limit) {
      throw new CouponApplyError('OP_COUPON_LIMIT_REACHED', 'このユーザーはクーポンの利用上限に達しています');
    }
  } else if (subscriptionTarget === 'org' && organizationId) {
    const { count, error: countErr } = await supabase
      .from('coupon_redemptions')
      .select('*', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('organization_id', organizationId);
    if (countErr) throw countErr;
    if ((count ?? 0) >= coupon.per_user_limit) {
      throw new CouponApplyError('OP_COUPON_LIMIT_REACHED', 'この組織はクーポンの利用上限に達しています');
    }
  }

  // 4. max_uses の原子的 increment (上限超過を確実に拒否する)
  const incremented = await incrementCouponUsesCount(supabase, coupon.id, coupon.max_uses);
  if (!incremented) {
    throw new CouponApplyError('OP_COUPON_LIMIT_REACHED', 'クーポンの利用上限に達しています');
  }

  try {
    // 5. 既存の有効な適用を終了 (1 契約につき ended_at IS NULL は常に 1 件まで)
    const { error: endErr } = await supabase
      .from('coupon_redemptions')
      .update({ ended_at: new Date().toISOString(), end_reason: 'replaced_by_other_coupon' })
      .eq('subscription_target', subscriptionTarget)
      .eq('applied_to_subscription_id', subscriptionId)
      .is('ended_at', null);
    if (endErr) throw endErr;

    const discountAmountJpy = calculateDiscountAmount(coupon, currentPriceJpy);

    // 6. 新規 redemption 作成 (遡及適用: applied_retroactively=true, approved_by=super_admin)
    const { data: redemption, error: insertErr } = await supabase
      .from('coupon_redemptions')
      .insert({
        coupon_id: coupon.id,
        user_id: userId,
        organization_id: organizationId,
        subscription_target: subscriptionTarget,
        applied_to_subscription_id: subscriptionId,
        discount_amount_jpy: discountAmountJpy,
        duration_months: coupon.duration_months,
        applied_retroactively: true,
        approved_by: approvedBy,
      })
      .select('id')
      .single();
    if (insertErr) throw insertErr;

    // 7. personal_subscriptions.active_coupon_redemption_id を更新 (該当列がある personal のみ)
    if (subscriptionTarget === 'personal') {
      const { error: updateSubErr } = await supabase
        .from('personal_subscriptions')
        .update({ active_coupon_redemption_id: redemption.id })
        .eq('id', subscriptionId);
      if (updateSubErr) {
        // 致命的ではない (redemption 自体は記録済み) が、ログに残す
        console.error('[applyCoupon] active_coupon_redemption_id 更新失敗 (non-fatal):', updateSubErr.message);
      }
    }

    return {
      redemptionId: redemption.id,
      discountAmountJpy,
      durationMonths: coupon.duration_months,
    };
  } catch (err) {
    // uses_count の increment をロールバックしてから再 throw する
    await decrementCouponUsesCount(supabase, coupon.id);
    throw err;
  }
}
