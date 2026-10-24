/**
 * #1129 / #1191 src/lib/backups/core.ts (バックアップの状態と DR 訓練の記録の正典) の単体テスト
 * 設計: docs/design/cross/17-backup-automation.md §5.3・§15 の core.test.ts の行 (段 B)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_AUDIT_ACTION_TYPES as SCRIPT_BACKUP_AUDIT_ACTION_TYPES,
  BACKUP_TIERS as SCRIPT_BACKUP_TIERS,
} from '../../../../scripts/lib/backup-db.mjs';
import {
  BACKUP_AUDIT_ACTION_TYPES,
  BACKUP_AUDIT_SELECT,
  BACKUP_AUDIT_TARGET_TYPE,
  BACKUP_FRESHNESS_CRON_INTERVAL_HOURS,
  BACKUP_FRESHNESS_SCHEDULE_UTC,
  BACKUP_SCHEDULE_HOURS,
  BACKUP_STALE_AFTER_HOURS,
  BACKUP_STALE_ALERT_COOLDOWN_MINUTES,
  BACKUP_STALE_SLACK_HOURS,
  BACKUP_TIERS,
  BACKUP_TIER_LABELS,
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_ACTION_TYPES,
  DR_TEST_AUDIT_TARGET_TYPE,
  DR_TEST_ENVIRONMENTS,
  DR_TEST_ENVIRONMENT_LABELS,
  DR_TEST_FIELDS,
  DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE,
  DR_TEST_KINDS,
  DR_TEST_KIND_LABELS,
  DR_TEST_NOTES_MAX_LENGTH,
  DR_TEST_RECORDER_ROLE,
  DR_TEST_RESULTS,
  DR_TEST_RESULT_LABELS,
  DR_TEST_RTO_MINUTES_MAX,
  DR_TEST_SMOKE_LABELS,
  DR_TEST_SMOKE_RESULTS,
  backupAuditAction,
  drTestErrorsFromResponse,
  drTestRecordBodySchema,
  drTestSeverity,
  isBackupAuditRow,
  isBackupStale,
  isDrTestAuditRow,
  toBackupStatusResponse,
  type BackupAuditRow,
  type BackupStatusSource,
  type DrTestRecordBody,
} from '@/lib/backups/core';
import { SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE, invalidInputBody, invalidJsonBodyBody } from '@/lib/super-admin/validation-errors';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');
const BACKUP_AUDIT_MIGRATION_SUFFIX = '_backup_audit_record.sql';

const MS_PER_HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-20T06:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * MS_PER_HOUR).toISOString();

const SUPER_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN_ID = '22222222-2222-4222-8222-222222222222';

let rowSeq = 0;
function row(overrides: Partial<BackupAuditRow>): BackupAuditRow {
  rowSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(rowSeq).padStart(12, '0')}`,
    created_at: hoursAgo(1),
    action_type: backupAuditAction('daily', 'completed'),
    target_type: BACKUP_AUDIT_TARGET_TYPE,
    actor_id: null,
    severity: 'info',
    details: {},
    ...overrides,
  };
}

const backupRow = (tier: 'daily' | 'weekly' | 'annual', overrides: Partial<BackupAuditRow> = {}) =>
  row({ action_type: backupAuditAction(tier, 'completed'), ...overrides });

const drRow = (kind: keyof typeof DR_TEST_AUDIT_ACTIONS, overrides: Partial<BackupAuditRow> = {}) =>
  row({
    action_type: DR_TEST_AUDIT_ACTIONS[kind],
    target_type: DR_TEST_AUDIT_TARGET_TYPE,
    actor_id: SUPER_ADMIN_ID,
    ...overrides,
  });

function source(overrides: Partial<BackupStatusSource> = {}): BackupStatusSource {
  return {
    latestByTier: { daily: null, weekly: null, annual: null },
    latestDrTestByKind: { monthly_pitr: null, quarterly_restore: null, annual_drill: null },
    backups: [],
    drTests: [],
    superAdminIds: [SUPER_ADMIN_ID],
    ...overrides,
  };
}

/** 通る本文 (DrTestRecordBody の形) に、上書き (未知の key を含む) を重ねる */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: DrTestRecordBody = {
    kind: 'quarterly_restore',
    result: 'success',
    performed_on: '2026-10-13',
    environment: 'local',
    restored_to: null,
    backup_key: 'daily/2026-10-13/homegohan-db-20261012T172300Z.tar.zst.age',
    rto_minutes: 45,
    smoke: 'passed',
    notes: '',
  };
  return { ...base, ...overrides };
}

