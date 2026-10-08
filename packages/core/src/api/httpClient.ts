export type GetAccessToken = () => Promise<string | null> | string | null;

/**
 * 1 回のリクエストごとの追加オプション。fetch の RequestInit に上乗せする。
 * 既存の呼び出し (`get(path, { signal })` など) はそのまま使える。
 */
export type HttpRequestInit = RequestInit & {
  /** このリクエストのタイムアウト (ミリ秒)。0 以下で無効。省略時はクライアントの既定値 */
  timeoutMs?: number;
  /** 失敗時の再試行回数。GET だけに効く (書き込み系は二重実行を避けるため再試行しない)。省略時はクライアントの既定値 */
  retries?: number;
};

export type HttpClient = {
  get<T>(path: string, init?: HttpRequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: HttpRequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: HttpRequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: HttpRequestInit): Promise<T>;
  del<T>(path: string, init?: HttpRequestInit): Promise<T>;
};

export type HttpClientConfig = {
  baseUrl: string;
  getAccessToken?: GetAccessToken;
  /** GET の既定タイムアウト (ミリ秒)。既定 30 秒 */
  timeoutMs?: number;
  /** GET 以外の既定タイムアウト (ミリ秒)。AI 解析など同期で時間のかかる API があるため GET より長い。既定 60 秒 */
  writeTimeoutMs?: number;
  /** GET の再試行回数 (通信エラーと 502 / 503 / 504 のときだけ)。既定 2 回 */
  retries?: number;
  /** 再試行までの待ち時間の基準 (ミリ秒)。n 回目の再試行の前に `基準 × 2^(n-1)` 待つ。既定 400 ミリ秒 */
  retryDelayMs?: number;
};

/** GET の既定タイムアウト */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** GET 以外の既定タイムアウト */
export const DEFAULT_HTTP_WRITE_TIMEOUT_MS = 60_000;
/** GET の既定の再試行回数 */
export const DEFAULT_HTTP_RETRIES = 2;
/** 再試行までの待ち時間の既定の基準 */
export const DEFAULT_HTTP_RETRY_DELAY_MS = 400;

/** 一時的な障害とみなして GET を再試行する HTTP ステータス (ゲートウェイ系) */
const RETRYABLE_STATUSES: readonly number[] = [502, 503, 504];

/** エラーメッセージに載せる本文の最大文字数 */
const MAX_DETAIL_LENGTH = 200;

/** HTTP がエラーステータス (2xx 以外) で返ってきた。`message` は `HTTP 502 Bad Gateway` の形で始まる */
export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** レスポンス本文 (生のテキスト) */
  readonly body: string;
  /** 本文を JSON として読めたときの値。読めなければ undefined */
  readonly json: unknown;

  constructor(params: { status: number; statusText: string; body: string; json?: unknown; message: string }) {
    super(params.message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'HttpError';
    this.status = params.status;
    this.statusText = params.statusText;
    this.body = params.body;
    this.json = params.json;
  }
}

/** 2xx で返ってきたが、本文が JSON として読めない (HTML のエラーページ、プロキシの応答など) */
export class HttpParseError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(params: { status: number; statusText: string; body: string }) {
    super(`HTTP ${params.status} ${params.statusText}: レスポンスが JSON ではありません`.trimEnd());
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'HttpParseError';
    this.status = params.status;
    this.body = params.body;
  }
}

