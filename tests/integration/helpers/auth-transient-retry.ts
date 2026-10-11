/**
 * 結合テストのプロセスからローカル Supabase の認証 (GoTrue。`<NEXT_PUBLIC_SUPABASE_URL>/auth/v1/...`) を叩くときに、
 * 手前のゲートウェイ (Kong) が返す一時的な失敗 (502 / 503 / 504) と接続の失敗を、間を空けてやり直す。
 *
 * なぜ要るか: 2026-10-11 に M2 で負荷が高いときに scripts/local-ci.sh を回すと、integration:security の 2 ファイル
 * (tests/integration/rls/segment-tables-require-login.test.ts と shopping-list-requests-owner-update.test.ts) の beforeAll で、
 * admin.createUser と signInWithPassword が `{}` というメッセージのエラーで落ちた (1,707 件のテストは全部通った)。
 * auth-js は 502 / 503 / 504 を AuthRetryableFetchError にし、そのメッセージに Response を JSON にしたもの (`{}`) を入れる
 * (node_modules/@supabase/auth-js/dist/main/lib/fetch.js の handleError)。つまり認証そのものの判定ではなく、
 * ゲートウェイが GoTrue から応答を得られなかった。同じ 2 分ほどの間に認証を使うほかのファイルは通っていて、途切れは断続的だった。
 * テストの assert とは関係のない基盤の揺れなので、テストのプロセスの fetch でだけやり直す (アプリの判定には触れない)。
 *
 * やり直す範囲 (assert を弱めないための線引き):
 *   - URL が `<NEXT_PUBLIC_SUPABASE_URL>/auth/v1/` で始まるものだけ。アプリ (next dev。INTEGRATION_BASE_URL) への要求は
 *     やり直さない (例: tests/integration/security/feature-flags-runtime.test.ts はアプリの 503 を検査している)。
 *   - 状態が 502 / 503 / 504 のときと、fetch が例外を投げたとき (接続の失敗) だけ。400 / 401 / 422 / 429 など認証の判定はそのまま返す。
 *   - 送り直せる要求だけ (本文が無いか文字列。auth-js は JSON の文字列で送る)。呼び出し側が中断 (AbortSignal) したらやり直さない。
 *   - やり尽くしたら最後の応答 (または例外) をそのまま返す。テストは今までどおり赤になる (やり直しで緑を作らない)。
 *
 * 504 の注意: ゲートウェイが時間切れで諦めても、GoTrue はその要求を最後まで処理していることがある。
 *   ユーザーの作成 (POST /auth/v1/admin/users) をやり直すと、1 回目で作られていて 422 (email_exists) になりうる。
 *   この呼び出しの中で一時的な失敗を挟んだあとに限って、同じメールのユーザーを管理 API の一覧で探し、見つかればそれを作成の応答として返す。
 *   一時的な失敗を挟んでいない 422 (テストがわざと重複を作るなど) は探さずにそのまま返す。
 *   ほかの要求 (サインアップ・削除など) は 1 回目が処理済みならやり直しが 4xx になりうるが、そのときはその応答をそのまま返す (赤のまま)。
 *
 * 回数と間隔は環境変数で変えられる (INTEGRATION_AUTH_RETRY_ATTEMPTS / INTEGRATION_AUTH_RETRY_BASE_DELAY_MS)。
 * 全体の上限は vitest.integration.config.ts のフック・テストの時間切れ。
 */

/** やり直す状態 (ゲートウェイの失敗。auth-js の NETWORK_ERROR_CODES のうち、ローカルの Kong が返しうるもの) */
export const AUTH_TRANSIENT_STATUSES: readonly number[] = [502, 503, 504];

export const AUTH_RETRY_ATTEMPTS_ENV = 'INTEGRATION_AUTH_RETRY_ATTEMPTS';
export const AUTH_RETRY_BASE_DELAY_ENV = 'INTEGRATION_AUTH_RETRY_BASE_DELAY_MS';

/**
 * 1 回の呼び出しで送る回数の既定 (1 回目 + やり直し 4 回)。間隔は 2・4・8・16 秒で、待つのは合わせて 30 秒。
 * 2026-10-11 の途切れは 2 分ほどの間に断続的で、その間も認証を使うほかのファイルは通っていたので、30 秒あれば次の応答を拾える見込み。
 * 1 回ごとにゲートウェイの時間切れ (60 秒) まで待たされる最悪のときは、フックの時間切れ (既定 120 秒) が先に来て赤になる。
 */
