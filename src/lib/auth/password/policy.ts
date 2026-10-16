/**
 * パスワードの過去履歴の禁止の世代数。設計の正典 docs/design/cross/16-auth-history-sessions.md §12.2。
 */
/** 過去履歴の禁止の世代数 (cross/01 §7.1)。履歴には現在のパスワードも入るので「現在 + 直前 N-1 個」と同じ */
export const PASSWORD_HISTORY_GENERATIONS = { user: 3, org_member: 5, operator: 10 } as const;
/** DB が残す世代の最大 = 運営の世代数。SQL の password_history_record / auth_password_check の c_max_generations と同じ値 (契約テスト) */
export const PASSWORD_HISTORY_MAX_GENERATIONS = 10;
/** メールのリンク / コードで作ったセッション (amr に recovery または otp。session-claims.ts の RECOVERY_AMR_METHODS) を、再設定の API が受け付ける分数。Supabase の再設定リンクの有効期間 (既定 1 時間) に合わせる */
export const PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES = 60;
/** 運営の世代数を適用するロール (cross/01 §7.1 の「運営 (admin+)」。support / sales / finance / content_moderator も運営の画面を持つので含める) */
const OPERATOR_ROLES: ReadonlySet<string> = new Set(['support', 'sales', 'finance', 'content_moderator', 'admin', 'super_admin']);
const ORG_ROLE_PREFIX = 'org_';
export function passwordHistoryGenerationsFor(roles: ReadonlyArray<string>): number {
  if (roles.some((r) => OPERATOR_ROLES.has(r))) return PASSWORD_HISTORY_GENERATIONS.operator;
  if (roles.some((r) => r.startsWith(ORG_ROLE_PREFIX))) return PASSWORD_HISTORY_GENERATIONS.org_member;
  return PASSWORD_HISTORY_GENERATIONS.user;
}