/** safeParse が落ちたときの issue の message の一覧 */
function issueMessages(input: unknown): string[] {
  const parsed = drTestRecordBodySchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => issue.message);
}

function issuesOf(input: unknown) {
  const parsed = drTestRecordBodySchema.safeParse(input);
  if (parsed.success) throw new Error('検証が通ってしまった');
  return parsed.error.issues;
}

describe('isBackupStale', () => {
  it('最新の completed が無い (null) なら古い', () => {
    expect(isBackupStale(null, NOW)).toBe(true);
  });
  it('29 時間前なら新しい・31 時間前なら古い (しきい値 30 時間)', () => {
    expect(isBackupStale(hoursAgo(29), NOW)).toBe(false);
    expect(isBackupStale(hoursAgo(31), NOW)).toBe(true);
  });
  it('日時として読めない文字列は古いとみなす', () => {
    expect(isBackupStale('not-a-date', NOW)).toBe(true);
  });
  it('BACKUP_STALE_AFTER_HOURS は BACKUP_SCHEDULE_HOURS + BACKUP_STALE_SLACK_HOURS', () => {
    expect(BACKUP_STALE_AFTER_HOURS).toBe(BACKUP_SCHEDULE_HOURS + BACKUP_STALE_SLACK_HOURS);
    expect(BACKUP_STALE_AFTER_HOURS).toBe(30);
  });
});

