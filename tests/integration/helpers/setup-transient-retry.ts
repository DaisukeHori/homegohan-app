/**
 * 結合テストの準備 (service_role で既知の行を upsert する・行を読む) の REST (PostgREST。`<NEXT_PUBLIC_SUPABASE_URL>/rest/v1/`) の
 * 問い合わせが、手前のゲートウェイ (Kong) の一時的な失敗を受けたときに、間を空けてやり直す (#1779)。
 *
 * なぜ要るか: 2026-10-16 だけで少なくとも 6 本の枝と PR (#1769 の health-goals・#1777 の org-challenges-api など) の結合テストが、
 * Kong の `An invalid response was received from the upstream server` (状態 502) で落ちた。同じ HEAD の流し直しでは緑になり、差分とは無関係。
 * supabase-js (postgrest-js) は、この応答を `{ error: { message: 'An invalid response ...' }, status: 502 }` の結果にする
 * (自前のやり直しは GET / HEAD の 503・520 だけで、502・504 と upsert (POST) はやり直さない)。
 *
 * 線引き (検査を緩めないため):
 *   - やり直すのは、retryIdempotentSetup に渡した op の中の問い合わせだけ。op には select と upsert しか作れない db が渡り
 *     (rpc・insert・update・delete・auth は型にも実物にも無い)、op が返す問い合わせがその db から作ったものでなければ、送る前に止める。
 *     テストの本体 (アプリの API・状態を変える RPC) や、helpers の外でそのまま書いた問い合わせには効かない (プロセスの fetch を差し替えない)。
 *   - やり直すのは、結果の状態が 502 / 503 / 504 のときと、エラーのメッセージが Kong の upstream の文のときだけ。
 *     400 / 401 / 403 / 409 など、PostgREST や DB の判定はそのまま返す。
 *   - やり尽くしたら最後の結果をそのまま返す。呼び出し側は今までどおりそのエラーで落ちる (やり直しで緑を作らない)。
 *   - 認証 (`/auth/v1/`) は helpers/auth-transient-retry.ts (#1475) がプロセスの fetch でやり直すので、ここでは扱わない
 *     (op の結果の型は PostgREST の結果 (status / statusText を持つ) に限るので、認証の呼び出しは渡せない。回数が掛け算にならない)。
 *
 * upsert が冪等であること: 既知の主キー・一意キーの行を同じ値で upsert するので、504 で 1 回目が DB で処理済みだったとしても、
 * やり直しは同じ行を同じ値にするだけで結果は変わらない。insert (重複で 409 になる) と update・delete・RPC はやり直さない。
 *
 * 回数と間隔は環境変数で変えられる (INTEGRATION_SETUP_RETRY_ATTEMPTS / INTEGRATION_SETUP_RETRY_BASE_DELAY_MS)。
 * 既定と間隔の伸ばし方は認証のやり直しと同じ (helpers/gateway-transient.ts)。全体の上限は vitest.integration.config.ts のフックの時間切れ。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DEFAULT_GATEWAY_RETRY_ATTEMPTS,
  DEFAULT_GATEWAY_RETRY_BASE_DELAY_MS,
  GATEWAY_RETRY_MAX_DELAY_MS,
  GATEWAY_TRANSIENT_STATUSES,
  defaultGatewayRetrySleep,
  gatewayRetryDelayMs,
  positiveIntFromEnv,
} from './gateway-transient';

/** やり直す状態 (ゲートウェイの失敗)。認証のやり直し (AUTH_TRANSIENT_STATUSES) と同じ値 */
export const SETUP_TRANSIENT_STATUSES: readonly number[] = GATEWAY_TRANSIENT_STATUSES;

/** Kong が奥 (PostgREST) から不正な応答を受けたときの本文の message。supabase-js はこれを error.message に入れる */
export const UPSTREAM_INVALID_RESPONSE_MESSAGE = 'An invalid response was received from the upstream server';

export const SETUP_RETRY_ATTEMPTS_ENV = 'INTEGRATION_SETUP_RETRY_ATTEMPTS';
export const SETUP_RETRY_BASE_DELAY_ENV = 'INTEGRATION_SETUP_RETRY_BASE_DELAY_MS';

/** 1 回の呼び出しで送る回数の既定 (1 回目 + やり直し 4 回。根拠は helpers/gateway-transient.ts の DEFAULT_GATEWAY_RETRY_ATTEMPTS) */
export const DEFAULT_SETUP_RETRY_ATTEMPTS = DEFAULT_GATEWAY_RETRY_ATTEMPTS;
/** 最初のやり直しまでの間隔 (ミリ秒)。以後は倍にしていく */
export const DEFAULT_SETUP_RETRY_BASE_DELAY_MS = DEFAULT_GATEWAY_RETRY_BASE_DELAY_MS;
/** 間隔の上限 (ミリ秒) */
export const SETUP_RETRY_MAX_DELAY_MS = GATEWAY_RETRY_MAX_DELAY_MS;

export type SetupRetryOptions = {
  /** 1 回の呼び出しで送る回数 (1 以上。1 ならやり直さない) */
  attempts: number;
  /** 最初のやり直しまでの間隔 (ミリ秒) */
  baseDelayMs: number;
  /** 待ち (テストで差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** やり直したことの記録 (テストで差し替える。既定は console.warn) */
  warn?: (message: string) => void;
};

