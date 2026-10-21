/**
 * 結合テストで家族グループを作る・メンバーを足すときの前提: 代表者に家族プランの契約を入れる (billing/03 §6.6・§16.1)。
 *
 * billing/03 の migration (*_billing_paid_plans_iap.sql) から、
 *   - create_family_group は、live な家族プラン (family_basic / family_pro) の契約が無い利用者には FAMILY_PLAN_REQUIRED を返す
 *   - family_members の INSERT (招待の承諾・子供の追加・service_role の直接の INSERT) は、plan_key = free の active なグループには
 *     代表者以外の行を足せない (トリガー family_members_billing_plan_gate)
 * ので、グループを作る利用者 (代表者) に、create_family_group を呼ぶ前に家族プランを手動付与する。
 * 付与は billing/02 の DB 関数 billing_grant_manual_subscription (service_role だけが実行できる。期限なし)。
 * 付与した代表者がグループを作ると、billing/01 のトリガー (family_groups_billing_plan_follow_representative) が
 * グループの plan_key と member_limit を契約に合わせる (family_basic = 4 人・family_pro = 8 人)。
 * 契約の行は、利用者を消すと CASCADE で消える (後片付けは要らない)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** 家族グループを作れる家族プランの plan_key (subscription_plans の plan_type = family・status = public) */
export type FamilyPlanKey = 'family_basic' | 'family_pro';

/** 何も言わなければ付与する家族プラン (e2e の fresh-family と使い方ページの撮影の種まきと同じ) */
export const DEFAULT_FAMILY_PLAN_KEY: FamilyPlanKey = 'family_basic';

/** billing_grant_manual_subscription の戻り値のうち、テストが使う項目 */
export interface FamilyPlanGrant {
  subscription_id: string;
  user_id: string;
  plan_key: string;
}

/**
 * 利用者 (代表者になる人) に家族プランを手動付与する。user_profiles の行が要る (無ければ BILL_UNKNOWN_USER)。
 * すでに live な契約がある利用者には BILL_LIVE_ROW_CONFLICT で失敗し、例外になる
 */
export async function grantFamilyPlan(
  srAdmin: SupabaseClient,
  userId: string,
  planKey: FamilyPlanKey = DEFAULT_FAMILY_PLAN_KEY,
): Promise<FamilyPlanGrant> {
  const { data, error } = await srAdmin.rpc('billing_grant_manual_subscription', {
    p_user_id: userId,
    p_plan_key: planKey,
    p_expires_at: null,
  });
  if (error || !data) throw new Error(`grantFamilyPlan(${userId}, ${planKey}): ${error?.message ?? '戻り値が無い'}`);
  return data as FamilyPlanGrant;
}

/**
 * service_role の直接の INSERT で作ったグループを家族プランにする (メンバーを足す前に呼ぶ)。
 * グループの INSERT では billing/01 のトリガーが代表者の契約から plan_key を決め、契約が無ければ free にする (渡した plan_key は使わない)。
 * free のままだとメンバーの INSERT がトリガー family_members_billing_plan_gate に FAMILY_PLAN_REQUIRED で止められるので、
 * 作ったあとに service_role で plan_key を UPDATE する (UPDATE OF plan_key はそのトリガーに当たらない。service_role は特権列のガードにも当たらない)。
 * member_limit は変えない (DDL の既定 4 = family_basic の人数)
 */
export async function setFamilyGroupPlan(
  srAdmin: SupabaseClient,
  familyIds: readonly string[],
  planKey: FamilyPlanKey = DEFAULT_FAMILY_PLAN_KEY,
): Promise<void> {
  const { error } = await srAdmin.from('family_groups').update({ plan_key: planKey }).in('id', [...familyIds]);
  if (error) throw new Error(`setFamilyGroupPlan(${familyIds.join(', ')}, ${planKey}): ${error.message}`);
}
