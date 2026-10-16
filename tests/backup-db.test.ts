// @vitest-environment node
/**
 * tests/backup-db.test.ts
 *
 * #1129 / #1191 DB バックアップ (scripts/lib/backup-db.mjs) の単体テスト。設計 docs/design/cross/17-backup-automation.md §15 の段 A の行。
 *
 * 外部コマンド (supabase / docker / psql / aws / age / zstd / tar / python3) は偽の CommandRunner に差し替え、本物を呼ばない。
 * 例外は子プロセスを起こす it だけ (bash でライブラリの終了コードを読む・python3 で補いの SQL の golden を作る・
 * 同じ python3 の引数の誤り・python3 で auth の表のアプリのトリガーの補いを作る・その定義の形の誤り)。R2・age・本番の DB には触れない。
 *
 * 偽の data.sql / schema.sql は §4.3 の「ダンプの出力の形」の表と骨組みのとおりに書く (CLI 2.62.10 の実物の形。引用符つきの名前)。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_ENTRIES,
  ARCHIVE_SCRIPT,
  AUDIT_DETAILS_MAX_BYTES,
  AUTH_STORAGE_TRIGGERS_CSV,
  AWS_CHECKSUM_ENV,
  BACKUP_AUDIT_ACTION_TYPES,
  BACKUP_AUDIT_RESULTS,
  BACKUP_ISSUE_MARKER,
  BACKUP_ISSUE_TITLE,
  BACKUP_TIERS,
  CATALOG_CSV_FILES,
  CATALOG_SNAPSHOT_SQL,
  CATALOG_VERIFY_SCRIPT,
  COMMAND_NOT_FOUND_EXIT_CODE,
  CRON_CHECK_LINE_PREFIX,
  CRON_JOBS_SQL,
  CommandFailedError,
  CommandTimeoutError,
  DATA_DUMP_SCHEMAS,
  DEFAULT_IMAGE_REGISTRY,
  DUMP_EXCLUDED_TABLES,
  FAILURE_REASONS,
  IMAGE_PULL_FALLBACK_SCRIPT,
  IMAGE_PULL_UNAVAILABLE_EXIT_CODE,
  INFREQUENT_ACCESS_AFTER_DAYS,
  INTERNAL_TRIGGER_FUNCTION_SCHEMAS,
  JOB_TIMEOUT_MINUTES,
  LEDGER_VERSIONS_SQL,
  LOCAL_SLOT_DEFAULT,
  LOCAL_SLOT_ENV,
  LOCAL_SLOT_MAX,
  LOCK_MAX_AGE_SECONDS,
  MANIFEST_SCHEMA_VERSION,
  MS_PER_MINUTE,
  PG_IMAGE_REPOSITORY,
  PSQL_SCRIPTS,
  R2_ABORT_MULTIPART_AFTER_DAYS,
  REMOTE_PG_SSLMODE_QUERY,
  REPORT_STEP_RESERVE_MINUTES,
  RESET_STORAGE_POLICIES_SQL,
  RESTORE_COUNT_SQL,
  RESTORE_FIXUPS_BUILDER_SCRIPT,
  RESTORE_REQUIRED_ENV_NAMES,
  RESTORE_STAGES,
  RESTORE_STAGE_TIMEOUT_MINUTES,
  RETENTION_DAYS,
  RUN_STEP_TIMEOUT_MINUTES,
  SECONDS_PER_DAY,
  STAGES,
  STAGE_DEFAULT_REASON,
  STAGE_TIMEOUT_MINUTES,
  SUPABASE_CLI_VERSION,
  SUPABASE_TEMP_POOLER_URL_FILE,
  TRIGGER_CSV_COLUMNS,
  TRIGGER_DEFINITION_PATTERN,
  UsageError,
  ZSTD_LEVEL,
  appTriggerChecks,
  awsCommandEnv,
  backupAuditActionType,
  buildAuditSql,
  buildCompletedDetails,
  buildFailedDetails,
  buildManifest,
  buildR2LifecycleConfig,
  buildR2LockCommands,
  buildResetSql,
  checkCatalogCapture,
  checkConfig,
  checkRestoreConfig,
  classifyFailure,
  countRoleRestoreErrors,
  cronJobsChecks,
  isAppTrigger,
  ledgerChecks,
  managedTablesInDump,
  objectKey,
  parseArgs,
  parseCatalogVerifySummary,
  parseCopyLine,
  parseCronJobsSql,
  parseCsv,
  parseLedgerVersions,
  parseLocalDbUrl,
  parseRestoreCounts,
  parseRunReport,
  parseSchemaTableLine,
  parseTriggerCatalog,
  planBackupIssue,
  planRun,
  r2EndpointUrl,
  r2ObjectUri,
  redactForLog,
  resolveRunTuning,
  restoreChecks,
  restoreFromArchive,
  restoreStageTimeoutMs,
  runBackup,
  runCli,
  runIdentityFromEnv,
  scanDataSql,
  scanSchemaSql,
  siblingKeys,
  stageTimeoutMs,
  tiersForDate,
  toRunReport,
  triggerFunctionSchema,
  unexpectedFailureReport,
  verifyChecksum,
  verifyDumpFiles,
} from '../scripts/lib/backup-db.mjs';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';
import { slotMaxOf } from './helpers/local-ci-slot-values';

// bash と python3 を起こす it があるので、負荷の高い機械でも既定の時間切れ (5 秒) で落ちないよう延ばす (#1605 の同じ型。§18)
vi.setConfig(resolveHeavyUnitTimeouts(process.env));

const ROOT = path.resolve(__dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// 偽物の材料
// ───────────────────────────────────────────────────────────────────────────

/** 本物の migration の版 (台帳の偽物に使う。ledgerChecks がファイルの有無を見るので実在する版にする) */
const REAL_VERSIONS = fs
  .readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((name) => /^\d{14}_.*\.sql$/.test(name))
  .map((name) => name.slice(0, 14))
  .sort()
  .slice(0, 2);

const SCHEMA_SQL = [
  'SET statement_timeout = 0;',
  'CREATE TABLE IF NOT EXISTS "public"."admin_audit_logs" (',
  '    "id" "uuid" NOT NULL,',
  '    "action_type" "text" NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS "public"."family_members" (',
  '    "id" "uuid" NOT NULL',
  ');',
  '',
].join('\n');

/** §4.3 の data.sql の骨組み */
const DATA_SQL = [
  'SET session_replication_role = replica;',
  '-- Dumped by pg_dump version 17.6',
  'SET statement_timeout = 0;',
  'COPY "auth"."users" ("instance_id", "id", "email") FROM stdin;',
  '00000000-0000-0000-0000-000000000000\t11111111-1111-1111-1111-111111111111\ta@example.com',
  '\\.',
  'COPY "public"."admin_audit_logs" ("id", "action_type") FROM stdin;',
  '22222222-2222-2222-2222-222222222222\tbackup.daily.completed',
  '\\.',
  'COPY "public"."family_members" ("id") FROM stdin;',
  '\\.',
  '--',
  '-- PostgreSQL database dump complete',
  '--',
  '-- \\unrestrict abc123',
  'RESET ALL;',
  '',
].join('\n');

const CRON_SQL = [
  "SELECT cron.schedule_in_database('a-job', '5 * * * *', pg_catalog.convert_from(pg_catalog.decode('73656c656374', 'hex'), 'UTF8'), 'postgres', 'postgres', 'true');",
  "SELECT cron.schedule_in_database('b''job', '0 1 * * *', pg_catalog.convert_from(pg_catalog.decode('73656c656374', 'hex'), 'UTF8'), 'postgres', 'postgres', 'true');",
  "DO $cron_check$ BEGIN IF (SELECT 1) IS DISTINCT FROM ARRAY['a-job', 'b''job']::text[] THEN RAISE EXCEPTION 'x'; END IF; END $cron_check$;",
  '',
].join('\n');

const LEDGER_TXT = `${REAL_VERSIONS.join('\n')}\n`;
/** auth・storage の表のトリガーの CSV の偽物 (snapshot_catalog.sql の \copy の形)。storage の内部の 4 本は origin/main の
 *  supabase/baseline/catalog/catalog_auth_storage_triggers.csv の行そのもの、auth の 4 本は #1757 (20261016243000) のトリガーを
 *  pg_get_triggerdef が書く形 (関数は postgres の search_path で見えるのでスキーマ無し・WHEN は括弧が 2 重) */
const STORAGE_INTERNAL_TRIGGER_ROWS = fs
  .readFileSync(path.join(ROOT, 'supabase/baseline/catalog', AUTH_STORAGE_TRIGGERS_CSV), 'utf8')
  .split('\n')
  .slice(1)
  .filter((line) => line !== '');
const AUTH_APP_TRIGGERS = [
  ['auth', 'sessions', 'on_auth_session_created', 'CREATE TRIGGER on_auth_session_created AFTER INSERT ON auth.sessions FOR EACH ROW EXECUTE FUNCTION auth_session_created()'],
  ['auth', 'sessions', 'on_auth_session_deleted', 'CREATE TRIGGER on_auth_session_deleted AFTER DELETE ON auth.sessions FOR EACH ROW EXECUTE FUNCTION auth_session_deleted()'],
  [
    'auth', 'sessions', 'on_auth_session_refreshed',
    'CREATE TRIGGER on_auth_session_refreshed AFTER UPDATE OF refreshed_at ON auth.sessions FOR EACH ROW WHEN ((old.refreshed_at IS DISTINCT FROM new.refreshed_at)) EXECUTE FUNCTION auth_session_refreshed()',
  ],
  ['auth', 'users', 'on_auth_user_password_changed', 'CREATE TRIGGER on_auth_user_password_changed AFTER INSERT OR UPDATE OF encrypted_password ON auth.users FOR EACH ROW EXECUTE FUNCTION password_history_record()'],
] as const;
function triggersCsv(rows: ReadonlyArray<readonly string[]>, internal: string[] = STORAGE_INTERNAL_TRIGGER_ROWS) {
  const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return `${[TRIGGER_CSV_COLUMNS.join(','), ...rows.map((row) => row.map(quote).join(',')), ...internal].join('\n')}\n`;
}
const TRIGGERS_CSV = triggersCsv(AUTH_APP_TRIGGERS);
const DUMPED = { public_tables: 2, auth_users: 1, audit_rows: 1 };
const COUNT_STDOUT = '2|1|1\n';
const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const FAKE_SECRET = 'fakeSecretValue0123456789abcdefXYZ';
const FAKE_ACCESS_KEY = 'AKIAFAKEACCESSKEY0001';
const FAKE_DB_PASSWORD = 'dbPasswordSecret0123456789';
const FAKE_RECIPIENT = `age1${'q'.repeat(58)}`;
const FAKE_ENV: Record<string, string | undefined> = {
  BACKUP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY,
  BACKUP_R2_SECRET_ACCESS_KEY: FAKE_SECRET,
  BACKUP_R2_ACCOUNT_ID: 'acc123',
  BACKUP_R2_BUCKET: 'fake-bucket',
  BACKUP_AGE_RECIPIENT: FAKE_RECIPIENT,
  SUPABASE_DB_PASSWORD: FAKE_DB_PASSWORD,
  SUPABASE_ACCESS_TOKEN: 'sbp_faketoken0123456789abcdef0123456789',
  GITHUB_RUN_ID: '4242',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SHA: 'deadbeefcafe',
};

const TUESDAY = new Date('2026-10-19T17:23:12Z'); // 2026-10-20 (火) 02:23 JST
const MONDAY = new Date('2026-10-18T17:23:00Z'); // 2026-10-19 (月) 02:23 JST
const NEW_YEAR_MONDAY = new Date('2028-12-31T17:23:00Z'); // 2029-01-01 (月) 02:23 JST
const NEW_YEAR_FRIDAY = new Date('2026-12-31T17:23:00Z'); // 2027-01-01 (金) 02:23 JST

interface RunOptions {
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  cwd?: string;
  stdinFile?: string;
  stdoutFile?: string;
  stderrFile?: string;
}
interface Call {
  cmd: string;
  args: string[];
  options: RunOptions;
  kind: string;
}
type Result = { code: number; stdout: string; stderrTail: string };
type Override = (call: Call) => Result | Promise<Result> | undefined;

const OK: Result = { code: 0, stdout: '', stderrTail: '' };

function argAfter(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0) throw new Error(`no ${flag} in ${args.join(' ')}`);
  return args[i + 1];
}

/** 呼び出しの種類 (テストの読みやすさのため) */
function kindOf(cmd: string, args: string[], options: RunOptions): string {
  if (cmd === 'npx' && args.includes('link')) return 'link';
  if (cmd === 'bash' && args[0] === IMAGE_PULL_FALLBACK_SCRIPT) return args[2].replace('db-backup ', '');
  if (cmd === 'bash' && args[0] === 'scripts/supabase-local.sh') return `local:${args[1]}`;
  if (cmd === 'bash' && args[0] === '-c') {
    if (args[1] === ARCHIVE_SCRIPT) return 'archive';
    const name = Object.entries(PSQL_SCRIPTS).find(([, body]) => body === args[1])?.[0];
    if (!name) return 'bash:unknown';
    const psqlFile = options.env?.PSQL_FILE;
    const content = psqlFile && fs.existsSync(psqlFile) && fs.statSync(psqlFile).isFile() ? fs.readFileSync(psqlFile, 'utf8') : '';
    if (name === 'count') {
      if (content.includes(LEDGER_VERSIONS_SQL)) return 'psql:ledger';
      if (content.includes(CRON_JOBS_SQL)) return 'psql:cron';
      if (content.includes(RESTORE_COUNT_SQL)) return 'psql:count';
      return 'psql:seed';
    }
    if (name === 'reset' && psqlFile && path.basename(psqlFile) === 'fixups.sql') return 'psql:fixups';
    if (name === 'catalog' && options.cwd?.endsWith('restored-catalog')) return 'psql:restored-catalog';
    return `psql:${name}`;
  }
  if (cmd === 'python3') {
    if (args[0] === '--version') return 'python:version';
    if (args[0] === RESTORE_FIXUPS_BUILDER_SCRIPT) return 'python:fixups';
    if (args[0] === CATALOG_VERIFY_SCRIPT) return 'python:verify';
  }
  if (cmd === 'aws') {
    if (args[0] === 's3' && args[1] === 'cp') return args[2].startsWith('s3://') ? 'aws:download' : 'aws:cp';
    if (args[1] === 'head-object') return 'aws:head';
    if (args[1] === 'list-objects-v2') return 'aws:list';
  }
  return cmd;
}

function writeCatalog(dir: string, skip: string[] = [], triggers: string = TRIGGERS_CSV) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of CATALOG_CSV_FILES) {
    if (skip.includes(name)) continue;
    fs.writeFileSync(path.join(dir, name), name === AUTH_STORAGE_TRIGGERS_CSV ? triggers : 'a,b\n1,2\n');
  }
}

