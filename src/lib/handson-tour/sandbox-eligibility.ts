import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/db-logger';

/**
 * ハンズオンツアーの sandbox 書き込み (リクエスト body の sandbox: true) を
 * 許可してよいユーザーかを判定する共通処理。
 *
 * menu-plans/add (#1025) と meal-plans/add-from-photo (#1109) で共有する。
 * 以前は各 route に同じ判定をコピーしていたため、#1025 で menu-plans/add だけを直しても
 * add-from-photo には反映されず、user_profiles を存在しない user_id 列で引いて常に失敗する
 * (= 後続の 2 ゲートが素通りする) 状態が残っていた (#1109)。判定を 1 か所に集めて再発を防ぐ。
 *
 * 方針は fail-closed。判定に必要な情報が取れないときは「許可しない」側に倒す。
 * 判定の順番は次のとおり。
 *   1. プロファイルの取得        (取れなければ 404 profile_not_found)
 *   2. ツアー完了/スキップ済み    (409 already_finished)
 *   3. 管理者ロール              (403 admin_role)
 *   4. 既存の通常データがある     (409 existing_user。RPC が失敗したときも同じ)
 */

const ADMIN_ROLES = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'] as const;

const LOGGER_NAME = 'handson-tour/sandbox-eligibility';

export type SandboxIneligibleReason = 'already_finished' | 'admin_role' | 'existing_user';

export type SandboxEligibilityError =
  | { code: 'profile_not_found'; message: string }
  | { code: 'sandbox_not_eligible'; message: string; reason: SandboxIneligibleReason };

export type SandboxEligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      /** そのまま HTTP ステータスとして返す値 */
      status: 403 | 404 | 409;
      /** `{ error: ... }` の中身としてそのまま返す値 */
      error: SandboxEligibilityError;
    };

function notEligible(status: 403 | 409, reason: SandboxIneligibleReason): SandboxEligibilityResult {
  return {
    eligible: false,
    status,
    error: {
      code: 'sandbox_not_eligible',
      message: 'サンドボックスの利用条件を満たしていません',
      reason,
    },
  };
}

/**
 * @param supabase ログイン中ユーザーのセッションで作った Supabase クライアント。
 *   user_has_non_sandbox_activity は auth.uid() を使うため、service_role のクライアントを渡してはいけない
 *   (auth.uid() が NULL になり、常に「既存データなし」と判定されてしまう)。
 * @param userId   認証済みユーザーの id (auth.getUser() で得た user.id)
 */
export async function checkSandboxEligibility(
  supabase: SupabaseClient<any>,
  userId: string,
): Promise<SandboxEligibilityResult> {
  // user_profiles の主キーは id (auth.users(id) を参照) で、user_id 列は存在しない。
  // .eq('user_id', ...) だと PostgREST が 42703 を返し、error を見ないと profile が常に
  // null になって以降のゲートが素通りしてしまう (#1109)。必ず id で引き、error も見る。
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('handson_tour_completed_at, handson_tour_skipped_at, roles')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    createLogger(LOGGER_NAME)
      .withUser(userId)
      .error(
        'user_profiles fetch error (sandbox eligibility)',
        profileError ?? new Error('user_profiles row not found'),
        { code: profileError?.code ?? null, found: Boolean(profile) },
      );
    return {
      eligible: false,
      status: 404,
      error: { code: 'profile_not_found', message: 'プロファイルが見つかりません' },
    };
  }

  if (profile.handson_tour_completed_at || profile.handson_tour_skipped_at) {
    return notEligible(409, 'already_finished');
  }

  const hasAdminRole =
    Array.isArray(profile.roles) &&
    profile.roles.some((r: string) => (ADMIN_ROLES as readonly string[]).includes(r));
  if (hasAdminRole) {
    return notEligible(403, 'admin_role');
  }

  const { data: hasActivity, error: activityError } = await supabase.rpc('user_has_non_sandbox_activity');
  if (activityError) {
    // 判定不能は拒否側に倒す (fail-closed、#1025 round-3)
    createLogger(LOGGER_NAME)
      .withUser(userId)
      .error('user_has_non_sandbox_activity RPC error (sandbox eligibility)', activityError, {
        code: activityError.code ?? null,
      });
    return notEligible(409, 'existing_user');
  }
  if (hasActivity) {
    return notEligible(409, 'existing_user');
  }

  return { eligible: true };
}
