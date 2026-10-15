/**
 * super-admin API の 400 (入力の誤り OP_INVALID_INPUT・クエリの誤り OP_INVALID_QUERY) の本文を 1 か所で作る (#1534 / #1641 / #1654)
 *
 * 以前は Zod の失敗で、応答の `error.message` に ZodError の `message` (issues 配列を JSON にした文字列) を入れていた
 * (クーポンは #1534 / #1641 で直し、feature-packages と plans は #1654 で直した)。画面は `error.message` をそのまま出す。
 *
 * ここでは、どの 400 も `error.message` を「最初の issue の文」にし、`details` に issues を全件入れる
 * (src/app/api/super-admin/plans/[id]/price-change/route.ts の firstIssueMessage と同じ形)。
 *
 * もとはクーポンの route だけの置き場 (src/lib/super-admin/coupon-errors.ts) にあった。
 * coupon-errors.ts はここを再公開しているだけで、クーポンの route の応答は変わらない。
 *
 * 本文が JSON として読めないとき (#1654) も 400 OP_INVALID_INPUT にする。以前は `await request.json()` の例外が
 * route の外側の catch に落ち、500 OP_INTERNAL_ERROR になっていた。
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';

/** 入力の誤りのコード (docs/design/operator/02-api-spec.md §19) */
export const SUPER_ADMIN_INVALID_INPUT_CODE = 'OP_INVALID_INPUT';

/** クエリの誤りのコード (docs/design/operator/02-api-spec.md §19) */
export const SUPER_ADMIN_INVALID_QUERY_CODE = 'OP_INVALID_QUERY';

/** 400 の本文に使えるコード */
export type SuperAdminValidationErrorCode = typeof SUPER_ADMIN_INVALID_INPUT_CODE | typeof SUPER_ADMIN_INVALID_QUERY_CODE;

/** issues が空のとき (Zod は失敗時に 1 件以上を返すので、通常は使われない) の文 (OP_INVALID_INPUT) */
export const SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE = '入力値が不正です';

/** issues が空のとき (同上) の文 (OP_INVALID_QUERY) */
export const SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE = 'クエリパラメータが不正です';

/**
 * 本文が JSON として読めないときの文 (#1654)。
 * src/app/api/super-admin/settings/route.ts・embeddings/regenerate/route.ts の同じ場面の文と同じ。
 */
export const SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE = 'リクエストボディが不正です';

const FALLBACK_MESSAGES: Readonly<Record<SuperAdminValidationErrorCode, string>> = {
  [SUPER_ADMIN_INVALID_INPUT_CODE]: SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE,
  [SUPER_ADMIN_INVALID_QUERY_CODE]: SUPER_ADMIN_INVALID_QUERY_FALLBACK_MESSAGE,
};

const HTTP_BAD_REQUEST = 400;

export interface SuperAdminValidationErrorBody<C extends SuperAdminValidationErrorCode = SuperAdminValidationErrorCode> {
  error: {
    code: C;
    message: string;
    details: readonly z.core.$ZodIssue[];
  };
}

/** 400 OP_INVALID_INPUT の本文の型 */
export type SuperAdminInvalidInputBody = SuperAdminValidationErrorBody<typeof SUPER_ADMIN_INVALID_INPUT_CODE>;

/** 400 OP_INVALID_QUERY の本文の型 */
export type SuperAdminInvalidQueryBody = SuperAdminValidationErrorBody<typeof SUPER_ADMIN_INVALID_QUERY_CODE>;

/** 400 の本文。`message` は最初の issue の文、`details` は issues の全件 */
export function validationErrorBody<C extends SuperAdminValidationErrorCode>(
  code: C,
  issues: readonly z.core.$ZodIssue[],
): SuperAdminValidationErrorBody<C> {
  return {
    error: {
      code,
      message: issues[0]?.message ?? FALLBACK_MESSAGES[code],
      details: issues,
    },
  };
}

/** 400 の応答 (code を引数で渡す) */
export function validationErrorResponse<C extends SuperAdminValidationErrorCode>(
  code: C,
  issues: readonly z.core.$ZodIssue[],
): NextResponse<SuperAdminValidationErrorBody<C>> {
  return NextResponse.json(validationErrorBody(code, issues), { status: HTTP_BAD_REQUEST });
}

/** 400 OP_INVALID_INPUT の本文 */
export function invalidInputBody(issues: readonly z.core.$ZodIssue[]): SuperAdminInvalidInputBody {
  return validationErrorBody(SUPER_ADMIN_INVALID_INPUT_CODE, issues);
}

/** 400 OP_INVALID_INPUT の応答 */
export function invalidInputResponse(issues: readonly z.core.$ZodIssue[]): NextResponse<SuperAdminInvalidInputBody> {
  return validationErrorResponse(SUPER_ADMIN_INVALID_INPUT_CODE, issues);
}

/** 400 OP_INVALID_QUERY の本文 */
export function invalidQueryBody(issues: readonly z.core.$ZodIssue[]): SuperAdminInvalidQueryBody {
  return validationErrorBody(SUPER_ADMIN_INVALID_QUERY_CODE, issues);
}

/** 400 OP_INVALID_QUERY の応答 */
export function invalidQueryResponse(issues: readonly z.core.$ZodIssue[]): NextResponse<SuperAdminInvalidQueryBody> {
  return validationErrorResponse(SUPER_ADMIN_INVALID_QUERY_CODE, issues);
}

/** 本文が JSON として読めないときの 400 OP_INVALID_INPUT の本文 (`message` は固定の文・`details` は空) */
export function invalidJsonBodyBody(): SuperAdminInvalidInputBody {
  return {
    error: {
      code: SUPER_ADMIN_INVALID_INPUT_CODE,
      message: SUPER_ADMIN_INVALID_JSON_BODY_MESSAGE,
      details: [],
    },
  };
}

/** 本文が JSON として読めないときの 400 OP_INVALID_INPUT の応答 */
export function invalidJsonBodyResponse(): NextResponse<SuperAdminInvalidInputBody> {
  return NextResponse.json(invalidJsonBodyBody(), { status: HTTP_BAD_REQUEST });
}

/** 本文の読み取りの結果 */
export type ReadJsonBodyResult = { ok: true; body: unknown } | { ok: false };

/**
 * 本文を JSON として読む。読めなければ `{ ok: false }` を返す (例外にしない)。
 * route は `ok: false` のとき 400 を返す (外側の catch の 500 に落とさない — #1654)。
 */
export async function readJsonBody(request: Request): Promise<ReadJsonBodyResult> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}