export const DEFAULT_AUTH_RETRY_ATTEMPTS = 5;
/** 最初のやり直しまでの間隔 (ミリ秒)。以後は倍にしていく */
export const DEFAULT_AUTH_RETRY_BASE_DELAY_MS = 2_000;
/** 間隔の上限 (ミリ秒)。倍にしていっても、1 回の待ちがフックの時間切れの多くを食わないようにする */
export const AUTH_RETRY_MAX_DELAY_MS = 16_000;
/** 間隔を倍にしていく底 */
const AUTH_RETRY_BACKOFF_FACTOR = 2;
/** 422 (email_exists) のあとに作られたユーザーを探すときに一覧で読む件数 (メールの部分一致で絞るので、1 ページで足りる) */
const RECOVER_LOOKUP_PER_PAGE = 50;
/** 作成のやり直しが 422 になったときの、GoTrue の「同じメールのユーザーがいる」のエラーコード */
const EMAIL_EXISTS_CODE = 'email_exists';
const HTTP_OK = 200;
const HTTP_UNPROCESSABLE = 422;

export type AuthRetryOptions = {
  /** やり直す URL の先頭 (`<NEXT_PUBLIC_SUPABASE_URL>/auth/v1/`) */
  authBaseUrl: string;
  /** 1 回の呼び出しで送る回数 (1 以上。1 ならやり直さない) */
  attempts: number;
  /** 最初のやり直しまでの間隔 (ミリ秒) */
  baseDelayMs: number;
  /** 待ち (テストで差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** やり直したことの記録 (テストで差し替える。既定は console.warn) */
  warn?: (message: string) => void;
};

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

/** 環境変数からやり直しの設定を作る。Supabase の URL が無ければ null (やり直しを入れない) */
export function authRetryOptionsFromEnv(env: Record<string, string | undefined>): AuthRetryOptions | null {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!supabaseUrl) return null;
  return {
    authBaseUrl: `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/`,
    attempts: positiveIntFromEnv(env, AUTH_RETRY_ATTEMPTS_ENV, DEFAULT_AUTH_RETRY_ATTEMPTS),
    baseDelayMs: positiveIntFromEnv(env, AUTH_RETRY_BASE_DELAY_ENV, DEFAULT_AUTH_RETRY_BASE_DELAY_MS),
  };
}

/** n 回目のやり直しの前に待つ時間 (n は 1 から) */
export function authRetryDelayMs(baseDelayMs: number, retryIndex: number): number {
  return Math.min(baseDelayMs * AUTH_RETRY_BACKOFF_FACTOR ** (retryIndex - 1), AUTH_RETRY_MAX_DELAY_MS);
}

function urlOf(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return null; // Request は本文を送り直せないことがあるので、やり直さない
}

function isResendableBody(body: RequestInit['body']): boolean {
  return body === undefined || body === null || typeof body === 'string';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 作成の要求の本文からメールを取る (無ければ null) */
function emailOfCreateBody(body: RequestInit['body']): string | null {
  if (typeof body !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'email' in parsed && typeof parsed.email === 'string') {
      return parsed.email;
    }
  } catch {
    return null;
  }
  return null;
}

async function isEmailExists(response: Response): Promise<boolean> {
  if (response.status !== HTTP_UNPROCESSABLE) return false;
  try {
    const data: unknown = await response.clone().json();
    if (typeof data !== 'object' || data === null) return false;
    const code = 'code' in data ? data.code : undefined;
    const errorCode = 'error_code' in data ? data.error_code : undefined;
    return code === EMAIL_EXISTS_CODE || errorCode === EMAIL_EXISTS_CODE;
  } catch {
    return false;
  }
}

