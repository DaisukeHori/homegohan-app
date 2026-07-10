// src/lib/errors/membership-errors.ts
// (設計書 01-data-model.md §1.2)

export enum MembershipErrorCode {
  // org
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',
  NOT_IN_ORG = 'NOT_IN_ORG',
  ALREADY_IN_ORG = 'ALREADY_IN_ORG',
  SEAT_LIMIT_EXCEEDED = 'SEAT_LIMIT_EXCEEDED',
  OWNER_CANNOT_LEAVE = 'OWNER_CANNOT_LEAVE',
  INSUFFICIENT_PERMISSION = 'INSUFFICIENT_PERMISSION',
  USER_NOT_IN_ORG = 'USER_NOT_IN_ORG',
  // #1062: 未登録だった org 系 RAISE EXCEPTION コード
  NOT_ORG_ADMIN = 'NOT_ORG_ADMIN',
  NOT_ORG_OWNER = 'NOT_ORG_OWNER',
  IS_ORG_OWNER = 'IS_ORG_OWNER',
  CANNOT_REMOVE_OWNER = 'CANNOT_REMOVE_OWNER',
  TARGET_NOT_IN_ORG = 'TARGET_NOT_IN_ORG',
  // family
  FAMILY_NOT_FOUND = 'FAMILY_NOT_FOUND',
  NOT_IN_FAMILY = 'NOT_IN_FAMILY',
  ALREADY_IN_FAMILY = 'ALREADY_IN_FAMILY',
  ALREADY_PROMOTED = 'ALREADY_PROMOTED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_NOT_IN_FAMILY = 'USER_NOT_IN_FAMILY',
  NOT_FAMILY_ADULT = 'NOT_FAMILY_ADULT',
  MEMBER_LIMIT_EXCEEDED = 'MEMBER_LIMIT_EXCEEDED',
  // #1062: 未登録だった family 系 RAISE EXCEPTION コード
  MEMBER_NOT_FOUND = 'MEMBER_NOT_FOUND',
  IS_FAMILY_REPRESENTATIVE = 'IS_FAMILY_REPRESENTATIVE',
  NOT_FAMILY_REPRESENTATIVE = 'NOT_FAMILY_REPRESENTATIVE',
  CANNOT_TRANSFER_TO_CHILD = 'CANNOT_TRANSFER_TO_CHILD',
  // invite
  INVITE_NOT_FOUND = 'INVITE_NOT_FOUND',
  INVITE_EXPIRED = 'INVITE_EXPIRED',
  INVITE_ALREADY_USED = 'INVITE_ALREADY_USED',
  INVITE_REVOKED = 'INVITE_REVOKED',
  EMAIL_MISMATCH = 'EMAIL_MISMATCH',
  INVITE_EMAIL_MISMATCH = 'INVITE_EMAIL_MISMATCH',
  // transfer
  TRANSFER_NOT_FOUND = 'TRANSFER_NOT_FOUND',
  TRANSFER_NOT_PENDING = 'TRANSFER_NOT_PENDING',
  // #1062: propose/accept_*_transfer RPC (org/family 共通, ownership_transfer_proposals 経由)
  // が実際に RAISE するコード。TRANSFER_NOT_FOUND/TRANSFER_NOT_PENDING とは別の文字列。
  TRANSFER_PROPOSAL_NOT_FOUND = 'TRANSFER_PROPOSAL_NOT_FOUND',
  TRANSFER_PROPOSAL_EXPIRED = 'TRANSFER_PROPOSAL_EXPIRED',
  // misc
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  RATE_LIMITED = 'RATE_LIMITED',
  RPC_FAILED = 'RPC_FAILED',
  EMAIL_SEND_FAILED = 'EMAIL_SEND_FAILED',
}