describe('drTestRecordBodySchema', () => {
  it('success は notes が空でよい', () => {
    expect(drTestRecordBodySchema.safeParse(validBody()).success).toBe(true);
  });
  it.each(['failed', 'skipped'])('%s は notes が必須 (空・空白だけは落ちる)', (result) => {
    expect(issueMessages(validBody({ result, notes: '' }))).toEqual(['失敗・見送りのときは理由を書いてください']);
    expect(issueMessages(validBody({ result, notes: '   ' }))).toEqual(['失敗・見送りのときは理由を書いてください']);
    expect(drTestRecordBodySchema.safeParse(validBody({ result, notes: 'plan_not_pro' })).success).toBe(true);
  });
  it('quarterly_restore の success は backup_key が必須', () => {
    const issues = issuesOf(validBody({ backup_key: null }));
    expect(issues.map((i) => [i.path, i.message])).toEqual([[['backup_key'], '復元に使った R2 のキーを書いてください']]);
    // ほかの種類・結果なら backup_key は null でよい
    expect(drTestRecordBodySchema.safeParse(validBody({ kind: 'monthly_pitr', backup_key: null })).success).toBe(true);
    expect(drTestRecordBodySchema.safeParse(validBody({ result: 'failed', notes: '復号できず', backup_key: null })).success).toBe(true);
  });
  it('backup_key は daily/・weekly/・annual/ で始まる形だけ', () => {
    for (const key of ['daily/2026-10-13/x.age', 'weekly/2026-10-13/x.age', 'annual/2026/x.age']) {
      expect(drTestRecordBodySchema.safeParse(validBody({ backup_key: key })).success).toBe(true);
    }
    for (const key of ['x/1', 'monthly/2026/x', 'daily/', 'daily/a b', '../daily/x']) {
      expect(drTestRecordBodySchema.safeParse(validBody({ backup_key: key })).success).toBe(false);
    }
  });
  it('rto_minutes は 0〜DR_TEST_RTO_MINUTES_MAX の整数 (100001 は落ちる)', () => {
    expect(drTestRecordBodySchema.safeParse(validBody({ rto_minutes: 0 })).success).toBe(true);
    expect(drTestRecordBodySchema.safeParse(validBody({ rto_minutes: DR_TEST_RTO_MINUTES_MAX })).success).toBe(true);
    expect(DR_TEST_RTO_MINUTES_MAX).toBe(100_000);
    expect(drTestRecordBodySchema.safeParse(validBody({ rto_minutes: 100_001 })).success).toBe(false);
    expect(drTestRecordBodySchema.safeParse(validBody({ rto_minutes: -1 })).success).toBe(false);
  });
  it('performed_on の 2026-02-30 (実在しない日) は落ちる', () => {
    expect(issueMessages(validBody({ performed_on: '2026-02-30' }))).toEqual(['実施日を YYYY-MM-DD の形で書いてください']);
  });
  it('restored_to はオフセットつきの日時か null', () => {
    expect(drTestRecordBodySchema.safeParse(validBody({ restored_to: '2026-10-13T02:23:00+09:00' })).success).toBe(true);
    expect(drTestRecordBodySchema.safeParse(validBody({ restored_to: '2026-10-12T17:23:00Z' })).success).toBe(true);
    expect(issueMessages(validBody({ restored_to: '2026-10-13T02:23' }))).toEqual(['復元した時点を日時で書いてください']);
  });
  it('未知の key は落ちる (strict)', () => {
    const issues = issuesOf(validBody({ extra: 1 }));
    expect(issues.map((i) => i.code)).toEqual(['unrecognized_keys']);
    expect(issues[0].path).toEqual([]);
  });
  it('issue の文は schema に書いた日本語 (kind 未知・2026-02-30・x/1・1.5・100001・2001 字・failed で notes 空)', () => {
    expect(issueMessages(validBody({ kind: 'weekly_pitr' }))).toEqual(['訓練の種類を選んでください']);
    expect(issueMessages(validBody({ performed_on: '2026-02-30' }))).toEqual(['実施日を YYYY-MM-DD の形で書いてください']);
    expect(issueMessages(validBody({ backup_key: 'x/1' }))).toEqual(['R2 のキーは daily/・weekly/・annual/ で始まる形で書いてください']);
    expect(issueMessages(validBody({ rto_minutes: 1.5 }))).toEqual(['復旧にかかった分は整数で書いてください']);
    expect(issueMessages(validBody({ rto_minutes: 100_001 }))).toEqual([`復旧にかかった分は ${DR_TEST_RTO_MINUTES_MAX} 以下で書いてください`]);
    expect(issueMessages(validBody({ notes: 'あ'.repeat(DR_TEST_NOTES_MAX_LENGTH + 1) }))).toEqual([
      `メモは ${DR_TEST_NOTES_MAX_LENGTH} 文字以内で書いてください`,
    ]);
    expect(issueMessages(validBody({ result: 'failed', notes: '' }))).toEqual(['失敗・見送りのときは理由を書いてください']);
    expect(issueMessages(validBody({ result: 'ok' }))).toEqual(['結果を選んでください']);
    expect(issueMessages(validBody({ environment: 'mars' }))).toEqual(['復元した先を選んでください']);
    expect(issueMessages(validBody({ smoke: 'maybe' }))).toEqual(['動作確認 (smoke) の結果を選んでください']);
    expect(issueMessages(validBody({ rto_minutes: '45' }))).toEqual(['復旧にかかった分を数で書いてください']);
    expect(issueMessages(validBody({ notes: 3 }))).toEqual(['メモを文字で書いてください']);
    expect(issueMessages(validBody({ backup_key: 3 }))).toEqual(['R2 のキーを文字で書いてください']);
    expect(DR_TEST_NOTES_MAX_LENGTH).toBe(2000);
  });
});

describe('DR_TEST_FIELDS', () => {
  it('drTestRecordBodySchema の shape のキーと同じ並び', () => {
    expect([...DR_TEST_FIELDS]).toEqual(Object.keys(drTestRecordBodySchema.shape));
  });
});

describe('drTestSeverity', () => {
  it('success は info・failed / skipped は warn', () => {
    expect(drTestSeverity('success')).toBe('info');
    expect(drTestSeverity('failed')).toBe('warn');
    expect(drTestSeverity('skipped')).toBe('warn');
  });
});

