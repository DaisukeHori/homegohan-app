/**
 * Edge Function で、動くのに欠かせない環境変数 (Supabase の接続情報・外部 API のキー) が無いときの扱い (#1467)
 *
 * Web 側 (src/lib/env-required.ts。#1182) と同じく、応答の本文にも例外の message にも環境変数の名前を入れない。
 * 例外の message をそのまま応答の本文に返す catch が書かれても (例: _shared/catalog/import-runner.ts の catch)、
 * 変数名が呼び出し元に届かないようにするため。欠けている変数名は、投げる前にサーバーのログ (console.error。
 * Supabase の関数ログ) に 1 行だけ残す (値は出さない)。
 *
 * 使い方:
 *  - 欠けていたら `throw missingEnvError(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])`
 *    (ログに名前を残してから、message が固定の MissingEnvError を返す)
 *  - 応答を返す場所では `logMissingEnv([...])` でログに名前を残し、`missingEnvResponseBody()` を本文にして、
 *    状態コードは MISSING_ENV_HTTP_STATUS (503) にする。
 *  - 環境変数は、モジュールの読み込み時ではなくリクエストの処理の中で確かめる。読み込み時に投げると、
 *    関数が起動できず、呼び出し元には変数名を含むかもしれない既定のエラーしか返らない。
 *
 * このファイルは何も import しない (Deno と vitest の両方から読む)。
 */

/** 応答の本文と例外の message に使う固定の文。どの変数が欠けていても同じ文にし、変数名も値も入れない */
export const MISSING_ENV_ERROR_MESSAGE = "サーバーの設定が不足しています";

/** 応答の本文の code。呼び出し元が「設定の不足」を見分けられるようにする */
export const MISSING_ENV_ERROR_CODE = "SERVER_CONFIG_MISSING";

/**
 * 設定が足りないときの状態コード。要求の中身の誤りでも処理中の失敗でもなく、サーバーの設定が整うまで
 * 使えない状態なので 503 (Service Unavailable) にする。Web 側の super-admin/embeddings/regenerate・
 * Edge の stripe-price-sync が以前から返していた 503 と揃える。
 */
export const MISSING_ENV_HTTP_STATUS = 503;

/** サーバーのログに出す 1 行の前置き。このあとに欠けている変数名だけが続く (値は出さない) */
export const MISSING_ENV_SERVER_LOG_PREFIX = "[env] missing required env:";

/**
 * 必須の環境変数が無いときに投げる。
 *  - message は MISSING_ENV_ERROR_MESSAGE で固定 (変数名も値も入らない)。
 *  - 欠けている変数名は envNames に入る。列挙されないプロパティにしてあるので、
 *    `JSON.stringify(error)`・`{ ...error }` で本文に入れても出てこない。
 */
export class MissingEnvError extends Error {
  declare readonly envNames: readonly string[];
  readonly code = MISSING_ENV_ERROR_CODE;

  constructor(envNames: readonly string[]) {
    super(MISSING_ENV_ERROR_MESSAGE);
    this.name = "MissingEnvError";
    Object.defineProperty(this, "envNames", {
      value: [...envNames],
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/** MissingEnvError かどうか。バンドルが分かれて instanceof が使えない場合に備えて名前でも判定する */
export function isMissingEnvError(error: unknown): error is MissingEnvError {
  return (
    error instanceof MissingEnvError ||
    (error instanceof Error && error.name === "MissingEnvError" && Array.isArray((error as { envNames?: unknown }).envNames))
  );
}

/**
 * 欠けている変数名をサーバーのログに 1 行残す (値は出さない)。例外を投げずにその場で応答を返す場所で使う。
 * envNames には「どれかが欠けている」候補をすべて書いてよい (例: 別名のどちらも無いとき)。
 */
export function logMissingEnv(envNames: readonly string[]): void {
  console.error(MISSING_ENV_SERVER_LOG_PREFIX, envNames.join(" / "));
}

/** 欠けている変数名をサーバーのログに 1 行残してから、MissingEnvError を返す (投げるのは呼ぶ側) */
export function missingEnvError(envNames: readonly string[]): MissingEnvError {
  logMissingEnv(envNames);
  return new MissingEnvError(envNames);
}

/** 設定が足りないときの応答の本文 (固定の文と code だけ) */
export function missingEnvResponseBody(): { error: string; code: string } {
  return { error: MISSING_ENV_ERROR_MESSAGE, code: MISSING_ENV_ERROR_CODE };
}
