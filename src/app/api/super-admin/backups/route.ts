/**
 * GET /api/super-admin/backups — DB バックアップの取得と DR 訓練の記録の状態 (#1129 / #1191)
 * 設計: docs/design/cross/17-backup-automation.md §7.1 (正典)
 *
 * 権限は super_admin だけ。admin_audit_logs は本人のセッションの client で読む (RLS の audit_logs_select_super_admin)。
 * service_role (getSupabaseAdmin) は、requireRole の後に「今の super_admin の id」を user_profiles から読む 1 本だけに使う
 * (user_profiles の SELECT のポリシーは本人の行だけなので、本人の client ではほかの super_admin が見えない)。
 *
 * 行を信じる条件 (§7.1・§10。admin_audit_logs の INSERT のポリシーは action_type を見ない):
 *   取得の行 = target_type 'database_backup' かつ actor_id IS NULL (record_backup_audit が書く形)
 *   訓練の行 = target_type 'dr_test' かつ actor_id が今の super_admin の 1 人
 * DB 側で絞り、toBackupStatusResponse が同じ条件で見直す (絞り込みの書き忘れを応答に出さない)。
 * 閲覧は記録しない (利用者の情報を返さない)。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/helpers';
import { authFailureNested } from '@/lib/api/error-responses';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import {
  BACKUP_AUDIT_ACTION_TYPES,
  BACKUP_AUDIT_TARGET_TYPE,
  BACKUP_STATUS_LIST_LIMIT,
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_ACTION_TYPES,
  DR_TEST_AUDIT_TARGET_TYPE,
  DR_TEST_LIST_LIMIT,
  DR_TEST_RECORDER_ROLE,
  backupAuditAction,
  backupAuditRowSchema,
  toBackupStatusResponse,
  type BackupAuditRow,
  type BackupStatusResponse,
} from '@/lib/backups/core';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'GET /api/super-admin/backups';

/** 監査行の状態を返すので、ブラウザや途中の経路に保存させない */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const backupAuditRowsSchema = z.array(backupAuditRowSchema);
const superAdminIdRowsSchema = z.array(z.object({ id: z.string() }));

/** 行の検証に落ちたとき (internalError に渡す。本文には出ない) */
class BackupAuditRowShapeError extends Error {
  constructor(label: string) {
    super(`admin_audit_logs の行の形が想定と違います: ${label}`);
    this.name = 'BackupAuditRowShapeError';
  }
}

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/** 最新 1 行 (maybeSingle) を検証する。無ければ null。形が違えば例外 (500) */
function parseLatestRow(result: QueryResult, label: string): BackupAuditRow | null {
  if (result.data === null) return null;
  const parsed = backupAuditRowSchema.safeParse(result.data);
  if (!parsed.success) throw new BackupAuditRowShapeError(label);
  return parsed.data;
}

/** 一覧を検証する。1 行でも形が違えば例外 (500) */
function parseRows(result: QueryResult, label: string): BackupAuditRow[] {
  const parsed = backupAuditRowsSchema.safeParse(result.data ?? []);
  if (!parsed.success) throw new BackupAuditRowShapeError(label);
  return parsed.data;
}

const EMPTY_RESULT: QueryResult = { data: null, error: null };
const EMPTY_LIST_RESULT: QueryResult = { data: [], error: null };