describe('isBackupAuditRow', () => {
  it('族の action_type・database_backup・actor_id null なら true', () => {
    for (const actionType of BACKUP_AUDIT_ACTION_TYPES) {
      expect(isBackupAuditRow(row({ action_type: actionType }))).toBe(true);
    }
  });
  it('actor_id がある・target_type が null か別の値・action_type が dr.test.… なら false', () => {
    expect(isBackupAuditRow(row({ actor_id: OTHER_ADMIN_ID }))).toBe(false);
    expect(isBackupAuditRow(row({ target_type: null }))).toBe(false);
    expect(isBackupAuditRow(row({ target_type: DR_TEST_AUDIT_TARGET_TYPE }))).toBe(false);
    expect(isBackupAuditRow(row({ action_type: DR_TEST_AUDIT_ACTIONS.annual_drill }))).toBe(false);
    expect(isBackupAuditRow(row({ action_type: 'backup.monthly.completed' }))).toBe(false);
  });
});

describe('isDrTestAuditRow', () => {
  const ids: ReadonlySet<string> = new Set([SUPER_ADMIN_ID]);
  it('族の action_type・dr_test・actor_id が集合の中なら true', () => {
    for (const actionType of DR_TEST_AUDIT_ACTION_TYPES) {
      expect(isDrTestAuditRow(drRow('monthly_pitr', { action_type: actionType }), ids)).toBe(true);
    }
  });
  it('actor_id が集合の外・null・target_type が別・action_type が backup.… なら false', () => {
    expect(isDrTestAuditRow(drRow('monthly_pitr', { actor_id: OTHER_ADMIN_ID }), ids)).toBe(false);
    expect(isDrTestAuditRow(drRow('monthly_pitr', { actor_id: null }), ids)).toBe(false);
    expect(isDrTestAuditRow(drRow('monthly_pitr', { target_type: BACKUP_AUDIT_TARGET_TYPE }), ids)).toBe(false);
    expect(isDrTestAuditRow(drRow('monthly_pitr', { target_type: null }), ids)).toBe(false);
    expect(isDrTestAuditRow(drRow('monthly_pitr', { action_type: backupAuditAction('daily', 'completed') }), ids)).toBe(false);
  });
});