/** 環境変数からやり直しの設定を作る (値が正の整数でなければ止める) */
export function setupRetryOptionsFromEnv(env: Record<string, string | undefined>): SetupRetryOptions {
  return {
    attempts: positiveIntFromEnv(env, SETUP_RETRY_ATTEMPTS_ENV, DEFAULT_SETUP_RETRY_ATTEMPTS),
    baseDelayMs: positiveIntFromEnv(env, SETUP_RETRY_BASE_DELAY_ENV, DEFAULT_SETUP_RETRY_BASE_DELAY_MS),
  };
}

/** n 回目のやり直しの前に待つ時間 (n は 1 から) */
export function setupRetryDelayMs(baseDelayMs: number, retryIndex: number): number {
  return gatewayRetryDelayMs(baseDelayMs, retryIndex);
}

/** PostgREST の結果 (supabase-js の from(...).select / upsert を await したもの) のうち、ここで読む部分 */
export interface PostgrestResultLike {
  readonly error: { readonly message: string } | null;
  readonly status: number;
  readonly statusText: string;
}

/** ゲートウェイの一時的な失敗の結果か (状態が 502 / 503 / 504、またはメッセージが Kong の upstream の文) */
export function isTransientGatewayResult(result: PostgrestResultLike): boolean {
  if (result.error === null) return false;
  return SETUP_TRANSIENT_STATUSES.includes(result.status) || result.error.message.includes(UPSTREAM_INVALID_RESPONSE_MESSAGE);
}

type QueryBuilder = ReturnType<SupabaseClient['from']>;
/** 準備で使ってよい表の操作 (冪等なものだけ。insert・update・delete は無い) */
export type IdempotentSetupTable = Pick<QueryBuilder, 'select' | 'upsert'>;
/** op に渡す db。表の select と upsert だけを作れる (rpc・auth・storage は無い) */
export interface IdempotentSetupDb {
  from(relation: string): IdempotentSetupTable;
}

/** IdempotentSetupTable に載せる操作の名前 (実物の表の、これ以外の操作は見えなくする) */
const IDEMPOTENT_TABLE_METHODS: ReadonlySet<PropertyKey> = new Set<keyof IdempotentSetupTable>(['select', 'upsert']);

/**
 * client の表の select / upsert だけを見せる db を作る。作った問い合わせは issued に記録する
 * (postgrest-js の絞り込み (eq・in・single など) は同じ問い合わせを返すので、op が返したものが issued にあれば、この db から作ったもの)
 */
function idempotentSetupDb(client: Pick<SupabaseClient, 'from'>, issued: WeakSet<object>): IdempotentSetupDb {
  return Object.freeze({
    from(relation: string): IdempotentSetupTable {
      const table = client.from(relation);
      return new Proxy(table, {
        get(target, prop) {
          if (!IDEMPOTENT_TABLE_METHODS.has(prop)) return undefined;
          const method: unknown = Reflect.get(target, prop);
          if (typeof method !== 'function') return undefined;
          return (...args: unknown[]): unknown => {
            const built: unknown = Reflect.apply(method, target, args);
            if (typeof built === 'object' && built !== null) issued.add(built);
            return built;
          };
        },
        has(_target, prop) {
          return IDEMPOTENT_TABLE_METHODS.has(prop);
        },
      });
    },
  });
}

/**
 * テストの準備の冪等な問い合わせ (表の select・既知の行の upsert) を、ゲートウェイの一時的な失敗のときだけやり直す。
 *
 *   const { error } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
 *     db.from('user_profiles').upsert({ id: userId, ... }, { onConflict: 'id' }),
 *   );
 *
 * op は、渡された db から作った問い合わせを (await せずに) そのまま返すこと。外の client で作ったもの・async の関数の Promise を返すと、
 * 送る前に Error を投げる (本体の検査や状態を変える呼び出しを、やり直しで包まないため)。op は 1 回ごとに呼び直す (問い合わせは 1 回きりのため)。
 * やり直したときは console.warn に回数と元のエラーを出す。結果はそのまま返す (エラーの扱いは呼び出し側のまま)。
 */
export async function retryIdempotentSetup<R extends PostgrestResultLike>(
  client: Pick<SupabaseClient, 'from'>,
  label: string,
  op: (db: IdempotentSetupDb) => PromiseLike<R>,
  options: SetupRetryOptions = setupRetryOptionsFromEnv(process.env),
): Promise<R> {
  const sleep = options.sleep ?? defaultGatewayRetrySleep;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  for (let attempt = 1; ; attempt += 1) {
    const issued = new WeakSet<object>();
    const pending = op(idempotentSetupDb(client, issued));
    if (!issued.has(pending)) {
      throw new Error(
        `[setup-transient-retry] ${label}: op は渡された db の select / upsert から作った問い合わせを、await せずにそのまま返してください (外の client の問い合わせ・async の関数はやり直さない)`,
      );
    }
    const result = await pending;
    if (!isTransientGatewayResult(result)) return result;
    if (attempt >= options.attempts) {
      if (attempt > 1) {
        warn(`[setup-transient-retry] ${label}: ゲートウェイの失敗 ${result.status} (${result.error?.message ?? ''}) が ${attempt} 回続いた。最後の結果をそのまま返す`);
      }
      return result;
    }
    const delay = setupRetryDelayMs(options.baseDelayMs, attempt);
    warn(
      `[setup-transient-retry] ${label}: ゲートウェイの失敗 ${result.status} (${result.error?.message ?? ''})。${attempt}/${options.attempts} 回目。${delay}ms 後にやり直す`,
    );
    await sleep(delay);
  }
}
