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
 */
import { NextResponse } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

/** 401: ログインしていない・セッションが切れた (組織チャレンジのメンバー向けの API が以前から返している文) */
export const ORG_API_UNAUTHENTICATED_MESSAGE = 'ログインが必要です';
/** 403: 所属組織の管理者 (owner / admin) でない・組織に所属していない */
export const ORG_API_FORBIDDEN_MESSAGE = 'この操作を行う権限がありません';
/** 403: 組織に所属していない (requireOrgMember の PERM_NOT_ORG_MEMBER)。メンバー向けの API が返す */
export const ORG_API_NOT_ORG_MEMBER_MESSAGE = '組織に所属していません';
/** 400: 本文が JSON として読めない */
export const ORG_API_INVALID_JSON_MESSAGE = 'リクエストボディが不正です';
/** 500: 内部エラー。原因は構造化ログにだけ残す (src/lib/api/errors.ts と同じ文) */
export const ORG_API_INTERNAL_ERROR_MESSAGE = INTERNAL_ERROR_MESSAGE;

/** nested の形の本文の code (従来のまま) */
export const ORG_API_UNAUTHORIZED_CODE = 'UNAUTHORIZED';
export const ORG_API_FORBIDDEN_CODE = 'FORBIDDEN';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/**
 * ForbiddenError の code ごとの文。ここに無い code は ORG_API_FORBIDDEN_MESSAGE にする。
 * 例外の文面 (err.message) は使わない (文面をこちらで書いていない ForbiddenError が来ても英語を出さないため)
 */
const FORBIDDEN_MESSAGES_BY_CODE: ReadonlyMap<string, string> = new Map([
  ['PERM_NOT_ORG_MEMBER', ORG_API_NOT_ORG_MEMBER_MESSAGE],
]);

/** 403 の本文の文 */
export function orgForbiddenMessage(err: ForbiddenError): string {
  return FORBIDDEN_MESSAGES_BY_CODE.get(err.code) ?? ORG_API_FORBIDDEN_MESSAGE;
}

export interface OrgApiFlatErrorBody {
  error: string;
}

export interface OrgApiNestedErrorBody {
  error: { code: string; message: string };
}

/**
 * 認可の失敗 (AuthError → 401・ForbiddenError → 403) を flat の形 `{ error: '<文>' }` で返す。
 * 認可の失敗でなければ null (呼び出し側が 500 などにする)
 */
export function orgAuthFailureFlat(err: unknown): NextResponse<OrgApiFlatErrorBody> | null {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: ORG_API_UNAUTHENTICATED_MESSAGE }, { status: HTTP_UNAUTHORIZED });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: orgForbiddenMessage(err) }, { status: HTTP_FORBIDDEN });
  }
  return null;
}

/**
 * 認可の失敗を nested の形 `{ error: { code: 'UNAUTHORIZED' | 'FORBIDDEN', message: '<文>' } }` で返す。
 * 認可の失敗でなければ null
 */
export function orgAuthFailureNested(err: unknown): NextResponse<OrgApiNestedErrorBody> | null {
  if (err instanceof AuthError) {
    return NextResponse.json(
      { error: { code: ORG_API_UNAUTHORIZED_CODE, message: ORG_API_UNAUTHENTICATED_MESSAGE } },
      { status: HTTP_UNAUTHORIZED },
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json(
      { error: { code: ORG_API_FORBIDDEN_CODE, message: orgForbiddenMessage(err) } },
      { status: HTTP_FORBIDDEN },
    );
  }
  return null;
}
