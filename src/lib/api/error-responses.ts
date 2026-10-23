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
 *     nested の code は、従来の route が書いていたものに合わせて選ぶ (401 と 403 で別々に選べる。AuthFailureCodeSource):
 *       'http'           = 'UNAUTHORIZED' / 'FORBIDDEN' (多くの route の従来の形)
 *       'error'          = 例外の code ('AUTH_UNAUTHENTICATED'・'PERM_DENIED'・'AUTH_2FA_REQUIRED' など。
 *                          画面が code を見て分岐する route (二段階認証の画面の AUTH_2FA_REQUIRED など) の従来の形)
 *       { fixed: '<コード>' } = route が決めて書いていた固定の code ('UNAUTHENTICATED'・'OP_PERMISSION_DENIED' など)
 *       { unauthorized, forbidden } = 401 と 403 で上の 3 つを別々に選ぶ。admin の営業 (sales/leads)・問い合わせ (support/tickets) の
 *                          route は 401 = 例外の code・403 = 'OP_PERMISSION_DENIED' (AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED)、
 *                          admin の会計 (finance) の route は 401 = 'UNAUTHENTICATED'・403 = 'OP_PERMISSION_DENIED'
 *                          (AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED)
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
/** nested の形の本文の 401 の固定の code (admin の会計 (finance) の route の従来の code) */
export const API_UNAUTHENTICATED_CODE = 'UNAUTHENTICATED';
/** nested の形の本文の 403 の固定の code (admin・super-admin の運営の route の従来の code。設計書 cross/12・15・16 が既存の 403 の code として読む) */
export const API_OP_PERMISSION_DENIED_CODE = 'OP_PERMISSION_DENIED';

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

/**
 * 1 つの状態 (401 か 403) の nested の code の選び方 (上のコメント参照)。
 * 固定の code を素の文字列にしないのは、'http' / 'error' と型の上で混ざらないようにするため
 */
export type AuthFailureCodeRule = 'http' | 'error' | { readonly fixed: string };

/** 401 と 403 で別々に選ぶときの nested の code の選び方 */
export interface AuthFailureCodeRules {
  /** 401 (AuthError) の code */
  readonly unauthorized: AuthFailureCodeRule;
  /** 403 (ForbiddenError) の code */
  readonly forbidden: AuthFailureCodeRule;
}

/** nested の本文の code の選び方。1 つの選び方を渡すと 401 と 403 の両方に当てる */
export type AuthFailureCodeSource = AuthFailureCodeRule | AuthFailureCodeRules;

/**
 * admin の営業 (sales/leads)・問い合わせ (support/tickets) の route の従来の code: 401 = 例外の code・403 = OP_PERMISSION_DENIED
 * (多くの route が共有するので freeze して、どこかの route が書き換えても他の route の code が変わらないようにする)
 */
export const AUTH_CODES_ERROR_AND_OP_PERMISSION_DENIED: AuthFailureCodeRules = Object.freeze({
  unauthorized: 'error',
  forbidden: Object.freeze({ fixed: API_OP_PERMISSION_DENIED_CODE }),
});

/** admin の会計 (finance) の route の従来の code: 401 = UNAUTHENTICATED・403 = OP_PERMISSION_DENIED */
export const AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED: AuthFailureCodeRules = Object.freeze({
  unauthorized: Object.freeze({ fixed: API_UNAUTHENTICATED_CODE }),
  forbidden: Object.freeze({ fixed: API_OP_PERMISSION_DENIED_CODE }),
});

export interface AuthFailureOptions {
  /** 403 の文の表。省略すると DEFAULT_FORBIDDEN_MESSAGES */
  forbiddenMessages?: ForbiddenMessageTable;
  /** 応答のヘッダ (Cache-Control: no-store など) */
  headers?: HeadersInit;
}

export interface AuthFailureNestedOptions extends AuthFailureOptions {
  /** nested の code の選び方。省略すると 'http' */
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

function isCodeRules(source: AuthFailureCodeSource): source is AuthFailureCodeRules {
  return typeof source === 'object' && 'unauthorized' in source;
}

/** 選び方と例外から code を決める。httpCode は 'http' を選んだときの code */
function codeOf(rule: AuthFailureCodeRule, err: AuthError | ForbiddenError, httpCode: string): string {
  if (rule === 'http') return httpCode;
  if (rule === 'error') return err.code;
  return rule.fixed;
}

/**
 * 認可の失敗を nested の形 `{ error: { code, message: '<文>' } }` で返す。
 * code は options.code で選ぶ (省略すると 'http' = 'UNAUTHORIZED' / 'FORBIDDEN'。'error' なら例外の code、
 * { fixed } なら固定の code、{ unauthorized, forbidden } なら 401 と 403 で別々)。文はどの選び方でも日本語の固定の文。
 * 認可の失敗でなければ null
 */
export function authFailureNested(err: unknown, options: AuthFailureNestedOptions = {}): NextResponse<ApiNestedErrorBody> | null {
  const source = options.code ?? 'http';
  const unauthorizedRule = isCodeRules(source) ? source.unauthorized : source;
  const forbiddenRule = isCodeRules(source) ? source.forbidden : source;
  if (err instanceof AuthError) {
    return NextResponse.json(
      { error: { code: codeOf(unauthorizedRule, err, API_UNAUTHORIZED_CODE), message: API_UNAUTHENTICATED_MESSAGE } },
      responseInit(HTTP_UNAUTHORIZED, options.headers),
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json(
      {
        error: {
          code: codeOf(forbiddenRule, err, API_FORBIDDEN_CODE),
          message: forbiddenMessageOf(err, options.forbiddenMessages),
        },
      },
      responseInit(HTTP_FORBIDDEN, options.headers),
    );
  }
  return null;
}
