/**
 * 結合テストのプロセスから、ローカル Supabase の入口のゲートウェイ (Kong) の一時的な失敗をやり直すときの共通の部品。
 *
 * 使うのは 2 か所で、受け持つ要求が重ならない:
 *   - helpers/auth-transient-retry.ts (#1475): 認証 (`/auth/v1/`) への要求を、プロセスの fetch でやり直す
 *   - helpers/setup-transient-retry.ts (#1779): テストの準備の、冪等な REST (PostgREST。`/rest/v1/`) の問い合わせを、呼び出しごとにやり直す
 * 考え方 (やり直す状態・回数・間隔の伸ばし方・上限) を 1 か所に置き、両方がこれを使う。
 */

/**
 * ゲートウェイの一時的な失敗の状態。ローカルの Kong が、奥の GoTrue / PostgREST から応答を得られなかったときに返す
 * (502 = 奥が不正な応答を返した / 503 = 奥がまだ受け付けていない / 504 = 奥の応答が時間内に来なかった)。
 * 2026-10-11 (#1475) には認証で、2026-10-16 (#1779) には REST の準備で、同じ HEAD の流し直しで緑になる失敗として出た
 */
export const GATEWAY_TRANSIENT_STATUSES: readonly number[] = [502, 503, 504];

/**
 * 1 回の呼び出しで送る回数の既定 (1 回目 + やり直し 4 回)。間隔は 2・4・8・16 秒で、待つのは合わせて 30 秒。
 * 2026-10-11 の途切れは 2 分ほどの間に断続的で、その間も同じ Supabase を使うほかのファイルは通っていたので、30 秒あれば次の応答を拾える見込み。
 * 1 回ごとにゲートウェイの時間切れ (60 秒) まで待たされる最悪のときは、フックの時間切れ (既定 120 秒。vitest.integration.config.ts) が先に来て赤になる。
 */
export const DEFAULT_GATEWAY_RETRY_ATTEMPTS = 5;
/** 最初のやり直しまでの間隔 (ミリ秒)。以後は倍にしていく */
export const DEFAULT_GATEWAY_RETRY_BASE_DELAY_MS = 2_000;
/** 間隔の上限 (ミリ秒)。倍にしていっても、1 回の待ちがフックの時間切れの多くを食わないようにする */
export const GATEWAY_RETRY_MAX_DELAY_MS = 16_000;
/** 間隔を倍にしていく底 */
const GATEWAY_RETRY_BACKOFF_FACTOR = 2;

/** 環境変数の正の整数。無い・空なら既定。整数でなければ設定の誤りとして止める (黙って既定に戻さない) */
export function positiveIntFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} は正の整数にしてください: ${raw}`);
  }
  return value;
}

/** n 回目のやり直しの前に待つ時間 (n は 1 から)。baseDelayMs から倍にしていき、GATEWAY_RETRY_MAX_DELAY_MS で止める */
export function gatewayRetryDelayMs(baseDelayMs: number, retryIndex: number): number {
  return Math.min(baseDelayMs * GATEWAY_RETRY_BACKOFF_FACTOR ** (retryIndex - 1), GATEWAY_RETRY_MAX_DELAY_MS);
}

/** 既定の待ち (テストでは差し替える) */
export function defaultGatewayRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
