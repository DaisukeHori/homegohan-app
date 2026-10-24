// src/lib/backups/core.ts
// #1129 / #1191 バックアップの状態と DR 訓練の記録の正典: 定数・Zod・型・純関数。
// 画面 (src/app/super-admin/backups/page.tsx) は、選択肢 (DR_TEST_* の配列)・ラベル (*_LABELS)・上限・パス・型・400 の文の読み方 (drTestErrorsFromResponse) をこのファイルから import する
// (zod を含むファイルの値を client の画面が import する前例: src/app/super-admin/llm/quotas/page.tsx の '@/lib/super-admin/llm-schemas')。
// 選択肢とラベルを page.tsx に書き写さない (正典を 2 か所にしない)。
import { z } from 'zod';

// ── 取得 (GitHub Actions が admin_audit_logs に残す行) ────────────────────────
export const BACKUP_TIERS = ['daily', 'weekly', 'annual'] as const;
export type BackupTier = (typeof BACKUP_TIERS)[number];
export const BACKUP_RESULTS = ['completed', 'failed'] as const;
export type BackupResult = (typeof BACKUP_RESULTS)[number];

/** action_type。scripts/lib/backup-db.mjs と migration の record_backup_audit が受け付ける 6 つと同じ */
export function backupAuditAction(tier: BackupTier, result: BackupResult): string {
  return `backup.${tier}.${result}`;
}
export const BACKUP_AUDIT_ACTION_TYPES: readonly string[] = BACKUP_TIERS.flatMap((tier) =>
  BACKUP_RESULTS.map((result) => backupAuditAction(tier, result)),
);
export const BACKUP_AUDIT_TARGET_TYPE = 'database_backup';

const MINUTES_PER_HOUR = 60;

/** 取得の予定 (1 日 1 回) と、「古い」とみなす経過時間。24 時間 + GitHub の schedule の遅れの余裕 6 時間 */
export const BACKUP_SCHEDULE_HOURS = 24;
export const BACKUP_STALE_SLACK_HOURS = 6;
export const BACKUP_STALE_AFTER_HOURS = BACKUP_SCHEDULE_HOURS + BACKUP_STALE_SLACK_HOURS;
/** 鮮度の cron の予定 (vercel.json)。取得 (02:23 JST) の 12 時間後で、取得の所要と遅れを吸収する。日 1 回 = 24 時間おき */
export const BACKUP_FRESHNESS_CRON_PATH = '/api/cron/backup-freshness';
export const BACKUP_FRESHNESS_SCHEDULE_UTC = '37 5 * * *';
export const BACKUP_FRESHNESS_CRON_INTERVAL_HOURS = 24;
/** 鮮度の通知の ops_alert_state のキー */
export const BACKUP_STALE_ALERT_KEY = 'backup_stale';
/** cron の起動時刻のぶれ (秒〜分) を吸収する余裕 */
export const BACKUP_STALE_ALERT_JITTER_MARGIN_HOURS = 1;
/** 送り直さない時間 (分) = 23 時間。claim_ops_alert は「前回から cooldown 以上たった」ときだけ権利を返すので、
 *  cron の間隔 (24 時間) とちょうど同じにすると、起動のぶれで翌日の回が 1 秒足りずに stale_deduped になり、通知が 48 時間空く。
 *  間隔より短く、同じ日の 2 回目 (手動の再実行など) は止まる長さにする */
export const BACKUP_STALE_ALERT_COOLDOWN_MINUTES =
  (BACKUP_FRESHNESS_CRON_INTERVAL_HOURS - BACKUP_STALE_ALERT_JITTER_MARGIN_HOURS) * MINUTES_PER_HOUR;
