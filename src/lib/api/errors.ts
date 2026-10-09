/**
 * API Route の「内部エラー (500)」の返し方を 1 か所にまとめる (#1172)
 *
 * 以前は route ごとに `NextResponse.json({ error: error.message }, { status: 500 })` と書き、
 * DB (Supabase / PostgREST) が返した生のエラー文をそのままブラウザ・モバイルに返していた。
 * 文面にはテーブル名・列名・制約名・接続先が入るため、攻撃の手がかりになる。
 *
 * internalError() は次の 2 つを一度に行う。route は 500 を返したい所でこれを `return` するだけにする。
 *   1. 元のエラーを構造化ログ (src/lib/db-logger.ts → app_logs) に残す。調査はこちらで行う
 *   2. 利用者には汎用メッセージだけを返す。原因・スタック・エラーコードは本文に出さない
 *
 * 使い方:
 *   if (error) {
 *     return internalError('GET /api/health/goals', error, { userId: user.id, table: 'health_goals' });
 *   }
 *
 * 本文の形 (shape):
 *   - 'flat' (既定): { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }
 *       画面が `data.error` を文字列として表示する一般の API 向け。
 *       オブジェクトを返すと、`setError(data.error)` した画面が描画で落ちる / `new Error(data.error)` が
 *       "[object Object]" になるため、`error` は文字列のままにして `code` を横に添える
 *       (429 の rateLimitExceededResponse (src/lib/rate-limit.ts) と同じ形)。
 *   - 'nested': { error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } }
 *       `error.message` を読むクライアント (運営 API: /api/super-admin/** など) 向け。
 *       docs/design/cross/04-api-conventions.md §5.2 の形。
 *
 * 4xx の検証メッセージ (こちらが書いた文面) はこの関数の対象外。そのまま返してよい。
 * このヘルパーを使わずに JSON 本文へ error.message を入れている route は、
 * tests/api-raw-error-message-scan.test.ts の許可リストに載っている。直したらリストから外す。
 */
import { NextResponse } from 'next/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';

/** 利用者に返す汎用メッセージ。原因 (DB の生のエラー文など) は含めない */
export const INTERNAL_ERROR_MESSAGE = '処理中にエラーが発生しました';
/** 本文の code */
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
/** 構造化ログの message (利用者には出ない)。function_name には route の名前が入る */
const INTERNAL_ERROR_LOG_MESSAGE = '内部エラーのため 500 を返しました';

export type InternalErrorShape = 'flat' | 'nested';

export interface InternalErrorFlatBody {
  error: string;
  code: typeof INTERNAL_ERROR_CODE;
}

export interface InternalErrorNestedBody {
  error: { code: typeof INTERNAL_ERROR_CODE; message: string };
}

export interface InternalErrorContext {
  /** 認証で確定した利用者の ID。渡すと app_logs の user_id に紐づく (本文には出ない) */
  userId?: string;
  /** その要求の ID (generateRequestId())。同じ要求の他のログと突き合わせたいときに渡す。省略すると新しく発行する */
  requestId?: string;
  /** そのほかのログ用メタデータ (例: table: 'health_goals')。リクエスト本文・個人情報・秘密は入れない */
  [key: string]: unknown;
}

export interface InternalErrorOptions {
  /** 本文の形。既定は 'flat' (上のコメント参照) */
  shape?: InternalErrorShape;
}

/**
 * ログ用に Error へそろえる。
 * supabase-js のエラーは Error とは限らず、{ message, code, details, hint } の素のオブジェクトで来ることがある
 * (createLogger().error は Error 以外を String() にするため、そのまま渡すと "[object Object]" になって原因が消える)。
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value) return new Error(value);
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return new Error(message);
  }
  return new Error('Unknown error');
}

/** PostgreSQL / PostgREST のエラーコード (例: 23505, 42501, PGRST116)。調べるときの手がかりとしてログにだけ残す */
function errorCodeOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code ? code : undefined;
}

/**
 * 内部エラーを構造化ログに残し、汎用メッセージの 500 を返す。
 *
 * @param routeName 構造化ログの function_name。`GET /api/health/goals` のように handler ごとに付ける
 * @param error     元のエラー (Error / supabase-js のエラーオブジェクト / 文字列 など何でもよい)。本文には出ない
 * @param ctx       ログに付ける文脈 (userId / requestId と、それ以外はメタデータ)
 * @param options   本文の形 (shape)
 */
export function internalError(
  routeName: string,
  error: unknown,
  ctx: InternalErrorContext = {},
  options: InternalErrorOptions = {},
): NextResponse<InternalErrorFlatBody | InternalErrorNestedBody> {
  const { userId, requestId, ...metadata } = ctx;

  try {
    const logger = createLogger(routeName, requestId ?? generateRequestId());
    const target = userId ? logger.withUser(userId) : logger;
    const errorCode = errorCodeOf(error);
    target.error(INTERNAL_ERROR_LOG_MESSAGE, toError(error), {
      ...(errorCode ? { error_code: errorCode } : {}),
      ...metadata,
    });
  } catch (loggingError) {
    // 記録に失敗しても、利用者への応答は汎用の 500 にする
    // (ここで例外を投げると、元の失敗が別の失敗に化けて、呼び出し側の catch や Next.js の既定の 500 に流れる)。
    // 元のエラーが失われないよう、サーバーの標準エラー出力には残す。
    console.error(`[${routeName}] 内部エラーの構造化ログへの記録に失敗しました`, error, loggingError);
  }

  const body: InternalErrorFlatBody | InternalErrorNestedBody =
    options.shape === 'nested'
      ? { error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } }
      : { error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE };

  return NextResponse.json(body, { status: 500 });
}