/** 一時的な失敗のあとの 422 (email_exists) で、1 回目に作られていたユーザーを探す。見つからなければ null */
async function findCreatedUser(baseFetch: FetchFn, url: string, init: RequestInit | undefined, email: string): Promise<Response | null> {
  const headers = new Headers(init?.headers);
  headers.delete('content-type');
  const lookupUrl = `${url}?${new URLSearchParams({ filter: email, per_page: String(RECOVER_LOOKUP_PER_PAGE) }).toString()}`;
  let res: Response;
  try {
    res = await baseFetch(lookupUrl, { method: 'GET', headers });
  } catch {
    return null;
  }
  if (res.status !== HTTP_OK) return null;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || !('users' in data) || !Array.isArray(data.users)) return null;
  const wanted = email.toLowerCase();
  const user: unknown = data.users.find(
    (u: unknown) => typeof u === 'object' && u !== null && 'email' in u && typeof u.email === 'string' && u.email.toLowerCase() === wanted,
  );
  if (user === undefined) return null;
  return new Response(JSON.stringify(user), { status: HTTP_OK, headers: { 'content-type': 'application/json' } });
}

/** 認証の URL への要求だけ、一時的な失敗をやり直す fetch を返す (それ以外の要求はそのまま baseFetch に渡す) */
export function withAuthTransientRetry(baseFetch: FetchFn, options: AuthRetryOptions): FetchFn {
  const sleep = options.sleep ?? defaultSleep;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const createUsersUrl = `${options.authBaseUrl}admin/users`;

  return async (input, init) => {
    const url = urlOf(input);
    if (url === null || !url.startsWith(options.authBaseUrl) || !isResendableBody(init?.body)) {
      return baseFetch(input, init);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    const label = `${method} ${new URL(url).pathname}`;
    let sawTransient = false;

    for (let attempt = 1; ; attempt += 1) {
      const isLast = attempt >= options.attempts;
      let response: Response;
      try {
        response = await baseFetch(input, init);
      } catch (error) {
        if (isLast || init?.signal?.aborted) throw error;
        sawTransient = true;
        const delay = authRetryDelayMs(options.baseDelayMs, attempt);
        warn(`[auth-transient-retry] ${label}: 接続に失敗 (${String(error)})。${attempt}/${options.attempts} 回目。${delay}ms 後にやり直す`);
        await sleep(delay);
        continue;
      }

      if (AUTH_TRANSIENT_STATUSES.includes(response.status)) {
        if (isLast || init?.signal?.aborted) return response;
        sawTransient = true;
        const delay = authRetryDelayMs(options.baseDelayMs, attempt);
        warn(`[auth-transient-retry] ${label}: ゲートウェイの失敗 ${response.status}。${attempt}/${options.attempts} 回目。${delay}ms 後にやり直す`);
        await sleep(delay);
        continue;
      }

      if (sawTransient && method === 'POST' && url === createUsersUrl && (await isEmailExists(response))) {
        const email = emailOfCreateBody(init?.body);
        const recovered = email === null ? null : await findCreatedUser(baseFetch, url, init, email);
        if (recovered) {
          warn(`[auth-transient-retry] ${label}: やり直しが 422 (${EMAIL_EXISTS_CODE})。失敗に見えた 1 回目で作られていたユーザーを返す`);
          return recovered;
        }
      }
      return response;
    }
  };
}

/**
 * 差し替えた fetch に付ける印。グローバルのシンボルにするのは、テストのファイルごとにこのモジュールが評価し直されても
 * (同じプロセスで setupFiles が何度も走っても) 印を読めるようにするため。二重に包むと、やり直しの回数が掛け算になる
 */
const INSTALLED_MARK = Symbol.for('homegohan.integration.authTransientRetry');

type FetchHolder = { fetch: FetchFn };

/**
 * target.fetch (既定は globalThis) を、認証の一時的な失敗をやり直すものに差し替える。tests/integration/setup.ts から呼ぶ。
 * すでに差し替えてあれば何もしない。Supabase の URL が環境変数に無ければ何もしない。差し替えたら true
 */
export function installAuthTransientRetry(env: Record<string, string | undefined>, target: FetchHolder = globalThis): boolean {
  if (Reflect.get(target.fetch, INSTALLED_MARK) === true) return false;
  const options = authRetryOptionsFromEnv(env);
  if (!options) return false;
  const wrapped = withAuthTransientRetry(target.fetch.bind(target), options);
  Object.defineProperty(wrapped, INSTALLED_MARK, { value: true });
  target.fetch = wrapped;
  return true;
}