export const ErrorStatusMap: Record<MembershipErrorCode, number> = {
  [MembershipErrorCode.ORG_NOT_FOUND]: 404,
  [MembershipErrorCode.NOT_IN_ORG]: 403,
  [MembershipErrorCode.ALREADY_IN_ORG]: 409,
  [MembershipErrorCode.SEAT_LIMIT_EXCEEDED]: 409,
  [MembershipErrorCode.OWNER_CANNOT_LEAVE]: 409,
  [MembershipErrorCode.INSUFFICIENT_PERMISSION]: 403,
  [MembershipErrorCode.USER_NOT_IN_ORG]: 404,
  [MembershipErrorCode.NOT_ORG_ADMIN]: 403,
  [MembershipErrorCode.NOT_ORG_OWNER]: 403,
  [MembershipErrorCode.IS_ORG_OWNER]: 409,
  [MembershipErrorCode.CANNOT_REMOVE_OWNER]: 409,
  [MembershipErrorCode.TARGET_NOT_IN_ORG]: 404,
  [MembershipErrorCode.FAMILY_NOT_FOUND]: 404,
  [MembershipErrorCode.NOT_IN_FAMILY]: 403,
  [MembershipErrorCode.ALREADY_IN_FAMILY]: 409,
  [MembershipErrorCode.ALREADY_PROMOTED]: 409,
  [MembershipErrorCode.USER_NOT_FOUND]: 404,
  [MembershipErrorCode.USER_NOT_IN_FAMILY]: 404,
  [MembershipErrorCode.NOT_FAMILY_ADULT]: 403,
  [MembershipErrorCode.MEMBER_LIMIT_EXCEEDED]: 409,
  [MembershipErrorCode.MEMBER_NOT_FOUND]: 404,
  [MembershipErrorCode.IS_FAMILY_REPRESENTATIVE]: 409,
  [MembershipErrorCode.NOT_FAMILY_REPRESENTATIVE]: 403,
  [MembershipErrorCode.CANNOT_TRANSFER_TO_CHILD]: 409,
  [MembershipErrorCode.INVITE_NOT_FOUND]: 404,
  [MembershipErrorCode.INVITE_EXPIRED]: 410,
  [MembershipErrorCode.INVITE_ALREADY_USED]: 409,
  [MembershipErrorCode.INVITE_REVOKED]: 409,
  [MembershipErrorCode.EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.INVITE_EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.TRANSFER_NOT_FOUND]: 404,
  [MembershipErrorCode.TRANSFER_NOT_PENDING]: 409,
  [MembershipErrorCode.TRANSFER_PROPOSAL_NOT_FOUND]: 404,
  [MembershipErrorCode.TRANSFER_PROPOSAL_EXPIRED]: 410,
  [MembershipErrorCode.NOT_AUTHENTICATED]: 401,
  [MembershipErrorCode.RATE_LIMITED]: 429,
  [MembershipErrorCode.RPC_FAILED]: 500,
  [MembershipErrorCode.EMAIL_SEND_FAILED]: 500,
};

export function mapPgErrorToHttp(message: string): { code: MembershipErrorCode | 'UNKNOWN'; status: number } {
  // #1045 (F6-16): message.includes(code) による部分一致だと、列挙順で先に評価された
  // 短いコードが誤ってヒットしてしまう (例: 'USER_NOT_IN_ORG' というメッセージに対して
  // 'NOT_IN_ORG' が部分文字列として先にマッチし、本来の 404/USER_NOT_IN_ORG ではなく
  // 403/NOT_IN_ORG に化けてしまっていた)。
  // コードは `[A-Z0-9_]+` の単語であり、区切り文字である '_' も \w に含まれるため、
  // 単語境界 (\b) で照合すれば "NOT_IN_ORG" は "USER_NOT_IN_ORG" の内部にはマッチしない
  // (境界の両側が \w である地点では \b は成立しない)。
  for (const code of Object.values(MembershipErrorCode)) {
    const pattern = new RegExp(`\\b${code}\\b`);
    if (pattern.test(message)) {
      return { code, status: ErrorStatusMap[code] };
    }
  }
  return { code: 'UNKNOWN', status: 500 };
}
