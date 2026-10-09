/**
 * Web / モバイル共通の HTTP クライアント (#1168)
 *
 * - タイムアウト: 1 回の通信ごとに timeoutMs (既定 20 秒) で打ち切る。AbortController を使うので、
 *   打ち切った通信は本当に止まる。打ち切ると kind が 'timeout' の HttpNetworkError を投げる。
 * - 応答なし: fetch が応答を受け取れずに失敗したとき (圏外・機内モード・接続の切断など) は、
 *   kind が 'offline' の HttpNetworkError を投げる。画面側は isHttpNetworkError() で見分けて
 *   「通信できません」と案内できる。
 * - リトライ: 何度やっても結果が変わらない失敗や、二重に実行してはいけない呼び出しはやり直さない。
 *   - やり直すのは GET / HEAD / PUT / DELETE だけ (POST と PATCH は既定ではやり直さない。
 *     AI の生成のように、二重に走ると困る呼び出しがあるため)。呼び出しごとに retry を渡せば、明示的に有効にできる。
 *   - やり直す失敗は、応答を受け取れなかったとき (offline) と、HTTP の 408 / 429 / 5xx (ただし 501 と 505 は除く)。
 *   - タイムアウトはやり直さない。待ち時間が (やり直しの回数 + 1) 倍になり、サーバーが重いときに追い打ちになるため。
 *   - 最大 2 回まで。待ち時間は指数的に増やし、乱数で散らす。サーバーが Retry-After を返したときはそれ以上待つ。
 */

export type GetAccessToken = () => Promise<string | null> | string | null;

/** 1 回の通信を待つ上限の既定値 (ミリ秒) */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 通信が成り立たなかった理由
 * - timeout: 待ち時間 (timeoutMs) を過ぎても、応答を最後まで受け取れなかった
 * - offline: 応答を受け取れなかった (圏外・機内モード・接続の切断など)
 */
export type HttpNetworkErrorKind = "timeout" | "offline";

/**
 * サーバーから HTTP の応答を受け取れなかったときのエラー。
 * HTTP のエラー応答 (4xx / 5xx) はこれではなく、従来どおり `HTTP <status> <statusText>: <本文>` の Error になる。
 */
export class HttpNetworkError extends Error {
  readonly kind: HttpNetworkErrorKind;
  /** kind が 'timeout' のとき、待った時間 (ミリ秒) */
  readonly timeoutMs?: number;

  constructor(kind: HttpNetworkErrorKind, message: string, options: { cause?: unknown; timeoutMs?: number } = {}) {
    super(message);
    this.name = "HttpNetworkError";
    this.kind = kind;
    this.timeoutMs = options.timeoutMs;
    if (options.cause !== undefined) {
      // Error.cause は ES2022 の標準。lib の版 (ES2020 など) に型が無くても動くよう、標準と同じ形 (列挙されない own プロパティ) で付ける
      Object.defineProperty(this, "cause", { value: options.cause, writable: true, configurable: true, enumerable: false });
    }
    // ES5 へのトランスパイルでも instanceof / プロトタイプが壊れないようにする
    Object.setPrototypeOf(this, HttpNetworkError.prototype);
  }
}

export function isHttpNetworkError(error: unknown): error is HttpNetworkError {
  return error instanceof HttpNetworkError;
}

export type RetryOptions = {
  /** 最初の 1 回に足して、最大で何回やり直すか。既定 2 */
  retries?: number;
  /**
   * やり直す前の待ち時間の基準 (ミリ秒)。n 回目のやり直しの前は、最大で baseDelayMs × 2^(n-1) まで待つ。
   * そのうち半分は必ず待ち、残りの半分を乱数で散らす (多くの端末が同時にやり直しても重ならないように)。既定 500
   */
  baseDelayMs?: number;
  /** 1 回あたりの待ち時間の上限 (ミリ秒)。既定 5000 */
  maxDelayMs?: number;
  /**
   * サーバーが Retry-After で指定した待ち時間の上限 (ミリ秒)。
   * これより長く待たされるときは、画面が固まったように見えるので、やり直さずにそのままエラーにする。既定 10000
   */
  maxRetryAfterMs?: number;
};