/** タイムアウトで打ち切った。呼び出し側の中断 (AbortError) とは区別できる */
export class HttpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, method: string, path: string) {
    super(`Request timed out after ${timeoutMs}ms: ${method} ${path}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 通信そのものが失敗した (オフライン、接続切れなど)。メッセージは元のエラーのまま */
export class HttpNetworkError extends Error {
  /** fetch / 本文の読み取りが投げた元のエラー */
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(originalError instanceof Error && originalError.message ? originalError.message : 'Network request failed');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'HttpNetworkError';
    this.originalError = originalError;
  }
}

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

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** 本文を JSON として読む。空文字は null (204 など)、読めなければ ok: false */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** エラーメッセージに添える本文。HTML のエラーページ (502 / 504 など) は載せず、長い本文は切り詰める */
function summarizeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return '';
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed;
}

/**
 * HttpError のメッセージ。API が { error | message } を返したときは従来どおり JSON をそのまま載せる。
 *
 * 本文があるときの形は従来と同じ `HTTP <status> <statusText>: <本文>` のまま (statusText が空の HTTP/2 では
 * `HTTP 403 : <本文>`)。apps/mobile/src/lib/api-error.ts がこの形を前提に本文の message を取り出すため、整形し直さない。
 */
function buildErrorMessage(
  res: { status: number; statusText: string },
  text: string,
  parsed: { ok: true; value: unknown } | { ok: false },
): string {
  let detail = '';
  if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
    const body = parsed.value as { error?: unknown; message?: unknown };
    if (body.error || body.message) detail = JSON.stringify(parsed.value);
  }
  if (!detail) detail = summarizeBody(text);
  if (detail) return `HTTP ${res.status} ${res.statusText}: ${detail}`;
  // 載せる本文が無いとき (HTML のエラーページなど)
  return `HTTP ${res.status} ${res.statusText}`.trimEnd();
}

/**
 * 呼び出し側の signal とタイムアウトを 1 本の AbortSignal にまとめる。
 * RN には AbortSignal.any / AbortSignal.timeout が無いので手で合成する。
 */
function createAttemptSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** 再試行の待ち。待っている間に呼び出し側が中断したらすぐ AbortError で終わる */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/** GET を再試行してよい失敗か。通信エラーとゲートウェイ系のステータスだけ。タイムアウト・中断・4xx・500 は再試行しない */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpNetworkError) return true;
  if (error instanceof HttpError) return RETRYABLE_STATUSES.includes(error.status);
  return false;
}

export function createHttpClient(config: HttpClientConfig): HttpClient {
  const {
    baseUrl,
    getAccessToken,
    timeoutMs: defaultTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    writeTimeoutMs: defaultWriteTimeoutMs = DEFAULT_HTTP_WRITE_TIMEOUT_MS,
    retries: defaultRetries = DEFAULT_HTTP_RETRIES,
    retryDelayMs = DEFAULT_HTTP_RETRY_DELAY_MS,
  } = config;

  /** 1 回分の通信。タイムアウトは本文を読み終えるまで有効 */
  async function attempt<T>(
    method: string,
    path: string,
    body: unknown,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const url = joinUrl(baseUrl, path);
    const headers = await buildHeaders(getAccessToken, init?.headers);
    // JSON.stringify の失敗 (循環参照など) は通信エラーではないので、fetch の try の外で行って、そのまま投げる
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const callerSignal = init?.signal;

    if (callerSignal?.aborted) throw createAbortError();

    const attemptSignal = createAttemptSignal(callerSignal, timeoutMs);
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          ...init,
          method,
          headers,
          body: payload,
          signal: attemptSignal.signal,
        });
        text = await res.text();
      } catch (error) {
        // 打ち切ったのがタイムアウトか呼び出し側かを区別して投げ直す
        if (attemptSignal.didTimeout()) throw new HttpTimeoutError(timeoutMs, method, path);
        if (isAbortError(error)) throw error;
        throw new HttpNetworkError(error);
      }

      const parsed = parseJson(text);

      if (!res.ok) {
        // 502 / 504 の HTML エラーページなど、JSON でない本文でも SyntaxError にせず HTTP エラーとして扱う
        throw new HttpError({
          status: res.status,
          statusText: res.statusText,
          body: text,
          json: parsed.ok ? parsed.value : undefined,
          message: buildErrorMessage(res, text, parsed),
        });
      }

      if (!parsed.ok) {
        throw new HttpParseError({ status: res.status, statusText: res.statusText, body: text });
      }

      return parsed.value as T;
    } finally {
      attemptSignal.cleanup();
    }
  }

  async function request<T>(method: string, path: string, body?: unknown, init?: HttpRequestInit): Promise<T> {
    const { timeoutMs: initTimeoutMs, retries: initRetries, ...fetchInit } = init ?? {};
    const isRead = method === 'GET';
    const timeoutMs = initTimeoutMs ?? (isRead ? defaultTimeoutMs : defaultWriteTimeoutMs);
    // 書き込み系は二重実行になり得るので、どの設定でも再試行しない
    const maxRetries = isRead ? Math.max(0, initRetries ?? defaultRetries) : 0;

    for (let tried = 0; ; tried++) {
      try {
        return await attempt<T>(method, path, body, fetchInit, timeoutMs);
      } catch (error) {
        if (tried >= maxRetries || !isRetryable(error)) throw error;
        await sleep(retryDelayMs * 2 ** tried, fetchInit.signal);
      }
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