/** 画面と API が読む取得の行の上限 (新しい順)。日 1〜3 行なので 1〜3 か月分。層ごとの最新はこの窓によらず別に読む (§7.1) */
export const BACKUP_STATUS_LIST_LIMIT = 100;
/** 画面と API が読む訓練の行の上限 (新しい順)。年 17 行 (月次 12 + 四半期 4 + 年次 1) なので約 5 年分。種類ごとの最新は別に読む */
export const DR_TEST_LIST_LIMIT = 100;
export const SUPER_ADMIN_BACKUPS_PATH = '/super-admin/backups';
export const SUPER_ADMIN_BACKUPS_API_PATH = '/api/super-admin/backups';
export const SUPER_ADMIN_DR_TESTS_API_PATH = '/api/super-admin/backups/dr-tests';

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** 最新の completed が無い、または BACKUP_STALE_AFTER_HOURS より古ければ true */
export function isBackupStale(latestCompletedAt: string | null, now: Date): boolean {
  if (latestCompletedAt === null) return true;
  const at = Date.parse(latestCompletedAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at > BACKUP_STALE_AFTER_HOURS * MS_PER_HOUR;
}

// ── DR 訓練の記録 ───────────────────────────────────────────────────────────
export const DR_TEST_KINDS = ['monthly_pitr', 'quarterly_restore', 'annual_drill'] as const;
export type DrTestKind = (typeof DR_TEST_KINDS)[number];
/** action_type (07 §7.1 の dr.test.monthly.pitr の形に揃える) */
export const DR_TEST_AUDIT_ACTIONS: Readonly<Record<DrTestKind, string>> = {
  monthly_pitr: 'dr.test.monthly.pitr',
  quarterly_restore: 'dr.test.quarterly.restore',
  annual_drill: 'dr.test.annual.drill',
};
export const DR_TEST_AUDIT_ACTION_TYPES: readonly string[] = DR_TEST_KINDS.map((kind) => DR_TEST_AUDIT_ACTIONS[kind]);
export const DR_TEST_AUDIT_TARGET_TYPE = 'dr_test';
/** 訓練を記録できるロール (POST の requireRole(['super_admin']) と同じ)。読む側は、訓練の行の actor が今このロールを持つかで絞る (§7.1) */
export const DR_TEST_RECORDER_ROLE = 'super_admin';
export const DR_TEST_RESULTS = ['success', 'failed', 'skipped'] as const;
export type DrTestResult = (typeof DR_TEST_RESULTS)[number];
export const DR_TEST_ENVIRONMENTS = ['local', 'staging', 'new_project', 'production'] as const;
export type DrTestEnvironment = (typeof DR_TEST_ENVIRONMENTS)[number];
export const DR_TEST_SMOKE_RESULTS = ['passed', 'failed', 'not_run'] as const;
export type DrTestSmokeResult = (typeof DR_TEST_SMOKE_RESULTS)[number];
/** 自由記述の上限。問い合わせの本文 (5000) より短い。要点だけを残す */
export const DR_TEST_NOTES_MAX_LENGTH = 2000;
/** R2 のキーの上限 (接頭辞 + 日付 + base + 拡張子で 80 字ほど。余裕をもって) */
export const DR_TEST_BACKUP_KEY_MAX_LENGTH = 256;
/** 復旧にかかった分の上限。約 69 日。これより長い値は打ち間違い */
export const DR_TEST_RTO_MINUTES_MAX = 100_000;
/** R2 のキーの形 (接頭辞 / 日付 / ファイル名)。それ以外の文字は受けない (監査行に任意の文字列を入れない) */
export const BACKUP_KEY_PATTERN = /^(daily|weekly|annual)\/[0-9A-Za-z._/-]{1,200}$/;

/** 400 の項目の文は schema に書いた日本語 (route は issues をそのまま src/lib/super-admin/validation-errors.ts の invalidInputResponse に渡し、画面は項目の下に出す。§7.2・§7.4) */
export const drTestRecordBodySchema = z
  .object({
    kind: z.enum(DR_TEST_KINDS, { message: '訓練の種類を選んでください' }),
    result: z.enum(DR_TEST_RESULTS, { message: '結果を選んでください' }),
    performed_on: z.iso.date({ message: '実施日を YYYY-MM-DD の形で書いてください' }),
    environment: z.enum(DR_TEST_ENVIRONMENTS, { message: '復元した先を選んでください' }),
    restored_to: z.iso.datetime({ offset: true, message: '復元した時点を日時で書いてください' }).nullable(),
    backup_key: z
      .string({ message: 'R2 のキーを文字で書いてください' })
      .max(DR_TEST_BACKUP_KEY_MAX_LENGTH, `R2 のキーは ${DR_TEST_BACKUP_KEY_MAX_LENGTH} 文字以内で書いてください`)
      .regex(BACKUP_KEY_PATTERN, 'R2 のキーは daily/・weekly/・annual/ で始まる形で書いてください')
      .nullable(),
    rto_minutes: z
      .number({ message: '復旧にかかった分を数で書いてください' })
      .int('復旧にかかった分は整数で書いてください')
      .min(0, '復旧にかかった分は 0 以上で書いてください')
      .max(DR_TEST_RTO_MINUTES_MAX, `復旧にかかった分は ${DR_TEST_RTO_MINUTES_MAX} 以下で書いてください`)
      .nullable(),
    smoke: z.enum(DR_TEST_SMOKE_RESULTS, { message: '動作確認 (smoke) の結果を選んでください' }),
    notes: z
      .string({ message: 'メモを文字で書いてください' })
      .max(DR_TEST_NOTES_MAX_LENGTH, `メモは ${DR_TEST_NOTES_MAX_LENGTH} 文字以内で書いてください`),
  })
  .strict()
  .superRefine((body, ctx) => {
    // 成功以外は理由を残す (skipped の plan_not_pro など)
    if (body.result !== 'success' && body.notes.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['notes'], message: '失敗・見送りのときは理由を書いてください' });
    }
    if (body.kind === 'quarterly_restore' && body.result === 'success' && body.backup_key === null) {
      ctx.addIssue({ code: 'custom', path: ['backup_key'], message: '復元に使った R2 のキーを書いてください' });
    }
  });
