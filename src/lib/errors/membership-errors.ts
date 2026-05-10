// src/lib/errors/membership-errors.ts
// (設計書 01-data-model.md §1.2)
export const MembershipErrorCode = {
  // 招待
  INVITE_NOT_FOUND:           'INVITE_NOT_FOUND',
  INVITE_EXPIRED:             'INVITE_EXPIRED',
  INVITE_ALREADY_USED:        'INVITE_ALREADY_USED',
  INVITE_REVOKED:             'INVITE_REVOKED',
  INVITE_EMAIL_MISMATCH:      'INVITE_EMAIL_MISMATCH',

  // 競合
  ALREADY_IN_ORG:             'ALREADY_IN_ORG',
  ALREADY_IN_FAMILY:          'ALREADY_IN_FAMILY',
  IS_ORG_OWNER:               'IS_ORG_OWNER',
  IS_FAMILY_REPRESENTATIVE:   'IS_FAMILY_REPRESENTATIVE',

  // 権限
  NOT_AUTHENTICATED:          'NOT_AUTHENTICATED',
  NOT_ORG_ADMIN:              'NOT_ORG_ADMIN',
  NOT_FAMILY_ADULT:           'NOT_FAMILY_ADULT',
  NOT_OPERATOR:               'NOT_OPERATOR',

  // 制限
  SEAT_LIMIT_EXCEEDED:        'SEAT_LIMIT_EXCEEDED',
  MEMBER_LIMIT_EXCEEDED:      'MEMBER_LIMIT_EXCEEDED',

  // 内部
  RPC_FAILED:                 'RPC_FAILED',
  EMAIL_SEND_FAILED:          'EMAIL_SEND_FAILED',
} as const;

export type MembershipErrorCode = typeof MembershipErrorCode[keyof typeof MembershipErrorCode];
