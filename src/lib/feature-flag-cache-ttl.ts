/**
 * 機能フラグの行をメモリに覚える時間 (ms) の読み方 (#1496)。
 *
 * 既定は 30 秒 (FEATURE_FLAG_CACHE_TTL_DEFAULT_MS)。運営画面で切り替えてから全員に反映されるまでの、最大の遅れになる。
 * 環境変数 FEATURE_FLAG_CACHE_TTL_MS (正の整数のミリ秒) で上書きできる。上書きするのは、結合テストの段
 * (.github/workflows/security-regression.yml と scripts/local-ci.sh の integration) が起動する next dev と、
 * そのサーバーに対して切り替えの反映を待つ tests/integration/security/feature-flags-runtime.test.ts だけ
 * (本物の 30 秒を待つと、ON と OFF の 2 回の反映待ちで 1 テストに 1 分以上かかるため)。本番 (Vercel) には足さない。
 * 未設定・正の整数でない (空・0・負・小数・数字でない) ときは既定値。
 *
 * middleware (Edge Runtime) からも読むので、何も import しない (zod を持つ src/lib/env.ts に到達させない)。
 * この変数を読むのはこのファイルだけ (src/lib/env.ts の一覧の readOnlyBy)。
 */

/** フラグの行をメモリに覚える時間の既定 (ms)。運営画面で切り替えてから全員に反映されるまでの、最大の遅れ */
export const FEATURE_FLAG_CACHE_TTL_DEFAULT_MS = 30_000;

/** 上書きの環境変数の名前 */
export const FEATURE_FLAG_CACHE_TTL_ENV = 'FEATURE_FLAG_CACHE_TTL_MS';

/**
 * フラグの行をメモリに覚える時間 (ms)。環境変数 FEATURE_FLAG_CACHE_TTL_MS が正の整数ならその値、
 * 未設定・正の整数でないときは FEATURE_FLAG_CACHE_TTL_DEFAULT_MS
 */
export function resolveFeatureFlagCacheTtlMs(
  value: string | undefined = process.env.FEATURE_FLAG_CACHE_TTL_MS,
): number {
  if (value === undefined || value.trim() === '') return FEATURE_FLAG_CACHE_TTL_DEFAULT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : FEATURE_FLAG_CACHE_TTL_DEFAULT_MS;
}