export type DrTestRecordBody = z.infer<typeof drTestRecordBodySchema>;

export function drTestSeverity(result: DrTestResult): 'info' | 'warn' {
  return result === 'success' ? 'info' : 'warn';
}

/** 画面の form の項目 (drTestRecordBodySchema の shape のキーと同じ並び。core のテストが突き合わせる) */
export const DR_TEST_FIELDS = ['kind', 'result', 'performed_on', 'environment', 'restored_to', 'backup_key', 'rto_minutes', 'smoke', 'notes'] as const;
export type DrTestField = (typeof DR_TEST_FIELDS)[number];

/** POST の 400 の本文 (validation-errors.ts の invalidInputBody / invalidJsonBodyBody の形) を画面が読むときの形。issue は path と message だけを使う */
const drTestIssueSchema = z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() });
export const drTestErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.array(drTestIssueSchema).optional() }),
});
/** 400 の本文が上の形で読めないときの文 */
export const DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE = '入力を確かめてください';

export interface DrTestFieldErrors {
  /** 項目ごとの最初の文 */
  fields: Partial<Record<DrTestField, string>>;
  /** 項目に結び付かない文 (path が空・知らない項目)。項目の文も項目に結び付かない文も無ければ error.message を 1 つ */
  form: string[];
}

/** POST の 400 の本文から、画面が項目の下と form の上に出す文を作る */
export function drTestErrorsFromResponse(json: unknown): DrTestFieldErrors {
  const parsed = drTestErrorResponseSchema.safeParse(json);
  if (!parsed.success) return { fields: {}, form: [DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE] };
  const fields: Partial<Record<DrTestField, string>> = {};
  const form: string[] = [];
  for (const issue of parsed.data.error.details ?? []) {
    const head = issue.path[0];
    const field = DR_TEST_FIELDS.find((name) => name === head);
    if (field === undefined) {
      form.push(issue.message);
    } else if (fields[field] === undefined) {
      fields[field] = issue.message;
    }
  }
  if (Object.keys(fields).length === 0 && form.length === 0) form.push(parsed.data.error.message);
  return { fields, form };
}

