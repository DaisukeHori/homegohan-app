/**
 * API の失敗の本文の日本語の固定の文と、認可の失敗 (401 / 403) の本文を作る共通の関数 (#1917)
 *
 * 問題:
 *   Web の画面 (src/app) とモバイル (apps/mobile) は、API の失敗の本文の文 (`error` の文字列か `error.message`) を
 *   そのまま利用者に見せることが多い。route ごとに 'Unauthorized' / 'Forbidden' / 'Internal server error' のような英語の文や、
 *   例外の文面 (`err.message`。'AUTH_UNAUTHENTICATED'・'Requires one of: super_admin'・'owner/admin role required' など。
 *   src/lib/auth/helpers.ts の requireRole / requireOrgAdmin が投げる ForbiddenError の文面は英語) を返すと、
 *   失敗したときだけ英語が画面に出る。#1966 が /api/org だけを src/lib/org-api-errors.ts で直した形を、全 API で使えるようにしたもの。
 *
 * 決まり:
 *   - 本文の文は、ここの日本語の固定の文にする。例外の文面 (err.message) は本文に入れない
 *     (文面をこちらで書いていない AuthError / ForbiddenError が来ても英語を出さないため。403 の文は code ごとの表で決める)
 *   - 本文の形と code は route ごとの従来の形のまま変えない (画面・モバイル・設計書 cross/04 §5.2 が読む)
 *       flat:   { error: '<文>' }
 *       nested: { error: { code: '<コード>', message: '<文>' } }
 *     nested の code は、従来の route が書いていたものに合わせて選ぶ:
 *       'http'  = 'UNAUTHORIZED' / 'FORBIDDEN' (多くの route の従来の形)
 *       'error' = 例外の code ('AUTH_UNAUTHENTICATED'・'PERM_DENIED'・'AUTH_2FA_REQUIRED' など。
 *                 画面が code を見て分岐する route (二段階認証の画面の AUTH_2FA_REQUIRED など) の従来の形)
 *   - 500 は src/lib/api/errors.ts の internalError を使う (原因は構造化ログにだけ残す)
 *   - 英語の文が入っていないことは、tests/helpers/api-error-text-scan.ts の走査が「直し終えた配下」の route を見張る
 *     (tests/api-error-japanese-scan.test.ts。配下の一覧は tests/helpers/api-error-japanese-scope.ts)
 */
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

/** 401: ログインしていない・セッションが切れた・プロフィールが無い */
export const API_UNAUTHENTICATED_MESSAGE = 'ログインが必要です';
/** 403: 権限が無い (ロールが足りない・組織が違う・管理者でない など) */
export const API_FORBIDDEN_MESSAGE = 'この操作を行う権限がありません';
/** 403: 組織に所属していない (requireOrgMember の PERM_NOT_ORG_MEMBER) */
export const API_NOT_ORG_MEMBER_MESSAGE = '組織に所属していません';
/** 403: アカウントが凍結されている (AUTH_ACCOUNT_FROZEN。src/lib/auth/helpers.ts の assertNotFrozen と同じ文) */
export const API_ACCOUNT_FROZEN_MESSAGE = 'アカウントが凍結されています';
/** 403: 二段階認証の確認が要る (AUTH_2FA_REQUIRED。src/lib/auth/mfa/assurance.ts と同じ文) */
export const API_MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
/** 403: 二段階認証の登録が要る (AUTH_2FA_ENROLLMENT_REQUIRED。src/lib/auth/mfa/assurance.ts と同じ文) */
export const API_MFA_ENROLLMENT_REQUIRED_MESSAGE = '二段階認証の登録が必要です';
/** 400: 本文が JSON として読めない */
export const API_INVALID_JSON_MESSAGE = 'リクエストボディが不正です';
/** 404: 対象が見つからない (他人のもの・消されたものを含む。在るかどうかを区別して見せない) */
export const API_NOT_FOUND_MESSAGE = '対象が見つかりません';
/** 409: 読んでから書くまでに他の操作が先に変えた・重なった */
export const API_CONFLICT_MESSAGE = '他の操作と重なったため、処理できませんでした。画面を読み込み直して、もう一度お試しください';
/** 500: 内部エラー。原因は構造化ログにだけ残す (src/lib/api/errors.ts と同じ文) */
export const API_INTERNAL_ERROR_MESSAGE = INTERNAL_ERROR_MESSAGE;

