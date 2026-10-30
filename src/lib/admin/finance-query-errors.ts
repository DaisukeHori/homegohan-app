/**
 * 会計の一覧の API (GET /api/admin/finance/invoices・revenue・reconciliation) のクエリの誤りの 400 (#2101 X6)
 *
 * 以前は、請求書・売上の一覧は Zod の `.parse` が投げる例外を外側の catch で 500 (「処理中にエラーが発生しました」) にし、
 * 整合チェックは `parseInt` の NaN をそのまま DB に渡して 500 にしていた (?page=abc など、URL を手で書いたとき)。
 * いまは DB に触れずに 400 VALIDATION_ERROR を返す。code と文は運営の他の一覧 (GET /api/admin/users・
 * GET /api/admin/moderation/queue の「パラメータが不正です」) と同じで、項目の名前を括弧で添える
 * (src/lib/super-admin/validation-errors.ts の validationMessageOf と同じ添え方)。
 * Zod の既定の文 (英語) は本文に入れない (画面は error.message をそのまま出すため。#1917)
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';

/** クエリの誤りのコード (運営の他の一覧の 400 と同じ) */
export const FINANCE_INVALID_QUERY_CODE = 'VALIDATION_ERROR';

/** クエリの誤りの文 (運営の他の一覧の 400 と同じ) */
export const FINANCE_INVALID_QUERY_MESSAGE = 'パラメータが不正です';

const HTTP_BAD_REQUEST = 400;

/** 項目の名前を並べるときの区切り */
const FIELD_SEPARATOR = '・';

export interface FinanceInvalidQueryBody {
  error: {
    code: typeof FINANCE_INVALID_QUERY_CODE;
    message: string;
    /** 誤っていた項目の名前 (クエリの名前。重ならない・issue の順) */
    details: { fields: string[] };
  };
}

/** 誤っていた項目の名前 (issue の path の先頭。重ならない・issue の順) */
export function invalidQueryFieldsOf(issues: readonly z.core.$ZodIssue[]): string[] {
  const fields: string[] = [];
  for (const issue of issues) {
    const head = issue.path[0];
    if (head !== undefined) fields.push(String(head));
  }
  return Array.from(new Set(fields));
}

/** 400 の本文の文 (「パラメータが不正です (page)」。項目が分からなければ固定の文だけ) */
export function financeInvalidQueryMessage(issues: readonly z.core.$ZodIssue[]): string {
  const fields = invalidQueryFieldsOf(issues);
  return fields.length > 0 ? `${FINANCE_INVALID_QUERY_MESSAGE} (${fields.join(FIELD_SEPARATOR)})` : FINANCE_INVALID_QUERY_MESSAGE;
}

/** 400 VALIDATION_ERROR の応答 */
export function financeInvalidQueryResponse(issues: readonly z.core.$ZodIssue[]): NextResponse<FinanceInvalidQueryBody> {
  return NextResponse.json(
    {
      error: {
        code: FINANCE_INVALID_QUERY_CODE,
        message: financeInvalidQueryMessage(issues),
        details: { fields: invalidQueryFieldsOf(issues) },
      },
    },
    { status: HTTP_BAD_REQUEST },
  );
}
