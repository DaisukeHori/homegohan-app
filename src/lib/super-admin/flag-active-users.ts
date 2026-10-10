/**
 * 機能フラグごとの「今 ON になっているユーザー数」(active_user_count) の算出 (#1148)
 *
 * GET /api/super-admin/flags が返す active_user_count。以前は常に 0 を返していた。
 * 実際の判定 (evaluateFlag) を、全ユーザーに対して実行して数える。段階公開 (percentage / plan / role / org) と
 * 条件 (constraints) をアプリの判定と同じ関数で数えるので、運営画面の数字と、実際に ON になる人数が食い違わない。
 *
 * 数え方:
 *   - enabled = false のフラグ: 0 (ユーザーを読まない)
 *   - 全員が対象で条件も無いフラグ (rollout が all または未設定、constraints なし): ユーザー総数 (件数だけを読む)
 *   - それ以外 (percentage / plan / role / org、条件あり): user_profiles の判定に要る列だけを読んで 1 人ずつ判定する
 *     ユーザーが上限 (activeUserCountScanLimit。既定 ACTIVE_USER_COUNT_SCAN_LIMIT) 人を超えるときは、読み込みに時間がかかりすぎるので数えず null を返す (画面側は「算出できない」扱い)
 *
 * 読むのは user_profiles の id / roles / organization_id / plan_key_cached / created_at だけ (メール・名前などは読まない)。
 * 呼び出し側は、super_admin の認可を通したあとに、サービスロールのクライアントを渡すこと
 * (user_profiles は RLS で本人の行しか見えないため)。結果は人数だけで、ユーザーの情報は返さない。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateFlag, type FeatureFlagRecord, type UserFlagContext } from './evaluate-flag';

/**
 * これより多いユーザーは、1 人ずつ判定しない (運営画面の表示のために、数万件を毎回読まない) ときの既定の上限。
 * 運用で変えるときは、環境変数 FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT (正の整数) で上書きする
 */
export const ACTIVE_USER_COUNT_SCAN_LIMIT = 20_000;

/**
 * 1 人ずつ判定するユーザー数の上限。環境変数 FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT が正の整数ならその値、
 * 未設定・正の整数でない (空・0・負・小数・数字でない) ときは ACTIVE_USER_COUNT_SCAN_LIMIT
 */
export function activeUserCountScanLimit(
  value: string | undefined = process.env.FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT,
): number {
  if (value === undefined || value.trim() === '') return ACTIVE_USER_COUNT_SCAN_LIMIT;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : ACTIVE_USER_COUNT_SCAN_LIMIT;
}
/** PostgREST の 1 回の取得件数の上限 (既定の max-rows) に合わせる */
const PAGE_SIZE = 1_000;

type Reader = Pick<SupabaseClient, 'from'>;

/** 全員が対象で、条件も無いフラグか (ON なら、ユーザー総数がそのまま答えになる) */
function isUnconditional(flag: FeatureFlagRecord): boolean {
  const rollout = flag.rollout_strategy;
  if (rollout && rollout.type !== 'all') return false;

  const c = flag.constraints;
  if (!c) return true;
  return !(
    typeof c.min_user_age_days === 'number' ||
    (c.exclude_plans?.length ?? 0) > 0 ||
    (c.include_plans?.length ?? 0) > 0 ||
    (c.include_roles?.length ?? 0) > 0 ||
    (c.include_org_ids?.length ?? 0) > 0
  );
}

async function countAllUsers(reader: Reader): Promise<number> {
  const { count, error } = await reader.from('user_profiles').select('id', { count: 'exact', head: true });
  if (error) {
    throw new Error(`user_profiles の件数の取得に失敗しました: ${error.message} (code: ${error.code ?? 'unknown'})`);
  }
  return count ?? 0;
}

async function loadAllUserContexts(reader: Reader, scanLimit: number): Promise<UserFlagContext[]> {
  const contexts: UserFlagContext[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await reader
      .from('user_profiles')
      .select('id, roles, organization_id, plan_key_cached, created_at')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`user_profiles の取得に失敗しました: ${error.message} (code: ${error.code ?? 'unknown'})`);
    }

    const rows = (data ?? []) as Array<{
      id: string;
      roles: string[] | null;
      organization_id: string | null;
      plan_key_cached: string | null;
      created_at: string | null;
    }>;
    for (const row of rows) {
      contexts.push({
        userId: row.id,
        roles: row.roles ?? [],
        organizationId: row.organization_id ?? null,
        // plan_key_cached が空のユーザーは無料プランとして扱う (src/lib/feature-flags.ts と同じ)
        planKey: row.plan_key_cached ?? 'free',
        accountCreatedAt: row.created_at ?? null,
      });
    }

    if (rows.length < PAGE_SIZE) break;
    // 読み込みの途中で増えた分まで追いかけない。上限を超えたら打ち切る (呼び出し側は null を返す)
    if (contexts.length > scanLimit) break;
  }

  return contexts;
}

/**
 * 各フラグの active_user_count を返す (key -> 人数)。数えられなかったフラグは null。
 * ユーザーの読み出しに失敗したときは例外を投げる (呼び出し側が、ログに残して全フラグを null にする)。
 */
export async function countActiveUsersForFlags(
  reader: Reader,
  flags: readonly FeatureFlagRecord[],
): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>();

  const enabledFlags = flags.filter((flag) => flag.enabled);
  for (const flag of flags) {
    if (!flag.enabled) counts.set(flag.key, 0);
  }
  if (enabledFlags.length === 0) return counts;

  const total = await countAllUsers(reader);

  const needsEvaluation: FeatureFlagRecord[] = [];
  for (const flag of enabledFlags) {
    if (isUnconditional(flag)) counts.set(flag.key, total);
    else needsEvaluation.push(flag);
  }
  if (needsEvaluation.length === 0) return counts;

  const scanLimit = activeUserCountScanLimit();
  if (total > scanLimit) {
    for (const flag of needsEvaluation) counts.set(flag.key, null);
    return counts;
  }

  const users = await loadAllUserContexts(reader, scanLimit);
  if (users.length > scanLimit) {
    // 件数を数えたあとに、上限を超えるほど増えた
    for (const flag of needsEvaluation) counts.set(flag.key, null);
    return counts;
  }

  for (const flag of needsEvaluation) {
    let active = 0;
    for (const user of users) {
      if (evaluateFlag(flag, user)) active++;
    }
    counts.set(flag.key, active);
  }
  return counts;
}
