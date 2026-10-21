/**
 * tests/e2e/helpers/billing-plan.ts
 *
 * E2E の利用者に有料プランを手動付与する道具 (billing/03 §16.1 の E2E の行)。
 *
 * billing/03 の migration (*_billing_paid_plans_iap.sql) から、
 *   - 家族グループにメンバーを足せるのは、代表者に live な家族プラン (family_basic / family_pro) の契約があるときだけ
 *     (create_family_group の門と、family_members の INSERT のトリガー family_members_billing_plan_gate。FAMILY_PLAN_REQUIRED)
 *   - 無料の利用者の AI は 1 日 3 回・献立の作成は 1 日 3 回 (ai_daily_limits と ai_plan_feature_caps。超えると 429)
 * になったので、家族を組み立てる fixture と、1 人で献立の作成を 4 回以上送る spec は、最初にこの関数で有料プランを付与する。
 *
 * 付与は billing/02 の DB 関数 billing_grant_manual_subscription (service_role だけが実行できる。
 * 引数は 20261017230000_billing_manual_plan_grant.sql の p_user_id uuid, p_plan_key text, p_expires_at timestamptz DEFAULT NULL)。
 * 結合テストの tests/integration/helpers/family-plan.ts の grantFamilyPlan と同じ RPC。
 * user_profiles の行が要る (無ければ BILL_UNKNOWN_USER) ので、利用者のプロファイルを作ってから呼ぶ。
 * 契約の行は利用者を消すと CASCADE で消える (fixture の後片付けは利用者の削除だけでよい)。
 */

/**
 * 手動付与できる有料プランの plan_key (subscription_plans の plan_type = personal / family・status = public・free 以外)。
 * billing/03 段 B の packages/shared/src/billing-plans.ts の PaidPlanKey と同じ 3 つ
 */
export type ManualGrantPlanKey = "pro" | "family_basic" | "family_pro";

/** 家族を組み立てる fixture が代表者に付与する家族プラン (family_basic = 4 人。結合テストの DEFAULT_FAMILY_PLAN_KEY と同じ) */
export const E2E_FAMILY_PLAN_KEY: ManualGrantPlanKey = "family_basic";

/** 1 人で献立の作成を 4 回以上送る spec が付与するプラン (pro は献立の作成 10 回・1 日の AI 30 回。billing/03 §6.5) */
export const E2E_PAID_PERSONAL_PLAN_KEY: ManualGrantPlanKey = "pro";

/** 失敗のときに例外の文へ載せる応答の本文の先頭の文字数 (ほかの E2E の道具と同じ長さ) */
const ERROR_BODY_PREVIEW_CHARS = 300;

function getSupabaseConfig(): { supabaseUrl: string; serviceRoleKey: string } {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[billing-plan helper] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定です。",
    );
  }
  return { supabaseUrl, serviceRoleKey };
}

/**
 * 利用者に有料プランを期限なしで手動付与する。
 * すでに live な契約がある利用者には BILL_LIVE_ROW_CONFLICT で失敗し、例外になる (共有の利用者には使わない)
 */
export async function grantManualPlanForE2e(userId: string, planKey: ManualGrantPlanKey): Promise<void> {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/billing_grant_manual_subscription`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ p_user_id: userId, p_plan_key: planKey, p_expires_at: null }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `[billing-plan helper] billing_grant_manual_subscription(${userId}, ${planKey}) 失敗 (${resp.status}): ${text.substring(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
}