export async function GET() {
  try {
    const actor = await requireRole(['super_admin']);

    // 今の super_admin の id (訓練の行の印)。requireRole の後にだけ service_role を使う。読む列は id だけ
    const superAdmins = await getSupabaseAdmin()
      .from('user_profiles')
      .select('id')
      .contains('roles', [DR_TEST_RECORDER_ROLE]);
    if (superAdmins.error) {
      return internalError(ROUTE_NAME, superAdmins.error, { userId: actor.id }, { shape: 'nested' });
    }
    const superAdminRows = superAdminIdRowsSchema.safeParse(superAdmins.data ?? []);
    if (!superAdminRows.success) {
      return internalError(ROUTE_NAME, new BackupAuditRowShapeError('user_profiles'), { userId: actor.id }, { shape: 'nested' });
    }
    const superAdminIds = superAdminRows.data.map((row) => row.id);
    const hasSuperAdmins = superAdminIds.length > 0;

    const supabase = await createClient();

    const latestBackup = (action: string) =>
      supabase
        .from('admin_audit_logs')
        .select('id, created_at, action_type, target_type, actor_id, severity, details')
        .eq('action_type', action)
        .eq('target_type', BACKUP_AUDIT_TARGET_TYPE)
        .is('actor_id', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

    const latestDrTest = async (action: string): Promise<QueryResult> => {
      // super_admin が居なければ訓練の行は読まない (§7.1。本人が super_admin なので普通は起きない)
      if (!hasSuperAdmins) return EMPTY_RESULT;
      return await supabase
        .from('admin_audit_logs')
        .select('id, created_at, action_type, target_type, actor_id, severity, details')
        .eq('action_type', action)
        .eq('target_type', DR_TEST_AUDIT_TARGET_TYPE)
        .in('actor_id', superAdminIds)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
    };

    const backupList = () =>
      supabase
        .from('admin_audit_logs')
        .select('id, created_at, action_type, target_type, actor_id, severity, details')
        .in('action_type', [...BACKUP_AUDIT_ACTION_TYPES])
        .eq('target_type', BACKUP_AUDIT_TARGET_TYPE)
        .is('actor_id', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(BACKUP_STATUS_LIST_LIMIT);

    const drTestList = async (): Promise<QueryResult> => {
      if (!hasSuperAdmins) return EMPTY_LIST_RESULT;
      return await supabase
        .from('admin_audit_logs')
        .select('id, created_at, action_type, target_type, actor_id, severity, details')
        .in('action_type', [...DR_TEST_AUDIT_ACTION_TYPES])
        .eq('target_type', DR_TEST_AUDIT_TARGET_TYPE)
        .in('actor_id', superAdminIds)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(DR_TEST_LIST_LIMIT);
    };

    const [
      latestDaily,
      latestWeekly,
      latestAnnual,
      latestMonthlyPitr,
      latestQuarterlyRestore,
      latestAnnualDrill,
      backups,
      drTests,
    ] = await Promise.all([
      latestBackup(backupAuditAction('daily', 'completed')),
      latestBackup(backupAuditAction('weekly', 'completed')),
      latestBackup(backupAuditAction('annual', 'completed')),
      latestDrTest(DR_TEST_AUDIT_ACTIONS.monthly_pitr),
      latestDrTest(DR_TEST_AUDIT_ACTIONS.quarterly_restore),
      latestDrTest(DR_TEST_AUDIT_ACTIONS.annual_drill),
      backupList(),
      drTestList(),
    ]);

    const results: readonly QueryResult[] = [
      latestDaily,
      latestWeekly,
      latestAnnual,
      latestMonthlyPitr,
      latestQuarterlyRestore,
      latestAnnualDrill,
      backups,
      drTests,
    ];
    const failed = results.find((result) => result.error !== null);
    if (failed?.error) {
      return internalError(ROUTE_NAME, failed.error, { userId: actor.id }, { shape: 'nested' });
    }

    let body: BackupStatusResponse;
    try {
      body = toBackupStatusResponse(
        {
          latestByTier: {
            daily: parseLatestRow(latestDaily, 'latest daily'),
            weekly: parseLatestRow(latestWeekly, 'latest weekly'),
            annual: parseLatestRow(latestAnnual, 'latest annual'),
          },
          latestDrTestByKind: {
            monthly_pitr: parseLatestRow(latestMonthlyPitr, 'latest monthly_pitr'),
            quarterly_restore: parseLatestRow(latestQuarterlyRestore, 'latest quarterly_restore'),
            annual_drill: parseLatestRow(latestAnnualDrill, 'latest annual_drill'),
          },
          backups: parseRows(backups, 'backups'),
          drTests: parseRows(drTests, 'dr_tests'),
          superAdminIds,
        },
        new Date(),
      );
    } catch (shapeError) {
      return internalError(ROUTE_NAME, shapeError, { userId: actor.id }, { shape: 'nested' });
    }

    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    const authFailure = authFailureNested(err, { headers: NO_STORE });
    if (authFailure) return authFailure;
    return internalError(ROUTE_NAME, err, {}, { shape: 'nested' });
  }
}
