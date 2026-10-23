/**
 * 組織の API (/api/org/**) が、認可の失敗 (401 / 403) と内部エラー (500) のときに返す本文
 *
 * 問題:
 *   組織の管理画面 (src/app/(org)) と、組織のメンバー向けの画面は、API の失敗の本文の文
 *   (`error` の文字列か `error.message`) をそのまま利用者に見せる。以前は route ごとに
 *   'Unauthorized' / 'Forbidden' / 'Internal server error' のような英語の文や、例外の文面
 *   (`err.message`。'AUTH_UNAUTHENTICATED'・'owner/admin role required' など) を返しており、
 *   失敗したときだけ英語が画面に出ていた。
 *
 * 決まり:
 *   - 本文の文は、ここの日本語の固定の文にする。例外の文面 (err.message) は本文に入れない
 *   - 本文の形は route ごとの従来の形のまま変えない (画面と設計書 cross/04 §5.2 の (a) flat / (b) nested が読む形)
 *       flat:   { error: '<文>' }                         (`/api/org/challenges`・`/api/org/invites` の GET / DELETE・`/api/org/members` の GET)
 *       nested: { error: { code: '<コード>', message: '<文>' } } (`/api/org/settings`・`/api/org/departments`・`/api/org/stats`・`/api/org/stats/refresh`・
 *               組織チャレンジのメンバー向けの API (src/lib/org-challenge-api.ts の handleMemberError))
 *   - 英語の文が入っていないことは tests/org-api-error-japanese.test.ts が /api/org の全 route を走査して見張る
 *     (走査の部品は tests/helpers/api-error-text-scan.ts)
 *   - 文と本文を作る仕組みは全 API の共通の関数 src/lib/api/error-responses.ts に載せている (#1917)。ここは /api/org の
 *     従来の文 (403 の文の表は PERM_NOT_ORG_MEMBER だけ) を保つための薄い包み
 */
import type { NextResponse } from 'next/server';
import type { ForbiddenError } from '@/lib/auth/errors';
import {
  API_FORBIDDEN_CODE,
  API_FORBIDDEN_MESSAGE,
  API_INTERNAL_ERROR_MESSAGE,
  API_INVALID_JSON_MESSAGE,
  API_NOT_ORG_MEMBER_MESSAGE,
  API_UNAUTHENTICATED_MESSAGE,
  API_UNAUTHORIZED_CODE,
  authFailureFlat,
  authFailureNested,
  forbiddenMessageOf,
  type ApiFlatErrorBody,
  type ApiNestedErrorBody,
  type ForbiddenMessageTable,
} from '@/lib/api/error-responses';

/** 401: ログインしていない・セッションが切れた (組織チャレンジのメンバー向けの API が以前から返している文) */
export const ORG_API_UNAUTHENTICATED_MESSAGE = API_UNAUTHENTICATED_MESSAGE;
/** 403: 所属組織の管理者 (owner / admin) でない・組織に所属していない */
export const ORG_API_FORBIDDEN_MESSAGE = API_FORBIDDEN_MESSAGE;
/** 403: 組織に所属していない (requireOrgMember の PERM_NOT_ORG_MEMBER)。メンバー向けの API が返す */
export const ORG_API_NOT_ORG_MEMBER_MESSAGE = API_NOT_ORG_MEMBER_MESSAGE;
/** 400: 本文が JSON として読めない */
export const ORG_API_INVALID_JSON_MESSAGE = API_INVALID_JSON_MESSAGE;
/** 500: 内部エラー。原因は構造化ログにだけ残す (src/lib/api/errors.ts と同じ文) */
export const ORG_API_INTERNAL_ERROR_MESSAGE = API_INTERNAL_ERROR_MESSAGE;

/**
 * 403: 役割が足りない (招待・除名・招待の取消・オーナーの譲渡の提案)。code は従来のまま 'INSUFFICIENT_PERMISSION' で、文だけを
 * 英字の役割名 ('owner/admin のみ招待可能です' など) から日本語の役割名 (オーナー・管理者) にした (#1917)
 */
export const ORG_API_INVITE_ADMIN_ONLY_MESSAGE = 'オーナー・管理者だけが招待できます';
export const ORG_API_REMOVE_ADMIN_ONLY_MESSAGE = 'オーナー・管理者だけがメンバーを除名できます';
export const ORG_API_REVOKE_ADMIN_ONLY_MESSAGE = 'オーナー・管理者だけが招待を取り消せます';
export const ORG_API_TRANSFER_OWNER_ONLY_MESSAGE = 'オーナーだけが譲渡を提案できます';

/** nested の形の本文の code (従来のまま) */
export const ORG_API_UNAUTHORIZED_CODE = API_UNAUTHORIZED_CODE;
export const ORG_API_FORBIDDEN_CODE = API_FORBIDDEN_CODE;

/**
 * /api/org の 403 の文の表。ここに無い code は ORG_API_FORBIDDEN_MESSAGE にする (従来のまま。凍結・二段階認証も
 * 「この操作を行う権限がありません」)。例外の文面 (err.message) は使わない
 */
const ORG_FORBIDDEN_MESSAGES: ForbiddenMessageTable = new Map([['PERM_NOT_ORG_MEMBER', ORG_API_NOT_ORG_MEMBER_MESSAGE]]);

/** 403 の本文の文 */
export function orgForbiddenMessage(err: ForbiddenError): string {
  return forbiddenMessageOf(err, ORG_FORBIDDEN_MESSAGES);
}

export type OrgApiFlatErrorBody = ApiFlatErrorBody;

export type OrgApiNestedErrorBody = ApiNestedErrorBody;

/**
 * 認可の失敗 (AuthError → 401・ForbiddenError → 403) を flat の形 `{ error: '<文>' }` で返す。
 * 認可の失敗でなければ null (呼び出し側が 500 などにする)
 */
export function orgAuthFailureFlat(err: unknown): NextResponse<OrgApiFlatErrorBody> | null {
  return authFailureFlat(err, { forbiddenMessages: ORG_FORBIDDEN_MESSAGES });
}

/**
 * 認可の失敗を nested の形 `{ error: { code: 'UNAUTHORIZED' | 'FORBIDDEN', message: '<文>' } }` で返す。
 * 認可の失敗でなければ null
 */
export function orgAuthFailureNested(err: unknown): NextResponse<OrgApiNestedErrorBody> | null {
  return authFailureNested(err, { code: 'http', forbiddenMessages: ORG_FORBIDDEN_MESSAGES });
}