/** nested の形の本文の code ('http' を選んだとき) */
export const API_UNAUTHORIZED_CODE = 'UNAUTHORIZED';
export const API_FORBIDDEN_CODE = 'FORBIDDEN';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** ForbiddenError の code → 本文の文 (表に無い code は API_FORBIDDEN_MESSAGE) */
export type ForbiddenMessageTable = ReadonlyMap<string, string>;

/**
 * 既定の 403 の文の表。従来 err.message をそのまま返していた route で、日本語で書かれていて画面に意味のある文
 * (凍結・二段階認証・組織に所属していない) は、同じ文のまま残す
 */
export const DEFAULT_FORBIDDEN_MESSAGES: ForbiddenMessageTable = new Map([
  ['PERM_NOT_ORG_MEMBER', API_NOT_ORG_MEMBER_MESSAGE],
  ['AUTH_ACCOUNT_FROZEN', API_ACCOUNT_FROZEN_MESSAGE],
  ['AUTH_2FA_REQUIRED', API_MFA_REQUIRED_MESSAGE],
  ['AUTH_2FA_ENROLLMENT_REQUIRED', API_MFA_ENROLLMENT_REQUIRED_MESSAGE],
]);

/** nested の本文の code の選び方 (上のコメント参照) */
export type AuthFailureCodeSource = 'http' | 'error';

export interface AuthFailureOptions {
  /** 403 の文の表。省略すると DEFAULT_FORBIDDEN_MESSAGES */
  forbiddenMessages?: ForbiddenMessageTable;
  /** 応答のヘッダ (Cache-Control: no-store など) */
  headers?: HeadersInit;
}

export interface AuthFailureNestedOptions extends AuthFailureOptions {
  /** nested の code。省略すると 'http' */
  code?: AuthFailureCodeSource;
}

export interface ApiFlatErrorBody {
  error: string;
}

export interface ApiNestedErrorBody {
  error: { code: string; message: string };
}

/** 403 の本文の文 (例外の文面は使わない) */
export function forbiddenMessageOf(err: ForbiddenError, table: ForbiddenMessageTable = DEFAULT_FORBIDDEN_MESSAGES): string {
  return table.get(err.code) ?? API_FORBIDDEN_MESSAGE;
}

function responseInit(status: number, headers: HeadersInit | undefined): ResponseInit {
  return headers === undefined ? { status } : { status, headers };
}

/**
 * 認可の失敗 (AuthError → 401・ForbiddenError → 403) を flat の形 `{ error: '<文>' }` で返す。
 * 認可の失敗でなければ null (呼び出し側が internalError などにする)
 */
export function authFailureFlat(err: unknown, options: AuthFailureOptions = {}): NextResponse<ApiFlatErrorBody> | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, responseInit(HTTP_UNAUTHORIZED, options.headers));
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json(
      { error: forbiddenMessageOf(err, options.forbiddenMessages) },
      responseInit(HTTP_FORBIDDEN, options.headers),
    );
  }
  return null;
}

/**
 * 認可の失敗を nested の形 `{ error: { code, message: '<文>' } }` で返す。
 * code は options.code が 'http' (既定) なら 'UNAUTHORIZED' / 'FORBIDDEN'、'error' なら例外の code。
 * 認可の失敗でなければ null
 */
export function authFailureNested(err: unknown, options: AuthFailureNestedOptions = {}): NextResponse<ApiNestedErrorBody> | null {
  const useErrorCode = options.code === 'error';
  if (err instanceof AuthError) {
    return NextResponse.json(
      { error: { code: useErrorCode ? err.code : API_UNAUTHORIZED_CODE, message: API_UNAUTHENTICATED_MESSAGE } },
      responseInit(HTTP_UNAUTHORIZED, options.headers),
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json(
      {
        error: {
          code: useErrorCode ? err.code : API_FORBIDDEN_CODE,
          message: forbiddenMessageOf(err, options.forbiddenMessages),
        },
      },
      responseInit(HTTP_FORBIDDEN, options.headers),
    );
  }
  return null;
}
