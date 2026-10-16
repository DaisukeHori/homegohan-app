/**
 * 運営ロールの MFA の監査 (admin_audit_logs) の facade (#1176。docs/design/cross/12-operator-mfa.md §17.1)
 *
 * 書くのは recordMfaAudit だけ (recordAdminAudit を包む)。client は service_role (getSupabaseAdmin()):
 * org_industrial_doctor は audit_logs_insert_admins の RLS の一覧に無く、本人の client では INSERT できないため。
 * 必ず認可 (requireRole) の後に書く。いつ書くか (監査の起点の後は途中で失敗しても必ず 1 回) は cross/12 §17.2。
 * reset の action と details の型も段 A で置く (reset の route は段 C)。
 */
import {
  recordAdminAudit,
  type AdminAuditSeverity,
  type RecordAdminAuditParams,
  type RecordAdminAuditResult,
} from '@/lib/admin/audit';

/** §17 の action_type (operator/07 §4 の命名) */
export const MFA_AUDIT_ACTIONS = {
  enroll: 'admin.mfa.enroll',
  backupCodesRegenerate: 'admin.mfa.backup_codes_regenerate',
  unenroll: 'admin.mfa.unenroll',
  recover: 'admin.mfa.recover',
  reset: 'super_admin.mfa.reset',
} as const;

export type MfaAuditAction = (typeof MFA_AUDIT_ACTIONS)[keyof typeof MFA_AUDIT_ACTIONS];

/** action ごとの severity (§17 の表) */
export const MFA_AUDIT_SEVERITY: Readonly<Record<MfaAuditAction, AdminAuditSeverity>> = {
  'admin.mfa.enroll': 'info',
  'admin.mfa.backup_codes_regenerate': 'info',
  'admin.mfa.unenroll': 'warn',
  'admin.mfa.recover': 'warn',
  'super_admin.mfa.reset': 'critical',
};

/** target_type (本人・対象のどちらも利用者。varchar(30)) */
export const MFA_AUDIT_TARGET_TYPE = 'user';

/**
 * 監査の起点の後で止まった手順の名前 (§17.2)。details の failed_step に入れる (最後まで進めば null)。
 * signOutSessions は回復の「本人の全セッションを終える」(admin.signOut の scope 'global')。admin の deleteFactor だけでは
 * セッションが終わらない (2026-10-16 のローカルの GoTrue v2.183.0 の実測) ので、回復の route が自分で終える
 */
export const MFA_AUDIT_FAILED_STEPS = {
  issueBackupCodes: 'issue_backup_codes',
  signOutSessions: 'sign_out_sessions',
  deleteFactor: 'delete_factor',
  deleteBackupCodes: 'delete_backup_codes',
  refreshSession: 'refresh_session',
} as const;

export type MfaAuditFailedStep = (typeof MFA_AUDIT_FAILED_STEPS)[keyof typeof MFA_AUDIT_FAILED_STEPS];

/**
 * action ごとの details の形 (§17 の表と、値の出どころの表)。秘密 (secret・QR・コードの値・ハッシュ) の欄は持たない。
 * 数の欄の null は「その手順に届かなかった・失敗した」(§17.2)。failed_step は action ごとに起こりうる手順だけを許す
 */
export interface MfaAuditDetailsMap {
  'admin.mfa.enroll': {
    factor_id: string;
    backup_codes_issued: number | null;
    failed_step: Extract<MfaAuditFailedStep, 'issue_backup_codes'> | null;
  };
  'admin.mfa.backup_codes_regenerate': {
    backup_codes_issued: number | null;
    failed_step: Extract<MfaAuditFailedStep, 'issue_backup_codes'> | null;
  };
  'admin.mfa.unenroll': {
    factor_id: string;
    backup_codes_deleted: number | null;
    failed_step: Extract<MfaAuditFailedStep, 'delete_backup_codes' | 'refresh_session'> | null;
  };
  'admin.mfa.recover': {
    factors_deleted: number;
    backup_codes_deleted: number | null;
    failed_step: Extract<MfaAuditFailedStep, 'sign_out_sessions' | 'delete_factor' | 'delete_backup_codes'> | null;
  };
  /** identity_check は MfaResetBodySchema で検証済みの MFA_RESET_IDENTITY_CHECKS の 1 つ (schemas.ts の段 C の定数に依らないよう string で持つ) */
  'super_admin.mfa.reset': { reason: string; identity_check: string; factors_before: number; backup_codes_before: number };
}

export interface RecordMfaAuditInput<A extends MfaAuditAction> {
  /** service_role の client (getSupabaseAdmin())。§17: org_industrial_doctor は本人の client で INSERT できない */
  admin: RecordAdminAuditParams['supabase'];
  /** 操作した人 (自己サービスは本人・reset は実行した super_admin) */
  actorId: string;
  /** 対象の利用者 (自己サービスは actorId と同じ・reset は対象) */
  targetUserId: string;
  action: A;
  details: MfaAuditDetailsMap[A];
  /** ip_address / user_agent を取り出す要求 (route の request) */
  request: Pick<Request, 'headers'>;
  /** 失敗を app_logs に出すときの名前 (その route の ROUTE_NAME) */
  routeName: string;
}

/**
 * MFA の監査を admin_audit_logs に 1 行書く (recordAdminAudit を包む)。例外は投げない。
 * 戻り値は recordAdminAudit のまま返す: fail-closed の reset は ok を読み、false なら 500 で何もしない。
 * fail-open の 4 種 (enroll / backup_codes_regenerate / unenroll / recover) は await するが戻り値を読まない
 * (失敗は recordAdminAudit が app_logs に残す)。4 種をいつ呼ぶか (起点の後は途中で失敗しても必ず 1 回) は cross/12 §17.2。
 * recordAdminAudit の呼び出しは request を渡すオブジェクトのリテラルで書く (tests/admin-mutation-audit-coverage-1571.test.ts の (b))
 */
export async function recordMfaAudit<A extends MfaAuditAction>(input: RecordMfaAuditInput<A>): Promise<RecordAdminAuditResult> {
  return recordAdminAudit({
    supabase: input.admin,
    actorId: input.actorId,
    actionType: input.action,
    targetId: input.targetUserId,
    targetType: MFA_AUDIT_TARGET_TYPE,
    details: input.details,
    severity: MFA_AUDIT_SEVERITY[input.action],
    request: input.request,
    routeName: input.routeName,
  });
}
