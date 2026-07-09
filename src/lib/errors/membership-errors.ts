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
  // family
  FAMILY_NOT_FOUND = 'FAMILY_NOT_FOUND',
  NOT_IN_FAMILY = 'NOT_IN_FAMILY',
  ALREADY_IN_FAMILY = 'ALREADY_IN_FAMILY',
  ALREADY_PROMOTED = 'ALREADY_PROMOTED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_NOT_IN_FAMILY = 'USER_NOT_IN_FAMILY',
  NOT_FAMILY_ADULT = 'NOT_FAMILY_ADULT',
  MEMBER_LIMIT_EXCEEDED = 'MEMBER_LIMIT_EXCEEDED',
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
  [MembershipErrorCode.FAMILY_NOT_FOUND]: 404,
  [MembershipErrorCode.NOT_IN_FAMILY]: 403,
  [MembershipErrorCode.ALREADY_IN_FAMILY]: 409,
  [MembershipErrorCode.ALREADY_PROMOTED]: 409,
  [MembershipErrorCode.USER_NOT_FOUND]: 404,
  [MembershipErrorCode.USER_NOT_IN_FAMILY]: 404,
  [MembershipErrorCode.NOT_FAMILY_ADULT]: 403,
  [MembershipErrorCode.MEMBER_LIMIT_EXCEEDED]: 409,
  [MembershipErrorCode.INVITE_NOT_FOUND]: 404,
  [MembershipErrorCode.INVITE_EXPIRED]: 410,
  [MembershipErrorCode.INVITE_ALREADY_USED]: 409,
  [MembershipErrorCode.INVITE_REVOKED]: 409,
  [MembershipErrorCode.EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.INVITE_EMAIL_MISMATCH]: 403,
  [MembershipErrorCode.TRANSFER_NOT_FOUND]: 404,
  [MembershipErrorCode.TRANSFER_NOT_PENDING]: 409,
  [MembershipErrorCode.NOT_AUTHENTICATED]: 401,
  [MembershipErrorCode.RATE_LIMITED]: 429,
  [MembershipErrorCode.RPC_FAILED]: 500,
  [MembershipErrorCode.EMAIL_SEND_FAILED]: 500,
};

export function mapPgErrorToHttp(message: string): { code: MembershipErrorCode | 'UNKNOWN'; status: number } {
  for (const code of Object.values(MembershipErrorCode)) {
    if (message.includes(code)) {
      return { code, status: ErrorStatusMap[code] };
    }
  }
  return { code: 'UNKNOWN', status: 500 };
}
