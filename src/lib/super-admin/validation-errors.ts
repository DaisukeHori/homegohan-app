/**
 * super-admin API の 400 (入力の誤り OP_INVALID_INPUT・クエリの誤り OP_INVALID_QUERY) の本文を 1 か所で作る (#1534 / #1641 / #1654)
 *
 * 以前は Zod の失敗で、応答の `error.message` に ZodError の `message` (issues 配列を JSON にした文字列) を入れていた
 * (クーポンは #1534 / #1641 で直し、feature-packages と plans は #1654 で直した)。画面は `error.message` をそのまま出す。
 *
 * ここでは、どの 400 も `error.message` を「最初の issue の文」にし、`details` に issues を全件入れる
 * (src/app/api/super-admin/plans/[id]/price-change/route.ts・price-impact/route.ts もここの invalidInputResponse / invalidQueryResponse を使う)。
 *
 * もとはクーポンの route だけの置き場 (src/lib/super-admin/coupon-errors.ts) にあった。
 * coupon-errors.ts はここを再公開しているだけで、クーポンの route の応答は変わらない。
 *
 * #1917: `error.message` に入れるのは日本語の文だけにする。schema に書いた日本語の文 (custom の message) はそのまま使い、
 * Zod の既定の文 (英語。'Invalid input: expected number, received string' など) は、code ごとの日本語の固定の文に
 * 項目の名前 (issue の path) を添えた文にする (validationMessageOf)。画面は `error.message` をそのまま出すため。
 * `details` は従来どおり issues の全件 (項目ごとに見る呼び出し側のため。形は変えない) で、各 issue の文も同じ規則で日本語にする。
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

/**
 * 日本語の文の判定 (ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号を 1 文字でも含む)。
 * tests/helpers/api-error-text-scan.ts の JAPANESE と同じ範囲
 */
const JAPANESE_TEXT = /[぀-ヿ㐀-鿿＀-￯]/;

/** 項目の名前 (issue の path) をつなぐ区切り */
const ISSUE_PATH_SEPARATOR = '.';

/**
 * 400 の本文の `message` にする文 (#1917)。
 * - issue が無い → code ごとの日本語の固定の文
 * - issue の文が日本語 (schema に書いた custom の message) → その文のまま
 * - issue の文が日本語でない (Zod の既定の英語の文) → code ごとの日本語の固定の文に、項目の名前を `(項目)` で添えた文
 */
export function validationMessageOf(code: SuperAdminValidationErrorCode, issue: z.core.$ZodIssue | undefined): string {
  const fallback = FALLBACK_MESSAGES[code];
  if (!issue) return fallback;
  if (JAPANESE_TEXT.test(issue.message)) return issue.message;
  const field = issue.path.map((segment) => String(segment)).join(ISSUE_PATH_SEPARATOR);
  return field ? `${fallback} (${field})` : fallback;
}

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

/**
 * 400 の本文。`details` は issues の全件で、各 issue の文も validationMessageOf の日本語の文に置き換える
 * (項目の下に issue の文を出す画面 (src/lib/backups/core.ts の drTestErrorsFromResponse) にも英語を出さないため)。
 * `message` は最初の issue の文 (= details[0].message)
 */
export function validationErrorBody<C extends SuperAdminValidationErrorCode>(
  code: C,
  issues: readonly z.core.$ZodIssue[],
): SuperAdminValidationErrorBody<C> {
  const details = issues.map((issue): z.core.$ZodIssue => ({ ...issue, message: validationMessageOf(code, issue) }));
  return {
    error: {
      code,
      message: validationMessageOf(code, issues[0]),
      details,
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