describe('toBackupStatusResponse', () => {
  it('latest は latestByTier の取得の行をそのまま写す (一覧 backups が空でも annual の最新が出る = 窓によらない)', () => {
    const daily = backupRow('daily');
    const weekly = backupRow('weekly', { created_at: hoursAgo(50) });
    const annual = backupRow('annual', { created_at: hoursAgo(24 * 200) });
    const res = toBackupStatusResponse(source({ latestByTier: { daily, weekly, annual }, backups: [] }), NOW);
    expect(res.data.latest).toEqual({ daily, weekly, annual });
    expect(res.data.backups).toEqual([]);
    expect(res.data.stale).toBe(false);
    expect(res.data.stale_after_hours).toBe(BACKUP_STALE_AFTER_HOURS);
  });

  it('latest_dr_tests も同じ (actor_id が superAdminIds にあり target_type dr_test)・一覧が空でも出る', () => {
    const monthly = drRow('monthly_pitr');
    const quarterly = drRow('quarterly_restore');
    const annual = drRow('annual_drill');
    const res = toBackupStatusResponse(
      source({ latestDrTestByKind: { monthly_pitr: monthly, quarterly_restore: quarterly, annual_drill: annual }, drTests: [] }),
      NOW,
    );
    expect(res.data.latest_dr_tests).toEqual({ monthly_pitr: monthly, quarterly_restore: quarterly, annual_drill: annual });
    expect(res.data.dr_tests).toEqual([]);
  });

  it('latest に action_type の違う行 (failed など) が渡されたら null', () => {
    const res = toBackupStatusResponse(
      source({
        latestByTier: {
          daily: row({ action_type: backupAuditAction('daily', 'failed') }),
          weekly: backupRow('daily'),
          annual: backupRow('weekly'),
        },
        latestDrTestByKind: {
          monthly_pitr: drRow('quarterly_restore'),
          quarterly_restore: drRow('annual_drill'),
          annual_drill: drRow('monthly_pitr'),
        },
      }),
      NOW,
    );
    expect(res.data.latest).toEqual({ daily: null, weekly: null, annual: null });
    expect(res.data.latest_dr_tests).toEqual({ monthly_pitr: null, quarterly_restore: null, annual_drill: null });
    expect(res.data.stale).toBe(true);
  });

  it.each([
    ['actor_id のある行', { actor_id: OTHER_ADMIN_ID }],
    ['target_type が database_backup でない行', { target_type: 'user' }],
    ['target_type が null の行', { target_type: null }],
  ])('latestByTier.daily が %s なら latest.daily が null で stale が true', (_label, overrides) => {
    const res = toBackupStatusResponse(source({ latestByTier: { daily: backupRow('daily', overrides), weekly: null, annual: null } }), NOW);
    expect(res.data.latest.daily).toBeNull();
    expect(res.data.stale).toBe(true);
  });

  it.each([
    ['actor_id が superAdminIds に無い行', { actor_id: OTHER_ADMIN_ID }],
    ['actor_id が null の行', { actor_id: null }],
    ['target_type が dr_test でない行', { target_type: BACKUP_AUDIT_TARGET_TYPE }],
  ])('latestDrTestByKind に %s が渡されたら null', (_label, overrides) => {
    const res = toBackupStatusResponse(
      source({ latestDrTestByKind: { monthly_pitr: drRow('monthly_pitr', overrides), quarterly_restore: null, annual_drill: null } }),
      NOW,
    );
    expect(res.data.latest_dr_tests.monthly_pitr).toBeNull();
  });

  it('backups / dr_tests は action_type の族の外の行と、印の合わない行を落とす (並びは保つ)', () => {
    const goodBackup1 = backupRow('daily');
    const goodBackup2 = row({ action_type: backupAuditAction('weekly', 'failed'), severity: 'warn' });
    const goodDr1 = drRow('annual_drill');
    const goodDr2 = drRow('monthly_pitr', { severity: 'warn' });
    const res = toBackupStatusResponse(
      source({
        backups: [
          goodBackup1,
          row({ action_type: 'admin.user.view' }),
          backupRow('daily', { actor_id: OTHER_ADMIN_ID }),
          backupRow('daily', { target_type: DR_TEST_AUDIT_TARGET_TYPE }),
          goodBackup2,
        ],
        drTests: [
          goodDr1,
          drRow('monthly_pitr', { action_type: 'dr.test.weekly.pitr' }),
          drRow('monthly_pitr', { actor_id: OTHER_ADMIN_ID }),
          drRow('monthly_pitr', { actor_id: null }),
          drRow('monthly_pitr', { target_type: BACKUP_AUDIT_TARGET_TYPE }),
          goodDr2,
        ],
      }),
      NOW,
    );
    expect(res.data.backups).toEqual([goodBackup1, goodBackup2]);
    expect(res.data.dr_tests).toEqual([goodDr1, goodDr2]);
  });

  it('superAdminIds が [] なら dr_tests が [] で latest_dr_tests がすべて null', () => {
    const res = toBackupStatusResponse(
      source({
        superAdminIds: [],
        latestDrTestByKind: { monthly_pitr: drRow('monthly_pitr'), quarterly_restore: drRow('quarterly_restore'), annual_drill: drRow('annual_drill') },
        drTests: [drRow('monthly_pitr')],
      }),
      NOW,
    );
    expect(res.data.dr_tests).toEqual([]);
    expect(res.data.latest_dr_tests).toEqual({ monthly_pitr: null, quarterly_restore: null, annual_drill: null });
  });

  it('stale は latest.daily から決まる (weekly / annual が新しくても daily が古ければ true)', () => {
    const fresh = toBackupStatusResponse(source({ latestByTier: { daily: backupRow('daily', { created_at: hoursAgo(29) }), weekly: null, annual: null } }), NOW);
    expect(fresh.data.stale).toBe(false);
    const stale = toBackupStatusResponse(
      source({
        latestByTier: {
          daily: backupRow('daily', { created_at: hoursAgo(31) }),
          weekly: backupRow('weekly', { created_at: hoursAgo(1) }),
          annual: backupRow('annual', { created_at: hoursAgo(1) }),
        },
      }),
      NOW,
    );
    expect(stale.data.stale).toBe(true);
    const none = toBackupStatusResponse(source({ latestByTier: { daily: null, weekly: backupRow('weekly'), annual: null } }), NOW);
    expect(none.data.stale).toBe(true);
  });
});

