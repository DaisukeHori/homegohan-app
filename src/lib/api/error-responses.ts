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
import { AuthError, ForbiddenError, MfaRequiredError, type MfaRequiredCode } from '@/lib/auth/errors';
import { INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { dbErrorMentionsCode, type DbRaisedErrorLike } from '@/lib/errors/db-raised-code';
import {
  API_ACCOUNT_FROZEN_MESSAGE,
  API_MFA_ENROLLMENT_REQUIRED_MESSAGE,
  API_MFA_REQUIRED_MESSAGE,
} from '@/lib/api/forbidden-reason-messages';

/** 401: ログインしていない・セッションが切れた・プロフィールが無い */
export const API_UNAUTHENTICATED_MESSAGE = 'ログインが必要です';
/** 403: 権限が無い (ロールが足りない・組織が違う・管理者でない など) */
export const API_FORBIDDEN_MESSAGE = 'この操作を行う権限がありません';
/** 403: 組織に所属していない (requireOrgMember の PERM_NOT_ORG_MEMBER) */
export const API_NOT_ORG_MEMBER_MESSAGE = '組織に所属していません';
// 403 の理由の文 (凍結・二段階認証の確認・二段階認証の登録) は、運営の画面も読むので next/server を読まないファイルに置く
export { API_ACCOUNT_FROZEN_MESSAGE, API_MFA_ENROLLMENT_REQUIRED_MESSAGE, API_MFA_REQUIRED_MESSAGE };
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
const HTTP_BAD_REQUEST = 400;

/** nested の 400: 本文が JSON として読めない (運営の API の従来の code。operator/02-api-spec.md のエラー表) */
export const API_INVALID_JSON_CODE = 'INVALID_JSON';

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

/**
 * 403: 運営の route (admin・super-admin) が OP_PERMISSION_DENIED の本文に従来から書いてきた文
 * (operator/02-api-spec.md のエラー表の route。画面・E2E が読むので変えない)
 */
export const API_OP_PERMISSION_DENIED_MESSAGE = '権限がありません';

/**
 * 運営の route の 403 (code は OP_PERMISSION_DENIED のまま) の本文の文。
 * 二段階認証が未完了 (MfaRequiredError) なら、その理由の日本語の固定の文 (forbiddenMessageOf の既定の表) にし、
 * それ以外 (ロールが足りない・凍結など) は従来の API_OP_PERMISSION_DENIED_MESSAGE のまま (#1917)。
 * ゲート (requireRole) の後でセッションの状態が変わったとき、二段階認証が要るのに権限が無いように見せないため
 * (ロールの変更の route (src/app/api/admin/users/[id]/role/route.ts) が先に直した形を、運営の route でそろえる)
 */
export function operatorForbiddenMessageOf(err: ForbiddenError): string {
  return err instanceof MfaRequiredError ? forbiddenMessageOf(err) : API_OP_PERMISSION_DENIED_MESSAGE;
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

/**
 * 本文が JSON として読めない (壊れた JSON) ときの 400 を nested の形 `{ error: { code: 'INVALID_JSON', message } }` で返す (#1917)。
 * `await request.json()` の例外を route 全体の catch (internalError の 500) に流さず、呼び出し元の入力の誤りとして返すために使う
 * (src/lib/http-params.ts の readJsonBody で読み、`{ ok: false }` のときにこれを返す)
 */
export function invalidJsonNested(): NextResponse<ApiNestedErrorBody> {
  return NextResponse.json(
    { error: { code: API_INVALID_JSON_CODE, message: API_INVALID_JSON_MESSAGE } },
    { status: HTTP_BAD_REQUEST },
  );
}

/**
 * DB の運営の関数 (docs/design/cross/12-operator-mfa.md §11.4 の 7 本。段 E) が二段階認証の判定
 * (`public.operator_mfa_satisfied()` が偽) で止めたときの `RAISE EXCEPTION` の文面
 */
export const DB_OPERATOR_MFA_REQUIRED_CODE = 'OPERATOR_MFA_REQUIRED';

/**
 * DB の判定が偽になるのは「TOTP を登録済みの必須ロールの呼び出し元が aal1 のセッション」のときだけ
 * (未登録なら判定は真)。route のゲート (requireRole / requireSuperAdmin) では、同じ状態は二段階認証の確認が要る
 * (AUTH_2FA_REQUIRED) になるので、DB で止まったときも同じ code の例外として扱う
 */
const DB_OPERATOR_MFA_GATE_EQUIVALENT_CODE: MfaRequiredCode = 'AUTH_2FA_REQUIRED';

/**
 * RPC のエラーが DB の二段階認証の判定 (OPERATOR_MFA_REQUIRED) で止まったものなら、route のゲートが二段階認証で止めたときと
 * 同じ 403 の本文 (nested の形・options.code で選んだ code・二段階認証の日本語の固定の文) を返す。そうでなければ null。
 * route のゲートを通った後でも、ゲートと RPC の間でセッションの状態が変わると DB の判定で止まりうる。
 * そのとき汎用の 500 にせず、二段階認証の確認が要ることを伝える (#1917)。RPC の生の文面は本文に入れない
 */
export function operatorMfaRequiredNested(
  error: DbRaisedErrorLike | null | undefined,
  options: AuthFailureNestedOptions = {},
): NextResponse<ApiNestedErrorBody> | null {
  if (!dbErrorMentionsCode(error, DB_OPERATOR_MFA_REQUIRED_CODE)) return null;
  return authFailureNested(new MfaRequiredError(DB_OPERATOR_MFA_GATE_EQUIVALENT_CODE), options);
}
