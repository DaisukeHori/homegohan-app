/**
 * #1178 個人情報の請求 (DSR) の本人向け API (/api/account/data-requests/**) の応答の部品 (設計 cross/15 §7.1・§7.2・§13)。サーバー専用。
 *
 * 6 本の route が同じ形で返すもの (認証の失敗・id の検査・本文の検査・service の失敗) をここに 1 つずつ置く。
 * 本文の形は flat (`{ error: '固定の文', code }`。cross/04 §5.2 (a))。どの応答にも Cache-Control: private, no-store を付ける。
 * 文はどれもこちらで書いた固定の文で、DB の生のエラー文は入れない (500 は internalError。原因はログにだけ残す)。
 *
 * 本文の NULL 文字の確かめ (rejectNullCharacterBody) はここに置かない。本文を読む handler の最初の 2 文に直接書く
 * (src/__tests__/api/null-character-routes.test.ts が handler の本体の文字列で確かめるため。§7.1)。
 */
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import type { ZodError } from 'zod';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireUserAllowingMissingProfile } from '@/lib/auth/helpers';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { dsrIdSchema } from '@/lib/data-subject-requests/core';
import type { DsrContext, DsrServiceResult } from '@/lib/data-subject-requests/service';

/** 本人向けの全 route の応答に付けるヘッダ (本人の請求の内容と応答はキャッシュさせない) */
export const DSR_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

/** service が返す失敗の code (DsrServiceResult の失敗側) */
type DsrServiceFailureCode = Extract<DsrServiceResult<never>, { ok: false }>['code'];

/**
 * 本人に返す 4xx の固定の文 (§13 のエラー表)。運営の PATCH だけが返す code (DSR_INVALID_TRANSITION など) は本人の route には届かないが、
 * 型で全部の code を埋めておく (service の戻り値の code を増やしたときに、ここで書き忘れが型の誤りになる)
 */
const DSR_REQUESTER_ERROR_MESSAGES: Record<Exclude<DsrServiceFailureCode, 'INTERNAL_ERROR'>, string> = {
  NOT_FOUND: '請求が見つかりません',
  DSR_ALREADY_OPEN:
    '同じ種類の請求がすでに受け付けられています。先にその請求の完了か取り下げをお待ちください',
  DSR_INVALID_STATE: 'この請求は現在の状態ではその操作ができません',
  DSR_VERIFICATION_INVALID: '確認リンクが正しくありません',
  DSR_VERIFICATION_EXPIRED: '確認リンクの期限が切れています。確認メールを再送してください',
  DSR_VERIFICATION_LIMIT: '確認メールの送信回数が上限に達しました。お問い合わせください',
  DSR_INVALID_TRANSITION: '現在の状態ではその変更はできません',
  DSR_RESPONSE_NOTE_REQUIRED: '対応済み・対応できずにするときは本人への応答を書いてください',
  CONFLICT_OPTIMISTIC_LOCK: '別の更新が先に行われました。再読み込みしてください',
  CONFLICT_STALE_DATA: '別の更新が先に行われました。再読み込みしてください',
  CONFLICT_PRECONDITION_REQUIRED: 'If-Unmodified-Since ヘッダが必要です',
};

/** 未ログイン (AuthError) の 401 の本文 (§7.1。文は全 API の共通の日本語の固定の文。#1917 で英語の 'Unauthorized' から変えた。code は従来のまま) */
export const DSR_UNAUTHENTICATED_BODY = { error: API_UNAUTHENTICATED_MESSAGE, code: 'AUTH_UNAUTHENTICATED' } as const;
/** 凍結中 (ForbiddenError) の 403 の本文 (§7.1。実際には middleware が先に止める。二重の守り) */
export const DSR_FROZEN_BODY = { error: 'アカウントが凍結されています', code: 'AUTH_ACCOUNT_FROZEN' } as const;
/** 本文が JSON として読めないときの 400 の文 (§13) */
export const DSR_INVALID_JSON_MESSAGE = 'リクエストボディが不正です';
/** 入力の検査 (zod・id の形式) に落ちたときの 400 の文 (§13) */
export const DSR_VALIDATION_ERROR_MESSAGE = '入力内容を確認してください';

/** 本人向けの flat の 4xx を返す (固定の文と code。Cache-Control: private, no-store) */
function requesterJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: DSR_NO_STORE_HEADERS });
}

