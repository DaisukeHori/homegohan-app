// src/lib/membership/audit-labels.ts
// メンバーシップの監査ログ (membership_audit) の操作 (action) と対象 (scope) を、画面に出す日本語の名前にする (#2086 V5)。
//
// 以前、運営の監査ログの画面 (/operator/membership/audit) は、一覧の操作の列・絞り込みの選択肢・詳細の枠に
// operator_force_owner_transfer などの内部の英字の値をそのまま出し、対象は詳細の枠で organization / family と出していた。
// 一覧の対象の列は organization 以外をすべて「家族」と出していた。対応表をここに 1 つにまとめ、一覧・選択肢・詳細が同じ語を出す。
//
// 操作の値は membership_audit_action_check の 28 値 (最後の定義は supabase/migrations/20261017030000_parental_consent_and_birth_date.sql の 7.)。
// 対象の値は membership_audit_scope_check の 2 値 (supabase/migrations/20251126124224_create_meal_planner_tables.sql)。
// 表のキーと DB の値の全数は tests/membership-audit-labels-contract-2086.test.ts が突き合わせる (CHECK を変えたら表も変える)。
// 表に無い値 (将来の値・壊れた応答) は、内部の値を画面に出さず固定の文を出す (src/lib/admin/moderation-labels.ts と同じ考え方)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

/** 監査ログの操作の表示名 (membership_audit_action_check の全値) */
export const MEMBERSHIP_AUDIT_ACTION_LABELS = {
  group_created: 'グループの作成',
  group_dissolved: 'グループの解散',
  invite_created: '招待の作成',
  invite_accepted: '招待の承諾',
  invite_rejected: '招待の辞退',
  invite_revoked: '招待の取り消し',
  invite_expired: '招待の期限切れ',
  member_added: 'メンバーの追加',
  member_removed: 'メンバーの除名',
  member_left: 'メンバーの脱退',
  child_added: '子供の追加',
  child_promoted: '子供の昇格',
  role_changed: '役割の変更',
  owner_transfer_proposed: 'オーナーの譲渡の提案',
  owner_transferred: 'オーナーの譲渡',
  owner_transfer_declined: 'オーナーの譲渡の辞退',
  representative_transfer_proposed: '代表者の譲渡の提案',
  representative_transferred: '代表者の譲渡',
  representative_transfer_declined: '代表者の譲渡の辞退',
  operator_force_owner_transfer: '運営によるオーナーの強制譲渡',
  operator_force_representative_transfer: '運営による代表者の強制譲渡',
  operator_force_dissolve: '運営による強制解散',
  paste_executed: '食事の家族への貼り付け',
  child_promotion_requested: '子供の昇格の依頼',
  child_promotion_rejected: '子供の昇格の拒否',
  child_promotion_revoked: '子供の昇格の依頼の取り消し',
  parental_consent_recorded: '保護者の同意の記録',
  parental_consent_revoked: '保護者の同意の取り消し',
} as const;

/** 監査ログの操作の値 (membership_audit.action) */
export type MembershipAuditAction = keyof typeof MEMBERSHIP_AUDIT_ACTION_LABELS;

/** 表に無い操作に出す固定の文 (内部の英字の値は出さない) */
export const MEMBERSHIP_AUDIT_ACTION_UNKNOWN_LABEL = '不明な操作';

/** 監査ログの対象の表示名 (membership_audit_scope_check の全値) */
export const MEMBERSHIP_AUDIT_SCOPE_LABELS = {
  organization: '組織',
  family: '家族',
} as const;

/** 監査ログの対象の値 (membership_audit.scope) */
export type MembershipAuditScope = keyof typeof MEMBERSHIP_AUDIT_SCOPE_LABELS;

/** 表に無い対象に出す固定の文 (内部の英字の値は出さない) */
export const MEMBERSHIP_AUDIT_SCOPE_UNKNOWN_LABEL = '不明な対象';

function lookup(table: Readonly<Record<string, string>>, value: string | null | undefined, unknown: string): string {
  if (value != null && Object.prototype.hasOwnProperty.call(table, value)) return table[value];
  return unknown;
}

/** 監査ログの操作の表示名。表に無い値・null は MEMBERSHIP_AUDIT_ACTION_UNKNOWN_LABEL */
export function membershipAuditActionLabel(action: string | null | undefined): string {
  return lookup(MEMBERSHIP_AUDIT_ACTION_LABELS, action, MEMBERSHIP_AUDIT_ACTION_UNKNOWN_LABEL);
}

/** 監査ログの対象の表示名。表に無い値・null は MEMBERSHIP_AUDIT_SCOPE_UNKNOWN_LABEL */
export function membershipAuditScopeLabel(scope: string | null | undefined): string {
  return lookup(MEMBERSHIP_AUDIT_SCOPE_LABELS, scope, MEMBERSHIP_AUDIT_SCOPE_UNKNOWN_LABEL);
}

/** 監査ログの操作の値の一覧 (表の順。絞り込みの選択肢に使う) */
export const MEMBERSHIP_AUDIT_ACTIONS = Object.keys(MEMBERSHIP_AUDIT_ACTION_LABELS) as MembershipAuditAction[];

/** 監査ログの対象の値の一覧 (表の順。絞り込みの選択肢に使う) */
export const MEMBERSHIP_AUDIT_SCOPES = Object.keys(MEMBERSHIP_AUDIT_SCOPE_LABELS) as MembershipAuditScope[];
