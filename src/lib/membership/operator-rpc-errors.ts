/**
 * 運営の membership の RPC が `RAISE EXCEPTION '<コード>'` で止めた既知のエラーを、4xx の nested の本文に写す (#1917 の続き)。
 *
 * これまで運営の強制解散・放置の一覧の route は、二段階認証の判定 (OPERATOR_MFA_REQUIRED) 以外の RPC のエラーを
 * すべて汎用の 500 (internalError) にしていた。そのため、解散済みの組織をもう一度解散しようとすると 409 でなく 500 になり、
 * 運営の画面 (本文の error.message をそのまま出す) に理由が出なかった。
 *
 * - 権限の判定で止めたコード (RPC ごとに語が違う) は、route のゲート (requireSuperAdmin) が権限で止めたときと同じ
 *   403 FORBIDDEN と日本語の固定の文 (強制の譲渡の 2 route の NOT_OPERATOR と同じ扱い)
 * - 業務のコードは src/lib/errors/membership-errors.ts の表 (ErrorStatusMap の 4xx・MEMBERSHIP_ERROR_MESSAGES の日本語の文)
 * - 二段階認証の判定 (OPERATOR_MFA_REQUIRED) は route が operatorMfaRequiredNested で先に拾う (ここでは扱わない。
 *   tests/operator-mfa-db-gate-routes-403.test.ts が route のソースに operatorMfaRequiredNested の呼び出しがあることを確かめる)
 *
 * RPC の生の文面は本文に入れない (#1172)。どれにも当たらなければ null を返し、route は従来どおり internalError の 500 にする。
 * RPC が RAISE するコードの一覧 (下の表) は、migration の最新の定義と tests/operator-membership-rpc-errors-1917.test.ts で突き合わせる。
 */
import { NextResponse } from 'next/server';
import { API_FORBIDDEN_CODE, API_FORBIDDEN_MESSAGE, type ApiNestedErrorBody } from '@/lib/api/error-responses';
import { dbErrorMentionsCode, type DbRaisedErrorLike } from '@/lib/errors/db-raised-code';
import { ErrorStatusMap, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';

/** 4xx に写してよい上限 (これ以上の status は呼び出し元の誤りではないので、表に載っていても写さない) */
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_FORBIDDEN = 403;

/** 運営の RPC が「呼び出し元が運営でない」ときに RAISE する語 (RPC ごとに違う) */
export type OperatorRpcPermissionCode = 'NOT_OPERATOR' | 'OPERATOR_PERMISSION_REQUIRED' | 'INSUFFICIENT_PERMISSION';

/** 1 本の RPC が RAISE するコード (OPERATOR_MFA_REQUIRED を除く) */
export interface OperatorRpcRaisedCodes {
  /** 権限の判定で止めたときの語 → 403 FORBIDDEN */
  readonly permission: OperatorRpcPermissionCode;
  /** 業務のコード → membership-errors の表の status と日本語の文 */
  readonly membership: readonly MembershipErrorCode[];
}

/**
 * 運営の membership の route のうち、RPC のエラーをこの関数で写す RPC と、その RPC が RAISE するコード。
 * 出典は migration の最新の定義:
 *   - operator_force_dissolve_org / operator_force_dissolve_family: supabase/migrations/20261019120000_self_dissolve.sql
 *   - list_orgs_with_inactive_owner / list_families_with_inactive_representative: supabase/migrations/20261017130000_operator_mfa_db_gate.sql
 * operator_force_dissolve_family は家族が無い・解散済みでも RAISE しない (後始末の UPDATE が 0 行・やり直しになる) ので、業務のコードは無い。
 * 強制の譲渡の 2 本 (operator_force_owner_transfer / operator_force_representative_transfer) は route が個別に写している
 */
export const OPERATOR_MEMBERSHIP_RPC_RAISED_CODES = {
  operator_force_dissolve_org: {
    permission: 'OPERATOR_PERMISSION_REQUIRED',
    membership: [MembershipErrorCode.ORG_NOT_FOUND, MembershipErrorCode.ORG_ALREADY_DISSOLVED],
  },
  operator_force_dissolve_family: { permission: 'NOT_OPERATOR', membership: [] },
  list_orgs_with_inactive_owner: { permission: 'INSUFFICIENT_PERMISSION', membership: [] },
  list_families_with_inactive_representative: { permission: 'INSUFFICIENT_PERMISSION', membership: [] },
} as const satisfies Record<string, OperatorRpcRaisedCodes>;

export type OperatorMembershipRpcName = keyof typeof OPERATOR_MEMBERSHIP_RPC_RAISED_CODES;

/**
 * RPC のエラーが、その RPC の既知のコード (権限の判定・業務のコード) なら 4xx の nested の本文を返す。そうでなければ null。
 * コードは語の境界で照合する (src/lib/errors/db-raised-code.ts の dbErrorMentionsCode。強制の譲渡の route と同じ)
 */
export function operatorMembershipRpcErrorNested(
  rpc: OperatorMembershipRpcName,
  error: DbRaisedErrorLike | null | undefined,
): NextResponse<ApiNestedErrorBody> | null {
  if (!error) return null;
  const known: OperatorRpcRaisedCodes = OPERATOR_MEMBERSHIP_RPC_RAISED_CODES[rpc];
  if (dbErrorMentionsCode(error, known.permission)) {
    return NextResponse.json({ error: { code: API_FORBIDDEN_CODE, message: API_FORBIDDEN_MESSAGE } }, { status: HTTP_FORBIDDEN });
  }
  for (const code of known.membership) {
    const status = ErrorStatusMap[code];
    if (status >= HTTP_SERVER_ERROR_MIN) continue;
    if (dbErrorMentionsCode(error, code)) {
      return NextResponse.json({ error: { code, message: MEMBERSHIP_ERROR_MESSAGES[code] } }, { status });
    }
  }
  return null;
}