describe('定数', () => {
  it('DR_TEST_RECORDER_ROLE は super_admin', () => {
    expect(DR_TEST_RECORDER_ROLE).toBe('super_admin');
  });

  it('BACKUP_AUDIT_TARGET_TYPE は migration の record_backup_audit が INSERT する target_type と同じ (読む側の印と書く側がずれない)', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(BACKUP_AUDIT_MIGRATION_SUFFIX));
    expect(files).toHaveLength(1);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8');
    const insert = /INSERT INTO public\.admin_audit_logs\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
    expect(insert).not.toBeNull();
    const columns = (insert?.[1] ?? '').split(',').map((c) => c.trim());
    const values = (insert?.[2] ?? '').split(',').map((v) => v.trim());
    const targetTypeValue = values[columns.indexOf('target_type')];
    expect(targetTypeValue).toBe(`'${BACKUP_AUDIT_TARGET_TYPE}'`);
    expect(BACKUP_AUDIT_TARGET_TYPE).toBe('database_backup');
  });

  it('backupAuditAction と BACKUP_AUDIT_ACTION_TYPES が 6 値', () => {
    expect(backupAuditAction('weekly', 'failed')).toBe('backup.weekly.failed');
    expect([...BACKUP_AUDIT_ACTION_TYPES]).toEqual([
      'backup.daily.completed',
      'backup.daily.failed',
      'backup.weekly.completed',
      'backup.weekly.failed',
      'backup.annual.completed',
      'backup.annual.failed',
    ]);
  });

  it('DR_TEST_AUDIT_ACTIONS は dr.test. で始まる 3 値', () => {
    expect(DR_TEST_AUDIT_ACTION_TYPES).toHaveLength(3);
    expect(new Set(DR_TEST_AUDIT_ACTION_TYPES).size).toBe(3);
    for (const actionType of DR_TEST_AUDIT_ACTION_TYPES) expect(actionType.startsWith('dr.test.')).toBe(true);
    expect(DR_TEST_AUDIT_ACTIONS).toEqual({
      monthly_pitr: 'dr.test.monthly.pitr',
      quarterly_restore: 'dr.test.quarterly.restore',
      annual_drill: 'dr.test.annual.drill',
    });
  });

  it('BACKUP_AUDIT_SELECT は 7 列', () => {
    expect(BACKUP_AUDIT_SELECT).toBe('id, created_at, action_type, target_type, actor_id, severity, details');
  });

  it.each([
    ['BACKUP_TIER_LABELS', BACKUP_TIER_LABELS, BACKUP_TIERS],
    ['DR_TEST_KIND_LABELS', DR_TEST_KIND_LABELS, DR_TEST_KINDS],
    ['DR_TEST_RESULT_LABELS', DR_TEST_RESULT_LABELS, DR_TEST_RESULTS],
    ['DR_TEST_ENVIRONMENT_LABELS', DR_TEST_ENVIRONMENT_LABELS, DR_TEST_ENVIRONMENTS],
    ['DR_TEST_SMOKE_LABELS', DR_TEST_SMOKE_LABELS, DR_TEST_SMOKE_RESULTS],
  ] as const)('%s のキーの集合が配列と同じで、値は空でない一意の文字列', (_name, labels, values) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
    const texts: string[] = Object.values(labels);
    for (const text of texts) expect(text.trim()).not.toBe('');
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('BACKUP_STALE_ALERT_COOLDOWN_MINUTES は cron の間隔より短い 1380 (= (24 − 1) × 60)', () => {
    expect(BACKUP_STALE_ALERT_COOLDOWN_MINUTES).toBeLessThan(BACKUP_FRESHNESS_CRON_INTERVAL_HOURS * 60);
    expect(BACKUP_STALE_ALERT_COOLDOWN_MINUTES).toBe(1380);
  });

  it('BACKUP_FRESHNESS_SCHEDULE_UTC は日 1 回の式 (分・時が数字で、日・月・曜日が *) で、間隔は 24 時間', () => {
    const fields = BACKUP_FRESHNESS_SCHEDULE_UTC.split(' ');
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatch(/^\d+$/);
    expect(fields[1]).toMatch(/^\d+$/);
    expect(fields.slice(2)).toEqual(['*', '*', '*']);
    expect(BACKUP_FRESHNESS_CRON_INTERVAL_HOURS).toBe(24);
  });

  it('BACKUP_TIERS と BACKUP_AUDIT_ACTION_TYPES が scripts/lib/backup-db.mjs と同じ並び (2 か所の正典のずれを見る)', () => {
    expect([...BACKUP_TIERS]).toEqual([...SCRIPT_BACKUP_TIERS]);
    expect([...BACKUP_AUDIT_ACTION_TYPES]).toEqual([...SCRIPT_BACKUP_AUDIT_ACTION_TYPES]);
  });
});