/** internalError の 500 にも no-store を付ける */
function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', DSR_NO_STORE_HEADERS['Cache-Control']);
  return response;
}

/** 本人の route の 500 (internalError。flat。原因はログにだけ残す) */
export function dsrRequesterInternalError(
  routeName: string,
  cause: unknown,
  ctx: { userId?: string; requestId?: string } = {},
): NextResponse {
  return noStore(internalError(routeName, cause, ctx));
}

export type DsrRequesterAuthResult = { ok: true; user: User } | { ok: false; response: NextResponse };

/**
 * requireUserAllowingMissingProfile() で本人を確かめる。AuthError (未ログイン) → 401 AUTH_UNAUTHENTICATED、
 * ForbiddenError (凍結) → 403 AUTH_ACCOUNT_FROZEN、それ以外の例外 (user_profiles の読み取りの失敗 UserProfileReadError を含む)
 * → 500 (internalError)。どれも表に触れない。
 * user_profiles の行が無い利用者 (新規登録の直後。行は同意・初期設定・招待の承諾で作られる) は通す (#1751):
 * 請求は規約への同意も初期設定の完了も条件にできない本人の権利で、同意の画面の案内から来るのは多くがこの人たち。
 * requireUser は行が無いと 401 にするので使わない。凍結は行の frozen_at なので、行が無ければ凍結は無い
 */
export async function authenticateDsrRequester(routeName: string): Promise<DsrRequesterAuthResult> {
  try {
    const user = await requireUserAllowingMissingProfile();
    return { ok: true, user };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, response: requesterJson({ ...DSR_UNAUTHENTICATED_BODY }, 401) };
    if (err instanceof ForbiddenError) return { ok: false, response: requesterJson({ ...DSR_FROZEN_BODY }, 403) };
    return { ok: false, response: dsrRequesterInternalError(routeName, err) };
  }
}

/** 入力の検査の 400 VALIDATION_ERROR (details は zod の flatten) */
export function dsrValidationErrorResponse(error: ZodError): NextResponse {
  return requesterJson(
    { error: DSR_VALIDATION_ERROR_MESSAGE, code: 'VALIDATION_ERROR', details: error.flatten() },
    400,
  );
}

/** 本文が JSON として読めないときの 400 INVALID_JSON */
export function dsrInvalidJsonResponse(): NextResponse {
  return requesterJson({ error: DSR_INVALID_JSON_MESSAGE, code: 'INVALID_JSON' }, 400);
}

export type DsrIdParseResult = { ok: true; id: string } | { ok: false; response: NextResponse };

/** パスの id を dsrIdSchema (UUID) で確かめる。UUID でなければ 400 VALIDATION_ERROR (表に触れない) */
export function parseDsrId(raw: string): DsrIdParseResult {
  const parsed = dsrIdSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: dsrValidationErrorResponse(parsed.error) };
  return { ok: true, id: parsed.data };
}

/** 本人の route の service の文脈 (今の時刻・要求の ID・本人に紐づくログ) */
export function createDsrRequesterContext(routeName: string, userId: string): DsrContext {
  const requestId = generateRequestId();
  return { now: new Date(), requestId, log: createLogger(routeName, requestId).withUser(userId) };
}

/**
 * service の結果を本人向けの応答にする。成功は `{ [key]: data }` を successStatus で返す。
 * 失敗は §13 の固定の文と code (500 は internalError。cause はログにだけ残し、本文に入れない)
 */
export function dsrRequesterResultResponse<T>(
  routeName: string,
  result: DsrServiceResult<T>,
  ctx: DsrContext & { userId: string },
  success: { key: 'request' | 'requests'; status: number },
): NextResponse {
  if (result.ok) return requesterJson({ [success.key]: result.data }, success.status);
  if (result.code === 'INTERNAL_ERROR') {
    return dsrRequesterInternalError(routeName, result.cause, { userId: ctx.userId, requestId: ctx.requestId });
  }
  return requesterJson({ error: DSR_REQUESTER_ERROR_MESSAGES[result.code], code: result.code }, result.status);
}

/** 429 の応答 (rateLimitExceededResponse) にも no-store を付ける */
export function withDsrNoStore(response: NextResponse): NextResponse {
  return noStore(response);
}