/** fetch の RequestInit に、このクライアント独自の指定を足したもの */
export type HttpRequestOptions = RequestInit & {
  /** この呼び出しだけ、1 回の通信を待つ上限 (ミリ秒) を変える。0 以下で上限なし */
  timeoutMs?: number;
  /**
   * この呼び出しだけ、やり直しの設定を変える。
   * - false: やり直さない
   * - true / オブジェクト: やり直す。POST や PATCH のように既定ではやり直さない呼び出しも、これで明示的に有効にできる
   *   (サーバーが同じリクエストを二重に処理しても困らないと確かめた呼び出しにだけ使うこと)
   */
  retry?: boolean | RetryOptions;
};

export type HttpClient = {
  get<T>(path: string, init?: HttpRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, init?: HttpRequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, init?: HttpRequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: HttpRequestOptions): Promise<T>;
  del<T>(path: string, init?: HttpRequestOptions): Promise<T>;
};

const DEFAULT_RETRY: Required<RetryOptions> = {
  retries: 2,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 10_000,
};

/** 同じリクエストを何度送っても結果が変わらない (サーバーの状態が増えない) メソッド。既定ではこれだけやり直す */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/** 5xx のうち、やり直しても結果が変わらないもの (未実装・未対応のバージョン) */
const PERMANENT_SERVER_ERRORS = new Set([501, 505]);

/** エラー応答の本文がテキスト (JSON ではない) のときに、エラー文に入れる最大の長さ。ゲートウェイの HTML 全体を画面に出さないため */
const MAX_TEXT_BODY_CHARS = 200;

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