// ── 読み取り (admin_audit_logs の行) ───────────────────────────────────────
/** API が select する列 (この並びで select する。tests/integration/security/select-columns-exist が列の実在を見る)。
 *  target_type と actor_id は、行がどの経路で書かれたかを見るために読む (isBackupAuditRow / isDrTestAuditRow。§7.1) */
export const BACKUP_AUDIT_COLUMNS = ['id', 'created_at', 'action_type', 'target_type', 'actor_id', 'severity', 'details'] as const;
export const BACKUP_AUDIT_SELECT = BACKUP_AUDIT_COLUMNS.join(', ');

export const backupAuditRowSchema = z.object({
  id: z.uuid(),
  created_at: z.string(),
  action_type: z.string(),
  target_type: z.string().nullable(),
  actor_id: z.string().nullable(),
  severity: z.enum(['info', 'warn', 'critical']),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type BackupAuditRow = z.infer<typeof backupAuditRowSchema>;

/** 取得の行として信じてよいか: record_backup_audit が書く形 (action_type が BACKUP_AUDIT_ACTION_TYPES の 1 つ・target_type が
 *  BACKUP_AUDIT_TARGET_TYPE・actor_id が NULL)。admin_audit_logs の INSERT のポリシーは action_type を見ないので、action_type だけでは信じない。
 *  audit_logs_insert_admins で書いた行 (actor_id = 本人) はここで外れる。"Admins can create audit logs" で actor_id を NULL にした行は外れない (Issue #1736。§21) */
export function isBackupAuditRow(row: BackupAuditRow): boolean {
  return BACKUP_AUDIT_ACTION_TYPES.includes(row.action_type) && row.target_type === BACKUP_AUDIT_TARGET_TYPE && row.actor_id === null;
}

/** 訓練の行として信じてよいか: action_type が DR_TEST_AUDIT_ACTION_TYPES の 1 つ・target_type が DR_TEST_AUDIT_TARGET_TYPE・
 *  actor_id が今の super_admin (superAdminIds。route が user_profiles から読む) の 1 人 */
export function isDrTestAuditRow(row: BackupAuditRow, superAdminIds: ReadonlySet<string>): boolean {
  return (
    DR_TEST_AUDIT_ACTION_TYPES.includes(row.action_type) &&
    row.target_type === DR_TEST_AUDIT_TARGET_TYPE &&
    row.actor_id !== null &&
    superAdminIds.has(row.actor_id)
  );
}

export interface BackupStatusResponse {
  data: {
    /** 層ごとの最新の completed (無ければ null)。一覧の窓 (BACKUP_STATUS_LIST_LIMIT) によらない */
    latest: Record<BackupTier, BackupAuditRow | null>;
    /** 訓練の種類ごとの最新の記録 (無ければ null)。一覧の窓 (DR_TEST_LIST_LIMIT) によらない */
    latest_dr_tests: Record<DrTestKind, BackupAuditRow | null>;
    /** daily の最新の completed が BACKUP_STALE_AFTER_HOURS より古い (無い) */
    stale: boolean;
    stale_after_hours: number;
    /** 取得の行 (completed・failed) 新しい順・BACKUP_STATUS_LIST_LIMIT 行まで */
    backups: BackupAuditRow[];
    /** 訓練の行 新しい順・DR_TEST_LIST_LIMIT 行まで */
    dr_tests: BackupAuditRow[];
  };
}

/** route が読んだもの (§7.1 の super_admin の一覧と 8 本の読み取り)。latest* は action_type ごとに最新 1 行 (無ければ null) */
export interface BackupStatusSource {
  latestByTier: Record<BackupTier, BackupAuditRow | null>;
  latestDrTestByKind: Record<DrTestKind, BackupAuditRow | null>;
  backups: readonly BackupAuditRow[];
  drTests: readonly BackupAuditRow[];
  /** 今の super_admin の id (route が getSupabaseAdmin で user_profiles から読む。§7.1) */
  superAdminIds: readonly string[];
}

/** 読んだ行が期待の action_type の取得の行でなければ null (route の読み間違い・絞り込みの書き忘れを応答に出さない) */
function pickBackupRow(row: BackupAuditRow | null, actionType: string): BackupAuditRow | null {
  return row !== null && row.action_type === actionType && isBackupAuditRow(row) ? row : null;
}

/** 読んだ行が期待の action_type の訓練の行でなければ null */
function pickDrTestRow(row: BackupAuditRow | null, actionType: string, superAdminIds: ReadonlySet<string>): BackupAuditRow | null {
  return row !== null && row.action_type === actionType && isDrTestAuditRow(row, superAdminIds) ? row : null;
}

/** API の応答を作る (一覧の行はすでに新しい順・上限内)。行は isBackupAuditRow / isDrTestAuditRow で見直す */
export function toBackupStatusResponse(source: BackupStatusSource, now: Date): BackupStatusResponse {
  const superAdminIds: ReadonlySet<string> = new Set(source.superAdminIds);
  const latest: Record<BackupTier, BackupAuditRow | null> = {
    daily: pickBackupRow(source.latestByTier.daily, backupAuditAction('daily', 'completed')),
    weekly: pickBackupRow(source.latestByTier.weekly, backupAuditAction('weekly', 'completed')),
    annual: pickBackupRow(source.latestByTier.annual, backupAuditAction('annual', 'completed')),
  };
  const latestDrTests: Record<DrTestKind, BackupAuditRow | null> = {
    monthly_pitr: pickDrTestRow(source.latestDrTestByKind.monthly_pitr, DR_TEST_AUDIT_ACTIONS.monthly_pitr, superAdminIds),
    quarterly_restore: pickDrTestRow(source.latestDrTestByKind.quarterly_restore, DR_TEST_AUDIT_ACTIONS.quarterly_restore, superAdminIds),
    annual_drill: pickDrTestRow(source.latestDrTestByKind.annual_drill, DR_TEST_AUDIT_ACTIONS.annual_drill, superAdminIds),
  };
  return {
    data: {
      latest,
      latest_dr_tests: latestDrTests,
      stale: isBackupStale(latest.daily?.created_at ?? null, now),
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
      backups: source.backups.filter((row) => isBackupAuditRow(row)),
      dr_tests: source.drTests.filter((row) => isDrTestAuditRow(row, superAdminIds)),
    },
  };
}

export const DR_TEST_KIND_LABELS: Readonly<Record<DrTestKind, string>> = {
  monthly_pitr: '月次 PITR 復元テスト',
  quarterly_restore: '四半期 論理バックアップの復元',
  annual_drill: '年次 DR 訓練',
};
export const DR_TEST_RESULT_LABELS: Readonly<Record<DrTestResult, string>> = { success: '成功', failed: '失敗', skipped: '見送り' };
export const DR_TEST_ENVIRONMENT_LABELS: Readonly<Record<DrTestEnvironment, string>> = {
  local: 'ローカル',
  staging: 'staging',
  new_project: '新しいプロジェクト',
  production: '本番',
};
export const DR_TEST_SMOKE_LABELS: Readonly<Record<DrTestSmokeResult, string>> = { passed: '通った', failed: '落ちた', not_run: '流していない' };
export const BACKUP_TIER_LABELS: Readonly<Record<BackupTier, string>> = { daily: '日次', weekly: '週次', annual: '年次' };