describe('drTestErrorsFromResponse', () => {
  it('invalidInputBody(issues) の形 → fields に項目ごとの最初の文', () => {
    const issues = issuesOf(validBody({ kind: 'nope', result: 'failed', notes: '', rto_minutes: 1.5 }));
    const errors = drTestErrorsFromResponse(JSON.parse(JSON.stringify(invalidInputBody(issues))));
    expect(errors.fields).toEqual({
      kind: '訓練の種類を選んでください',
      rto_minutes: '復旧にかかった分は整数で書いてください',
    });
    expect(errors.form).toEqual([]);
  });

  it('同じ項目に 2 つの文があれば最初の文だけ', () => {
    const body = {
      error: {
        code: 'OP_INVALID_INPUT',
        message: '一つ目',
        details: [
          { path: ['notes'], message: '一つ目' },
          { path: ['notes'], message: '二つ目' },
        ],
      },
    };
    expect(drTestErrorsFromResponse(body)).toEqual({ fields: { notes: '一つ目' }, form: [] });
  });

  it('path が [] の issue (strict の unrecognized_keys) と知らない項目は form に', () => {
    const issues = issuesOf(validBody({ extra: 1 }));
    const errors = drTestErrorsFromResponse(JSON.parse(JSON.stringify(invalidInputBody(issues))));
    expect(errors.fields).toEqual({});
    // #1917: Zod の既定の英語の文 ('Unrecognized key: "extra"') は本文に入れず、日本語の固定の文にする (path が空なので項目の名前は添えない)
    expect(issues[0].message).toBe('Unrecognized key: "extra"');
    expect(errors.form).toEqual([SUPER_ADMIN_INVALID_INPUT_FALLBACK_MESSAGE]);
    const unknownField = drTestErrorsFromResponse({
      error: { code: 'OP_INVALID_INPUT', message: 'x', details: [{ path: ['other'], message: '知らない項目' }] },
    });
    expect(unknownField).toEqual({ fields: {}, form: ['知らない項目'] });
  });

  it('superRefine の notes の文は notes の下に出る', () => {
    const issues = issuesOf(validBody({ result: 'failed', notes: '' }));
    expect(drTestErrorsFromResponse(JSON.parse(JSON.stringify(invalidInputBody(issues))))).toEqual({
      fields: { notes: '失敗・見送りのときは理由を書いてください' },
      form: [],
    });
  });

  it('details が空なら form に error.message (invalidJsonBodyBody → 「リクエストボディが不正です」)', () => {
    expect(drTestErrorsFromResponse(JSON.parse(JSON.stringify(invalidJsonBodyBody())))).toEqual({
      fields: {},
      form: ['リクエストボディが不正です'],
    });
    expect(drTestErrorsFromResponse({ error: { code: 'X', message: '固定の文' } })).toEqual({ fields: {}, form: ['固定の文'] });
  });

  it.each([null, 'text', 42, {}, { error: 'flat' }])('形の違う JSON (%j) → form に DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE', (json) => {
    expect(drTestErrorsFromResponse(json)).toEqual({ fields: {}, form: [DR_TEST_INVALID_INPUT_FALLBACK_MESSAGE] });
  });
});