async function buildHeaders(getAccessToken?: GetAccessToken, initHeaders?: HeadersInit) {
  const headers = new Headers(initHeaders);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  if (getAccessToken) {
    const token = await getAccessToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  return headers;
}

type ResolvedRetry = Required<RetryOptions>;

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** この呼び出しのやり直しの設定を決める。やり直さないときは retries が 0 */
function resolveRetry(
  method: string,
  clientRetry: false | RetryOptions | undefined,
  callRetry: boolean | RetryOptions | undefined,
): ResolvedRetry {
  const disabled: ResolvedRetry = { ...DEFAULT_RETRY, retries: 0 };
  if (callRetry === false) return disabled;

  // 呼び出し側が true / オブジェクトで明示したときだけ、POST などでもやり直す
  const explicit = callRetry === true || (typeof callRetry === "object" && callRetry !== null);
  if (!explicit && (clientRetry === false || !IDEMPOTENT_METHODS.has(method))) return disabled;

  const merged = {
    ...DEFAULT_RETRY,
    ...(clientRetry || {}),
    ...(typeof callRetry === "object" && callRetry !== null ? callRetry : {}),
  };
  return {
    retries: Math.floor(nonNegativeNumber(merged.retries, DEFAULT_RETRY.retries)),
    baseDelayMs: nonNegativeNumber(merged.baseDelayMs, DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: nonNegativeNumber(merged.maxDelayMs, DEFAULT_RETRY.maxDelayMs),
    maxRetryAfterMs: nonNegativeNumber(merged.maxRetryAfterMs, DEFAULT_RETRY.maxRetryAfterMs),
  };
}

/** HTTP のエラー応答のうち、少し待ってやり直せば通る可能性があるもの */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599 && !PERMANENT_SERVER_ERRORS.has(status);
}

/** n 回目 (1 始まり) のやり直しの前に待つ時間 (ミリ秒、整数)。指数的に増やし、半分は乱数で散らす */
function backoffDelayMs(retryNumber: number, retry: ResolvedRetry): number {
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (retryNumber - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Retry-After ヘッダー (秒数 または HTTP の日時) を、待つ時間 (ミリ秒) にする。読めなければ undefined */
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** 呼び出し側の signal が中断されていたら、その理由を投げる (中断の理由は、標準では AbortError) */
function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (!signal?.aborted) return;
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) throw reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

/** ms だけ待つ。呼び出し側の signal が中断されたら、待たずに戻る (次の処理が中断を投げる) */
function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/** エラー応答から Error を作る。文面は従来どおり `HTTP <status> <statusText>: <本文>` */
function toHttpError(res: Response, text: string): Error {
  let json: unknown = null;
  let isJson = false;
  if (text) {
    try {
      json = JSON.parse(text);
      isJson = true;
    } catch {
      // JSON ではない本文 (ゲートウェイの HTML など): 下でテキストとして扱う
    }
  }
  const body = json as { error?: unknown; message?: unknown } | null;
  let message: string;
  if (isJson && body && (body.error || body.message)) {
    message = JSON.stringify(json);
  } else if (isJson || text.length <= MAX_TEXT_BODY_CHARS) {
    message = text;
  } else {
    message = `${text.slice(0, MAX_TEXT_BODY_CHARS)}…`;
  }
  return new Error(`HTTP ${res.status} ${res.statusText}: ${message}`);
}

export function createHttpClient(config: {
  baseUrl: string;
  getAccessToken?: GetAccessToken;
  /** 1 回の通信を待つ上限 (ミリ秒)。既定 DEFAULT_TIMEOUT_MS (20 秒)。0 以下で上限なし */
  timeoutMs?: number;
  /** 既定のやり直しの設定。false でやり直しを止める (呼び出しごとの retry が優先される) */
  retry?: false | RetryOptions;
  /** 通信できなかったときのエラーの文面。画面にそのまま出せる文面を渡す (既定は英語の技術的な文面) */
  networkErrorMessages?: Partial<Record<HttpNetworkErrorKind, string>>;
}): HttpClient {
  const { baseUrl, getAccessToken, retry: clientRetry, networkErrorMessages } = config;
  const defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** 1 回だけ送って、本文の読み取りまで終える。応答を受け取れなければ HttpNetworkError を投げる */
  async function sendOnce(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal: AbortSignal | null | undefined,
  ): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    const forwardAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", forwardAbort);
    }

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // 本文の読み取りも、同じ待ち時間の中で終える
      const text = await res.text();
      return { res, text };
    } catch (error) {
      // 呼び出し側が自分で中断したときは、タイムアウトや通信エラーにせず、そのまま (AbortError) 返す
      if (callerSignal?.aborted) throw error;
      if (timedOut) {
        throw new HttpNetworkError("timeout", networkErrorMessages?.timeout ?? `Request timed out after ${timeoutMs}ms`, {
          cause: error,
          timeoutMs,
        });
      }
      throw new HttpNetworkError("offline", networkErrorMessages?.offline ?? "Network request failed", { cause: error });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  async function request<T>(method: string, path: string, body?: unknown, options: HttpRequestOptions = {}) {
    const { timeoutMs: callTimeoutMs, retry: callRetry, signal: callerSignal, ...fetchInit } = options;
    const url = joinUrl(baseUrl, path);
    const headers = await buildHeaders(getAccessToken, fetchInit.headers);
    const timeoutMs = callTimeoutMs ?? defaultTimeoutMs;
    const retry = resolveRetry(method.toUpperCase(), clientRetry, callRetry);
    const init: RequestInit = {
      ...fetchInit,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(callerSignal);

      let sent: { res: Response; text: string };
      try {
        sent = await sendOnce(url, init, timeoutMs, callerSignal);
      } catch (error) {
        // 応答を受け取れなかった (offline) ときだけ、やり直す。タイムアウトは、待ち時間が増えるだけなのでやり直さない
        if (isHttpNetworkError(error) && error.kind === "offline" && attempt < retry.retries) {
          await sleep(backoffDelayMs(attempt + 1, retry), callerSignal);
          continue;
        }
        throw error;
      }

      const { res, text } = sent;
      if (res.ok) {
        return (text ? JSON.parse(text) : null) as T;
      }

      if (attempt < retry.retries && isRetryableStatus(res.status)) {
        // モックなど headers を持たない応答でも壊れないようにする
        const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
        // サーバーの指定が長すぎるときは、待たずにエラーにする (画面が固まったように見えるため)
        if (retryAfterMs === undefined || retryAfterMs <= retry.maxRetryAfterMs) {
          await sleep(Math.max(backoffDelayMs(attempt + 1, retry), retryAfterMs ?? 0), callerSignal);
          continue;
        }
      }

      throw toHttpError(res, text);
    }
  }

  return {
    get: (path, init) => request("GET", path, undefined, init),
    post: (path, body, init) => request("POST", path, body, init),
    put: (path, body, init) => request("PUT", path, body, init),
    patch: (path, body, init) => request("PATCH", path, body, init),
    del: (path, init) => request("DELETE", path, undefined, init),
  };
}