/** 偽の CommandRunner。override が結果を返せばそれを使い、undefined なら既定の成功の振る舞い */
function fakeRunner(override: Override = () => undefined) {
  const calls: Call[] = [];
  /** R2 に「置いた」キー → 大きさ */
  const uploaded = new Map<string, number>();
  const run = async (cmd: string, args: string[], options: RunOptions): Promise<Result> => {
    const call: Call = { cmd, args: [...args], options: { ...options }, kind: kindOf(cmd, args, options) };
    calls.push(call);
    const overridden = await override(call);
    if (overridden !== undefined) return overridden;
    switch (call.kind) {
      case 'stats':
        fs.writeFileSync(argAfter(args, '--stdout'), '136|195|2500000000\n');
        return OK;
      case 'dump roles':
        fs.writeFileSync(argAfter(args, '-f'), 'CREATE ROLE "x";\n');
        return OK;
      case 'dump schema':
        fs.writeFileSync(argAfter(args, '-f'), SCHEMA_SQL);
        return OK;
      case 'dump data':
        fs.writeFileSync(argAfter(args, '-f'), DATA_SQL);
        return OK;
      case 'psql:catalog':
      case 'psql:restored-catalog':
        writeCatalog(options.cwd as string);
        return OK;
      case 'psql:ledger':
        fs.writeFileSync(options.stdoutFile as string, LEDGER_TXT);
        return OK;
      case 'psql:cron':
        fs.writeFileSync(options.stdoutFile as string, CRON_SQL);
        return OK;
      case 'psql:count':
        return { code: 0, stdout: COUNT_STDOUT, stderrTail: '' };
      case 'psql:version':
        return { code: 0, stdout: 'psql (PostgreSQL) 16.15\n', stderrTail: '' };
      case 'psql:roles':
        if (options.stderrFile) fs.writeFileSync(options.stderrFile, 'psql:/w/roles.sql:3: ERROR:  42710\n');
        return OK;
      case 'python:version':
        return { code: 0, stdout: 'Python 3.12.3\n', stderrTail: '' };
      case 'python:fixups':
        fs.writeFileSync(args[3], 'REVOKE ALL ON ROUTINE x FROM anon;\n');
        return OK;
      case 'python:verify':
        return { code: 0, stdout: '[warn] storage internal\n[verify] errors=0 warnings=1\n', stderrTail: '' };
      case 'archive':
        fs.writeFileSync(args[5], 'TARZST');
        return OK;
      case 'age': {
        const out = argAfter(args, '-o');
        fs.writeFileSync(out, args[0] === '-d' ? 'TARZST' : 'ENCRYPTED-ARCHIVE');
        return OK;
      }
      case 'aws:cp':
        uploaded.set(args[3].replace(/^s3:\/\/[^/]+\//, ''), fs.statSync(args[2]).size);
        return OK;
      case 'aws:head': {
        const key = argAfter(args, '--key');
        return { code: 0, stdout: JSON.stringify({ ContentLength: uploaded.get(key) ?? -1 }), stderrTail: '' };
      }
      case 'aws:list':
        return { code: 0, stdout: '3\n', stderrTail: '' };
      case 'local:env':
        return { code: 0, stdout: `NEXT_PUBLIC_SUPABASE_URL=http://x\nSUPABASE_DB_URL=${LOCAL_DB_URL}\n`, stderrTail: '' };
      default:
        return OK;
    }
  };
  return { run, calls, uploaded };
}

function deps(runner: ReturnType<typeof fakeRunner>, overrides: { env?: Record<string, string | undefined>; now?: Date } = {}) {
  const logs: string[] = [];
  const at = overrides.now ?? TUESDAY;
  return {
    deps: { run: runner.run, env: overrides.env ?? FAKE_ENV, now: () => at, log: (line: string) => logs.push(line) },
    logs,
  };
}

const kinds = (calls: Call[]) => calls.map((c) => c.kind);
const auditCall = (calls: Call[]) => calls.find((c) => c.kind === 'psql:audit');

async function* linesOf(text: string) {
  for (const line of text.split('\n')) yield line;
}

const tempDirs: string[] = [];
function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function decodeAuditRows(sql: string): Array<{ action: string; details: Record<string, unknown> }> {
  return sql
    .trim()
    .split('\n')
    .map((line) => {
      const m = /record_backup_audit\('([^']+)', pg_catalog\.convert_from\(pg_catalog\.decode\('([^']+)', 'base64'\)/.exec(line);
      if (!m) throw new Error(`audit line: ${line}`);
      return { action: m[1], details: JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')) };
    });
}

/** 偽の run の audit の呼び出しで書いた SQL を読む (PSQL_FILE は cleanup で消えるので、呼ばれた時点で控える) */
function captureAudit(): { override: Override; rows: () => Array<{ action: string; details: Record<string, unknown> }> } {
  let sql = '';
  return {
    override: (call) => {
      if (call.kind === 'psql:audit') sql = fs.readFileSync(call.options.env?.PSQL_FILE as string, 'utf8');
      return undefined;
    },
    rows: () => decodeAuditRows(sql),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 層・予定・キー
// ───────────────────────────────────────────────────────────────────────────

describe('tiersForDate / planRun / objectKey', () => {
  it('火曜 → [daily] / 月曜 → [daily, weekly] / 2027-01-01 (金) → [daily, annual] / 2029-01-01 (月) → 3 つ', () => {
    expect(tiersForDate('2026-10-20')).toEqual(['daily']);
    expect(tiersForDate('2026-10-19')).toEqual(['daily', 'weekly']);
    expect(tiersForDate('2027-01-01')).toEqual(['daily', 'annual']);
    expect(tiersForDate('2029-01-01')).toEqual(['daily', 'weekly', 'annual']);
  });

  it('JST の境界: 16:00 UTC の日曜 = 月曜 01:00 JST で weekly になる', () => {
    expect(planRun({ now: new Date('2026-10-18T16:00:00Z'), tierOverride: 'auto' }).tiers).toEqual(['daily', 'weekly']);
    expect(planRun({ now: new Date('2026-10-18T14:59:59Z'), tierOverride: 'auto' }).tiers).toEqual(['daily']);
  });

  it('tierOverride weekly → [daily, weekly]、annual → [daily, annual]、daily → [daily]、auto は日付どおり', () => {
    expect(planRun({ now: TUESDAY, tierOverride: 'weekly' }).tiers).toEqual(['daily', 'weekly']);
    expect(planRun({ now: TUESDAY, tierOverride: 'annual' }).tiers).toEqual(['daily', 'annual']);
    expect(planRun({ now: MONDAY, tierOverride: 'daily' }).tiers).toEqual(['daily']);
    expect(planRun({ now: TUESDAY, tierOverride: 'auto' }).tiers).toEqual(['daily']);
  });

  it('basename が homegohan-db-<YYYYMMDDTHHMMSSZ> (UTC) で、jst_date は JST の暦日', () => {
    const plan = planRun({ now: TUESDAY, tierOverride: 'auto' });
    expect(plan.basename).toBe('homegohan-db-20261019T172312Z');
    expect(plan.jst_date).toBe('2026-10-20');
    expect(plan.keys.daily.archive).toBe('daily/2026-10-20/homegohan-db-20261019T172312Z.tar.zst.age');
  });

  it('objectKey: daily/2026-10-20/<base>.tar.zst.age・annual は annual/2026/', () => {
    expect(objectKey('daily', '2026-10-20', 'b', 'archive')).toBe('daily/2026-10-20/b.tar.zst.age');
    expect(objectKey('weekly', '2026-10-19', 'b', 'sha256')).toBe('weekly/2026-10-19/b.sha256');
    expect(objectKey('annual', '2026-01-01', 'b', 'manifest')).toBe('annual/2026/b.manifest.json');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 設定
// ───────────────────────────────────────────────────────────────────────────

describe('checkConfig / resolveRunTuning / checkRestoreConfig', () => {
  it('5 つそろえば ok', () => {
    expect(checkConfig(FAKE_ENV)).toEqual({ ok: true });
  });

  it('無い・空・age1 以外は missing に名前だけ (値を含まない)', () => {
    const result = checkConfig({ ...FAKE_ENV, BACKUP_R2_ACCESS_KEY_ID: undefined, BACKUP_R2_BUCKET: '  ', BACKUP_AGE_RECIPIENT: 'ssh-rsa AAAA' });
    expect(result).toEqual({ ok: false, missing: ['BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_BUCKET', 'BACKUP_AGE_RECIPIENT'] });
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  });

  it('上書き無し → 既定 (dump 120・upload 60・restore_check 60・zstd 6) / 240 → 240', () => {
    expect(resolveRunTuning({})).toEqual({
      ok: true,
      tuning: { dumpTimeoutMinutes: 120, uploadTimeoutMinutes: 60, restoreCheckTimeoutMinutes: 60, zstdLevel: ZSTD_LEVEL },
    });
    const resolved = resolveRunTuning({ BACKUP_DUMP_TIMEOUT_MINUTES: '240' });
    expect(resolved.ok && resolved.tuning.dumpTimeoutMinutes).toBe(240);
  });

  it('0・301 (JOB_TIMEOUT_MINUTES 超)・1.5・abc・zstd 20 は invalid に名前', () => {
    for (const value of ['0', String(JOB_TIMEOUT_MINUTES + 1), '1.5', 'abc', '-1']) {
      expect(resolveRunTuning({ BACKUP_UPLOAD_TIMEOUT_MINUTES: value })).toEqual({ ok: false, invalid: ['BACKUP_UPLOAD_TIMEOUT_MINUTES'] });
    }
    expect(resolveRunTuning({ BACKUP_ZSTD_LEVEL: '20' })).toEqual({ ok: false, invalid: ['BACKUP_ZSTD_LEVEL'] });
  });

  it('checkConfig は invalid の名前を missing に入れる (値は入れない)', () => {
    expect(checkConfig({ ...FAKE_ENV, BACKUP_ZSTD_LEVEL: '99' })).toEqual({ ok: false, missing: ['BACKUP_ZSTD_LEVEL'] });
  });

  it('checkRestoreConfig: 4 つそろえば既定の tuning・無い/空の名前だけ・BACKUP_AGE_RECIPIENT を見ない・0 分は missing', () => {
    const restoreEnv = {
      BACKUP_R2_ACCOUNT_ID: 'a', BACKUP_R2_BUCKET: 'b', BACKUP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, BACKUP_R2_SECRET_ACCESS_KEY: FAKE_SECRET,
    };
    const ok = checkRestoreConfig(restoreEnv);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.tuning).toEqual(resolveRunTuning({}).ok && (resolveRunTuning({}) as { tuning: unknown }).tuning);
    expect(checkRestoreConfig({ ...restoreEnv, BACKUP_R2_BUCKET: '' })).toEqual({ ok: false, missing: ['BACKUP_R2_BUCKET'] });
    expect(checkRestoreConfig({ ...restoreEnv, BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES: '0' })).toEqual({
      ok: false, missing: ['BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES'],
    });
    const missingOne = checkRestoreConfig({ ...restoreEnv, BACKUP_R2_SECRET_ACCESS_KEY: undefined });
    expect(JSON.stringify(missingOne)).not.toContain(FAKE_ACCESS_KEY);
  });

  it('stageTimeoutMs / restoreStageTimeoutMs / RESTORE_STAGE_TIMEOUT_MINUTES の対応', () => {
    const base = (resolveRunTuning({}) as { tuning: Record<string, number> }).tuning;
    expect(Object.keys(RESTORE_STAGE_TIMEOUT_MINUTES).sort()).toEqual([...RESTORE_STAGES].sort());
    expect(RESTORE_STAGE_TIMEOUT_MINUTES.download).toBe(STAGE_TIMEOUT_MINUTES.upload);
    expect(RESTORE_STAGE_TIMEOUT_MINUTES.checksum).toBe(STAGE_TIMEOUT_MINUTES.verify);
    expect(RESTORE_STAGE_TIMEOUT_MINUTES.decrypt).toBe(STAGE_TIMEOUT_MINUTES.encrypt);
    expect(RESTORE_STAGE_TIMEOUT_MINUTES.extract).toBe(STAGE_TIMEOUT_MINUTES.archive);
    for (const s of ['restore_env', 'restore', 'restore_check'] as const) expect(RESTORE_STAGE_TIMEOUT_MINUTES[s]).toBe(STAGE_TIMEOUT_MINUTES.restore_check);
    expect(restoreStageTimeoutMs('download', { ...base, uploadTimeoutMinutes: 90 })).toBe(90 * MS_PER_MINUTE);
    expect(restoreStageTimeoutMs('restore', { ...base, restoreCheckTimeoutMinutes: 120 })).toBe(120 * MS_PER_MINUTE);
    expect(restoreStageTimeoutMs('decrypt', base)).toBe(STAGE_TIMEOUT_MINUTES.encrypt * MS_PER_MINUTE);
    expect(stageTimeoutMs('dump', { ...base, dumpTimeoutMinutes: 240 })).toBe(240 * MS_PER_MINUTE);
    expect(stageTimeoutMs('copy', { ...base, uploadTimeoutMinutes: 90 })).toBe(90 * MS_PER_MINUTE);
    expect(stageTimeoutMs('audit', base)).toBe(STAGE_TIMEOUT_MINUTES.audit * MS_PER_MINUTE);
    expect(STAGE_TIMEOUT_MINUTES.copy).toBe(STAGE_TIMEOUT_MINUTES.upload);
  });

  it('RUN_STEP_TIMEOUT_MINUTES = JOB_TIMEOUT_MINUTES − REPORT_STEP_RESERVE_MINUTES で正', () => {
    expect(RUN_STEP_TIMEOUT_MINUTES).toBe(JOB_TIMEOUT_MINUTES - REPORT_STEP_RESERVE_MINUTES);
    expect(RUN_STEP_TIMEOUT_MINUTES).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ダンプの読み取りと検査
// ───────────────────────────────────────────────────────────────────────────

describe('parseCopyLine / parseSchemaTableLine', () => {
  it('COPY の行を schema と表に分ける (列の無い形・"" を戻す)。引用符の無い形は null', () => {
    expect(parseCopyLine('COPY "auth"."users" ("id", "email") FROM stdin;')).toEqual({ schema: 'auth', table: 'users' });
    expect(parseCopyLine('COPY "public"."t" FROM stdin;')).toEqual({ schema: 'public', table: 't' });
    expect(parseCopyLine('COPY "public"."a""b" ("x") FROM stdin;')).toEqual({ schema: 'public', table: 'a"b' });
    expect(parseCopyLine('COPY public.x (a) FROM stdin;')).toBeNull();
  });

  it('schema.sql の表の行 (IF NOT EXISTS・UNLOGGED)。引用符の無い形は null', () => {
    expect(parseSchemaTableLine('CREATE TABLE IF NOT EXISTS "public"."family_members" (')).toEqual({ schema: 'public', table: 'family_members' });
    expect(parseSchemaTableLine('CREATE UNLOGGED TABLE "public"."b" (')).toEqual({ schema: 'public', table: 'b' });
    expect(parseSchemaTableLine('CREATE TABLE public.a (')).toBeNull();
  });
});

describe('scanDataSql', () => {
  it('§4.3 の骨組み: 行数・public / managed の分け方・完了行と RESET ALL;', async () => {
    const scan = await scanDataSql(linesOf(DATA_SQL));
    expect(scan.copy_row_counts['auth.users']).toBe(1);
    expect(scan.copy_row_counts['public.admin_audit_logs']).toBe(1);
    expect(scan.copy_row_counts['public.family_members']).toBe(0);
    expect(scan.public_copy_tables).toEqual(['admin_audit_logs', 'family_members']);
    expect(scan.managed_copy_tables).toEqual(['auth.users']);
    expect(scan.complete_trailer_seen).toBe(true);
    expect(scan.statements_after_trailer).toEqual(['RESET ALL;']);
    expect(scan.unterminated_copy).toBeNull();
    expect(scan.unexpected_copy_tables).toEqual([]);
  });

  it('`-- \\unrestrict` の行を除いても同じ結果', async () => {
    const scan = await scanDataSql(linesOf(DATA_SQL.replace('-- \\unrestrict abc123\n', '')));
    expect(scan.statements_after_trailer).toEqual(['RESET ALL;']);
    expect(scan.complete_trailer_seen).toBe(true);
  });

  it('完了行の無いファイル → complete_trailer_seen false・statements_after_trailer []', async () => {
    const scan = await scanDataSql(linesOf(DATA_SQL.split('--\n-- PostgreSQL database dump complete')[0]));
    expect(scan.complete_trailer_seen).toBe(false);
    expect(scan.statements_after_trailer).toEqual([]);
  });

  it('\\. の前でファイルが終わると unterminated_copy にその表', async () => {
    const scan = await scanDataSql(linesOf('COPY "storage"."objects" ("id") FROM stdin;\nrow1\n'));
    expect(scan.unterminated_copy).toBe('storage.objects');
    expect(scan.managed_copy_tables).toEqual(['storage.objects']);
  });

  it('COPY の本体の中の行が完了行と同じ文字列でも complete_trailer_seen にしない', async () => {
    const scan = await scanDataSql(linesOf('COPY "public"."x" ("t") FROM stdin;\n-- PostgreSQL database dump complete\n\\.\n'));
    expect(scan.complete_trailer_seen).toBe(false);
    expect(scan.copy_row_counts['public.x']).toBe(1);
  });

  it('先頭の SET と注釈を表に数えない・cron.job の COPY を unexpected に入れる', async () => {
    const scan = await scanDataSql(linesOf(`${DATA_SQL}COPY "cron"."job" ("jobid") FROM stdin;\n\\.\n`));
    expect(scan.public_copy_tables).toEqual(['admin_audit_logs', 'family_members']);
    expect(scan.unexpected_copy_tables).toEqual(['cron.job']);
  });
});

describe('scanSchemaSql', () => {
  it('IF NOT EXISTS と UNLOGGED を拾い、分割の親を除く (子は数える)・public の外は non_public_tables', async () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS "public"."a" (',
      '    "id" integer',
      ');',
      'CREATE UNLOGGED TABLE "public"."b" (',
      '    "id" integer',
      ');',
      'CREATE TABLE IF NOT EXISTS "public"."p" (',
      '    "d" date',
      ')',
      'PARTITION BY RANGE ("d");',
      'CREATE TABLE IF NOT EXISTS "public"."p_2026" (',
      '    "d" date',
      ');',
      'ALTER TABLE ONLY "public"."p" ATTACH PARTITION "public"."p_2026" FOR VALUES FROM (1) TO (2);',
      'CREATE TABLE IF NOT EXISTS "auth"."x" (',
      '    "id" integer',
      ');',
    ].join('\n');
    const scan = await scanSchemaSql(linesOf(sql));
    expect(scan.public_tables).toEqual(['a', 'b', 'p_2026']);
    expect(scan.non_public_tables).toEqual(['auth.x']);
  });

  it('実物の形の検査: supabase/baseline/prod_schema.sql の public の表の数が行の数え方と同じ・古い形が無い', async () => {
    const file = path.join(ROOT, 'supabase/baseline/prod_schema.sql');
    const scan = await scanSchemaSql(readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity }));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const counted = lines.filter((l) => l.startsWith('CREATE TABLE IF NOT EXISTS "public".') || l.startsWith('CREATE UNLOGGED TABLE "public".')).length;
    expect(scan.public_tables.length).toBeGreaterThan(0);
    expect(scan.public_tables.length).toBe(counted);
    expect(lines.some((l) => l.startsWith('CREATE TABLE public.'))).toBe(false);
    expect(lines.some((l) => l.startsWith('--'))).toBe(false);
  });
});

describe('verifyDumpFiles', () => {
  const sizes = { 'roles.sql': 1, 'schema.sql': 1, 'data.sql': 1 };
  const scanBoth = async (data = DATA_SQL, schema = SCHEMA_SQL) => ({
    data: await scanDataSql(linesOf(data)),
    schema: await scanSchemaSql(linesOf(schema)),
  });

  it('集合が同じで ok と dumped', async () => {
    expect(verifyDumpFiles({ fileSizes: sizes, ...(await scanBoth()) })).toEqual({ ok: true, dumped: DUMPED });
  });

  it('1 表少ないと dump_incomplete {expected, actual}・名前が違うと落ちる', async () => {
    const fewer = await scanBoth(DATA_SQL.replace('COPY "public"."family_members" ("id") FROM stdin;\n\\.\n', ''));
    expect(verifyDumpFiles({ fileSizes: sizes, ...fewer })).toEqual({ ok: false, reason: 'dump_incomplete', expected: 2, actual: 1 });
    const renamed = await scanBoth(DATA_SQL.replace('"public"."family_members"', '"public"."other"'));
    expect(verifyDumpFiles({ fileSizes: sizes, ...renamed }).ok).toBe(false);
  });

  it('完了行が無い・RESET ALL; が無い・後に別の文・COPY が終わっていない・auth.users / admin_audit_logs が無い → 落ちる', async () => {
    const cases = [
      DATA_SQL.replace('-- PostgreSQL database dump complete\n', ''),
      DATA_SQL.replace('RESET ALL;\n', ''),
      DATA_SQL.replace('RESET ALL;\n', 'SET x = 1;\nRESET ALL;\n'),
      `${DATA_SQL}COPY "public"."zz" ("a") FROM stdin;\nrow\n`,
      DATA_SQL.replace(/COPY "auth"\."users"[^\n]*\n[^\n]*\n\\\.\n/, ''),
    ];
    for (const data of cases) {
      const result = verifyDumpFiles({ fileSizes: sizes, ...(await scanBoth(data)) });
      expect(result.ok).toBe(false);
    }
    const noAudit = await scanBoth(
      DATA_SQL.replace(/COPY "public"\."admin_audit_logs"[^\n]*\n[^\n]*\n\\\.\n/, ''),
      SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS "public"\."admin_audit_logs" \(\n[^)]*\);\n/, ''),
    );
    expect(verifyDumpFiles({ fileSizes: sizes, ...noAudit }).ok).toBe(false);
  });

  it('schema の表も COPY の表も 0 (形が変わって何も拾えない) で落ちる・空のファイルで落ちる', async () => {
    const none = await scanBoth('-- PostgreSQL database dump complete\nRESET ALL;\n', 'CREATE TABLE public.a (\n);\n');
    expect(verifyDumpFiles({ fileSizes: sizes, ...none }).ok).toBe(false);
    expect(verifyDumpFiles({ fileSizes: { ...sizes, 'roles.sql': 0 }, ...(await scanBoth()) }).ok).toBe(false);
  });

  it('unexpected_copy_tables が 1 つで落ち expected 0・actual 1 / non_public_tables が 1 つで落ちる', async () => {
    const cron = await scanBoth(DATA_SQL.replace('RESET ALL;', 'RESET ALL;').replace('--\n-- PostgreSQL', 'COPY "cron"."job" ("jobid") FROM stdin;\n\\.\n--\n-- PostgreSQL'));
    expect(verifyDumpFiles({ fileSizes: sizes, ...cron })).toEqual({ ok: false, reason: 'dump_incomplete', expected: 0, actual: 1 });
    const nonPublic = await scanBoth(DATA_SQL, `${SCHEMA_SQL}CREATE TABLE IF NOT EXISTS "auth"."x" (\n    "id" integer\n);\n`);
    expect(verifyDumpFiles({ fileSizes: sizes, ...nonPublic }).ok).toBe(false);
  });

  it('引数に live の stats を取らない (dumped は data.sql の中身から)', async () => {
    const result = verifyDumpFiles({ fileSizes: sizes, ...(await scanBoth()) });
    expect(result.ok && result.dumped.auth_users).toBe(1);
    expect(verifyDumpFiles.length).toBe(1);
  });
});

describe('復元の SQL と読み取り', () => {
  it('managedTablesInDump: auth・storage を拾い public は拾わない・重複を除く', () => {
    expect(
      managedTablesInDump({
        public_copy_tables: ['x'], managed_copy_tables: ['auth.users', 'storage.objects', 'auth.users'], copy_row_counts: {},
        unterminated_copy: null, complete_trailer_seen: true, statements_after_trailer: [], unexpected_copy_tables: [],
      }),
    ).toEqual(['auth.users', 'storage.objects']);
  });

  it('buildResetSql: DROP → CREATE → GRANT 2 つ → storage のポリシー → TRUNCATE の順・a"b は "a""b"・[] なら TRUNCATE 無し', () => {
    const sql = buildResetSql(['auth.users', 'storage.objects']);
    const order = ['DROP SCHEMA IF EXISTS "public" CASCADE;', 'CREATE SCHEMA "public";', 'GRANT USAGE, CREATE ON SCHEMA "public" TO "postgres";',
      'GRANT USAGE ON SCHEMA "public" TO "anon", "authenticated", "service_role";', RESET_STORAGE_POLICIES_SQL,
      'TRUNCATE "auth"."users", "storage"."objects" CASCADE;'].map((s) => sql.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(buildResetSql(['auth.a"b'])).toContain('TRUNCATE "auth"."a""b" CASCADE;');
    expect(buildResetSql([])).not.toContain('TRUNCATE');
  });

  it('countRoleRestoreErrors: 42710 は数えて許し、ほかは others に・NOTICE は数えない', () => {
    expect(
      countRoleRestoreErrors('psql:/w/roles.sql:3: ERROR:  42710\npsql:/w/roles.sql:4: ERROR:  42710\npsql:/w/roles.sql:5: ERROR:  42501\nNOTICE:  00000\n'),
    ).toEqual({ tolerated: 2, others: ['42501'] });
    expect(countRoleRestoreErrors('')).toEqual({ tolerated: 0, others: [] });
  });

  it('parseLocalDbUrl: SUPABASE_DB_URL の値・無い/空は null', () => {
    expect(parseLocalDbUrl(`SUPABASE_URL=x\nSUPABASE_DB_URL=${LOCAL_DB_URL}\n`)).toBe(LOCAL_DB_URL);
    expect(parseLocalDbUrl('SUPABASE_URL=x\n')).toBeNull();
    expect(parseLocalDbUrl('SUPABASE_DB_URL=\n')).toBeNull();
  });

  it('parseRestoreCounts: 136|195|261 → 3 つ・列が 2 つ・数でない・負は null', () => {
    expect(parseRestoreCounts('136|195|261\n')).toEqual({ public_tables: 136, auth_users: 195, audit_rows: 261 });
    for (const bad of ['1|2', '1|x|3', '1|-2|3', '']) expect(parseRestoreCounts(bad)).toBeNull();
  });

  it('restoreChecks: 3 つ一致で ok・1 つずれれば failed で expected / actual', () => {
    expect(restoreChecks(DUMPED, { ...DUMPED })).toEqual({ ok: true });
    expect(restoreChecks(DUMPED, { ...DUMPED, auth_users: 2 })).toEqual({
      ok: false, reason: 'restore_check_failed', expected: DUMPED, actual: { ...DUMPED, auth_users: 2 },
    });
  });
});

describe('catalog・台帳・cron の定義', () => {
  const csvAll = Object.fromEntries(CATALOG_CSV_FILES.map((n) => [n, 2])) as Record<string, number | null>;

  it('parseLedgerVersions: 2 つ (末尾の空の行は無視)・空・2025・逆順・重複は null', () => {
    expect(parseLedgerVersions('20251126124224\n20261016230000\n')).toEqual(['20251126124224', '20261016230000']);
    for (const bad of ['', '2025\n', '20261016230000\n20251126124224\n', '20251126124224\n20251126124224\n']) {
      expect(parseLedgerVersions(bad)).toBeNull();
    }
  });

  it('parseCronJobsSql: 名前 (\'\' を戻す)・比べる行だけは []・形の違うものは null', () => {
    expect(parseCronJobsSql(`\n${CRON_SQL}\n`)).toEqual(['a-job', "b'job"]);
    expect(parseCronJobsSql(`${CRON_CHECK_LINE_PREFIX}BEGIN END $cron_check$;\n`)).toEqual([]);
    const lines = CRON_SQL.trim().split('\n');
    const bad = [
      lines.slice(0, 2).join('\n'),
      [lines[2], lines[0]].join('\n'),
      [`SELECT cron.schedule_in_database(E'a\\\\b', '1 * * * *', x);`, lines[2]].join('\n'),
      [`SELECT cron.schedule_in_database(NULL, '1 * * * *', x);`, lines[2]].join('\n'),
      ['SELECT 1;', lines[2]].join('\n'),
      [lines[0], lines[0], lines[2]].join('\n'),
      '',
    ];
    for (const text of bad) expect(parseCronJobsSql(text)).toBeNull();
  });

  it('cronJobsChecks: 2 と 2 → ok・3 → failed (actual 2)・読めない → actual null', () => {
    expect(cronJobsChecks(2, CRON_SQL)).toEqual({ ok: true, cron_jobs: 2 });
    expect(cronJobsChecks(3, CRON_SQL)).toEqual({ ok: false, reason: 'restore_check_failed', expected: 3, actual: 2 });
    expect(cronJobsChecks(2, 'x')).toEqual({ ok: false, reason: 'restore_check_failed', expected: 2, actual: null });
  });

  it('CRON_JOBS_SQL は読むだけ (cron.job を読み、書く文を含まない)', () => {
    expect(CRON_JOBS_SQL.startsWith('SELECT')).toBe(true);
    expect(CRON_JOBS_SQL).toContain('FROM cron.job');
    expect(CRON_JOBS_SQL).toContain('cron.schedule_in_database');
    expect(CRON_JOBS_SQL).toContain('DO $cron_check$');
    for (const word of ['INSERT', 'UPDATE', 'DELETE', 'cron.unschedule']) expect(CRON_JOBS_SQL).not.toContain(word);
  });

  it("CRON_JOBS_SQL は取得した人と同じ username を NULL にする (pg_cron 1.6.4 は superuser でない人が username を渡すと止める)", () => {
    expect(CRON_JOBS_SQL).toContain("CASE WHEN j.username = CURRENT_USER THEN 'NULL' ELSE pg_catalog.quote_literal(j.username) END");
    expect(CRON_JOBS_SQL).toContain("%L, %s, %L);'");
  });

  it('checkCatalogCapture: そろえば ok と ledger・cron_jobs / ジョブ 0 本でも ok / 欠けると catalog_failed', () => {
    const base = { csvLineCounts: csvAll, ledgerText: LEDGER_TXT, cronJobsText: CRON_SQL, fixupsBytes: 10 };
    expect(checkCatalogCapture(base)).toEqual({
      ok: true, ledger: { versions_count: 2, max_version: REAL_VERSIONS[1] }, cron_jobs: 2,
    });
    expect(checkCatalogCapture({ ...base, cronJobsText: `${CRON_CHECK_LINE_PREFIX}x;\n` })).toMatchObject({ ok: true, cron_jobs: 0 });
    const fail = { ok: false, reason: 'catalog_failed' };
    expect(checkCatalogCapture({ ...base, cronJobsText: '' })).toEqual(fail);
    expect(checkCatalogCapture({ ...base, csvLineCounts: { ...csvAll, 'catalog_tables.csv': null } })).toEqual(fail);
    expect(checkCatalogCapture({ ...base, csvLineCounts: { ...csvAll, 'storage_buckets.csv': 0 } })).toEqual(fail);
    expect(checkCatalogCapture({ ...base, ledgerText: '' })).toEqual(fail);
    expect(checkCatalogCapture({ ...base, ledgerText: '123\n' })).toEqual(fail);
    expect(checkCatalogCapture({ ...base, ledgerText: `${REAL_VERSIONS[0]}\n${REAL_VERSIONS[0]}\n` })).toEqual(fail);
    expect(checkCatalogCapture({ ...base, fixupsBytes: 0 })).toEqual(fail);
  });

  it('ledgerChecks: 数と最大が同じでファイルがあれば ok・違えば failed・.bak だけ / 無いと versions_without_files', () => {
    const expected = { versions_count: 2, max_version: '20261016230000' };
    expect(ledgerChecks(expected, ['20251126124224', '20261016230000'], ['20251126124224_a.sql', '20261016230000_b.sql'])).toEqual({ ok: true });
    expect(ledgerChecks({ ...expected, versions_count: 3 }, ['20251126124224', '20261016230000'], ['20251126124224_a.sql', '20261016230000_b.sql']).ok).toBe(false);
    expect(ledgerChecks({ ...expected, max_version: '20261016230001' }, ['20251126124224', '20261016230000'], ['20251126124224_a.sql', '20261016230000_b.sql']).ok).toBe(false);
    const result = ledgerChecks(expected, ['20251126124224', '20261016230000'], ['20251126124224_a.sql.bak']);
    expect(result).toMatchObject({ ok: false, versions_without_files: ['20251126124224', '20261016230000'] });
  });

  it('parseCatalogVerifySummary: [warn] の後の要約・無ければ null・2 つあれば最後', () => {
    expect(parseCatalogVerifySummary('[warn] x\n[verify] errors=0 warnings=3\n')).toEqual({ errors: 0, warnings: 3 });
    expect(parseCatalogVerifySummary('[warn] x\n')).toBeNull();
    expect(parseCatalogVerifySummary('[verify] errors=1 warnings=0\n[verify] errors=0 warnings=2\n')).toEqual({ errors: 0, warnings: 2 });
  });

  it('CATALOG_CSV_FILES が snapshot_catalog.sql の TO の名前の並びと同じ', () => {
    const sql = fs.readFileSync(path.join(ROOT, CATALOG_SNAPSHOT_SQL), 'utf8');
    const names = [...sql.matchAll(/TO '([^']+\.csv)'/g)].map((m) => m[1]);
    expect(names).toEqual([...CATALOG_CSV_FILES]);
  });

  it('補いの SQL の golden: build_restore_fixups.py の出力が prod_function_acl・prod_table_acl・prod_storage をつないだものと同じ', () => {
    const out = tempDir('fixups-');
    const catalogDir = path.join(ROOT, 'supabase/baseline/catalog');
    const before = fs.readdirSync(catalogDir).sort();
    const r = spawnSync('python3', [RESTORE_FIXUPS_BUILDER_SCRIPT, 'supabase/baseline/catalog', 'supabase/baseline/prod_schema.sql', path.join(out, 'fixups.sql')], {
      cwd: ROOT, encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const expected = ['prod_function_acl.sql', 'prod_table_acl.sql', 'prod_storage.sql']
      .map((name) => fs.readFileSync(path.join(ROOT, 'supabase/baseline', name), 'utf8'))
      .join('');
    expect(fs.readFileSync(path.join(out, 'fixups.sql'), 'utf8')).toBe(expected);
    expect(fs.readdirSync(catalogDir).sort()).toEqual(before);
  });

  it('build_restore_fixups.py: 引数が 2 つ → 2・カタログのディレクトリが無い → 1 で CSV の中身を出さない', () => {
    const out = tempDir('fixups-bad-');
    const usage = spawnSync('python3', [RESTORE_FIXUPS_BUILDER_SCRIPT, 'a', 'b'], { cwd: ROOT, encoding: 'utf8' });
    expect(usage.status).toBe(2);
    const missing = spawnSync('python3', [RESTORE_FIXUPS_BUILDER_SCRIPT, path.join(out, 'nope'), 'supabase/baseline/prod_schema.sql', path.join(out, 'f.sql')], {
      cwd: ROOT, encoding: 'utf8',
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/^build_restore_fixups: \w+/);
    expect(missing.stderr).not.toContain('proacl');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// auth・storage の表のアプリのトリガー (dump を流しても戻らないものの (6)。#1757 との取り込みで足した)
// ───────────────────────────────────────────────────────────────────────────

/** 本物のカタログ (supabase/baseline/catalog) を写し、トリガーの CSV だけ差し替えた置き場を作る */
function catalogWithTriggers(prefix: string, triggers: string) {
  const dir = tempDir(prefix);
  const source = path.join(ROOT, 'supabase/baseline/catalog');
  for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, AUTH_STORAGE_TRIGGERS_CSV), triggers);
  return dir;
}

function buildFixups(catalogDir: string) {
  const out = path.join(tempDir('fixups-trg-'), 'fixups.sql');
  const r = spawnSync('python3', [RESTORE_FIXUPS_BUILDER_SCRIPT, catalogDir, 'supabase/baseline/prod_schema.sql', out], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
}

const GOLDEN_FIXUPS = () =>
  ['prod_function_acl.sql', 'prod_table_acl.sql', 'prod_storage.sql'].map((name) => fs.readFileSync(path.join(ROOT, 'supabase/baseline', name), 'utf8')).join('');

describe('auth・storage の表のアプリのトリガー', () => {
  it('parseCsv: 引用符の中の , と改行と "" を扱い、閉じない引用符・引用符の後ろの文字は null', () => {
    expect(parseCsv('a,b\n"x,1","say ""hi""\nnext"\n')).toEqual([['a', 'b'], ['x,1', 'say "hi"\nnext']]);
    expect(parseCsv('a,b\r\n1,\r\n')).toEqual([['a', 'b'], ['1', '']]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,"b\n')).toBeNull();
    expect(parseCsv('a,"b"c\n')).toBeNull();
  });

  it('triggerFunctionSchema / isAppTrigger: storage・auth の関数は内部、スキーマ無し・public・ほかのスキーマはアプリ、形が違えば undefined', () => {
    expect(INTERNAL_TRIGGER_FUNCTION_SCHEMAS).toEqual(['auth', 'storage']);
    expect(triggerFunctionSchema('CREATE TRIGGER t BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()')).toBe('storage');
    expect(isAppTrigger('CREATE TRIGGER t BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()')).toBe(false);
    expect(isAppTrigger('CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.internal()')).toBe(false);
    expect(triggerFunctionSchema(AUTH_APP_TRIGGERS[0][3])).toBeNull();
    for (const row of AUTH_APP_TRIGGERS) expect(isAppTrigger(row[3]), row[2]).toBe(true);
    expect(isAppTrigger('CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()')).toBe(true);
    expect(triggerFunctionSchema('CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION "My.Schema"."f()"(\'a\')')).toBe('My.Schema');
    expect(isAppTrigger('CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE PROCEDURE "storage".f()')).toBe(false);
    expect(isAppTrigger('CREATE CONSTRAINT TRIGGER t AFTER INSERT ON auth.users DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f()')).toBe(true);
    // WHEN の中の文字列に EXECUTE FUNCTION があっても、最後の EXECUTE の関数を見る
    expect(triggerFunctionSchema("CREATE TRIGGER t AFTER UPDATE ON auth.users FOR EACH ROW WHEN ((new.x = 'EXECUTE FUNCTION storage.y()')) EXECUTE FUNCTION f()")).toBeNull();
    expect(triggerFunctionSchema('ALTER TABLE auth.users ENABLE TRIGGER t')).toBeUndefined();
    expect(isAppTrigger('')).toBeUndefined();
  });

  it('parseTriggerCatalog: 本物のベースラインの 4 行はどれも内部・見出し / 列の数 / 定義の形 / 重なりが違えば null', () => {
    const baseline = parseTriggerCatalog(fs.readFileSync(path.join(ROOT, 'supabase/baseline/catalog', AUTH_STORAGE_TRIGGERS_CSV), 'utf8'));
    expect(baseline).toHaveLength(STORAGE_INTERNAL_TRIGGER_ROWS.length);
    expect(baseline!.every((t) => !t.app && t.schema === 'storage')).toBe(true);
    const parsed = parseTriggerCatalog(TRIGGERS_CSV)!;
    expect(parsed.filter((t) => t.app).map((t) => t.key).sort()).toEqual(AUTH_APP_TRIGGERS.map((r) => `${r[0]}.${r[1]}.${r[2]}`).sort());
    expect(parseTriggerCatalog('schema,table_name,trigger_name\n')).toBeNull();
    expect(parseTriggerCatalog(`${TRIGGER_CSV_COLUMNS.join(',')}\nauth,users,t\n`)).toBeNull();
    expect(parseTriggerCatalog(`${TRIGGER_CSV_COLUMNS.join(',')}\nauth,users,t,not a trigger\n`)).toBeNull();
    expect(parseTriggerCatalog(`${TRIGGERS_CSV}${STORAGE_INTERNAL_TRIGGER_ROWS[0]}\n`)).toBeNull();
    expect(parseTriggerCatalog('')).toBeNull();
    expect(parseTriggerCatalog(`${TRIGGER_CSV_COLUMNS.join(',')}\n`)).toEqual([]);
  });

  it('appTriggerChecks: 同じなら ok (アプリ 4 本)・無い / 余分 / 定義が違う / 読めない は restore_check_failed・内部の差は落とさない', () => {
    expect(appTriggerChecks(TRIGGERS_CSV, TRIGGERS_CSV)).toEqual({ ok: true, app_triggers: 4, internal_differences: [] });
    const missing = appTriggerChecks(TRIGGERS_CSV, triggersCsv(AUTH_APP_TRIGGERS.slice(1)));
    expect(missing).toEqual({ ok: false, reason: 'restore_check_failed', unreadable: false, missing: ['auth.sessions.on_auth_session_created'], extra: [], differs: [] });
    // 取得の時点にアプリのトリガーが無く、復元した DB にだけある (ローカルの migration が作った) → 余分
    const extra = appTriggerChecks(triggersCsv([]), TRIGGERS_CSV);
    expect(extra).toMatchObject({ ok: false, reason: 'restore_check_failed', missing: [] });
    expect((extra as { extra: string[] }).extra).toHaveLength(AUTH_APP_TRIGGERS.length);
    const changed = AUTH_APP_TRIGGERS.map((r) => (r[2] === 'on_auth_user_password_changed' ? [r[0], r[1], r[2], r[3].replace('AFTER INSERT OR UPDATE', 'AFTER UPDATE')] : r));
    expect(appTriggerChecks(TRIGGERS_CSV, triggersCsv(changed))).toMatchObject({ ok: false, differs: ['auth.users.on_auth_user_password_changed'] });
    expect(appTriggerChecks(TRIGGERS_CSV, '')).toMatchObject({ ok: false, reason: 'restore_check_failed', unreadable: true });
    expect(appTriggerChecks('a,b\n1,2\n', TRIGGERS_CSV)).toMatchObject({ ok: false, unreadable: true });
    // 内部のトリガー (スタックの Storage の版の差) は名前を返すだけ
    const internalOnly = appTriggerChecks(TRIGGERS_CSV, triggersCsv(AUTH_APP_TRIGGERS, STORAGE_INTERNAL_TRIGGER_ROWS.slice(1)));
    expect(internalOnly).toMatchObject({ ok: true, app_triggers: 4 });
    expect((internalOnly as { internal_differences: string[] }).internal_differences).toHaveLength(1);
  });

  it('build_restore_fixups.py: アプリのトリガーを無いときだけ作る DO を golden の後ろに足す (内部の 4 本は作らない)・無ければ golden のまま', () => {
    const built = buildFixups(catalogWithTriggers('cat-trg-', TRIGGERS_CSV));
    expect(built.status, built.stderr).toBe(0);
    const golden = GOLDEN_FIXUPS();
    expect(built.text.startsWith(golden)).toBe(true);
    const section = built.text.slice(golden.length).split('\n').filter((line) => line !== '');
    expect(section[0]).toMatch(/^-- /);
    expect(section[1]).toBe("SELECT pg_catalog.set_config('search_path', 'public, extensions', false);");
    const dos = section.slice(2);
    expect(dos).toHaveLength(AUTH_APP_TRIGGERS.length);
    for (const [schema, table, name, definition] of AUTH_APP_TRIGGERS) {
      const relation = `'"${schema}"."${table}"'::pg_catalog.regclass`;
      expect(dos).toContain(
        `DO $restore_trigger$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = ${relation} AND t.tgname = '${name}' ` +
          `AND NOT t.tgisinternal) THEN EXECUTE '${definition.replace(/'/g, "''")}'; END IF; END $restore_trigger$;`,
      );
    }
    expect(built.text).not.toContain('protect_delete');
    expect(built.text).not.toContain('enforce_bucket_name_length_trigger');
    // アプリのトリガーが無いカタログ (ベースライン) は golden と同じ (既存の it と同じ。差し替えた置き場でも同じになること)
    expect(buildFixups(catalogWithTriggers('cat-trg0-', triggersCsv([]))).text).toBe(golden);
  });

  it("build_restore_fixups.py: 引用符を含む定義は SQL の文字列で '' にする・定義の形の誤り / DO の目印 / 見出しの誤り → 1 で中身を出さない", () => {
    const quoted = ['auth', 'users', 'trg_q', "CREATE TRIGGER trg_q AFTER UPDATE ON auth.users FOR EACH ROW WHEN ((new.role = 'x,y')) EXECUTE FUNCTION f()"];
    const ok = buildFixups(catalogWithTriggers('cat-trgq-', triggersCsv([quoted])));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.text).toContain("EXECUTE 'CREATE TRIGGER trg_q AFTER UPDATE ON auth.users FOR EACH ROW WHEN ((new.role = ''x,y'')) EXECUTE FUNCTION f()';");
    for (const bad of [
      triggersCsv([['auth', 'users', 'trg_bad', 'secret-definition-text']]),
      triggersCsv([['auth', 'users', 'trg_tag', 'CREATE TRIGGER trg_tag AFTER INSERT ON auth.users FOR EACH ROW WHEN ((new.x = $restore_trigger$a$restore_trigger$)) EXECUTE FUNCTION f()']]),
      'schema,table,trigger_name,definition\n',
    ]) {
      const r = buildFixups(catalogWithTriggers('cat-trgbad-', bad));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^build_restore_fixups: \w+/);
      expect(r.stderr).not.toContain('secret-definition-text');
    }
  });

  it('build_restore_fixups.py と backup-db.mjs の見分け方が同じ (内部のスキーマ・定義の式・見出し)', () => {
    const py = fs.readFileSync(path.join(ROOT, RESTORE_FIXUPS_BUILDER_SCRIPT), 'utf8');
    expect(/^INTERNAL_TRIGGER_FUNCTION_SCHEMAS = \(([^)]*)\)$/m.exec(py)?.[1]).toBe(INTERNAL_TRIGGER_FUNCTION_SCHEMAS.map((s) => `"${s}"`).join(', '));
    expect(/^TRIGGER_CSV_COLUMNS = \(([^)]*)\)$/m.exec(py)?.[1]).toBe(TRIGGER_CSV_COLUMNS.map((s) => `"${s}"`).join(', '));
    expect(/^TRIGGERS_CSV = "([^"]+)"$/m.exec(py)?.[1]).toBe(AUTH_STORAGE_TRIGGERS_CSV);
    expect(/^ {4}r'(.*)',$/m.exec(py)?.[1]).toBe(TRIGGER_DEFINITION_PATTERN.source);
    expect(TRIGGER_DEFINITION_PATTERN.flags).toBe('s');
    expect(/^TRIGGER_DEFINITION_PATTERN = re\.compile\($/m.test(py) && /^ {4}re\.S,$/m.test(py)).toBe(true);
  });

  it('同じ型の掃除: migration が auth・storage の表に作るトリガーは、どれも関数が auth・storage の外 (= アプリのトリガーとして補われ、比べられる)', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const found: string[] = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.sql') && !n.endsWith('.down.sql'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/--[^\n]*/g, '');
      for (const m of text.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER\s+("?[\w]+"?)\s[^;]*?\bON\s+"?(auth|storage)"?\."?\w+"?[^;]*?;/gis)) {
        const statement = m[0].replace(/\s+/g, ' ').replace(/;$/, '');
        found.push(`${name}:${m[1]}`);
        expect(isAppTrigger(statement), `${name}: ${statement}`).toBe(true);
      }
    }
    // #1757 の 4 本 (取り込みのときに増えた分) が見つかっていること (式が migration の書き方を取りこぼさない)
    for (const [, , trigger] of AUTH_APP_TRIGGERS) expect(found.some((entry) => entry.endsWith(`:${trigger}`)), trigger).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 監査行・manifest・reason
// ───────────────────────────────────────────────────────────────────────────

describe('監査行と manifest', () => {
  it('backupAuditActionType と BACKUP_AUDIT_ACTION_TYPES: 6 値・BACKUP_TIERS × BACKUP_AUDIT_RESULTS の順', () => {
    expect(BACKUP_AUDIT_ACTION_TYPES).toEqual(BACKUP_TIERS.flatMap((t) => BACKUP_AUDIT_RESULTS.map((r) => `backup.${t}.${r}`)));
    expect(BACKUP_AUDIT_ACTION_TYPES[0]).toBe('backup.daily.completed');
    expect(BACKUP_AUDIT_ACTION_TYPES).toHaveLength(6);
    expect(backupAuditActionType('weekly', 'failed')).toBe('backup.weekly.failed');
  });

  it('buildAuditSql: 2 行で 2 文・base64 を戻すと details と同じ・SQL に { と " が無い', () => {
    const rows = [
      { tier: 'daily', result: 'completed', details: { tier: 'daily', note: 'a"b{c}\\' } },
      { tier: 'weekly', result: 'failed', details: { tier: 'weekly', stage: 'copy', reason: 'copy_failed' } },
    ] as const;
    const sql = buildAuditSql(rows as never);
    const decoded = decodeAuditRows(sql);
    expect(decoded.map((r) => r.action)).toEqual(['backup.daily.completed', 'backup.weekly.failed']);
    expect(decoded[0].details).toEqual(rows[0].details);
    expect(sql).not.toContain('{');
    expect(sql).not.toContain('"');
  });

  it('STAGE_DEFAULT_REASON: cleanup を除く段の全部にキーがあり、値が FAILURE_REASONS の中', () => {
    const keys = new Set([...STAGES, ...RESTORE_STAGES].filter((s) => s !== 'cleanup'));
    expect(new Set(Object.keys(STAGE_DEFAULT_REASON))).toEqual(keys);
    for (const value of Object.values(STAGE_DEFAULT_REASON)) expect(FAILURE_REASONS).toContain(value);
  });

  it('buildCompletedDetails: 上限を超えたら inventory → restore_check の順に落とす・超えないなら全部残す', () => {
    const base = {
      tier: 'weekly', key: 'k', sha256: 'h', size_bytes: 1, captured_at: 't', duration_seconds: 1, public_tables: 1, auth_users: 1,
      run_id: '1', run_attempt: 1, git_sha: 's',
    };
    const restoreCheck = {
      result: 'passed', public_tables: 1, auth_users: 1, audit_rows: 1, catalog_errors: 0, catalog_warnings: 0, ledger_versions: 1, cron_jobs: 1, duration_seconds: 1,
    };
    const small = buildCompletedDetails({ ...base, restore_check: restoreCheck, inventory: { daily_objects: 1, weekly_objects: 1, annual_objects: 1 } } as never);
    expect(small).toHaveProperty('inventory');
    expect(small).toHaveProperty('restore_check');
    const huge = 'x'.repeat(AUDIT_DETAILS_MAX_BYTES);
    const dropInventory = buildCompletedDetails({ ...base, restore_check: restoreCheck, inventory: { pad: huge } } as never);
    expect(dropInventory).not.toHaveProperty('inventory');
    expect(dropInventory).toHaveProperty('restore_check');
    const dropBoth = buildCompletedDetails({ ...base, restore_check: { pad: huge }, inventory: { pad: huge } } as never);
    expect(dropBoth).not.toHaveProperty('inventory');
    expect(dropBoth).not.toHaveProperty('restore_check');
  });

  it('buildFailedDetails: reason が FAILURE_REASONS の外なら投げる', () => {
    const base = { tier: 'daily', stage: 'dump', duration_seconds: 1, run_id: '1', run_attempt: 1, git_sha: 's' };
    expect(buildFailedDetails({ ...base, reason: 'dump_failed' } as never)).toMatchObject({ reason: 'dump_failed' });
    expect(() => buildFailedDetails({ ...base, reason: 'nope' } as never)).toThrow();
  });

  it('buildManifest: schema_version と写したキーだけ・files の sha256 は .age の行だけ文字列', () => {
    const input = {
      captured_at: 't', jst_date: '2026-10-20', tiers: ['daily'], basename: 'b', git_sha: 's', supabase_cli: SUPABASE_CLI_VERSION, postgres_version: '17',
      age_recipient: FAKE_RECIPIENT, excluded_tables: [...DUMP_EXCLUDED_TABLES], data_schemas: [...DATA_DUMP_SCHEMAS],
      source: { public_tables: 1, auth_users: 1, db_size_bytes: 1 }, dumped: DUMPED, ledger: { versions_count: 1, max_version: 'v' }, cron_jobs: 15,
      files: [{ name: 'b.tar.zst.age', size_bytes: 1, sha256: 'h' }, { name: 'b.sha256', size_bytes: 1, sha256: null }],
    };
    const manifest = buildManifest(input as never);
    expect(manifest).toEqual({ schema_version: MANIFEST_SCHEMA_VERSION, ...input });
    expect(Object.keys(manifest).sort()).toEqual(['schema_version', ...Object.keys(input)].sort());
  });

  it('classifyFailure: timeout・段の既定・75 は stats / dump / restore_env だけ・TypeError は unknown', () => {
    expect(classifyFailure('dump', new CommandTimeoutError('x', 1))).toBe('timeout');
    expect(classifyFailure('link', new CommandFailedError('x', 1))).toBe('link_failed');
    expect(classifyFailure('audit', new CommandFailedError('x', 1))).toBe('audit_failed');
    expect(classifyFailure('restore', new CommandFailedError('x', 1))).toBe('restore_check_failed');
    for (const s of ['stats', 'dump', 'restore_env'] as const) {
      expect(classifyFailure(s, new CommandFailedError('x', IMAGE_PULL_UNAVAILABLE_EXIT_CODE))).toBe('image_pull_unavailable');
    }
    expect(classifyFailure('restore_check', new CommandFailedError('x', IMAGE_PULL_UNAVAILABLE_EXIT_CODE))).toBe('restore_check_failed');
    expect(classifyFailure('dump', new TypeError('x'))).toBe('unknown');
  });

  it('redactForLog: 24 文字以上の英数字と秘密らしい名前の値を伏せ、短い語は残す', () => {
    const text = `fail token ${'A1'.repeat(15)} pw ${FAKE_DB_PASSWORD} short ok postgresql://u:p@h/db`;
    const out = redactForLog(text, { SUPABASE_DB_PASSWORD: FAKE_DB_PASSWORD, OTHER: 'x' });
    expect(out).not.toContain('A1A1A1A1A1A1');
    expect(out).not.toContain(FAKE_DB_PASSWORD);
    expect(out).not.toContain('u:p@h');
    expect(out).toContain('short ok');
    expect(out).toContain('***');
  });

  it('IMAGE_PULL_UNAVAILABLE_EXIT_CODE がライブラリの SIP_EXIT_PULL_UNAVAILABLE と同じ・fallback の入口がある', () => {
    const r = spawnSync('bash', ['-c', '. scripts/lib/supabase-image-pull.sh; echo $SIP_EXIT_PULL_UNAVAILABLE'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(Number(r.stdout.trim())).toBe(IMAGE_PULL_UNAVAILABLE_EXIT_CODE);
    expect(fs.existsSync(path.join(ROOT, IMAGE_PULL_FALLBACK_SCRIPT))).toBe(true);
  });

  it('runIdentityFromEnv: 3 つの値・無い/空は local・0・unknown・attempt 0 / x は 0', () => {
    expect(runIdentityFromEnv({ GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '3', GITHUB_SHA: 'abc' })).toEqual({ run_id: '9', run_attempt: 3, git_sha: 'abc' });
    expect(runIdentityFromEnv({})).toEqual({ run_id: 'local', run_attempt: 0, git_sha: 'unknown' });
    expect(runIdentityFromEnv({ GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '0' }).run_attempt).toBe(0);
    expect(runIdentityFromEnv({ GITHUB_RUN_ATTEMPT: 'x' }).run_attempt).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R2
// ───────────────────────────────────────────────────────────────────────────

describe('R2 の設定と aws の env', () => {
  it('awsCommandEnv: 鍵を写し、checksum の 2 つを足し、一時鍵とプロファイルを外す', () => {
    const out = awsCommandEnv({ BACKUP_R2_ACCESS_KEY_ID: 'AK', BACKUP_R2_SECRET_ACCESS_KEY: 'SK', AWS_SESSION_TOKEN: 'T', AWS_PROFILE: 'p' });
    expect(out.AWS_ACCESS_KEY_ID).toBe('AK');
    expect(out.AWS_SECRET_ACCESS_KEY).toBe('SK');
    expect(out).toMatchObject(AWS_CHECKSUM_ENV);
    expect(Object.hasOwn(out, 'AWS_SESSION_TOKEN') && out.AWS_SESSION_TOKEN === undefined).toBe(true);
    expect(Object.hasOwn(out, 'AWS_PROFILE') && out.AWS_PROFILE === undefined).toBe(true);
  });

  it('r2EndpointUrl / r2ObjectUri', () => {
    expect(r2EndpointUrl('acc')).toBe('https://acc.r2.cloudflarestorage.com');
    expect(r2ObjectUri('b', 'daily/x')).toBe('s3://b/daily/x');
  });

  it('LOCK_MAX_AGE_SECONDS = RETENTION_DAYS × SECONDS_PER_DAY', () => {
    for (const t of BACKUP_TIERS) expect(LOCK_MAX_AGE_SECONDS[t]).toBe(RETENTION_DAYS[t] * SECONDS_PER_DAY);
  });

  it('buildR2LifecycleConfig が §4.5 の JSON と同じ・S3 の形のキーが無い', () => {
    const config = buildR2LifecycleConfig();
    expect(config).toEqual({
      rules: [
        { id: 'daily-expire', enabled: true, conditions: { prefix: 'daily/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2592000 } } },
        {
          id: 'weekly-ia', enabled: true, conditions: { prefix: 'weekly/' },
          storageClassTransitions: [{ condition: { type: 'Age', maxAge: 2592000 }, storageClass: 'InfrequentAccess' }],
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 31622400 } },
        },
        {
          id: 'annual-ia', enabled: true, conditions: { prefix: 'annual/' },
          storageClassTransitions: [{ condition: { type: 'Age', maxAge: 2592000 }, storageClass: 'InfrequentAccess' }],
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 220924800 } },
        },
        { id: 'abort-multipart', enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } } },
      ],
    });
    expect(config.rules[1].storageClassTransitions?.[0].condition.maxAge).toBe(INFREQUENT_ACCESS_AFTER_DAYS * SECONDS_PER_DAY);
    expect(config.rules[3].abortMultipartUploadsTransition?.condition.maxAge).toBe(R2_ABORT_MULTIPART_AFTER_DAYS * SECONDS_PER_DAY);
    const json = JSON.stringify(config);
    for (const key of ['"Rules"', '"Expiration"', '"Transitions"', 'STANDARD_IA', '"Days"']) expect(json).not.toContain(key);
  });

  it('lock の --retention-days × SECONDS_PER_DAY が Lifecycle の削除の秒と同じ・IA の遷移が削除より前・名前が一意', () => {
    const config = buildR2LifecycleConfig();
    const commands = buildR2LockCommands({ bucket: 'homegohan-db-backups', lifecycleFile: '/d/r2-lifecycle.json' });
    expect(commands[0]).toEqual(['npx', 'wrangler', 'r2', 'bucket', 'lifecycle', 'set', 'homegohan-db-backups', '--file', '/d/r2-lifecycle.json']);
    const names = new Set<string>();
    for (const [i, tier] of BACKUP_TIERS.entries()) {
      const command = commands[i + 1];
      const days = Number(argAfter(command, '--retention-days'));
      const rule = config.rules.find((r) => r.conditions.prefix === `${tier}/`);
      expect(days * SECONDS_PER_DAY).toBe(rule?.deleteObjectsTransition?.condition.maxAge);
      expect(argAfter(command, '--name')).toBe(`${tier}-${RETENTION_DAYS[tier]}d`);
      names.add(argAfter(command, '--name'));
      if (rule?.storageClassTransitions) expect(rule.storageClassTransitions[0].condition.maxAge).toBeLessThan(rule.deleteObjectsTransition!.condition.maxAge);
    }
    expect(names.size).toBe(3);
  });

  it('siblingKeys / verifyChecksum', () => {
    expect(siblingKeys('daily/2026-10-13/b.tar.zst.age')).toEqual({
      archive: 'daily/2026-10-13/b.tar.zst.age', sha256: 'daily/2026-10-13/b.sha256', manifest: 'daily/2026-10-13/b.manifest.json',
    });
    expect(siblingKeys('daily/2026-10-13/b.sha256')).toBeNull();
    expect(siblingKeys('other/2026-10-13/b.tar.zst.age')).toBeNull();
    const digest = 'ab'.repeat(32);
    expect(verifyChecksum({ sha256FileText: `${digest}  b.tar.zst.age\n`, actualSha256: digest })).toEqual({ ok: true });
    expect(verifyChecksum({ sha256FileText: `${digest.toUpperCase()} *b.tar.zst.age\n`, actualSha256: digest })).toEqual({ ok: true });
    expect(verifyChecksum({ sha256FileText: `${digest}  b\n`, actualSha256: 'cd'.repeat(32) })).toEqual({
      ok: false, reason: 'checksum_mismatch', expectedPrefix: 'abababab', actualPrefix: 'cdcdcdcd',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 結果ファイルと Issue
// ───────────────────────────────────────────────────────────────────────────

const PLAN = planRun({ now: TUESDAY, tierOverride: 'auto' });
function result(overrides: Partial<{ exitCode: number; completed: string[]; failed: unknown[]; warnings: unknown[]; auditWritten: boolean }> = {}) {
  return { ok: true, exitCode: 0, plan: PLAN, completed: ['daily'], failed: [], warnings: [], auditWritten: true, ...overrides };
}

describe('toRunReport / parseRunReport / planBackupIssue', () => {
  it('toRunReport: exitCode 0 → ok・3 → not_configured・1 → failed、missing の名前を写し値を写さない', () => {
    expect(toRunReport(result() as never).status).toBe('ok');
    const notConfigured = toRunReport(
      result({ exitCode: 3, completed: [], failed: [{ tier: 'daily', stage: 'config', reason: 'not_configured', missing: ['BACKUP_R2_BUCKET'] }], auditWritten: true }) as never,
    );
    expect(notConfigured).toMatchObject({ status: 'not_configured', exit_code: 3, failures: [{ tier: 'daily', stage: 'config', reason: 'not_configured', missing: ['BACKUP_R2_BUCKET'] }] });
    const failed = toRunReport(result({ exitCode: 1, warnings: [{ stage: 'inventory', reason: 'inventory_failed' }], auditWritten: false }) as never);
    expect(failed).toMatchObject({ status: 'failed', warnings: [{ stage: 'inventory', reason: 'inventory_failed' }], audit_written: false });
  });

  it('parseRunReport: 往復で同じ・unexpectedFailureReport も読む・形の違うものは null', () => {
    const report = toRunReport(result() as never);
    expect(parseRunReport(JSON.stringify(report))).toEqual(report);
    const unexpected = unexpectedFailureReport({ jstDate: '2026-10-20' });
    expect(parseRunReport(JSON.stringify(unexpected))).toEqual(unexpected);
    const bad = [
      null, 'not json', JSON.stringify({ ...report, schema_version: 2 }), JSON.stringify({ ...report, status: 'weird' }),
      JSON.stringify({ ...report, status: 'failed', exit_code: 1, failures: [{ tier: 'daily', stage: 'dump', reason: 'nope' }] }),
      JSON.stringify({ ...report, status: 'ok', exit_code: 1 }), JSON.stringify({ ...report, status: 'failed', exit_code: 0 }),
      JSON.stringify({ ...report, failures: [{ tier: 'daily', stage: 'dump', reason: 'dump_failed' }] }),
    ];
    for (const text of bad) expect(parseRunReport(text)).toBeNull();
  });

  const URL = 'https://github.com/o/r/actions/runs/1';
  it('ok + success → 問題なし・warnings だけも問題なし', () => {
    expect(planBackupIssue({ report: toRunReport(result() as never), runOutcome: 'success', runUrl: URL })).toEqual({ hasProblems: false });
    const warned = toRunReport(result({ warnings: [{ stage: 'inventory', reason: 'inventory_failed' }] }) as never);
    expect(planBackupIssue({ report: warned, runOutcome: 'success', runUrl: URL })).toEqual({ hasProblems: false });
  });

  it('failures 1 件 → marker で始まり層・段・reason・missing の名前・run の URL を含み、値を含まない', () => {
    const report = toRunReport(
      result({ exitCode: 3, completed: [], failed: [{ tier: 'daily', stage: 'config', reason: 'not_configured', missing: ['BACKUP_R2_BUCKET'] }] }) as never,
    );
    const plan = planBackupIssue({ report, runOutcome: 'failure', runUrl: URL });
    if (!plan.hasProblems) throw new Error('expected problems');
    expect(plan.title).toBe(BACKUP_ISSUE_TITLE);
    expect(plan.body.startsWith(BACKUP_ISSUE_MARKER)).toBe(true);
    for (const word of ['daily', 'config', 'not_configured', 'BACKUP_R2_BUCKET', URL]) expect(plan.body).toContain(word);
    expect(plan.body).not.toContain(FAKE_SECRET);
  });

  it('report null + failure / cancelled → 「結果を残さずに終わった」と outcome', () => {
    for (const outcome of ['failure', 'cancelled'] as const) {
      const plan = planBackupIssue({ report: null, runOutcome: outcome, runUrl: URL });
      expect(plan.hasProblems).toBe(true);
      if (plan.hasProblems) {
        expect(plan.body).toContain('結果を残さずに終わった');
        expect(plan.body).toContain(outcome);
      }
    }
  });

  it('ok なのに outcome failure → 「食い違う」/ failures が空の failed → 「段の失敗として記録できずに終わった」/ audit だけの失敗は completed を本文に', () => {
    const okPlan = planBackupIssue({ report: toRunReport(result() as never), runOutcome: 'failure', runUrl: URL });
    expect(okPlan.hasProblems && okPlan.body).toContain('食い違う');
    const unexpected = planBackupIssue({ report: unexpectedFailureReport({ jstDate: '2026-10-20' }), runOutcome: 'failure', runUrl: URL });
    expect(unexpected.hasProblems && unexpected.body).toContain('段の失敗として記録できずに終わった');
    const auditOnly = toRunReport(result({ exitCode: 1, failed: [{ tier: 'daily', stage: 'audit', reason: 'audit_failed' }], auditWritten: false }) as never);
    const plan = planBackupIssue({ report: auditOnly, runOutcome: 'failure', runUrl: URL });
    expect(plan.hasProblems && plan.body).toContain('取得は成功した層: daily');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 引数
// ───────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('run の既定 tier auto・--result-file は任意', () => {
    expect(parseArgs(['run'])).toEqual({ command: 'run', tier: 'auto', resultFile: null });
    expect(parseArgs(['run', '--tier', 'weekly', '--result-file', '/t/r.json'])).toEqual({ command: 'run', tier: 'weekly', resultFile: '/t/r.json' });
  });

  it('restore は key と identity-file 必須・--key の形・--slot の範囲', () => {
    expect(parseArgs(['restore', '--key', 'daily/2026-10-13/b.tar.zst.age', '--identity-file', '/k'])).toEqual({
      command: 'restore', key: 'daily/2026-10-13/b.tar.zst.age', identityFile: '/k', slot: LOCAL_SLOT_DEFAULT,
    });
    expect(parseArgs(['restore', '--key', 'daily/x/b.tar.zst.age', '--identity-file', '/k', '--slot', '0']).slot).toBe(0);
    expect(parseArgs(['roundtrip-local', '--slot', '9'])).toEqual({ command: 'roundtrip-local', slot: 9 });
    const bad = [
      ['restore', '--identity-file', '/k'],
      ['restore', '--key', 'daily/x/b.tar.zst.age'],
      ['restore', '--key', 'daily/x/b.sha256', '--identity-file', '/k'],
      ...['-1', '10', '1.5', 'a'].map((s) => ['roundtrip-local', '--slot', s]),
      ['roundtrip-local', '--slot'],
      ['run', '--slot', '1'],
      ['run', '--tier', 'monthly'],
      ['run', '--bogus', 'x'],
      ['run', '--tier', 'daily', '--tier', 'daily'],
      ['report-issue', '--result-file', 'f', '--run-outcome', 'weird', '--run-url', 'u'],
      ['report-issue', '--result-file', 'f', '--run-outcome', 'success'],
      ['r2-config', '--bucket', 'b'],
      ['nope'],
    ];
    for (const argv of bad) expect(() => parseArgs(argv), argv.join(' ')).toThrow(UsageError);
  });

  it('report-issue / r2-config / help', () => {
    expect(parseArgs(['report-issue', '--result-file', 'f', '--run-outcome', 'cancelled', '--run-url', 'u'])).toEqual({
      command: 'report-issue', resultFile: 'f', runOutcome: 'cancelled', runUrl: 'u',
    });
    expect(parseArgs(['r2-config', '--bucket', 'b', '--out-dir', 'd'])).toEqual({ command: 'r2-config', bucket: 'b', outDir: 'd' });
    expect(parseArgs(['--help'])).toEqual({ command: 'help' });
  });

  it('LOCAL_SLOT_MAX が local-ci-slot.sh の LCS_SLOT_MAX と同じ・LOCAL_SLOT_ENV が supabase-local.sh の枠の変数', () => {
    expect(LOCAL_SLOT_MAX).toBe(slotMaxOf(process.cwd()));
    expect(LOCAL_SLOT_ENV).toBe('LOCAL_CI_SLOT');
    expect(fs.readFileSync(path.join(ROOT, 'scripts/supabase-local.sh'), 'utf8')).toContain('LOCAL_CI_SLOT:-0');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// runBackup (偽の run)
// ───────────────────────────────────────────────────────────────────────────

describe('runBackup', () => {
  it('火曜の成功: 段の順・呼ぶコマンド・結果 (daily だけ・終了 0)', async () => {
    const audit = captureAudit();
    const runner = fakeRunner(audit.override);
    const { deps: d } = deps(runner);
    const r = await runBackup({ tier: 'auto' }, d);
    expect(r).toMatchObject({ ok: true, exitCode: 0, completed: ['daily'], failed: [], auditWritten: true });
    expect(kinds(runner.calls)).toEqual([
      'link', 'stats', 'dump roles', 'dump schema', 'dump data',
      'psql:catalog', 'psql:ledger', 'psql:cron', 'python:fixups',
      'archive', 'age',
      'aws:cp', 'aws:cp', 'aws:cp', 'aws:head', 'aws:head', 'aws:head',
      'aws:list', 'aws:list', 'aws:list',
      'psql:audit',
    ]);
    const rows = audit.rows();
    expect(rows.map((x) => x.action)).toEqual(['backup.daily.completed']);
    expect(rows[0].details).toMatchObject({
      tier: 'daily', key: PLAN.keys.daily.archive, public_tables: DUMPED.public_tables, auth_users: DUMPED.auth_users,
      run_id: '4242', run_attempt: 2, git_sha: 'deadbeefcafe', inventory: { daily_objects: 3, weekly_objects: 3, annual_objects: 3 },
    });
    expect(rows[0].details).not.toHaveProperty('restore_check');
  });

  it('stats と dump は fallback で包み (`bash` + script + --step + --)、supabase の版と data の -s・-x', async () => {
    const runner = fakeRunner();
    const { deps: d } = deps(runner);
    await runBackup({ tier: 'auto' }, d);
    const stats = runner.calls.find((c) => c.kind === 'stats')!;
    expect(stats.cmd).toBe('bash');
    expect(stats.args.slice(0, 3)).toEqual([IMAGE_PULL_FALLBACK_SCRIPT, '--step', 'db-backup stats']);
    expect(stats.args.slice(stats.args.indexOf('--') + 1, stats.args.indexOf('--') + 3)).toEqual(['bash', '-c']);
    expect(stats.args.join(' ')).toContain(`\${SUPABASE_INTERNAL_IMAGE_REGISTRY:-${DEFAULT_IMAGE_REGISTRY}}/${PG_IMAGE_REPOSITORY}:\${PG_IMAGE_TAG}`);
    expect(stats.options.env).toMatchObject({ PGPASSWORD: FAKE_DB_PASSWORD });
    for (const label of ['roles', 'schema', 'data']) {
      const dump = runner.calls.find((c) => c.kind === `dump ${label}`)!;
      expect(dump.args.slice(0, 4)).toEqual([IMAGE_PULL_FALLBACK_SCRIPT, '--step', `db-backup dump ${label}`, '--']);
      expect(dump.args).toContain(`supabase@${SUPABASE_CLI_VERSION}`);
      expect(dump.args).toContain('--linked');
      if (label === 'data') {
        expect(argAfter(dump.args, '-s')).toBe('public,auth,storage');
        expect(dump.args.filter((a, i) => dump.args[i - 1] === '-x')).toEqual([...DUMP_EXCLUDED_TABLES]);
      } else {
        expect(dump.args).not.toContain('-s');
      }
    }
  });

  it('パスワード・鍵・接続先・details の JSON をコマンドラインに載せない (env で渡す)', async () => {
    const runner = fakeRunner();
    const { deps: d } = deps(runner);
    await runBackup({ tier: 'auto' }, d);
    const pooler = fs.readFileSync(path.join(ROOT, SUPABASE_TEMP_POOLER_URL_FILE), 'utf8').trim();
    for (const call of runner.calls) {
      const argv = call.args.join(' ');
      for (const secret of [FAKE_DB_PASSWORD, FAKE_SECRET, FAKE_ACCESS_KEY, pooler, '{"tier"']) expect(argv).not.toContain(secret);
    }
  });

  it('catalog の段: 段の順が dump → catalog → verify、psql の本文・cwd・env・stdoutFile・python3 の argv', async () => {
    const runner = fakeRunner();
    const { deps: d } = deps(runner);
    await runBackup({ tier: 'auto' }, d);
    const pooler = fs.readFileSync(path.join(ROOT, SUPABASE_TEMP_POOLER_URL_FILE), 'utf8').trim();
    const catalog = runner.calls.find((c) => c.kind === 'psql:catalog')!;
    expect(catalog.args).toEqual(['-c', PSQL_SCRIPTS.catalog]);
    const work = path.dirname(catalog.options.cwd as string);
    expect(catalog.options.cwd).toBe(path.join(work, 'catalog'));
    expect(catalog.options.env).toMatchObject({ PSQL_FILE: path.resolve(CATALOG_SNAPSHOT_SQL), PG_URL: `${pooler}${REMOTE_PG_SSLMODE_QUERY}`, PGPASSWORD: FAKE_DB_PASSWORD });
    const ledger = runner.calls.find((c) => c.kind === 'psql:ledger')!;
    expect(ledger.args).toEqual(['-c', PSQL_SCRIPTS.count]);
    expect(ledger.options.stdoutFile).toBe(path.join(work, 'ledger.txt'));
    const cron = runner.calls.find((c) => c.kind === 'psql:cron')!;
    expect(cron.options.stdoutFile).toBe(path.join(work, 'cron_jobs.sql'));
    const fixups = runner.calls.find((c) => c.kind === 'python:fixups')!;
    expect(fixups.args).toEqual([RESTORE_FIXUPS_BUILDER_SCRIPT, path.join(work, 'catalog'), path.join(work, 'schema.sql'), path.join(work, 'fixups.sql')]);
    for (const c of [catalog, ledger, cron, fixups]) expect(c.options.timeoutMs).toBe(STAGE_TIMEOUT_MINUTES.catalog * MS_PER_MINUTE);
    const archive = runner.calls.find((c) => c.kind === 'archive')!;
    expect(archive.args.slice(-ARCHIVE_ENTRIES.length)).toEqual([...ARCHIVE_ENTRIES]);
    expect(archive.args).toContain(`-${ZSTD_LEVEL}`);
  });

  it('manifest の ledger と cron_jobs が偽の ledger.txt / cron_jobs.sql の数', async () => {
    let manifest: Record<string, unknown> | null = null;
    const runner = fakeRunner((call) => {
      if (call.kind === 'aws:cp' && call.args[2].endsWith('.manifest.json')) manifest = JSON.parse(fs.readFileSync(call.args[2], 'utf8'));
      return undefined;
    });
    const { deps: d } = deps(runner);
    await runBackup({ tier: 'auto' }, d);
    expect(manifest).toMatchObject({
      schema_version: MANIFEST_SCHEMA_VERSION, ledger: { versions_count: 2, max_version: REAL_VERSIONS[1] }, cron_jobs: 2, dumped: DUMPED,
      source: { public_tables: 136, auth_users: 195, db_size_bytes: 2500000000 }, age_recipient: FAKE_RECIPIENT, data_schemas: ['public', 'auth', 'storage'],
    });
  });

  it('zstd のレベルの上書き・dump / upload の時間の上書きが子に効く', async () => {
    const runner = fakeRunner();
    const { deps: d } = deps(runner, { env: { ...FAKE_ENV, BACKUP_ZSTD_LEVEL: '9', BACKUP_DUMP_TIMEOUT_MINUTES: '240', BACKUP_UPLOAD_TIMEOUT_MINUTES: '90' } });
    await runBackup({ tier: 'auto' }, d);
    expect(runner.calls.find((c) => c.kind === 'archive')!.args).toContain('-9');
    for (const c of runner.calls.filter((x) => x.kind.startsWith('dump '))) expect(c.options.timeoutMs).toBe(240 * MS_PER_MINUTE);
    for (const c of runner.calls.filter((x) => x.kind === 'aws:cp')) expect(c.options.timeoutMs).toBe(90 * MS_PER_MINUTE);
  });

  it('aws を呼ぶすべての回の env が awsCommandEnv(偽の env) と同じで、argv の最後が endpoint と region', async () => {
    const runner = fakeRunner();
    const { deps: d } = deps(runner, { now: MONDAY });
    await runBackup({ tier: 'auto' }, d);
    const awsCalls = runner.calls.filter((c) => c.cmd === 'aws');
    expect(awsCalls.length).toBeGreaterThan(0);
    for (const call of awsCalls) {
      expect(call.options.env).toEqual(awsCommandEnv(FAKE_ENV));
      expect(call.args.slice(-4)).toEqual(['--endpoint-url', 'https://acc123.r2.cloudflarestorage.com', '--region', 'auto']);
    }
    expect(awsCalls.some((c) => c.args.join(' ').includes('s3://fake-bucket/daily/'))).toBe(true);
    const list = awsCalls.filter((c) => c.kind === 'aws:list');
    expect(list.map((c) => c.args.slice(0, 11))).toEqual(
      BACKUP_TIERS.map((t) => ['s3api', 'list-objects-v2', '--bucket', 'fake-bucket', '--prefix', `${t}/`, '--no-paginate', '--query', 'KeyCount', '--output', 'text']),
    );
  });

  it('月曜: copy は手元のファイルを weekly のキーへ送り (--copy-props 無し)、head-object 3 回、復元の検査をして 2 行', async () => {
    const audit = captureAudit();
    const runner = fakeRunner(audit.override);
    const { deps: d } = deps(runner, { now: MONDAY });
    const r = await runBackup({ tier: 'auto' }, d);
    expect(r).toMatchObject({ exitCode: 0, completed: ['daily', 'weekly'] });
    const plan = planRun({ now: MONDAY, tierOverride: 'auto' });
    const weeklyCp = runner.calls.filter((c) => c.kind === 'aws:cp' && c.args[3].includes('/weekly/'));
    expect(weeklyCp).toHaveLength(3);
    for (const [i, suffix] of ['.tar.zst.age', '.sha256', '.manifest.json'].entries()) {
      expect(weeklyCp[i].args[2].startsWith('s3://')).toBe(false);
      expect(weeklyCp[i].args[2].endsWith(`${plan.basename}${suffix}`)).toBe(true);
      expect(weeklyCp[i].args[3]).toBe(`s3://fake-bucket/weekly/2026-10-19/${plan.basename}${suffix}`);
      expect(weeklyCp[i].args).not.toContain('--copy-props');
    }
    const weeklyHeads = runner.calls.filter((c) => c.kind === 'aws:head' && argAfter(c.args, '--key').startsWith('weekly/'));
    expect(weeklyHeads.map((c) => argAfter(c.args, '--key'))).toEqual(Object.values(plan.keys.weekly));
    const rows = audit.rows();
    expect(rows.map((x) => x.action)).toEqual(['backup.daily.completed', 'backup.weekly.completed']);
    expect(rows[1].details).toMatchObject({
      copied_from: plan.keys.daily.archive,
      restore_check: { result: 'passed', catalog_errors: 0, catalog_warnings: 1, ledger_versions: 2, cron_jobs: 2, ...DUMPED },
    });
  });

  it('run の restore_check の段: 子プロセスの順・reset.sql の中身・verify の引数・枠 0・cron_jobs.sql を psql に渡さない', async () => {
    let resetSql = '';
    const runner = fakeRunner((call) => {
      if (call.kind === 'psql:reset') resetSql = fs.readFileSync(call.options.env?.PSQL_FILE as string, 'utf8');
      return undefined;
    });
    const { deps: d, logs } = deps(runner, { now: MONDAY });
    await runBackup({ tier: 'auto' }, d);
    const tail = kinds(runner.calls).slice(kinds(runner.calls).indexOf('psql:version'));
    expect(tail).toEqual([
      'psql:version', 'python:version', 'local:start', 'local:env', 'psql:reset', 'psql:roles', 'psql:restore', 'psql:fixups',
      'psql:count', 'psql:restored-catalog', 'python:verify', 'psql:audit',
    ]);
    expect(resetSql).toContain(RESET_STORAGE_POLICIES_SQL);
    expect(resetSql).toContain('TRUNCATE "auth"."users" CASCADE;');
    const work = path.dirname(runner.calls.find((c) => c.kind === 'psql:catalog')!.options.cwd as string);
    expect(runner.calls.find((c) => c.kind === 'python:verify')!.args).toEqual([CATALOG_VERIFY_SCRIPT, path.join(work, 'catalog'), path.join(work, 'restored-catalog')]);
    expect(runner.calls.find((c) => c.kind === 'psql:roles')!.options.stderrFile).toBeTruthy();
    for (const c of runner.calls.filter((x) => x.kind.startsWith('local:'))) expect(c.options.env).toEqual({ [LOCAL_SLOT_ENV]: '0' });
    for (const c of runner.calls) expect(c.options.env?.PSQL_FILE ?? '').not.toMatch(/cron_jobs\.sql$/);
    const restoreTimeout = STAGE_TIMEOUT_MINUTES.restore_check * MS_PER_MINUTE;
    for (const c of runner.calls.slice(runner.calls.findIndex((x) => x.kind === 'psql:version'), -1)) expect(c.options.timeoutMs).toBe(restoreTimeout);
    expect(logs.join('\n')).not.toContain('[warn]');
    expect(logs.join('\n')).toContain('verify_baseline: errors=0 warnings=1');
    expect(logs.join('\n')).toContain('auth・storage の表のアプリのトリガー 4 本が取得の時点と同じ');
  });

  it('restore_check の失敗: fixups 1 → restore_check_failed / verify_baseline 1 → catalog_errors / 要約の行が無い / 台帳 / cron の数', async () => {
    const cases: Array<{ override: Override; reason: string }> = [
      { override: (c) => (c.kind === 'psql:fixups' ? { code: 1, stdout: '', stderrTail: '' } : undefined), reason: 'restore_check_failed' },
      { override: (c) => (c.kind === 'python:verify' ? { code: 1, stdout: '[verify] errors=2 warnings=0\n', stderrTail: '' } : undefined), reason: 'restore_check_failed' },
      { override: (c) => (c.kind === 'python:verify' ? { code: 0, stdout: 'nothing\n', stderrTail: '' } : undefined), reason: 'restore_check_failed' },
      {
        override: (c) => {
          if (c.kind === 'psql:ledger') {
            fs.writeFileSync(c.options.stdoutFile as string, '19990101000000\n');
            return OK;
          }
          return undefined;
        },
        reason: 'restore_check_failed',
      },
      { override: (c) => (c.kind === 'psql:count' ? { code: 0, stdout: '2|9|1', stderrTail: '' } : undefined), reason: 'restore_check_failed' },
      { override: (c) => (c.kind === 'psql:count' ? { code: 0, stdout: 'garbage', stderrTail: '' } : undefined), reason: 'restore_check_failed' },
      // 復元した DB に auth のアプリのトリガーが 1 本足りない (verify_baseline.py は errors=0 のまま。#1757 との取り込みの指摘)
      {
        override: (c) =>
          c.kind === 'psql:restored-catalog' ? (writeCatalog(c.options.cwd as string, [], triggersCsv(AUTH_APP_TRIGGERS.slice(1))), OK) : undefined,
        reason: 'restore_check_failed',
      },
      // 復元した DB のトリガーの CSV が書かれない
      {
        override: (c) => (c.kind === 'psql:restored-catalog' ? (writeCatalog(c.options.cwd as string, [AUTH_STORAGE_TRIGGERS_CSV]), OK) : undefined),
        reason: 'restore_check_failed',
      },
      { override: (c) => (c.kind === 'psql:reset' ? { code: 1, stdout: '', stderrTail: '' } : undefined), reason: 'restore_check_failed' },
      {
        override: (c) => (c.kind === 'psql:roles' ? (fs.writeFileSync(c.options.stderrFile as string, 'ERROR:  42501\n'), OK) : undefined),
        reason: 'restore_check_failed',
      },
      { override: (c) => (c.kind === 'local:start' ? { code: IMAGE_PULL_UNAVAILABLE_EXIT_CODE, stdout: '', stderrTail: '' } : undefined), reason: 'image_pull_unavailable' },
      { override: (c) => (c.kind === 'local:env' ? { code: 0, stdout: 'X=1\n', stderrTail: '' } : undefined), reason: 'restore_env_failed' },
    ];
    for (const { override, reason } of cases) {
      const audit = captureAudit();
      const runner = fakeRunner((c) => override(c) ?? audit.override(c));
      const { deps: d } = deps(runner, { now: MONDAY });
      const r = await runBackup({ tier: 'auto' }, d);
      expect(r.exitCode).toBe(1);
      expect(r.completed).toEqual(['daily']);
      expect(r.failed).toEqual([{ tier: 'weekly', stage: 'restore_check', reason }]);
      const rows = audit.rows();
      expect(rows.map((x) => x.action)).toEqual(['backup.daily.completed', 'backup.weekly.failed']);
      expect(rows[1].details).toMatchObject({ stage: 'restore_check', reason });
    }
  });

  it('restore_check のトリガー: 足りない名前をログに出し、監査行の weekly は failed・内部のトリガーだけの差は passed で名前をログに出す', async () => {
    const missing = fakeRunner((c) =>
      c.kind === 'psql:restored-catalog' ? (writeCatalog(c.options.cwd as string, [], triggersCsv(AUTH_APP_TRIGGERS.slice(1))), OK) : undefined,
    );
    const { deps: d1, logs: l1 } = deps(missing, { now: MONDAY });
    const r1 = await runBackup({ tier: 'auto' }, d1);
    expect(r1.failed).toEqual([{ tier: 'weekly', stage: 'restore_check', reason: 'restore_check_failed' }]);
    expect(l1.join('\n')).toContain('アプリのトリガーが合いません: 無い auth.sessions.on_auth_session_created・余分 (なし)・定義が違う (なし)');
    const internal = fakeRunner((c) =>
      c.kind === 'psql:restored-catalog'
        ? (writeCatalog(c.options.cwd as string, [], triggersCsv(AUTH_APP_TRIGGERS, STORAGE_INTERNAL_TRIGGER_ROWS.slice(1))), OK)
        : undefined,
    );
    const { deps: d2, logs: l2 } = deps(internal, { now: MONDAY });
    const r2 = await runBackup({ tier: 'auto' }, d2);
    expect(r2.exitCode).toBe(0);
    expect(l2.join('\n')).toMatch(/内部のトリガーの差 \(スタックの版の差。落とさない\): storage\./);
  });

  it('psql --version が 127 → restore_env_failed で supabase-local.sh start を呼ばない・python3 --version が 127 も同じ', async () => {
    for (const kind of ['psql:version', 'python:version']) {
      const runner = fakeRunner((c) => (c.kind === kind ? { code: COMMAND_NOT_FOUND_EXIT_CODE, stdout: '', stderrTail: '' } : undefined));
      const { deps: d } = deps(runner, { now: MONDAY });
      const r = await runBackup({ tier: 'auto' }, d);
      expect(r.failed).toEqual([{ tier: 'weekly', stage: 'restore_check', reason: 'restore_env_failed' }]);
      expect(kinds(runner.calls)).not.toContain('local:start');
    }
  });

  it('偽の stats を 1 ずらしても restore_check は dumped と比べて passed (live の数は記録だけ)', async () => {
    const audit = captureAudit();
    const runner = fakeRunner((c) => {
      if (c.kind === 'stats') {
        fs.writeFileSync(argAfter(c.args, '--stdout'), '137|196|1\n');
        return OK;
      }
      return audit.override(c);
    });
    const { deps: d } = deps(runner, { now: MONDAY });
    const r = await runBackup({ tier: 'auto' }, d);
    expect(r.exitCode).toBe(0);
    expect(audit.rows()[0].details).toMatchObject({ public_tables: 2, auth_users: 1 });
  });

  it('copy の失敗: head の大きさが違う → weekly だけ copy_failed・時間切れ → timeout・restore_check をしない', async () => {
    const mismatch = fakeRunner((c) =>
      c.kind === 'aws:head' && argAfter(c.args, '--key').startsWith('weekly/') ? { code: 0, stdout: '{"ContentLength": 1}', stderrTail: '' } : undefined,
    );
    const r1 = await runBackup({ tier: 'auto' }, deps(mismatch, { now: MONDAY }).deps);
    expect(r1).toMatchObject({ exitCode: 1, completed: ['daily'], failed: [{ tier: 'weekly', stage: 'copy', reason: 'copy_failed' }] });
    expect(kinds(mismatch.calls)).not.toContain('local:start');
    const timeout = fakeRunner((c) => {
      if (c.kind === 'aws:cp' && c.args[3].includes('/weekly/')) throw new CommandTimeoutError('aws', 1);
      return undefined;
    });
    const r2 = await runBackup({ tier: 'auto' }, deps(timeout, { now: MONDAY }).deps);
    expect(r2.failed).toEqual([{ tier: 'weekly', stage: 'copy', reason: 'timeout' }]);
    const failed = fakeRunner((c) => (c.kind === 'aws:cp' && c.args[3].includes('/weekly/') ? { code: 1, stdout: '', stderrTail: '' } : undefined));
    const r3 = await runBackup({ tier: 'auto' }, deps(failed, { now: MONDAY }).deps);
    expect(r3.failed).toEqual([{ tier: 'weekly', stage: 'copy', reason: 'copy_failed' }]);
  });

  it('1/1 が月曜で weekly の copy だけ失敗 → restore_check を 1 回・daily completed・weekly failed (copy)・annual completed (restore_check)', async () => {
    const audit = captureAudit();
    const runner = fakeRunner((c) => {
      if (c.kind === 'aws:cp' && c.args[3].includes('/weekly/')) return { code: 1, stdout: '', stderrTail: '' };
      return audit.override(c);
    });
    const r = await runBackup({ tier: 'auto' }, deps(runner, { now: NEW_YEAR_MONDAY }).deps);
    expect(r.completed).toEqual(['daily', 'annual']);
    expect(kinds(runner.calls).filter((k) => k === 'local:start')).toHaveLength(1);
    const rows = audit.rows();
    expect(rows.map((x) => x.action)).toEqual(['backup.daily.completed', 'backup.weekly.failed', 'backup.annual.completed']);
    expect(rows[1].details).toMatchObject({ stage: 'copy', reason: 'copy_failed' });
    expect(rows[2].details).toHaveProperty('restore_check');
  });

  it('1/1 (金) は annual を annual/<年>/ に送る', async () => {
    const runner = fakeRunner();
    const r = await runBackup({ tier: 'auto' }, deps(runner, { now: NEW_YEAR_FRIDAY }).deps);
    expect(r.completed).toEqual(['daily', 'annual']);
    expect(runner.calls.some((c) => c.kind === 'aws:cp' && c.args[3].includes('/annual/2027/'))).toBe(true);
  });

  it('config で止まる: dump を呼ばず、audit は failed (missing の名前)、終了 3', async () => {
    const audit = captureAudit();
    const runner = fakeRunner(audit.override);
    const r = await runBackup({ tier: 'auto' }, deps(runner, { env: { ...FAKE_ENV, BACKUP_R2_ACCESS_KEY_ID: '' } }).deps);
    expect(r).toMatchObject({ exitCode: 3, completed: [], auditWritten: true });
    expect(r.failed).toEqual([{ tier: 'daily', stage: 'config', reason: 'not_configured', missing: ['BACKUP_R2_ACCESS_KEY_ID'] }]);
    expect(kinds(runner.calls)).toEqual(['link', 'psql:audit']);
    expect(audit.rows()[0]).toMatchObject({ action: 'backup.daily.failed', details: { stage: 'config', reason: 'not_configured', missing: ['BACKUP_R2_ACCESS_KEY_ID'] } });
  });

  it('config の失敗のあと audit も失敗 → 終了 3 で failures に config と audit', async () => {
    const runner = fakeRunner((c) => (c.kind === 'psql:audit' ? { code: 1, stdout: '', stderrTail: '' } : undefined));
    const r = await runBackup({ tier: 'auto' }, deps(runner, { env: { ...FAKE_ENV, BACKUP_R2_BUCKET: '' } }).deps);
    expect(r.exitCode).toBe(3);
    expect(r.failed.map((f: { stage: string }) => f.stage)).toEqual(['config', 'audit']);
    expect(r.auditWritten).toBe(false);
  });

  it('link の失敗は audit を呼ばず終了 1', async () => {
    const runner = fakeRunner((c) => (c.kind === 'link' ? { code: 1, stdout: '', stderrTail: '' } : undefined));
    const r = await runBackup({ tier: 'auto' }, deps(runner).deps);
    expect(r).toMatchObject({ exitCode: 1, completed: [], auditWritten: false, failed: [{ tier: 'daily', stage: 'link', reason: 'link_failed' }] });
    expect(kinds(runner.calls)).toEqual(['link']);
  });

  it('audit の psql が 1 → failures に全層の {audit, audit_failed}・completed は残る・時間切れは timeout', async () => {
    const runner = fakeRunner((c) => (c.kind === 'psql:audit' ? { code: 1, stdout: '', stderrTail: '' } : undefined));
    const r = await runBackup({ tier: 'auto' }, deps(runner, { now: MONDAY }).deps);
    expect(r).toMatchObject({ exitCode: 1, completed: ['daily', 'weekly'], auditWritten: false });
    expect(r.failed).toEqual([{ tier: 'daily', stage: 'audit', reason: 'audit_failed' }, { tier: 'weekly', stage: 'audit', reason: 'audit_failed' }]);
    const timeout = fakeRunner((c) => {
      if (c.kind === 'psql:audit') throw new CommandTimeoutError('bash', 1);
      return undefined;
    });
    const r2 = await runBackup({ tier: 'auto' }, deps(timeout).deps);
    expect(r2.failed).toEqual([{ tier: 'daily', stage: 'audit', reason: 'timeout' }]);
  });

  it('audit: 1 回の psql で全層・env に PG_URL・PGPASSWORD・PSQL_FILE・時間の上限', async () => {
    const runner = fakeRunner();
    await runBackup({ tier: 'auto' }, deps(runner, { now: MONDAY }).deps);
    const audits = runner.calls.filter((c) => c.kind === 'psql:audit');
    expect(audits).toHaveLength(1);
    expect(audits[0].args).toEqual(['-c', PSQL_SCRIPTS.audit]);
    const pooler = fs.readFileSync(path.join(ROOT, SUPABASE_TEMP_POOLER_URL_FILE), 'utf8').trim();
    expect(audits[0].options.env).toMatchObject({ PG_URL: `${pooler}${REMOTE_PG_SSLMODE_QUERY}`, PGPASSWORD: FAKE_DB_PASSWORD });
    expect(audits[0].options.env?.PSQL_FILE).toMatch(/audit\.sql$/);
    expect(audits[0].options.timeoutMs).toBe(STAGE_TIMEOUT_MINUTES.audit * MS_PER_MINUTE);
  });

  it('dump の段で TypeError → 全層 failed (dump, unknown)・aws を呼ばない・audit は呼ぶ・reject しない', async () => {
    const runner = fakeRunner((c) => {
      if (c.kind === 'dump schema') throw new TypeError('boom');
      return undefined;
    });
    const r = await runBackup({ tier: 'auto' }, deps(runner, { now: MONDAY }).deps);
    expect(r.failed).toEqual([{ tier: 'daily', stage: 'dump', reason: 'unknown' }, { tier: 'weekly', stage: 'dump', reason: 'unknown' }]);
    expect(runner.calls.some((c) => c.cmd === 'aws')).toBe(false);
    expect(kinds(runner.calls)).toContain('psql:audit');
  });

  it('dump が 75 → image_pull_unavailable・stats が 75 → dump を呼ばない', async () => {
    const dump = fakeRunner((c) => (c.kind === 'dump data' ? { code: IMAGE_PULL_UNAVAILABLE_EXIT_CODE, stdout: '', stderrTail: '' } : undefined));
    const r1 = await runBackup({ tier: 'auto' }, deps(dump).deps);
    expect(r1).toMatchObject({ exitCode: 1, failed: [{ tier: 'daily', stage: 'dump', reason: 'image_pull_unavailable' }] });
    expect(dump.calls.some((c) => c.cmd === 'aws')).toBe(false);
    const stats = fakeRunner((c) => (c.kind === 'stats' ? { code: IMAGE_PULL_UNAVAILABLE_EXIT_CODE, stdout: '', stderrTail: '' } : undefined));
    const r2 = await runBackup({ tier: 'auto' }, deps(stats).deps);
    expect(r2.failed).toEqual([{ tier: 'daily', stage: 'stats', reason: 'image_pull_unavailable' }]);
    expect(kinds(stats.calls).some((k) => k.startsWith('dump'))).toBe(false);
  });

  it('catalog の失敗: カタログの psql 1・cron の psql 1・python3 127・CSV を 1 つ書かない → catalog_failed で aws を呼ばない', async () => {
    const overrides: Override[] = [
      (c) => (c.kind === 'psql:catalog' ? { code: 1, stdout: '', stderrTail: '' } : undefined),
      (c) => (c.kind === 'psql:cron' ? { code: 1, stdout: '', stderrTail: '' } : undefined),
      (c) => (c.kind === 'python:fixups' ? { code: COMMAND_NOT_FOUND_EXIT_CODE, stdout: '', stderrTail: '' } : undefined),
      (c) => {
        if (c.kind === 'psql:catalog') {
          writeCatalog(c.options.cwd as string, ['catalog_publication.csv']);
          return OK;
        }
        return undefined;
      },
    ];
    for (const override of overrides) {
      const runner = fakeRunner(override);
      const r = await runBackup({ tier: 'auto' }, deps(runner).deps);
      expect(r.failed).toEqual([{ tier: 'daily', stage: 'catalog', reason: 'catalog_failed' }]);
      expect(runner.calls.some((c) => c.cmd === 'aws')).toBe(false);
      expect(kinds(runner.calls)).toContain('psql:audit');
    }
  });

  it('verify で落ちると aws を呼ばない (details に expected / actual)', async () => {
    const audit = captureAudit();
    const runner = fakeRunner((c) => {
      if (c.kind === 'dump data') {
        fs.writeFileSync(argAfter(c.args, '-f'), DATA_SQL.replace('RESET ALL;\n', ''));
        return OK;
      }
      return audit.override(c);
    });
    const r = await runBackup({ tier: 'auto' }, deps(runner).deps);
    expect(r.failed).toEqual([{ tier: 'daily', stage: 'verify', reason: 'dump_incomplete' }]);
    expect(runner.calls.some((c) => c.cmd === 'aws')).toBe(false);
    expect(audit.rows()[0].details).toMatchObject({ expected: 2, actual: 2 });
  });

  it('upload の大きさが違う → upload_size_mismatch・送信の失敗 → upload_failed', async () => {
    const mismatch = fakeRunner((c) => (c.kind === 'aws:head' ? { code: 0, stdout: '{"ContentLength": 0}', stderrTail: '' } : undefined));
    expect((await runBackup({ tier: 'auto' }, deps(mismatch).deps)).failed).toEqual([{ tier: 'daily', stage: 'upload', reason: 'upload_size_mismatch' }]);
    const failed = fakeRunner((c) => (c.kind === 'aws:cp' ? { code: 255, stdout: '', stderrTail: '' } : undefined));
    expect((await runBackup({ tier: 'auto' }, deps(failed).deps)).failed).toEqual([{ tier: 'daily', stage: 'upload', reason: 'upload_failed' }]);
  });

  it('inventory の失敗は completed のまま終了 0 (警告)', async () => {
    const runner = fakeRunner((c) => (c.kind === 'aws:list' ? { code: 1, stdout: '', stderrTail: '' } : undefined));
    const r = await runBackup({ tier: 'auto' }, deps(runner).deps);
    expect(r).toMatchObject({ exitCode: 0, completed: ['daily'], warnings: [{ stage: 'inventory', reason: 'inventory_failed' }] });
  });

  it('cleanup: 一時ディレクトリを成功でも失敗でも消す', async () => {
    for (const override of [undefined, ((c: Call) => (c.kind === 'archive' ? { code: 1, stdout: '', stderrTail: '' } : undefined)) as Override]) {
      const runner = fakeRunner(override);
      const work = path.join(tempDir('backup-work-'), 'w');
      await runBackup({ tier: 'auto' }, { ...deps(runner).deps, workDir: work });
      expect(fs.existsSync(work)).toBe(false);
    }
  });

  it('監査行の details に stderr の文・接続先を含まない', async () => {
    const audit = captureAudit();
    const runner = fakeRunner((c) => (c.kind === 'aws:cp' ? { code: 1, stdout: '', stderrTail: 'secret-ish error postgresql://x' } : audit.override(c)));
    await runBackup({ tier: 'auto' }, deps(runner).deps);
    const json = JSON.stringify(audit.rows());
    expect(json).not.toContain('secret-ish');
    expect(json).not.toContain('postgresql://');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// restoreFromArchive (偽の run)
// ───────────────────────────────────────────────────────────────────────────

const RESTORE_KEY = 'daily/2026-10-13/homegohan-db-20261012T172300Z.tar.zst.age';
const RESTORE_ENV: Record<string, string | undefined> = {
  BACKUP_R2_ACCOUNT_ID: 'acc123', BACKUP_R2_BUCKET: 'fake-bucket', BACKUP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, BACKUP_R2_SECRET_ACCESS_KEY: FAKE_SECRET,
};
const ARCHIVE_BYTES = 'ENCRYPTED-ARCHIVE';
const MANIFEST = { dumped: DUMPED, ledger: { versions_count: 2, max_version: REAL_VERSIONS[1] }, cron_jobs: 2 };

function restoreRunner(override: Override = () => undefined, options: { skipEntry?: string; sha?: string } = {}) {
  return fakeRunner((call) => {
    const o = override(call);
    if (o !== undefined) return o;
    if (call.kind === 'aws:download') {
      const dest = call.args[3];
      if (dest.endsWith('.tar.zst.age')) fs.writeFileSync(dest, ARCHIVE_BYTES);
      if (dest.endsWith('.sha256')) fs.writeFileSync(dest, `${options.sha ?? createHash('sha256').update(ARCHIVE_BYTES).digest('hex')}  x.tar.zst.age\n`);
      if (dest.endsWith('.manifest.json')) fs.writeFileSync(dest, JSON.stringify(MANIFEST));
      return OK;
    }
    if (call.kind === 'zstd') {
      fs.writeFileSync(argAfter(call.args, '-o'), 'TAR');
      return OK;
    }
    if (call.kind === 'tar') {
      const dir = argAfter(call.args, '-C');
      const files: Record<string, string> = {
        'roles.sql': 'x', 'schema.sql': SCHEMA_SQL, 'data.sql': DATA_SQL, 'fixups.sql': 'x', 'cron_jobs.sql': CRON_SQL, 'ledger.txt': LEDGER_TXT,
      };
      for (const [name, text] of Object.entries(files)) if (name !== options.skipEntry) fs.writeFileSync(path.join(dir, name), text);
      if (options.skipEntry !== 'catalog') writeCatalog(path.join(dir, 'catalog'));
      return OK;
    }
    return undefined;
  });
}

function restoreDeps(runner: ReturnType<typeof fakeRunner>, env = RESTORE_ENV) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    deps: { run: runner.run, env, now: () => TUESDAY, log: (l: string) => logs.push(l), logError: (l: string) => errors.push(l) },
    logs,
    errors,
  };
}

describe('restoreFromArchive', () => {
  const opts = { key: RESTORE_KEY, identityFile: '/home/owner/secret/backup.key', slot: 0 };

  it('成功: 段の順・終了 0・checks・stop を呼ばない・identity のパスをログに出さない', async () => {
    const runner = restoreRunner();
    const { deps: d, logs } = restoreDeps(runner);
    const r = await restoreFromArchive(opts, d);
    expect(r).toMatchObject({ ok: true, exitCode: 0, checks: { result: 'passed', cron_jobs: 2, ledger_versions: 2, catalog_errors: 0 } });
    expect(kinds(runner.calls)).toEqual([
      'aws:download', 'aws:download', 'aws:download', 'age', 'zstd', 'tar',
      'psql:version', 'python:version', 'local:start', 'local:env', 'psql:reset', 'psql:roles', 'psql:restore', 'psql:fixups',
      'psql:count', 'psql:restored-catalog', 'python:verify',
    ]);
    expect(kinds(runner.calls)).not.toContain('local:stop');
    expect(logs.join('\n')).not.toContain('/home/owner/secret');
    const verify = runner.calls.find((c) => c.kind === 'python:verify')!;
    expect(verify.args[1].endsWith(path.join('plain', 'catalog'))).toBe(true);
    expect(verify.args[2].endsWith('restored-catalog')).toBe(true);
    expect(runner.calls.find((c) => c.kind === 'psql:roles')!.options.stderrFile).toBeTruthy();
  });

  it('download の argv と env (awsCommandEnv)・鍵を argv に載せない', async () => {
    const runner = restoreRunner();
    await restoreFromArchive(opts, restoreDeps(runner).deps);
    const downloads = runner.calls.filter((c) => c.kind === 'aws:download');
    const keys = siblingKeys(RESTORE_KEY)!;
    expect(downloads.map((c) => c.args[2])).toEqual([keys.archive, keys.sha256, keys.manifest].map((k) => `s3://fake-bucket/${k}`));
    for (const c of downloads) {
      expect(c.args.slice(0, 2)).toEqual(['s3', 'cp']);
      expect(c.args.slice(-4)).toEqual(['--endpoint-url', 'https://acc123.r2.cloudflarestorage.com', '--region', 'auto']);
      expect(c.options.env).toEqual(awsCommandEnv(RESTORE_ENV));
      expect(c.args.join(' ')).not.toContain(FAKE_SECRET);
    }
  });

  it('config: 4 つのどれかが無い・空 → 終了 3 で何も呼ばず、名前を出して値を出さない・RECIPIENT が無くても通る・調整用 abc は 3', async () => {
    for (const name of RESTORE_REQUIRED_ENV_NAMES) {
      const runner = restoreRunner();
      const { deps: d, errors } = restoreDeps(runner, { ...RESTORE_ENV, [name]: '' });
      const r = await restoreFromArchive(opts, d);
      expect(r).toEqual({ ok: false, exitCode: 3, stage: 'config', reason: 'not_configured' });
      expect(runner.calls).toHaveLength(0);
      expect(errors.join('\n')).toContain(name);
      expect(errors.join('\n')).not.toContain(FAKE_SECRET);
    }
    const ok = await restoreFromArchive(opts, restoreDeps(restoreRunner(), { ...RESTORE_ENV, BACKUP_AGE_RECIPIENT: undefined }).deps);
    expect(ok.exitCode).toBe(0);
    const abc = await restoreFromArchive(opts, restoreDeps(restoreRunner(), { ...RESTORE_ENV, BACKUP_UPLOAD_TIMEOUT_MINUTES: 'abc' }).deps);
    expect(abc).toMatchObject({ exitCode: 3, stage: 'config' });
  });

  it('上限: download 90 分・start と reset 120 分・age は encrypt の値', async () => {
    const runner = restoreRunner();
    await restoreFromArchive(opts, restoreDeps(runner, { ...RESTORE_ENV, BACKUP_UPLOAD_TIMEOUT_MINUTES: '90', BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES: '120' }).deps);
    for (const c of runner.calls.filter((x) => x.kind === 'aws:download')) expect(c.options.timeoutMs).toBe(90 * MS_PER_MINUTE);
    for (const k of ['local:start', 'psql:reset']) expect(runner.calls.find((c) => c.kind === k)!.options.timeoutMs).toBe(120 * MS_PER_MINUTE);
    expect(runner.calls.find((c) => c.kind === 'age')!.options.timeoutMs).toBe(STAGE_TIMEOUT_MINUTES.encrypt * MS_PER_MINUTE);
  });

  it('失敗の段と reason', async () => {
    const cases: Array<{ runner: ReturnType<typeof fakeRunner>; stage: string; reason: string; notCalled?: string }> = [
      { runner: restoreRunner((c) => (c.kind === 'aws:download' ? { code: 1, stdout: '', stderrTail: '' } : undefined)), stage: 'download', reason: 'download_failed', notCalled: 'age' },
      {
        runner: restoreRunner((c) => {
          if (c.kind === 'aws:download') throw new CommandTimeoutError('aws', 1);
          return undefined;
        }),
        stage: 'download', reason: 'timeout', notCalled: 'age',
      },
      { runner: restoreRunner(undefined, { sha: 'ab'.repeat(32) }), stage: 'checksum', reason: 'checksum_mismatch', notCalled: 'age' },
      { runner: restoreRunner((c) => (c.kind === 'age' ? { code: 1, stdout: '', stderrTail: '' } : undefined)), stage: 'decrypt', reason: 'decrypt_failed', notCalled: 'local:start' },
      {
        runner: restoreRunner((c) => {
          if (c.kind === 'age') throw new CommandTimeoutError('age', 1);
          return undefined;
        }),
        stage: 'decrypt', reason: 'timeout',
      },
      { runner: restoreRunner((c) => (c.kind === 'zstd' ? { code: 1, stdout: '', stderrTail: '' } : undefined)), stage: 'extract', reason: 'extract_failed' },
      { runner: restoreRunner((c) => (c.kind === 'tar' ? { code: 2, stdout: '', stderrTail: '' } : undefined)), stage: 'extract', reason: 'extract_failed' },
      { runner: restoreRunner(undefined, { skipEntry: 'fixups.sql' }), stage: 'extract', reason: 'extract_failed', notCalled: 'local:start' },
      { runner: restoreRunner(undefined, { skipEntry: 'cron_jobs.sql' }), stage: 'extract', reason: 'extract_failed', notCalled: 'local:start' },
      { runner: restoreRunner((c) => (c.kind === 'local:start' ? { code: IMAGE_PULL_UNAVAILABLE_EXIT_CODE, stdout: '', stderrTail: '' } : undefined)), stage: 'restore_env', reason: 'image_pull_unavailable' },
      { runner: restoreRunner((c) => (c.kind === 'psql:version' ? { code: COMMAND_NOT_FOUND_EXIT_CODE, stdout: '', stderrTail: '' } : undefined)), stage: 'restore_env', reason: 'restore_env_failed', notCalled: 'local:start' },
      { runner: restoreRunner((c) => (c.kind === 'psql:fixups' ? { code: 1, stdout: '', stderrTail: '' } : undefined)), stage: 'restore', reason: 'restore_check_failed', notCalled: 'psql:count' },
      {
        runner: restoreRunner((c) => (c.kind === 'psql:roles' ? (fs.writeFileSync(c.options.stderrFile as string, 'ERROR:  42501\n'), OK) : undefined)),
        stage: 'restore', reason: 'restore_check_failed', notCalled: 'psql:restore',
      },
      { runner: restoreRunner((c) => (c.kind === 'psql:count' ? { code: 0, stdout: 'bad', stderrTail: '' } : undefined)), stage: 'restore_check', reason: 'restore_check_failed' },
      { runner: restoreRunner((c) => (c.kind === 'psql:count' ? { code: 0, stdout: '2|1|5', stderrTail: '' } : undefined)), stage: 'restore_check', reason: 'restore_check_failed' },
      { runner: restoreRunner((c) => (c.kind === 'python:verify' ? { code: 1, stdout: '[error] x\n[verify] errors=1 warnings=0\n', stderrTail: '' } : undefined)), stage: 'restore_check', reason: 'restore_check_failed' },
      {
        runner: restoreRunner((c) =>
          c.kind === 'psql:restored-catalog' ? (writeCatalog(c.options.cwd as string, [], triggersCsv(AUTH_APP_TRIGGERS.slice(0, -1))), OK) : undefined,
        ),
        stage: 'restore_check', reason: 'restore_check_failed', notCalled: 'psql:audit',
      },
    ];
    for (const { runner, stage, reason, notCalled } of cases) {
      const r = await restoreFromArchive(opts, restoreDeps(runner).deps);
      expect(r, `${stage}/${reason}`).toMatchObject({ ok: false, exitCode: 1, stage, reason });
      if (notCalled) expect(kinds(runner.calls)).not.toContain(notCalled);
    }
  });

  it('verify_baseline の [error] の行は手元なので出す・書庫の cron の数が manifest と違う → restore_check_failed', async () => {
    const runner = restoreRunner((c) => (c.kind === 'python:verify' ? { code: 1, stdout: '[error] function x acl\n[verify] errors=1 warnings=0\n', stderrTail: '' } : undefined));
    const { deps: d, logs } = restoreDeps(runner);
    await restoreFromArchive(opts, d);
    expect(logs.join('\n')).toContain('[error] function x acl');
    const cron = restoreRunner((c) => {
      if (c.kind === 'tar') {
        const dir = argAfter(c.args, '-C');
        for (const [name, text] of Object.entries({ 'roles.sql': 'x', 'schema.sql': SCHEMA_SQL, 'data.sql': DATA_SQL, 'fixups.sql': 'x', 'ledger.txt': LEDGER_TXT })) {
          fs.writeFileSync(path.join(dir, name), text);
        }
        fs.writeFileSync(path.join(dir, 'cron_jobs.sql'), `${CRON_SQL.split('\n')[0]}\n${CRON_SQL.split('\n')[2]}\n`);
        writeCatalog(path.join(dir, 'catalog'));
        return OK;
      }
      return undefined;
    });
    expect(await restoreFromArchive(opts, restoreDeps(cron).deps)).toMatchObject({ stage: 'restore_check', reason: 'restore_check_failed' });
  });

  it('枠 3 を渡すと supabase-local.sh の start と env に LOCAL_CI_SLOT=3', async () => {
    const runner = restoreRunner();
    await restoreFromArchive({ ...opts, slot: 3 }, restoreDeps(runner).deps);
    for (const k of ['local:start', 'local:env']) expect(runner.calls.find((c) => c.kind === k)!.options.env).toEqual({ [LOCAL_SLOT_ENV]: '3' });
  });

  it('失敗でも一時ディレクトリを消す', async () => {
    const runner = restoreRunner((c) => (c.kind === 'age' ? { code: 1, stdout: '', stderrTail: '' } : undefined));
    const work = path.join(tempDir('restore-work-'), 'w');
    await restoreFromArchive(opts, { ...restoreDeps(runner).deps, workDir: work });
    expect(fs.existsSync(work)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// runCli
// ───────────────────────────────────────────────────────────────────────────

describe('runCli', () => {
  const silent = { log: () => undefined, logError: () => undefined };

  it('run: runBackup が reject → 結果ファイルが unexpectedFailureReport で 1・一時ファイルを残さない', async () => {
    const dir = tempDir('cli-');
    const file = path.join(dir, 'r.json');
    const code = await runCli(['run', '--result-file', file], {
      ...silent, env: FAKE_ENV, now: () => TUESDAY,
      runBackup: async () => {
        throw new Error('bookkeeping bug');
      },
    });
    expect(code).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(unexpectedFailureReport({ jstDate: '2026-10-20' }));
    expect(fs.readdirSync(dir)).toEqual(['r.json']);
  });

  it('run: 成功なら toRunReport の中身・--result-file が無ければ書かない・引数の誤りは 2 で書かない', async () => {
    const dir = tempDir('cli-');
    const file = path.join(dir, 'r.json');
    const res = result({ exitCode: 0 });
    expect(await runCli(['run', '--result-file', file], { ...silent, env: FAKE_ENV, now: () => TUESDAY, runBackup: async () => res as never })).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(toRunReport(res as never));
    fs.rmSync(file);
    expect(await runCli(['run'], { ...silent, env: FAKE_ENV, now: () => TUESDAY, runBackup: async () => res as never })).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await runCli(['run', '--tier', 'x', '--result-file', file], { ...silent, env: FAKE_ENV })).toBe(2);
    expect(fs.existsSync(file)).toBe(false);
  });

  function fakeGithub(existing: Array<{ number: number; title: string; body: string }>, failOn?: string) {
    const ops: string[] = [];
    const guard = (op: string) => {
      ops.push(op);
      if (op === failOn) throw new Error(`gh failed token ${'Z9'.repeat(15)}`);
    };
    return {
      ops,
      github: {
        listOpenIssues: () => (guard('list'), existing),
        createIssue: () => (guard('create'), 101),
        updateIssue: () => guard('update'),
        closeIssue: () => guard('close'),
      },
    };
  }

  async function reportIssue(reportJson: string | null, outcome: string, gh: ReturnType<typeof fakeGithub>, env: Record<string, string | undefined> = { GITHUB_REPOSITORY: 'o/r' }) {
    const dir = tempDir('rep-');
    const file = path.join(dir, 'r.json');
    if (reportJson !== null) fs.writeFileSync(file, reportJson);
    const errors: string[] = [];
    const code = await runCli(['report-issue', '--result-file', file, '--run-outcome', outcome, '--run-url', 'https://x/run/1'], {
      env, github: gh.github, log: () => undefined, logError: (l: string) => errors.push(l),
    });
    return { code, errors };
  }

  it('report-issue: 問題ありで既存が無ければ create・あれば update・問題なしで既存があれば close', async () => {
    const failed = JSON.stringify(toRunReport(result({ exitCode: 1, failed: [{ tier: 'daily', stage: 'dump', reason: 'dump_failed' }] }) as never));
    const ok = JSON.stringify(toRunReport(result() as never));
    const marker = [{ number: 7, title: BACKUP_ISSUE_TITLE, body: `${BACKUP_ISSUE_MARKER}\nold` }];
    const create = fakeGithub([]);
    expect((await reportIssue(failed, 'failure', create)).code).toBe(0);
    expect(create.ops).toEqual(['list', 'create']);
    const update = fakeGithub(marker);
    expect((await reportIssue(failed, 'failure', update)).code).toBe(0);
    expect(update.ops).toEqual(['list', 'update']);
    const close = fakeGithub(marker);
    expect((await reportIssue(ok, 'success', close)).code).toBe(0);
    expect(close.ops).toEqual(['list', 'close']);
    const none = fakeGithub([]);
    expect((await reportIssue(ok, 'success', none)).code).toBe(0);
    expect(none.ops).toEqual(['list']);
    const missingFile = fakeGithub([]);
    await reportIssue(null, 'failure', missingFile);
    expect(missingFile.ops).toEqual(['list', 'create']);
  });

  it('report-issue: GITHUB_REPOSITORY が無い → 2 で github を呼ばない', async () => {
    const gh = fakeGithub([]);
    const { code } = await reportIssue(null, 'failure', gh, {});
    expect(code).toBe(2);
    expect(gh.ops).toEqual([]);
  });

  it('report-issue: 各操作の例外 → 1・操作の名前・伏せた文・後の操作を呼ばない', async () => {
    const failed = JSON.stringify(toRunReport(result({ exitCode: 1, failed: [{ tier: 'daily', stage: 'dump', reason: 'dump_failed' }] }) as never));
    const ok = JSON.stringify(toRunReport(result() as never));
    const marker = [{ number: 7, title: BACKUP_ISSUE_TITLE, body: BACKUP_ISSUE_MARKER }];
    const cases: Array<[string, string, Array<{ number: number; title: string; body: string }>, string]> = [
      ['list', failed, [], 'failure'],
      ['create', failed, [], 'failure'],
      ['update', failed, marker, 'failure'],
      ['close', ok, marker, 'success'],
    ];
    for (const [op, json, existing, outcome] of cases) {
      const gh = fakeGithub(existing, op);
      const { code, errors } = await reportIssue(json, outcome, gh);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(`(${op})`);
      expect(errors.join('\n')).not.toContain('Z9Z9Z9Z9');
      expect(gh.ops[gh.ops.length - 1]).toBe(op);
    }
  });

  it('r2-config: JSON を書き、wrangler の 4 行を出す', async () => {
    const dir = tempDir('r2-');
    const lines: string[] = [];
    expect(await runCli(['r2-config', '--bucket', 'homegohan-db-backups', '--out-dir', dir], { log: (l: string) => lines.push(l), logError: () => undefined })).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'r2-lifecycle.json'), 'utf8'))).toEqual(buildR2LifecycleConfig());
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('npx wrangler r2 bucket lock add homegohan-db-backups --name daily-30d --prefix daily/ --retention-days 30');
  });

  it('restore: --slot の誤りは 2・slot 3 は supabase-local.sh へ・run の restore_check は枠 0', async () => {
    expect(await runCli(['restore', '--key', RESTORE_KEY, '--identity-file', '/k', '--slot', '10'], silent)).toBe(2);
    const runner = restoreRunner();
    expect(await runCli(['restore', '--key', RESTORE_KEY, '--identity-file', '/k', '--slot', '3'], { ...silent, env: RESTORE_ENV, run: runner.run, now: () => TUESDAY })).toBe(0);
    expect(runner.calls.find((c) => c.kind === 'local:start')!.options.env).toEqual({ [LOCAL_SLOT_ENV]: '3' });
  });
});
