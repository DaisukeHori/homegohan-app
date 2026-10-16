/**
 * scripts/lib/backup-db.mjs
 *
 * #1129 / #1191 本番 DB の論理バックアップ (GitHub Actions の .github/workflows/db-backup.yml) の本体。
 * 設計の正典は docs/design/cross/17-backup-automation.md (§4・§5.1)。名前・引数・戻り値は §5.1 の宣言と同じにする。
 *
 * 入口 scripts/backup-db.mjs は `process.exitCode = await runCli(process.argv.slice(2))` の 1 行だけ。
 * サブコマンド:
 *   run            取得の 1 本道 (link → config → stats → dump → catalog → verify → archive → encrypt → upload → copy →
 *                  inventory → restore_check → audit → cleanup)。結果は --result-file に書く (report の step が読む)
 *   restore        オーナーが手元で R2 の書庫を取り出し、ローカルのスタックに復元して確かめる (監査行・Issue は作らない)
 *   roundtrip-local PR の往復の検査 (ローカルのスタックをダンプし、空にして戻し、同じになるかを見る)
 *   report-issue   run の結果ファイルと steps.run.outcome から Issue を作る・更新・閉じる
 *   r2-config      R2 の Lifecycle の JSON と wrangler のコマンドを作る (R2 には繋がない)
 *   help           使い方
 *
 * 外部コマンドの実行は CommandRunner で差し替えられる (単体テストは本物の supabase / aws / age / docker を呼ばない)。
 * 秘密 (DB パスワード・R2 の鍵) は argv に載せず env で渡し、ログ・結果ファイル・監査行・Issue には出さない (§4.10)。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { createGitHub } from '../consistency-check.mjs';
import { planIssueAction } from './consistency-check.mjs';

// ───────────────────────────────────────────────────────────────────────────
// 定数 (§5.1)
// ───────────────────────────────────────────────────────────────────────────

export const BACKUP_TIERS = Object.freeze(['daily', 'weekly', 'annual']);

/** 取得の予定 (UTC の cron 式) と、その JST の時刻。vercel.json ではなく .github/workflows/db-backup.yml に書く */
export const BACKUP_SCHEDULE_CRON_UTC = '23 17 * * *';
export const BACKUP_SCHEDULE_JST = '02:23';
/** weekly を作る曜日 (JST。0 = 日曜) と annual を作る月日 (JST) */
export const WEEKLY_WEEKDAY_JST = 1;
export const ANNUAL_MONTH_DAY_JST = '01-01';
/** 保持日数 (R2 の Lifecycle と bucket lock に同じ値を入れる。§4.1) */
export const RETENTION_DAYS = Object.freeze({ daily: 30, weekly: 366, annual: 2557 });
/** Infrequent Access へ移す日数 (R2 の IA の最短課金 30 日より前にしない) */
export const INFREQUENT_ACCESS_AFTER_DAYS = 30;
export const SECONDS_PER_DAY = 86_400;
/** bucket lock の Age 条件の秒数 (R2 の API の maxAgeSeconds の形)。RETENTION_DAYS から作る (手で書かない) */
export const LOCK_MAX_AGE_SECONDS = Object.freeze({
  daily: RETENTION_DAYS.daily * SECONDS_PER_DAY,
  weekly: RETENTION_DAYS.weekly * SECONDS_PER_DAY,
  annual: RETENTION_DAYS.annual * SECONDS_PER_DAY,
});
/** 途中で切れたマルチパートの送信を消すまでの日数 (Lifecycle の abort-multipart。1 回の取得の再試行の窓より十分長く、残骸の課金を 1 週で止める) */
export const R2_ABORT_MULTIPART_AFTER_DAYS = 7;

export const SUPABASE_CLI_VERSION = '2.62.10';
export const SUPABASE_PROJECT_REF = 'flmeolcfutuwwbjmzyoz';
/** Supabase の backup-restore の手順と同じ除外 (データのダンプから外す表) */
export const DUMP_EXCLUDED_TABLES = Object.freeze(['storage.buckets_vectors', 'storage.vector_indexes']);
/** データのダンプに入れるスキーマ (db dump の `-s` に `,` でつないで渡す)。CLI 2.62.10 の既定は cron・net などの拡張の表も入れ、
 *  復元先のスタックの cron.job と重なって復元が落ちる (§4.3)。cron のジョブの定義は CRON_JOBS_FILE で別に書庫に入れる */
export const DATA_DUMP_SCHEMAS = Object.freeze(['public', 'auth', 'storage']);
export const DUMP_FILES = Object.freeze(['roles.sql', 'schema.sql', 'data.sql']);
/** dump を流しても戻らないものを書庫に入れる (§3.3・§4.3 の catalog)。どれも tar の中の名前 */
export const RESTORE_FIXUPS_FILE = 'fixups.sql';
export const LEDGER_FILE = 'ledger.txt';
/** 本番の cron.job の定義を、流せば同じジョブがそろう SQL にしたもの (§4.3 の catalog の 2)。migration に登録の SQL が無いジョブがあるので書庫に持つ (§3.3 の (5)) */
export const CRON_JOBS_FILE = 'cron_jobs.sql';
export const CATALOG_DIR = 'catalog';
/** restore_check が復元した DB のカタログを書く置き場 (作業ディレクトリの下。書庫には入れない) */
export const RESTORED_CATALOG_DIR = 'restored-catalog';
/** tar に入れる順 (§4.3 の書庫。7 つ)。展開した後もこの名前で読む */
export const ARCHIVE_ENTRIES = Object.freeze([...DUMP_FILES, RESTORE_FIXUPS_FILE, CRON_JOBS_FILE, LEDGER_FILE, CATALOG_DIR]);
/** 既存のカタログの照会 (READ ONLY の取引で \copy し、最後に ROLLBACK)。prod-schema-snapshot.yml と supabase-local.sh verify と同じファイルで、変えない */
export const CATALOG_SNAPSHOT_SQL = 'scripts/baseline/snapshot_catalog.sql';
/** CATALOG_SNAPSHOT_SQL が cwd に書く CSV (ファイルの中の並び。tests/backup-db.test.ts がファイルの `TO '<名前>'` と突き合わせる) */
export const CATALOG_CSV_FILES = Object.freeze([
  'catalog_policies.csv', 'catalog_functions.csv', 'catalog_tables.csv', 'storage_buckets.csv',
  'catalog_extensions.csv', 'catalog_publication.csv', 'catalog_auth_storage_triggers.csv',
]);
/** 補いの SQL を作るスクリプト (新設。build_baseline.py の 3 つの関数をつなぐ。§5.5) と、カタログを比べるスクリプト (既存。errors があれば終了 1) */
export const RESTORE_FIXUPS_BUILDER_SCRIPT = 'scripts/baseline/build_restore_fixups.py';
export const CATALOG_VERIFY_SCRIPT = 'scripts/baseline/verify_baseline.py';
export const PYTHON_COMMAND = 'python3';
/** verify_baseline.py が最後に書く要約の行。1 = errors の数、2 = warnings の数 */
export const CATALOG_VERIFY_SUMMARY_LINE = /^\[verify\] errors=(\d+) warnings=(\d+)$/;
/** 台帳の版を読む SQL (読むだけ) */
export const LEDGER_VERSIONS_SQL = 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;';
/** 台帳の版の形 (supabase migration new の YYYYMMDDHHMMSS の 14 桁。本番の 200 版はすべてこの形。§3.3) */
export const LEDGER_VERSION_PATTERN = /^[0-9]{14}$/;
/** migration のファイルの置き場 (台帳の版ごとにファイルがあるかを見る。新しいプロジェクトで台帳を戻す migration repair はファイルが要る) */
export const MIGRATIONS_DIR = 'supabase/migrations';
/** CRON_JOBS_FILE の中身を作る SQL (cron.job を読むだけ。psql -At の 1 行 = 1 文)。ジョブの名前の順に 1 ジョブ 1 行の cron.schedule_in_database
 *  (command は複数行のものがあるので UTF-8 の hex にして 1 行に収める。database・username・active も写す) と、最後に 1 行の DO
 *  (流した先の cron.job の名前の集合が書庫の集合と違えば例外。--single-transaction で流せば全体が戻る)。2026-10-16 に本番へ流して 15 行 + 1 行を確かめた。
 *  username は、取得した人 (CURRENT_USER = postgres) と同じなら NULL (流した人のジョブになる) にする: pg_cron 1.6.4 は username を渡すと
 *  superuser でない人 (Supabase の postgres) を「must be superuser to create a job for another role」で止める (同じ名前でも止める。
 *  2026-10-16 にローカルのスタックの roundtrip-local で実測)。ほかの username のジョブは名前を残し、流す側で superuser が要ることが分かるようにする */
export const CRON_JOBS_SQL = `SELECT q.line FROM (SELECT 0 AS part, j.jobname COLLATE "C" AS sort_key, pg_catalog.format('SELECT cron.schedule_in_database(%L, %L, pg_catalog.convert_from(pg_catalog.decode(%L, ''hex''), ''UTF8''), %L, %s, %L);', j.jobname, j.schedule, pg_catalog.encode(pg_catalog.convert_to(j.command, 'UTF8'), 'hex'), j.database, CASE WHEN j.username = CURRENT_USER THEN 'NULL' ELSE pg_catalog.quote_literal(j.username) END, j.active) AS line FROM cron.job j UNION ALL SELECT 1, NULL, pg_catalog.format('DO $cron_check$ BEGIN IF (SELECT COALESCE(pg_catalog.array_agg(c.jobname COLLATE "C" ORDER BY c.jobname COLLATE "C"), ARRAY[]::text[]) FROM cron.job c) IS DISTINCT FROM ARRAY[%s]::text[] THEN RAISE EXCEPTION ''cron jobs differ from the backup''; END IF; END $cron_check$;', (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.quote_literal(k.jobname), ', ' ORDER BY k.jobname COLLATE "C"), '') FROM cron.job k))) q ORDER BY q.part, q.sort_key;`;
/** CRON_JOBS_FILE のジョブの行。1 = ジョブの名前 (%L の形。'' は ' に戻す)。名前の無いジョブ (NULL) と \ を含む名前 (%L が E'…' にする) は当たらない */
export const CRON_SCHEDULE_LINE_PATTERN = /^SELECT cron\.schedule_in_database\('((?:[^'\\]|'')+)', '/;
/** CRON_JOBS_FILE の最後の行の始まり (名前の集合を比べる DO) */
export const CRON_CHECK_LINE_PREFIX = 'DO $cron_check$ ';
/** 復元の前に storage の全部のポリシーを外す (fixups.sql が取得の時点のポリシーだけを作り直すので、ローカルにだけあるものを残さない。§4.8 の 2) */
export const RESET_STORAGE_POLICIES_SQL =
  "DO $reset$ DECLARE r record; BEGIN FOR r IN SELECT p.policyname, p.tablename FROM pg_catalog.pg_policies p WHERE p.schemaname = 'storage' " +
  "LOOP EXECUTE pg_catalog.format('DROP POLICY %I ON storage.%I', r.policyname, r.tablename); END LOOP; END $reset$;";
/** Docker イメージの取得の一過性の失敗 (#1523) に強くして CLI を打つ既存の入口。dump の 3 回と stats をこれで包む (§4.2・§4.3) */
export const IMAGE_PULL_FALLBACK_SCRIPT = 'scripts/supabase-image-fallback.sh';
/** どの取得元でもイメージを取れなかったときの終了コード。scripts/lib/supabase-image-pull.sh の SIP_EXIT_PULL_UNAVAILABLE
 *  (sysexits.h の EX_TEMPFAIL) と同じ値 (tests/backup-db.test.ts がライブラリを source して突き合わせる)。supabase-local.sh start も同じ値で終わる */
export const IMAGE_PULL_UNAVAILABLE_EXIT_CODE = 75;
/** stats の docker run のイメージ名の組み立て: <取得元>/<PG_IMAGE_REPOSITORY>:<supabase/.temp/postgres-version>。
 *  取得元は fallback が渡す SUPABASE_INTERNAL_IMAGE_REGISTRY、無ければ CLI の既定 (= SIP_REGISTRIES_DEFAULT の先頭) */
export const PG_IMAGE_REPOSITORY = 'supabase/postgres';
export const DEFAULT_IMAGE_REGISTRY = 'public.ecr.aws';
/** 書庫の圧縮レベルの既定。19 は数倍遅く縮みは 1 割しか変わらない (BACKUP_ZSTD_LEVEL で上書きできる) */
export const ZSTD_LEVEL = 6;
/** zstd の通常のレベルの範囲 (20 以上は --ultra が要り、メモリを大きく使うので受けない) */
export const ZSTD_LEVEL_MIN = 1;
export const ZSTD_LEVEL_MAX = 19;
export const ARCHIVE_BASENAME_PREFIX = 'homegohan-db';
export const FILE_SUFFIXES = Object.freeze({ archive: '.tar.zst.age', sha256: '.sha256', manifest: '.manifest.json' });
export const MANIFEST_SCHEMA_VERSION = 1;
/** GitHub Actions の secrets / variables の名前 (値はここでは扱わない) */
export const REQUIRED_SECRET_NAMES = Object.freeze(['BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY']);
export const REQUIRED_VARIABLE_NAMES = Object.freeze(['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_BUCKET', 'BACKUP_AGE_RECIPIENT']);
/** 運用で変えうる値の上書き (GitHub Actions variable。任意)。無ければ既定、形が違えば not_configured で止める */
export const RUN_TUNING_ENV = Object.freeze({
  dumpTimeoutMinutes: 'BACKUP_DUMP_TIMEOUT_MINUTES',
  uploadTimeoutMinutes: 'BACKUP_UPLOAD_TIMEOUT_MINUTES',
  restoreCheckTimeoutMinutes: 'BACKUP_RESTORE_CHECK_TIMEOUT_MINUTES',
  zstdLevel: 'BACKUP_ZSTD_LEVEL',
});
export const OPTIONAL_VARIABLE_NAMES = Object.freeze([
  RUN_TUNING_ENV.dumpTimeoutMinutes, RUN_TUNING_ENV.uploadTimeoutMinutes, RUN_TUNING_ENV.restoreCheckTimeoutMinutes, RUN_TUNING_ENV.zstdLevel,
]);
export const AGE_RECIPIENT_PATTERN = /^age1[0-9a-z]{58}$/;
/** aws cli 2.23 以降の既定の CRC ヘッダーを R2 が受け付けないことがあるので、要るときだけ付ける */
export const AWS_CHECKSUM_ENV = Object.freeze({ AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' });
export const R2_REGION = 'auto';
/** R2 の S3 互換 API の endpoint のホスト (`https://<アカウント>.<これ>`) */
export const R2_ENDPOINT_HOST_SUFFIX = 'r2.cloudflarestorage.com';
/** restore サブコマンドが手元のシェルから読む名前 (§4.4。キーは復元用の読み取り専用のトークン)。BACKUP_AGE_RECIPIENT は読まない (復号は --identity-file) */
export const RESTORE_REQUIRED_ENV_NAMES = Object.freeze(['BACKUP_R2_ACCOUNT_ID', 'BACKUP_R2_BUCKET', 'BACKUP_R2_ACCESS_KEY_ID', 'BACKUP_R2_SECRET_ACCESS_KEY']);
/** 段ごとの上限 (分)。段の中で起こす子プロセス 1 つずつの timeoutMs に掛かる (stageTimeoutMs。§4.12)。job 全体は workflow の timeout-minutes 300 (GitHub の 6 時間より短く)。
 *  copy は upload と同じ手元のファイルを層のキーへ送り直すので upload と同じ値 (上書きも BACKUP_UPLOAD_TIMEOUT_MINUTES が両方に効く。§4.4) */
export const STAGE_TIMEOUT_MINUTES = Object.freeze({
  link: 5, config: 1, stats: 5, dump: 120, catalog: 5, verify: 10, archive: 30, encrypt: 30, upload: 60, copy: 60, inventory: 5, restore_check: 60, audit: 5, cleanup: 5,
});
/** 分 → ミリ秒 (CommandRunner の timeoutMs) */
export const MS_PER_MINUTE = 60_000;
export const JOB_TIMEOUT_MINUTES = 300;
/** run の step の後に残す分 (stop と report の step が動く時間。§4.11) */
export const REPORT_STEP_RESERVE_MINUTES = 10;
/** run の step の timeout-minutes。job の上限から report の分を引く (run が時間切れでも report が動けるように) */
export const RUN_STEP_TIMEOUT_MINUTES = JOB_TIMEOUT_MINUTES - REPORT_STEP_RESERVE_MINUTES;
/** roundtrip-check job の timeout-minutes。ローカルのスタックの起動 (イメージの取得のやり直しを含む) が大半で、
 *  同じスタックを起こす security-regression.yml の job と同じ 45 分 (種まきした小さい DB の dump → 復元は数分) */
export const ROUNDTRIP_JOB_TIMEOUT_MINUTES = 45;
/** concurrency の group。backup job は固定 (取得どうしを直列)、roundtrip-check job は ref ごと (取得の group に入れない。§4.2) */
export const BACKUP_CONCURRENCY_GROUP = 'db-backup';
export const ROUNDTRIP_CONCURRENCY_GROUP = 'db-backup-roundtrip-${{ github.ref }}';
/** ローカルのスタックの枠 (scripts/lib/local-ci-slot.sh の枠。restore / roundtrip-local の --slot。§4.7 の引数の表)。既定は CI と同じ枠 0。
 *  上限は local-ci-slot.sh の LCS_SLOT_MAX と同じ値 (tests/backup-db.test.ts が tests/helpers/local-ci-slot-values.ts の slotMaxOf と突き合わせる) */
export const LOCAL_SLOT_DEFAULT = 0;
export const LOCAL_SLOT_MIN = 0;
export const LOCAL_SLOT_MAX = 9;
/** 枠を supabase-local.sh に渡す環境変数の名前 (start / env / stop に同じ値を渡す。run は LOCAL_SLOT_DEFAULT) */
export const LOCAL_SLOT_ENV = 'LOCAL_CI_SLOT';
/** GitHub Actions の外 (手元) で run を流したときの details / manifest の値 (runIdentityFromEnv) */
export const RUN_ID_OUTSIDE_ACTIONS = 'local';
export const RUN_ATTEMPT_OUTSIDE_ACTIONS = 0;
export const GIT_SHA_OUTSIDE_ACTIONS = 'unknown';
/** run → report の結果ファイルの名前 ($RUNNER_TEMP の下。workflow の 2 つの step が同じパスを書く) */
export const RUN_REPORT_FILE_NAME = 'db-backup-result.json';
export const RUN_REPORT_SCHEMA_VERSION = 1;
/** GitHub Actions の steps.<id>.outcome の値 */
export const STEP_OUTCOMES = Object.freeze(['success', 'failure', 'cancelled', 'skipped']);
/** pg_dump がダンプの最後に書く注釈の行 (data.sql。CLI は data の注釈を消さない)。これが無ければ途中で切れている */
export const DUMP_COMPLETE_TRAILER = '-- PostgreSQL database dump complete';
/** CLI の dump_data.sh が pg_dump の後に足す最後の行。pg_dump が失敗すると (set -euo pipefail で) 書かれない */
export const DATA_DUMP_FINAL_LINE = 'RESET ALL;';
/** COPY の本体の終わりの行 (text 形式) */
export const COPY_END_LINE = '\\.';
/** schema.sql の表の行。CLI は --quote-all-identifier で名前を引用符で囲み、`CREATE TABLE "` を `CREATE TABLE IF NOT EXISTS "` に書き換える
 *  (UNLOGGED は書き換えの対象外)。1 = schema、2 = 表 (どちらも `""` は引用符 1 つに戻して使う) */
export const SCHEMA_TABLE_LINE_PATTERN = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?"((?:[^"]|"")+)"\."((?:[^"]|"")+)" \($/;
/** 分割の親: 表の本体を閉じる `)` の行の次の行がこれで始まる (pg_dump は `)` と `PARTITION BY …;` を別の行に書く) */
export const PARTITION_BY_LINE_PREFIX = 'PARTITION BY ';
/** data.sql の COPY の行 (`COPY "<schema>"."<t>" ("a", "b") FROM stdin;`)。1 = schema、2 = 表 */
export const DATA_COPY_LINE_PATTERN = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)" (?:\(.*\) )?FROM stdin;$/;
/** 監査行の details の上限 (bytes)。SQL の record_backup_audit と同じ値 */
export const AUDIT_DETAILS_MAX_BYTES = 8192;
/** 伏せ字の規則 (scripts/lib/cron-secret-drift.mjs と同じ) */
export const MIN_OPAQUE_TOKEN_LENGTH = 24;
export const STDERR_TAIL_LINES = 5;
export const BACKUP_ISSUE_MARKER = '<!-- db-backup -->';
export const BACKUP_ISSUE_TITLE = '【自動】DB バックアップの失敗';
/** 監査行の結果 (action_type の 3 つ目) */
export const BACKUP_AUDIT_RESULTS = Object.freeze(['completed', 'failed']);

/** action_type (`backup.<層>.<結果>`)。migration の record_backup_audit が受け付ける 6 つと、src/lib/backups/core.ts の BACKUP_AUDIT_ACTION_TYPES と同じ */
export function backupAuditActionType(tier, result) {
  return `backup.${tier}.${result}`;
}
/** BACKUP_TIERS × BACKUP_AUDIT_RESULTS の順 (daily.completed, daily.failed, weekly.completed, …) */
export const BACKUP_AUDIT_ACTION_TYPES = Object.freeze(
  BACKUP_TIERS.flatMap((tier) => BACKUP_AUDIT_RESULTS.map((result) => backupAuditActionType(tier, result))),
);

/** psql の打ち方 (§4.12)。CommandRunner で `bash -c <本文>` として打つ。値 (接続先・パスワード・ファイルのパス) は env の
 *  PG_URL・PGPASSWORD・PSQL_FILE・SCHEMA_FILE・DATA_FILE で渡し、argv に載せない。psql は runner (手元なら手元の機械) のもの */
export const PSQL_SCRIPTS = Object.freeze({
  version: 'exec psql --version',
  audit: 'exec psql "$PG_URL" -X -q -At -v ON_ERROR_STOP=1 --single-transaction --file "$PSQL_FILE"',
  reset: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file "$PSQL_FILE"',
  roles: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate --file "$PSQL_FILE"',
  restore:
    'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction --file "$SCHEMA_FILE" --command "SET session_replication_role = replica" --file "$DATA_FILE"',
  count: 'exec psql "$PG_URL" -X -q -At -v ON_ERROR_STOP=1 --file "$PSQL_FILE"',
  /** CATALOG_SNAPSHOT_SQL を流す。CommandRunner の cwd に CSV が書かれる (本番では catalog の段、復元した DB では restore_check) */
  catalog: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --file "$PSQL_FILE"',
  /** CRON_JOBS_FILE を確定させずに流す (roundtrip-local の §4.8 の 8 と、手順書 §6 の (6) の訓練が同じ打ち方) */
  cron_dry_run: 'exec psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 --command "BEGIN" --file "$PSQL_FILE" --command "ROLLBACK"',
});
/** 接続先の後ろに付ける sslmode。本番の pooler は必須、ローカルのスタックは無し (supabase-local.sh verify と同じ) */
export const REMOTE_PG_SSLMODE_QUERY = '?sslmode=require';
export const LOCAL_PG_SSLMODE_QUERY = '?sslmode=disable';
/** roles.sql で許すエラー (duplicate_object = ローカルにすでにあるロール)。ほかの SQLSTATE は復元の失敗 */
export const ROLES_TOLERATED_SQLSTATE = '42710';
/** VERBOSITY=sqlstate の psql が標準エラー出力に書くエラーの行 (`psql:<file>:<行>: ERROR:  42710`)。1 = SQLSTATE */
export const PSQL_SQLSTATE_ERROR_LINE = /\bERROR:\s+([0-9A-Z]{5})\s*$/;
/** 復元の後の数を 1 行 (`<表>|<利用者>|<監査行>`) で返す SQL。表は public の通常の表 (relkind r。分割の親を除き子を含む = verify の数え方) で、拡張の表を除く */
export const RESTORE_COUNT_SQL =
  "SELECT (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' " +
  "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')), " +
  '(SELECT count(*) FROM auth.users), (SELECT count(*) FROM public.admin_audit_logs);';

export const STAGES = Object.freeze(['link', 'config', 'stats', 'dump', 'catalog', 'verify', 'archive', 'encrypt', 'upload', 'copy', 'inventory', 'restore_check', 'audit', 'cleanup']);
/** restore サブコマンドの段 (§4.7 の 2 つ目の表)。監査行には書かない */
export const RESTORE_STAGES = Object.freeze(['config', 'download', 'checksum', 'decrypt', 'extract', 'restore_env', 'restore', 'restore_check', 'cleanup']);
/** restore サブコマンドの段ごとの上限 (分)。run の同じ大きさの仕事をする段の値をそのまま使う (download = upload、checksum = verify、decrypt = encrypt、
 *  extract = archive、restore_env・restore・restore_check = restore_check)。config・checksum・cleanup は子プロセスを起こさないので使わない (§4.12) */
export const RESTORE_STAGE_TIMEOUT_MINUTES = Object.freeze({
  config: STAGE_TIMEOUT_MINUTES.config,
  download: STAGE_TIMEOUT_MINUTES.upload,
  checksum: STAGE_TIMEOUT_MINUTES.verify,
  decrypt: STAGE_TIMEOUT_MINUTES.encrypt,
  extract: STAGE_TIMEOUT_MINUTES.archive,
  restore_env: STAGE_TIMEOUT_MINUTES.restore_check,
  restore: STAGE_TIMEOUT_MINUTES.restore_check,
  restore_check: STAGE_TIMEOUT_MINUTES.restore_check,
  cleanup: STAGE_TIMEOUT_MINUTES.cleanup,
});
export const FAILURE_REASONS = Object.freeze([
  'link_failed', 'not_configured', 'stats_failed', 'dump_failed', 'catalog_failed', 'dump_incomplete', 'archive_failed', 'encrypt_failed',
  'upload_failed', 'upload_size_mismatch', 'copy_failed', 'inventory_failed', 'restore_check_failed', 'restore_env_failed',
  'audit_failed', 'download_failed', 'checksum_mismatch', 'decrypt_failed', 'extract_failed', 'image_pull_unavailable', 'timeout', 'unknown',
]);
/** 子プロセスが 0 以外で終わったときの段ごとの reason (classifyFailure が使う)。cleanup の失敗は警告だけで reason を持たない (§4.7)。
 *  config・verify は子プロセスを打たない段で、ここに当たるのは形の上だけ (checkConfig / verifyDumpFiles が not_configured / dump_incomplete を直接決める) */
export const STAGE_DEFAULT_REASON = Object.freeze({
  link: 'link_failed', config: 'not_configured', stats: 'stats_failed', dump: 'dump_failed', catalog: 'catalog_failed', verify: 'dump_incomplete',
  archive: 'archive_failed', encrypt: 'encrypt_failed', upload: 'upload_failed', copy: 'copy_failed', inventory: 'inventory_failed',
  restore_check: 'restore_check_failed', audit: 'audit_failed', download: 'download_failed', checksum: 'checksum_mismatch',
  decrypt: 'decrypt_failed', extract: 'extract_failed', restore_env: 'restore_env_failed', restore: 'restore_check_failed',
});
/** 終了コード: 0 成功 / 1 失敗 (記録済み) / 2 引数の誤り / 3 未設定で止めた */
export const EXIT_CODES = Object.freeze({ ok: 0, failed: 1, usage: 2, not_configured: 3 });
/** 子プロセスを起こせなかった (ENOENT) ときに CommandRunner が返す終了コード (bash の「コマンドが無い」と同じ) */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;

// ── §5.1 の宣言の外の、実装の内部の定数 (名前と根拠を持たせる) ─────────────────────

/** stats の照会 (本番を読むだけ。1 行 `<public の表>|<auth.users>|<DB の大きさ>`。記録だけで突き合わせには使わない。§4.3) */
export const STATS_SQL =
  "SELECT (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'), (SELECT count(*) FROM auth.users), pg_catalog.pg_database_size(pg_catalog.current_database());";
/** stats の docker run (fallback の子として bash -c で打つ。値は env の PG_IMAGE_TAG・PG_URL・STATS_SQL・PGPASSWORD で渡す。§4.3) */
export const STATS_DOCKER_SCRIPT =
  `exec docker run --rm --network host -e PGPASSWORD "\${SUPABASE_INTERNAL_IMAGE_REGISTRY:-${DEFAULT_IMAGE_REGISTRY}}/${PG_IMAGE_REPOSITORY}:\${PG_IMAGE_TAG}" psql "$PG_URL" -At -v ON_ERROR_STOP=1 -c "$STATS_SQL"`;
/** 書庫を作る (tar | zstd のパイプ。平文の tar をディスクに置かない)。$1 = 作業ディレクトリ、$2 = zstd のレベル (-N)、$3 = 出力、$4 以降 = ARCHIVE_ENTRIES */
export const ARCHIVE_SCRIPT = 'set -o pipefail; tar -C "$1" -cf - "${@:4}" | zstd -q -T0 "$2" -o "$3"';
/** supabase link の後に CLI が書く接続先 (pooler) と Postgres の版 (§4.3) */
export const SUPABASE_TEMP_POOLER_URL_FILE = 'supabase/.temp/pooler-url';
export const SUPABASE_TEMP_POSTGRES_VERSION_FILE = 'supabase/.temp/postgres-version';
/** ローカルのスタックを扱う既存のスクリプト (start / env / stop。枠は LOCAL_SLOT_ENV) */
export const SUPABASE_LOCAL_SCRIPT = 'scripts/supabase-local.sh';
/** `supabase-local.sh env` の出力の接続先の行の頭 */
export const LOCAL_DB_URL_ENV_PREFIX = 'SUPABASE_DB_URL=';
/** ログ・Issue に出すダイジェストの先頭の長さ (§4.10) */
export const DIGEST_PREFIX_LENGTH = 8;
/** sha256 の 16 進の長さ */
export const SHA256_HEX_LENGTH = 64;
/** 名前に秘密らしい語を含む環境変数の値を伏せる (§4.10)。cron-secret-drift.mjs の規則と同じ語 */
export const SECRET_ENV_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|KEY)/i;
/** 上の名前の環境変数でも、これより短い値は伏せない (「1」や「true」で普通の語まで伏せないため。cron-secret-drift.mjs と同じ値) */
export const MIN_SECRET_ENV_VALUE_LENGTH = 8;
/** 標準エラー出力を末尾の行のために手元に残す上限 (bytes)。長いエラーでもメモリを使い切らないように */
export const STDERR_CAPTURE_MAX_BYTES = 65_536;
/** JST (Asia/Tokyo) の UTC からのずれ (分)。暦日と曜日の判定に使う (§4.1) */
export const JST_OFFSET_MINUTES = 540;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** シグナルで止まったときの終了コードの基数 (シェルの慣習: 128 + シグナル番号) */
export const SIGNAL_EXIT_CODE_BASE = 128;
/** 一時ディレクトリを消すシグナル (Ctrl-C・kill・端末を閉じた。§4.10) */
export const CLEANUP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
/** 一時ディレクトリの名前の頭 */
export const WORK_DIR_PREFIX = 'homegohan-db-backup-';
/** 書いたファイルの許可 (所有者だけ読み書き。§4.10 の umask 077 と同じ) */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** stats・dump・restore_env の終了 75 は image_pull_unavailable に分ける段 (§4.7・classifyFailure) */
const IMAGE_PULL_STAGES = new Set(['stats', 'dump', 'restore_env']);
const REDACTED = '***';
const USAGE = `使い方:
  node scripts/backup-db.mjs run [--tier auto|daily|weekly|annual] [--result-file <path>]
  node scripts/backup-db.mjs restore --key <daily/…/<base>.tar.zst.age> --identity-file <path> [--slot <0-${LOCAL_SLOT_MAX}>]
  node scripts/backup-db.mjs roundtrip-local [--slot <0-${LOCAL_SLOT_MAX}>]
  node scripts/backup-db.mjs report-issue --result-file <path> --run-outcome <${STEP_OUTCOMES.join('|')}> --run-url <url>
  node scripts/backup-db.mjs r2-config --bucket <name> --out-dir <dir>
  node scripts/backup-db.mjs help
設計: docs/design/cross/17-backup-automation.md`;

// ───────────────────────────────────────────────────────────────────────────
// エラーの型
// ───────────────────────────────────────────────────────────────────────────

/** 子プロセスが 0 以外で終わった。段の中で runBackup / restoreFromArchive / roundtripLocal が投げ、classifyFailure が段の既定の reason にする */
export class CommandFailedError extends Error {
  constructor(cmd, code) {
    super(`${cmd} が終了コード ${code} で終わりました`);
    this.name = 'CommandFailedError';
    this.cmd = cmd;
    this.code = code;
  }
}

/** CommandRunner が timeoutMs を超えた子プロセスを止めた (SIGTERM)。classifyFailure は timeout にする */
export class CommandTimeoutError extends Error {
  constructor(cmd, timeoutMs) {
    super(`${cmd} が ${timeoutMs} ms で終わらなかったので止めました`);
    this.name = 'CommandTimeoutError';
    this.cmd = cmd;
    this.timeoutMs = timeoutMs;
  }
}

/** 引数の誤り (parseArgs が投げ、runCli が使い方を出して 2 で終わる) */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 段の判定が直接決めた失敗 (子プロセスの失敗ではない。reason をそのまま使い、classifyFailure を通さない。§4.7) */
class StageFailure extends Error {
  constructor(reason, info = {}) {
    super(`stage failure: ${reason}`);
    this.name = 'StageFailure';
    this.reason = reason;
    this.info = info;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 小さな純関数
// ───────────────────────────────────────────────────────────────────────────

/** `https://${accountId}.${R2_ENDPOINT_HOST_SUFFIX}` (aws の --endpoint-url。§4.4) */
export function r2EndpointUrl(accountId) {
  return `https://${accountId}.${R2_ENDPOINT_HOST_SUFFIX}`;
}

/** `s3://${bucket}/${key}` (aws s3 cp の転送元・転送先。§4.4) */
export function r2ObjectUri(bucket, key) {
  return `s3://${bucket}/${key}`;
}

/** aws を呼ぶ回の CommandRunner の env。aws cli は BACKUP_R2_* を読まないので写す。手元のシェルの別の AWS の一時鍵・プロファイルは undefined で外す */
export function awsCommandEnv(env) {
  return {
    AWS_ACCESS_KEY_ID: env.BACKUP_R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.BACKUP_R2_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: undefined,
    AWS_PROFILE: undefined,
    ...AWS_CHECKSUM_ENV,
  };
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 10 進の整数 (符号・小数点・空白を含まない) を数にする。形が違えば null */
function parseDecimalInteger(raw) {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** UTC の時刻から JST の暦日 YYYY-MM-DD */
function jstDateOf(now) {
  const jst = new Date(now.getTime() + JST_OFFSET_MINUTES * MS_PER_MINUTE);
  return `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}`;
}

/** UTC の時刻から basename の時刻の部分 (YYYYMMDDTHHMMSSZ) */
function utcStampOf(now) {
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
}

/** JST の暦日から層を決める: daily は常に、月曜なら weekly、1/1 なら annual */
export function tiersForDate(jstDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(jstDate);
  if (!m) throw new TypeError('jstDate は YYYY-MM-DD の形にしてください');
  const [, y, mo, d] = m;
  const weekday = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  const tiers = ['daily'];
  if (weekday === WEEKLY_WEEKDAY_JST) tiers.push('weekly');
  if (`${mo}-${d}` === ANNUAL_MONTH_DAY_JST) tiers.push('annual');
  return tiers;
}

export function objectKey(tier, jstDate, basename, suffix) {
  const folder = tier === 'annual' ? jstDate.slice(0, 4) : jstDate;
  return `${tier}/${folder}/${basename}${FILE_SUFFIXES[suffix]}`;
}

/** 取得の予定を作る。tierOverride が auto 以外なら、その層 (weekly / annual は daily と一緒) */
export function planRun({ now, tierOverride }) {
  const jst_date = jstDateOf(now);
  const tiers = tierOverride === 'auto' ? tiersForDate(jst_date) : tierOverride === 'daily' ? ['daily'] : ['daily', tierOverride];
  const basename = `${ARCHIVE_BASENAME_PREFIX}-${utcStampOf(now)}`;
  const keys = {};
  for (const tier of BACKUP_TIERS) {
    keys[tier] = {};
    for (const suffix of Object.keys(FILE_SUFFIXES)) keys[tier][suffix] = objectKey(tier, jst_date, basename, suffix);
  }
  return { jst_date, tiers, basename, keys };
}

/** RUN_TUNING_ENV を読む。無い・空は既定。時間は 1 以上 JOB_TIMEOUT_MINUTES 以下の整数、zstd は ZSTD_LEVEL_MIN〜ZSTD_LEVEL_MAX の整数。外れたら invalid に名前 */
export function resolveRunTuning(env) {
  const tuning = {
    dumpTimeoutMinutes: STAGE_TIMEOUT_MINUTES.dump,
    uploadTimeoutMinutes: STAGE_TIMEOUT_MINUTES.upload,
    restoreCheckTimeoutMinutes: STAGE_TIMEOUT_MINUTES.restore_check,
    zstdLevel: ZSTD_LEVEL,
  };
  const invalid = [];
  const ranges = {
    dumpTimeoutMinutes: [1, JOB_TIMEOUT_MINUTES],
    uploadTimeoutMinutes: [1, JOB_TIMEOUT_MINUTES],
    restoreCheckTimeoutMinutes: [1, JOB_TIMEOUT_MINUTES],
    zstdLevel: [ZSTD_LEVEL_MIN, ZSTD_LEVEL_MAX],
  };
  for (const [field, name] of Object.entries(RUN_TUNING_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = parseDecimalInteger(raw);
    const [min, max] = ranges[field];
    if (value === null || value < min || value > max) {
      invalid.push(name);
      continue;
    }
    tuning[field] = value;
  }
  return invalid.length === 0 ? { ok: true, tuning } : { ok: false, invalid };
}

/** 既定の tuning (roundtrip-local と、形の違う上書きがあったときの config までの段) */
function defaultTuning() {
  const resolved = resolveRunTuning({});
  if (!resolved.ok) throw new Error('既定の tuning が作れません');
  return resolved.tuning;
}

/** env を受け取り、必須の名前の無い・空・形が違うもの と、任意の RUN_TUNING_ENV の形が違うものを返す。値は返さない */
export function checkConfig(env) {
  const missing = [];
  for (const name of [...REQUIRED_SECRET_NAMES, ...REQUIRED_VARIABLE_NAMES]) {
    if (!isNonEmpty(env[name])) missing.push(name);
  }
  if (isNonEmpty(env.BACKUP_AGE_RECIPIENT) && !AGE_RECIPIENT_PATTERN.test(env.BACKUP_AGE_RECIPIENT.trim())) missing.push('BACKUP_AGE_RECIPIENT');
  const tuning = resolveRunTuning(env);
  if (!tuning.ok) missing.push(...tuning.invalid);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** restore の config の段。RESTORE_REQUIRED_ENV_NAMES の無い・空の名前と、RUN_TUNING_ENV の形が違う名前を missing に返す (BACKUP_AGE_RECIPIENT は見ない) */
export function checkRestoreConfig(env) {
  const missing = RESTORE_REQUIRED_ENV_NAMES.filter((name) => !isNonEmpty(env[name]));
  const tuning = resolveRunTuning(env);
  if (!tuning.ok) missing.push(...tuning.invalid);
  if (missing.length > 0 || !tuning.ok) return { ok: false, missing };
  return { ok: true, tuning: tuning.tuning };
}

/** run (と roundtrip-local) の段の子プロセスの timeoutMs。dump・upload・restore_check は tuning の値、copy は tuning.uploadTimeoutMinutes */
export function stageTimeoutMs(stage, tuning) {
  const minutes =
    stage === 'dump' ? tuning.dumpTimeoutMinutes
      : stage === 'upload' || stage === 'copy' ? tuning.uploadTimeoutMinutes
        : stage === 'restore_check' ? tuning.restoreCheckTimeoutMinutes
          : STAGE_TIMEOUT_MINUTES[stage];
  return minutes * MS_PER_MINUTE;
}

/** restore サブコマンドの段の子プロセスの timeoutMs。download は tuning.uploadTimeoutMinutes、restore_env・restore・restore_check は tuning.restoreCheckTimeoutMinutes */
export function restoreStageTimeoutMs(stage, tuning) {
  const minutes =
    stage === 'download' ? tuning.uploadTimeoutMinutes
      : stage === 'restore_env' || stage === 'restore' || stage === 'restore_check' ? tuning.restoreCheckTimeoutMinutes
        : RESTORE_STAGE_TIMEOUT_MINUTES[stage];
  return minutes * MS_PER_MINUTE;
}

function unquoteIdent(name) {
  return name.replace(/""/g, '"');
}

/** COPY の行 (DATA_COPY_LINE_PATTERN) を schema と表に分ける (引用符を外し `""` を `"` に戻す)。当たらなければ null */
export function parseCopyLine(line) {
  const m = DATA_COPY_LINE_PATTERN.exec(line);
  return m ? { schema: unquoteIdent(m[1]), table: unquoteIdent(m[2]) } : null;
}

/** schema.sql の表の行 (SCHEMA_TABLE_LINE_PATTERN) を schema と表に分ける (引用符を外し `""` を `"` に戻す)。当たらなければ null */
export function parseSchemaTableLine(line) {
  const m = SCHEMA_TABLE_LINE_PATTERN.exec(line);
  return m ? { schema: unquoteIdent(m[1]), table: unquoteIdent(m[2]) } : null;
}

function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** data.sql を 1 行ずつ読む (GB 級なので行の非同期の列で受ける。全体を文字列にしない) */
export async function scanDataSql(lines) {
  const scan = {
    public_copy_tables: [],
    managed_copy_tables: [],
    copy_row_counts: {},
    unterminated_copy: null,
    complete_trailer_seen: false,
    statements_after_trailer: [],
    unexpected_copy_tables: [],
  };
  let inCopy = null;
  for await (const raw of lines) {
    const line = stripCr(raw);
    if (inCopy !== null) {
      if (line === COPY_END_LINE) inCopy = null;
      else scan.copy_row_counts[inCopy] += 1;
      continue;
    }
    const copy = parseCopyLine(line);
    if (copy) {
      const key = `${copy.schema}.${copy.table}`;
      if (copy.schema === 'public') scan.public_copy_tables.push(copy.table);
      else if (DATA_DUMP_SCHEMAS.includes(copy.schema)) scan.managed_copy_tables.push(key);
      else scan.unexpected_copy_tables.push(key);
      scan.copy_row_counts[key] = scan.copy_row_counts[key] ?? 0;
      inCopy = key;
      if (scan.complete_trailer_seen) scan.statements_after_trailer.push(line.trim());
      continue;
    }
    if (line === DUMP_COMPLETE_TRAILER) {
      scan.complete_trailer_seen = true;
      scan.statements_after_trailer = [];
      continue;
    }
    const trimmed = line.trim();
    if (scan.complete_trailer_seen && trimmed !== '' && !trimmed.startsWith('--')) scan.statements_after_trailer.push(trimmed);
  }
  if (inCopy !== null) scan.unterminated_copy = inCopy;
  return scan;
}

/** schema.sql を 1 行ずつ読む */
export async function scanSchemaSql(lines) {
  const scan = { public_tables: [], non_public_tables: [] };
  /** 本体を閉じる行を待っている public の表 */
  let open = null;
  /** `)` だけの行の後で、次の行が PARTITION BY かを待っている public の表 */
  let awaitingPartition = null;
  for await (const raw of lines) {
    const line = stripCr(raw);
    if (awaitingPartition !== null) {
      if (!line.startsWith(PARTITION_BY_LINE_PREFIX)) scan.public_tables.push(awaitingPartition);
      awaitingPartition = null;
    }
    const header = parseSchemaTableLine(line);
    if (header) {
      if (open !== null) scan.public_tables.push(open);
      open = null;
      if (header.schema === 'public') open = header.table;
      else scan.non_public_tables.push(`${header.schema}.${header.table}`);
      continue;
    }
    if (open !== null && line.startsWith(')')) {
      if (line.trimEnd().endsWith(';')) scan.public_tables.push(open);
      else awaitingPartition = open;
      open = null;
    }
  }
  if (awaitingPartition !== null) scan.public_tables.push(awaitingPartition);
  if (open !== null) scan.public_tables.push(open);
  return scan;
}

/** §4.3 の verify の 1〜6。基準はダンプの中身 (schema.sql の表) で、live の stats を受け取らない。合えば dumped を返す */
export function verifyDumpFiles({ fileSizes, data, schema }) {
  const schemaCount = schema.public_tables.length;
  const fail = (expected, actual) => ({ ok: false, reason: 'dump_incomplete', expected, actual });
  // 1. 3 ファイルが空でない
  if (DUMP_FILES.some((name) => !(fileSizes[name] > 0))) return fail(schemaCount, schemaCount);
  // 2. 完了行と、その後の文が RESET ALL; の 1 行だけ
  if (!data.complete_trailer_seen) return fail(schemaCount, schemaCount);
  if (data.statements_after_trailer.length !== 1 || data.statements_after_trailer[0] !== DATA_DUMP_FINAL_LINE) return fail(schemaCount, schemaCount);
  // 3. すべての COPY が終わっている
  if (data.unterminated_copy !== null) return fail(schemaCount, schemaCount);
  // 4. public の表の集合が空でなく、COPY "public". の表の集合とちょうど同じ
  const schemaSet = new Set(schema.public_tables);
  const dataSet = new Set(data.public_copy_tables);
  const sameSet = schemaSet.size > 0 && schemaSet.size === dataSet.size && [...schemaSet].every((t) => dataSet.has(t));
  if (!sameSet) return fail(schemaSet.size, dataSet.size);
  // 5. auth.users と admin_audit_logs の COPY がある
  if (!Object.hasOwn(data.copy_row_counts, 'auth.users') || !Object.hasOwn(data.copy_row_counts, 'public.admin_audit_logs')) {
    return fail(schemaSet.size, schemaSet.size);
  }
  // 6. DATA_DUMP_SCHEMAS の外の COPY が無く、schema.sql に public の外の表が無い
  const outside = data.unexpected_copy_tables.length + schema.non_public_tables.length;
  if (outside > 0) return fail(0, outside);
  return {
    ok: true,
    dumped: {
      public_tables: dataSet.size,
      auth_users: data.copy_row_counts['auth.users'],
      audit_rows: data.copy_row_counts['public.admin_audit_logs'],
    },
  };
}

/** DataSqlScan の managed_copy_tables から、復元の前に空にする表を `<schema>.<t>` で集める (重複を除き、出てきた順) */
export function managedTablesInDump(scan) {
  return [...new Set(scan.managed_copy_tables)];
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(qualified) {
  const dot = qualified.indexOf('.');
  return `${quoteIdent(qualified.slice(0, dot))}.${quoteIdent(qualified.slice(dot + 1))}`;
}

/** 復元の前に空にする SQL (§4.8 の 2)。この順: public を落として作り直し GRANT → storage のポリシーを全部外す → TRUNCATE … CASCADE (空なら書かない) */
export function buildResetSql(managedTables) {
  const statements = [
    'DROP SCHEMA IF EXISTS "public" CASCADE;',
    'CREATE SCHEMA "public";',
    'GRANT USAGE, CREATE ON SCHEMA "public" TO "postgres";',
    'GRANT USAGE ON SCHEMA "public" TO "anon", "authenticated", "service_role";',
    RESET_STORAGE_POLICIES_SQL,
  ];
  if (managedTables.length > 0) statements.push(`TRUNCATE ${managedTables.map(quoteQualified).join(', ')} CASCADE;`);
  return `${statements.join('\n')}\n`;
}

/** roles.sql を流した psql (VERBOSITY=sqlstate) の標準エラー出力の全部を、PSQL_SQLSTATE_ERROR_LINE の行で数える */
export function countRoleRestoreErrors(stderrText) {
  let tolerated = 0;
  const others = [];
  for (const raw of String(stderrText ?? '').split('\n')) {
    const m = PSQL_SQLSTATE_ERROR_LINE.exec(stripCr(raw));
    if (!m) continue;
    if (m[1] === ROLES_TOLERATED_SQLSTATE) tolerated += 1;
    else others.push(m[1]);
  }
  return { tolerated, others };
}

/** `supabase-local.sh env` の標準出力から `SUPABASE_DB_URL=` の行の値を取る (無い・空なら null) */
export function parseLocalDbUrl(envText) {
  for (const raw of String(envText ?? '').split('\n')) {
    const line = stripCr(raw).trim();
    if (line.startsWith(LOCAL_DB_URL_ENV_PREFIX)) {
      const value = line.slice(LOCAL_DB_URL_ENV_PREFIX.length).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}

/** `<a>|<b>|<c>` の 1 行 (前後の空白・改行は無視) を 3 つの 0 以上の整数にする。形が違えば null */
function parseThreeCounts(stdout) {
  const text = String(stdout ?? '').trim();
  if (text.includes('\n')) return null;
  const parts = text.split('|');
  if (parts.length !== 3) return null;
  const values = parts.map((part) => parseDecimalInteger(part.trim()));
  return values.every((v) => v !== null) ? values : null;
}

/** RESTORE_COUNT_SQL の出力を読む。3 つの 0 以上の整数でなければ null */
export function parseRestoreCounts(stdout) {
  const values = parseThreeCounts(stdout);
  return values ? { public_tables: values[0], auth_users: values[1], audit_rows: values[2] } : null;
}

/** STATS_SQL の出力を読む (記録だけ)。形が違えば null */
export function parseSourceStats(stdout) {
  const values = parseThreeCounts(stdout);
  return values ? { public_tables: values[0], auth_users: values[1], db_size_bytes: values[2] } : null;
}

function nonEmptyLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => stripCr(line).trim())
    .filter((line) => line !== '');
}

/** ledger.txt の本文を読む。空の行は無視し、残りがすべて LEDGER_VERSION_PATTERN で、真に昇順 (重複なし) で 1 つ以上なら版の配列、ほかは null */
export function parseLedgerVersions(text) {
  const versions = nonEmptyLines(text);
  if (versions.length === 0) return null;
  for (let i = 0; i < versions.length; i++) {
    if (!LEDGER_VERSION_PATTERN.test(versions[i])) return null;
    if (i > 0 && !(versions[i - 1] < versions[i])) return null;
  }
  return versions;
}

/** CRON_JOBS_FILE の本文を読む。最後の行が CRON_CHECK_LINE_PREFIX で始まり、ほかの行がすべて CRON_SCHEDULE_LINE_PATTERN に当たり、名前が重ならなければ名前の配列 */
export function parseCronJobsSql(text) {
  const lines = nonEmptyLines(text);
  if (lines.length === 0 || !lines[lines.length - 1].startsWith(CRON_CHECK_LINE_PREFIX)) return null;
  const names = [];
  for (const line of lines.slice(0, -1)) {
    const m = CRON_SCHEDULE_LINE_PATTERN.exec(line);
    if (!m) return null;
    const name = m[1].replace(/''/g, "'");
    if (names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

/** 復元の検査の cron の突き合わせ (§4.8 の 8)。parseCronJobsSql が null でなく、その数が expected と同じなら ok */
export function cronJobsChecks(expected, cronJobsText) {
  const names = parseCronJobsSql(cronJobsText);
  if (names === null) return { ok: false, reason: 'restore_check_failed', expected, actual: null };
  if (names.length !== expected) return { ok: false, reason: 'restore_check_failed', expected, actual: names.length };
  return { ok: true, cron_jobs: names.length };
}

function ledgerSummary(versions) {
  return { versions_count: versions.length, max_version: versions[versions.length - 1] ?? '' };
}

/** catalog の段の判定 (§4.3 の catalog の 4) */
export function checkCatalogCapture({ csvLineCounts, ledgerText, cronJobsText, fixupsBytes }) {
  const fail = { ok: false, reason: 'catalog_failed' };
  for (const name of CATALOG_CSV_FILES) {
    const count = csvLineCounts[name];
    if (typeof count !== 'number' || count < 1) return fail;
  }
  const versions = parseLedgerVersions(ledgerText);
  if (versions === null) return fail;
  const cronNames = parseCronJobsSql(cronJobsText);
  if (cronNames === null) return fail;
  if (!(fixupsBytes >= 1)) return fail;
  return { ok: true, ledger: ledgerSummary(versions), cron_jobs: cronNames.length };
}

/** verify_baseline.py の標準出力のうち、最後の CATALOG_VERIFY_SUMMARY_LINE の行を読む (無ければ null) */
export function parseCatalogVerifySummary(stdout) {
  let found = null;
  for (const raw of String(stdout ?? '').split('\n')) {
    const m = CATALOG_VERIFY_SUMMARY_LINE.exec(stripCr(raw));
    if (m) found = { errors: Number(m[1]), warnings: Number(m[2]) };
  }
  return found;
}

/** 台帳の突き合わせ (§4.8 の 8)。版の数と最大が expected と同じ、かつ全部の版に `<版>_*.sql` があれば ok */
export function ledgerChecks(expected, versions, migrationFileNames) {
  const actual = ledgerSummary(versions);
  const versionsWithoutFiles = versions.filter(
    (version) => !migrationFileNames.some((name) => name.startsWith(`${version}_`) && name.endsWith('.sql')),
  );
  const same = actual.versions_count === expected.versions_count && actual.max_version === expected.max_version;
  if (same && versionsWithoutFiles.length === 0) return { ok: true };
  return { ok: false, reason: 'restore_check_failed', expected, actual, versions_without_files: versionsWithoutFiles };
}

/** 監査行を書く SQL (rows の順に 1 行 1 文)。details は UTF-8 の JSON を base64 にして SQL の中で jsonb に戻す (SQL に JSON の文字が出ない) */
export function buildAuditSql(rows) {
  return rows
    .map((row) => {
      const actionType = backupAuditActionType(row.tier, row.result);
      if (!BACKUP_AUDIT_ACTION_TYPES.includes(actionType)) throw new TypeError('監査行の層・結果が一覧の外です');
      const base64 = Buffer.from(JSON.stringify(row.details), 'utf8').toString('base64');
      return `SELECT public.record_backup_audit('${actionType}', pg_catalog.convert_from(pg_catalog.decode('${base64}', 'base64'), 'UTF8')::jsonb);`;
    })
    .map((statement) => `${statement}\n`)
    .join('');
}

/** 基準は manifest の dumped (ダンプの中身)。3 つとも完全一致で ok */
export function restoreChecks(expected, observed) {
  const same =
    expected.public_tables === observed.public_tables && expected.auth_users === observed.auth_users && expected.audit_rows === observed.audit_rows;
  return same ? { ok: true } : { ok: false, reason: 'restore_check_failed', expected, actual: observed };
}

export function buildManifest(input) {
  return { schema_version: MANIFEST_SCHEMA_VERSION, ...input };
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** details を作り、AUDIT_DETAILS_MAX_BYTES を超えたら inventory → restore_check の順に落とす (超えたまま送らない) */
export function buildCompletedDetails(input) {
  const details = { ...input };
  if (jsonBytes(details) > AUDIT_DETAILS_MAX_BYTES) delete details.inventory;
  if (jsonBytes(details) > AUDIT_DETAILS_MAX_BYTES) delete details.restore_check;
  if (jsonBytes(details) > AUDIT_DETAILS_MAX_BYTES) throw new RangeError('監査行の details が上限を超えます');
  return details;
}

export function buildFailedDetails(input) {
  if (!FAILURE_REASONS.includes(input.reason)) throw new TypeError('reason が FAILURE_REASONS の外です');
  if (!STAGES.includes(input.stage)) throw new TypeError('stage が STAGES の外です');
  const details = { ...input };
  if (jsonBytes(details) > AUDIT_DETAILS_MAX_BYTES) throw new RangeError('監査行の details が上限を超えます');
  return details;
}

/** 段と失敗から reason を決める (上から順): 時間切れ → timeout / 終了 75 (stats・dump・restore_env) → image_pull_unavailable / 子の失敗 → 段の既定 / ほか → unknown */
export function classifyFailure(stage, error) {
  if (error instanceof CommandTimeoutError) return 'timeout';
  if (error instanceof CommandFailedError) {
    if (error.code === IMAGE_PULL_UNAVAILABLE_EXIT_CODE && IMAGE_PULL_STAGES.has(stage)) return 'image_pull_unavailable';
    return STAGE_DEFAULT_REASON[stage] ?? 'unknown';
  }
  return 'unknown';
}

const URL_WITH_SCHEME_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
const OPAQUE_TOKEN_PATTERN = new RegExp(`[A-Za-z0-9]{${MIN_OPAQUE_TOKEN_LENGTH},}`, 'g');

/** 文を表示する前に、秘密らしい名前の環境変数の値・接続先の URL・24 文字以上の英数字の連なりを *** に伏せる (§4.10) */
export function redactForLog(text, env) {
  let result = String(text ?? '');
  const secrets = Object.entries(env ?? {})
    .filter(([name, value]) => SECRET_ENV_NAME_PATTERN.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_ENV_VALUE_LENGTH)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result.replace(URL_WITH_SCHEME_PATTERN, REDACTED).replace(OPAQUE_TOKEN_PATTERN, REDACTED);
}

/** restore の --key (アーカイブのキー) から、同じ場所の .sha256 / .manifest.json のキーを作る。形が違えば null */
export function siblingKeys(archiveKey) {
  if (typeof archiveKey !== 'string') return null;
  if (!BACKUP_TIERS.some((tier) => archiveKey.startsWith(`${tier}/`))) return null;
  if (!archiveKey.endsWith(FILE_SUFFIXES.archive)) return null;
  const base = archiveKey.slice(0, -FILE_SUFFIXES.archive.length);
  const lastPart = base.slice(base.lastIndexOf('/') + 1);
  if (lastPart === '') return null;
  return { archive: archiveKey, sha256: `${base}${FILE_SUFFIXES.sha256}`, manifest: `${base}${FILE_SUFFIXES.manifest}` };
}

/** `.sha256` の本文 (sha256sum の出力 `<hex>  <name>`) と、取ったファイルのダイジェストを比べる */
export function verifyChecksum({ sha256FileText, actualSha256 }) {
  const first = nonEmptyLines(sha256FileText)[0] ?? '';
  const expected = (/^([0-9A-Fa-f]+)\s/.exec(`${first} `)?.[1] ?? '').toLowerCase();
  const actual = String(actualSha256 ?? '').toLowerCase();
  if (expected.length === SHA256_HEX_LENGTH && expected === actual) return { ok: true };
  return {
    ok: false,
    reason: 'checksum_mismatch',
    expectedPrefix: expected.slice(0, DIGEST_PREFIX_LENGTH),
    actualPrefix: actual.slice(0, DIGEST_PREFIX_LENGTH),
  };
}

/** §4.5 の Lifecycle の JSON を RETENTION_DAYS / INFREQUENT_ACCESS_AFTER_DAYS / R2_ABORT_MULTIPART_AFTER_DAYS から作る */
export function buildR2LifecycleConfig() {
  const age = (days) => ({ type: 'Age', maxAge: days * SECONDS_PER_DAY });
  const iaTransition = () => [{ condition: age(INFREQUENT_ACCESS_AFTER_DAYS), storageClass: 'InfrequentAccess' }];
  return {
    rules: [
      { id: 'daily-expire', enabled: true, conditions: { prefix: 'daily/' }, deleteObjectsTransition: { condition: age(RETENTION_DAYS.daily) } },
      {
        id: 'weekly-ia', enabled: true, conditions: { prefix: 'weekly/' },
        storageClassTransitions: iaTransition(),
        deleteObjectsTransition: { condition: age(RETENTION_DAYS.weekly) },
      },
      {
        id: 'annual-ia', enabled: true, conditions: { prefix: 'annual/' },
        storageClassTransitions: iaTransition(),
        deleteObjectsTransition: { condition: age(RETENTION_DAYS.annual) },
      },
      { id: 'abort-multipart', enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: age(R2_ABORT_MULTIPART_AFTER_DAYS) } },
    ],
  };
}

/** §4.5 の wrangler の 4 行 (lifecycle set 1 + lock add 3) を argv の配列で作る。lock の日数は RETENTION_DAYS、名前は `<層>-<日数>d` */
export function buildR2LockCommands({ bucket, lifecycleFile }) {
  return [
    ['npx', 'wrangler', 'r2', 'bucket', 'lifecycle', 'set', bucket, '--file', lifecycleFile],
    ...BACKUP_TIERS.map((tier) => [
      'npx', 'wrangler', 'r2', 'bucket', 'lock', 'add', bucket,
      '--name', `${tier}-${RETENTION_DAYS[tier]}d`, '--prefix', `${tier}/`, '--retention-days', String(RETENTION_DAYS[tier]),
    ]),
  ];
}

/** 監査行の details と manifest の run_id・run_attempt・git_sha を GITHUB_RUN_ID・GITHUB_RUN_ATTEMPT・GITHUB_SHA から取る */
export function runIdentityFromEnv(env) {
  const attempt = parseDecimalInteger(env.GITHUB_RUN_ATTEMPT ?? '');
  return {
    run_id: isNonEmpty(env.GITHUB_RUN_ID) ? env.GITHUB_RUN_ID : RUN_ID_OUTSIDE_ACTIONS,
    run_attempt: attempt !== null && attempt >= 1 ? attempt : RUN_ATTEMPT_OUTSIDE_ACTIONS,
    git_sha: isNonEmpty(env.GITHUB_SHA) ? env.GITHUB_SHA : GIT_SHA_OUTSIDE_ACTIONS,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// run → report の結果ファイル
// ───────────────────────────────────────────────────────────────────────────

function statusFromExitCode(exitCode) {
  if (exitCode === EXIT_CODES.ok) return 'ok';
  if (exitCode === EXIT_CODES.not_configured) return 'not_configured';
  return 'failed';
}

function copyFailure(failure) {
  const out = { tier: failure.tier, stage: failure.stage, reason: failure.reason };
  if (Array.isArray(failure.missing)) out.missing = [...failure.missing];
  return out;
}

/** RunResult から結果ファイルの中身を作る */
export function toRunReport(result) {
  return {
    schema_version: RUN_REPORT_SCHEMA_VERSION,
    status: statusFromExitCode(result.exitCode),
    exit_code: result.exitCode,
    jst_date: result.plan.jst_date,
    completed: [...result.completed],
    failures: result.failed.map(copyFailure),
    warnings: result.warnings.map((w) => ({ stage: w.stage, reason: w.reason })),
    audit_written: result.auditWritten,
  };
}

/** runBackup が reject したときに runCli が書く結果ファイル */
export function unexpectedFailureReport({ jstDate }) {
  return {
    schema_version: RUN_REPORT_SCHEMA_VERSION,
    status: 'failed',
    exit_code: EXIT_CODES.failed,
    jst_date: jstDate,
    completed: [],
    failures: [],
    warnings: [],
    audit_written: false,
  };
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** 結果ファイルの本文を読む。形が違う・status が exit_code から決まる値と違う・ok なのに failures があれば null */
export function parseRunReport(text) {
  if (typeof text !== 'string') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema_version !== RUN_REPORT_SCHEMA_VERSION) return null;
  if (!['ok', 'failed', 'not_configured'].includes(value.status)) return null;
  if (!Number.isInteger(value.exit_code)) return null;
  if (typeof value.jst_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.jst_date)) return null;
  if (!Array.isArray(value.completed) || !value.completed.every((t) => BACKUP_TIERS.includes(t))) return null;
  if (!Array.isArray(value.failures)) return null;
  for (const f of value.failures) {
    if (f === null || typeof f !== 'object') return null;
    if (!BACKUP_TIERS.includes(f.tier) || !STAGES.includes(f.stage) || !FAILURE_REASONS.includes(f.reason)) return null;
    if (f.missing !== undefined && !isStringArray(f.missing)) return null;
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((w) => w && w.stage === 'inventory' && w.reason === 'inventory_failed')) return null;
  if (typeof value.audit_written !== 'boolean') return null;
  if (statusFromExitCode(value.exit_code) !== value.status) return null;
  if (value.status === 'ok' && value.failures.length > 0) return null;
  return {
    schema_version: RUN_REPORT_SCHEMA_VERSION,
    status: value.status,
    exit_code: value.exit_code,
    jst_date: value.jst_date,
    completed: [...value.completed],
    failures: value.failures.map(copyFailure),
    warnings: value.warnings.map((w) => ({ stage: w.stage, reason: w.reason })),
    audit_written: value.audit_written,
  };
}

function issueBody(lines, runUrl) {
  return [BACKUP_ISSUE_MARKER, '', ...lines, '', `実行ログ: ${runUrl}`, '', '設計: docs/design/cross/17-backup-automation.md (§4.7 の表と手順書の「困ったとき」)'].join('\n');
}

/** report の step の判定 (§4.11 の 4 通り。上から順に当てる)。body は BACKUP_ISSUE_MARKER で始まり、run の URL を含む */
export function planBackupIssue({ report, runOutcome, runUrl }) {
  if (report === null) {
    return {
      hasProblems: true,
      title: BACKUP_ISSUE_TITLE,
      body: issueBody([`run の step が結果を残さずに終わった (outcome ${runOutcome})。時間切れか取り消し。`], runUrl),
    };
  }
  if (report.status !== 'ok') {
    const lines = [`取得の結果: ${report.status} (exit_code ${report.exit_code}・${report.jst_date} JST)`, ''];
    if (report.failures.length === 0) {
      lines.push(`run の step が段の失敗として記録できずに終わった (予期しない例外。exit_code ${report.exit_code})。Actions のログを見る。`);
    } else {
      lines.push('失敗:');
      for (const f of report.failures) {
        const missing = f.missing && f.missing.length > 0 ? `・missing: ${f.missing.join(', ')}` : '';
        lines.push(`- ${f.tier}: 段 ${f.stage}・reason ${f.reason}${missing}`);
      }
    }
    lines.push('', `取得は成功した層: ${report.completed.length > 0 ? report.completed.join(', ') : '(なし)'}`);
    lines.push(`監査行: ${report.audit_written ? '書いた' : '書けなかった'}`);
    return { hasProblems: true, title: BACKUP_ISSUE_TITLE, body: issueBody(lines, runUrl) };
  }
  if (runOutcome !== 'success') {
    return {
      hasProblems: true,
      title: BACKUP_ISSUE_TITLE,
      body: issueBody([`結果ファイルと step の結果が食い違う (結果ファイルは ok、outcome ${runOutcome})。`], runUrl),
    };
  }
  return { hasProblems: false };
}

// ───────────────────────────────────────────────────────────────────────────
// 引数
// ───────────────────────────────────────────────────────────────────────────

const OPTIONS_BY_COMMAND = Object.freeze({
  run: ['--tier', '--result-file'],
  restore: ['--key', '--identity-file', '--slot'],
  'roundtrip-local': ['--slot'],
  'report-issue': ['--result-file', '--run-outcome', '--run-url'],
  'r2-config': ['--bucket', '--out-dir'],
  help: [],
});

function parseSlot(raw) {
  if (raw === undefined) return LOCAL_SLOT_DEFAULT;
  const slot = parseDecimalInteger(raw);
  if (slot === null || slot < LOCAL_SLOT_MIN || slot > LOCAL_SLOT_MAX) {
    throw new UsageError(`--slot は ${LOCAL_SLOT_MIN}〜${LOCAL_SLOT_MAX} の整数にしてください`);
  }
  return slot;
}

function requireValue(options, name) {
  const value = options[name];
  if (!isNonEmpty(value)) throw new UsageError(`${name} が必要です`);
  return value;
}

/** §4.7 の引数の表 */
export function parseArgs(argv) {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === '--help' ? 'help' : rawCommand;
  if (!Object.hasOwn(OPTIONS_BY_COMMAND, command ?? '')) throw new UsageError(`知らないサブコマンドです: ${rawCommand ?? '(なし)'}`);
  const allowed = OPTIONS_BY_COMMAND[command];
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!allowed.includes(name)) throw new UsageError(`知らないオプションです: ${name}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`同じオプションが 2 回あります: ${name}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} には値が必要です`);
    options[name] = value;
    i += 1;
  }
  switch (command) {
    case 'run': {
      const tier = options['--tier'] ?? 'auto';
      if (tier !== 'auto' && !BACKUP_TIERS.includes(tier)) throw new UsageError('--tier は auto / daily / weekly / annual のどれかにしてください');
      const resultFile = options['--result-file'];
      if (resultFile !== undefined && !isNonEmpty(resultFile)) throw new UsageError('--result-file は空でないパスにしてください');
      return { command, tier, resultFile: resultFile ?? null };
    }
    case 'restore': {
      const key = requireValue(options, '--key');
      if (siblingKeys(key) === null) throw new UsageError('--key は daily/・weekly/・annual/ で始まり .tar.zst.age で終わる R2 のキーにしてください');
      const identityFile = requireValue(options, '--identity-file');
      return { command, key, identityFile, slot: parseSlot(options['--slot']) };
    }
    case 'roundtrip-local':
      return { command, slot: parseSlot(options['--slot']) };
    case 'report-issue': {
      const resultFile = requireValue(options, '--result-file');
      const runOutcome = requireValue(options, '--run-outcome');
      if (!STEP_OUTCOMES.includes(runOutcome)) throw new UsageError(`--run-outcome は ${STEP_OUTCOMES.join(' / ')} のどれかにしてください`);
      const runUrl = requireValue(options, '--run-url');
      return { command, resultFile, runOutcome, runUrl };
    }
    case 'r2-config':
      return { command, bucket: requireValue(options, '--bucket'), outDir: requireValue(options, '--out-dir') };
    default:
      return { command: 'help' };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 子プロセスと一時ディレクトリ
// ───────────────────────────────────────────────────────────────────────────

function tailLines(text, env) {
  return redactForLog(text, env)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-STDERR_TAIL_LINES)
    .join('\n');
}

/**
 * 既定の CommandRunner。子は親の環境 (baseEnv) に options.env を重ねて動かし、値が undefined のキーは渡さない。
 * 終了コードによらず { code, stdout, stderrTail } で解決する (起こせない ENOENT は COMMAND_NOT_FOUND_EXIT_CODE)。時間切れは CommandTimeoutError で reject
 */
export function createCommandRunner(baseEnv = process.env) {
  return (cmd, args, options) =>
    new Promise((resolve, reject) => {
      const merged = { ...baseEnv };
      for (const [name, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete merged[name];
        else merged[name] = value;
      }
      const fds = [];
      const openFd = (file, flags) => {
        const fd = fs.openSync(file, flags, PRIVATE_FILE_MODE);
        fds.push(fd);
        return fd;
      };
      const closeFds = () => {
        for (const fd of fds.splice(0)) {
          try {
            fs.closeSync(fd);
          } catch {
            // すでに閉じている
          }
        }
      };
      let child;
      try {
        const stdin = options.stdinFile ? openFd(options.stdinFile, 'r') : 'ignore';
        const stdout = options.stdoutFile ? openFd(options.stdoutFile, 'w') : 'pipe';
        child = spawn(cmd, args, { cwd: options.cwd, env: merged, stdio: [stdin, stdout, 'pipe'] });
      } catch (error) {
        closeFds();
        reject(error);
        return;
      }
      const stderrCopy = options.stderrFile ? fs.createWriteStream(options.stderrFile, { mode: PRIVATE_FILE_MODE }) : null;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeFds();
        const done = () => fn();
        if (stderrCopy) stderrCopy.end(done);
        else done();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(new CommandTimeoutError(cmd, options.timeoutMs)));
      }, options.timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderrCopy?.write(chunk);
        stderr += chunk;
        if (stderr.length > STDERR_CAPTURE_MAX_BYTES) stderr = stderr.slice(-STDERR_CAPTURE_MAX_BYTES);
      });
      child.on('error', (error) => {
        if (error && error.code === 'ENOENT') finish(() => resolve({ code: COMMAND_NOT_FOUND_EXIT_CODE, stdout: '', stderrTail: '' }));
        else finish(() => reject(error));
      });
      child.on('close', (code, signal) => {
        const exitCode = code ?? (signal ? SIGNAL_EXIT_CODE_BASE + (os.constants.signals[signal] ?? 0) : EXIT_CODES.failed);
        finish(() => resolve({ code: exitCode, stdout, stderrTail: tailLines(stderr, merged) }));
      });
    });
}

/** シグナルで止まったときに消す一時ディレクトリ (runCli が受け手を置く) */
const liveTempDirs = new Set();

function makeWorkDir(deps) {
  let dir;
  if (deps.workDir) {
    fs.mkdirSync(deps.workDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    dir = deps.workDir;
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), WORK_DIR_PREFIX));
  }
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
  liveTempDirs.add(dir);
  return dir;
}

function removeWorkDir(dir, log) {
  liveTempDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    log(`[db-backup] 警告: 一時ディレクトリを消せませんでした (${error?.name ?? 'Error'})`);
  }
}

/** SIGINT / SIGTERM / SIGHUP で一時ディレクトリを消してから 128 + シグナル番号で終わる受け手を置く。返した関数で外す */
export function installSignalCleanup(proc = process) {
  const onSignal = (signal) => {
    for (const dir of liveTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 消せなくても終わることを優先する (runner は job の終わりに消える)
      }
    }
    liveTempDirs.clear();
    proc.exit(SIGNAL_EXIT_CODE_BASE + (os.constants.signals[signal] ?? 0));
  };
  for (const name of CLEANUP_SIGNALS) proc.on(name, onSignal);
  return () => {
    for (const name of CLEANUP_SIGNALS) proc.removeListener(name, onSignal);
  };
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
}

function readTextOr(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function fileLines(file) {
  return readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function countFileLines(file) {
  if (!fs.existsSync(file)) return null;
  return nonEmptyLines(fs.readFileSync(file, 'utf8')).length;
}

async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function seconds(fromMs, toMs) {
  return Math.round((toMs - fromMs) / MS_PER_SECOND);
}

/** 子プロセスを 1 つ動かし、0 でなければ CommandFailedError を投げる */
async function mustRun(ctx, cmd, args, options) {
  const result = await ctx.run(cmd, args, options);
  if (result.code !== 0) {
    if (result.stderrTail) ctx.log(`[db-backup] ${cmd} の標準エラー出力 (末尾・伏せ字):\n${result.stderrTail}`);
    throw new CommandFailedError(cmd, result.code);
  }
  return result;
}

function psql(ctx, script, env, options) {
  return mustRun(ctx, 'bash', ['-c', PSQL_SCRIPTS[script]], { ...options, env });
}

// ───────────────────────────────────────────────────────────────────────────
// 3 つの入口が共有する内部の関数 (§5.1 の後の段落)
// ───────────────────────────────────────────────────────────────────────────

function supabaseCli(...args) {
  return ['--yes', `supabase@${SUPABASE_CLI_VERSION}`, ...args];
}

/** dump の 3 回 (fallback で包む)。target は { linked: true } か { dbUrl } */
async function dumpDatabase(ctx, target, workDir, timeoutMs) {
  const targetArgs = target.linked ? ['--linked'] : ['--db-url', target.dbUrl];
  const dumps = [
    ['roles', ['-f', path.join(workDir, 'roles.sql'), '--role-only']],
    ['schema', ['-f', path.join(workDir, 'schema.sql')]],
    [
      'data',
      [
        '-f', path.join(workDir, 'data.sql'), '--data-only', '--use-copy',
        '-s', DATA_DUMP_SCHEMAS.join(','),
        ...DUMP_EXCLUDED_TABLES.flatMap((table) => ['-x', table]),
      ],
    ],
  ];
  for (const [label, args] of dumps) {
    await mustRun(
      ctx,
      'bash',
      [IMAGE_PULL_FALLBACK_SCRIPT, '--step', `db-backup dump ${label}`, '--', 'npx', ...supabaseCli('db', 'dump', ...targetArgs, ...args)],
      { timeoutMs },
    );
  }
}

/** catalog の段 (§4.3 の catalog の 1〜3)。戻り値は checkCatalogCapture の入力 */
async function captureCatalog(ctx, { pgUrl, pgPassword, workDir, schemaFile, timeoutMs }) {
  const catalogDir = path.join(workDir, CATALOG_DIR);
  fs.mkdirSync(catalogDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const baseEnv = pgPassword === undefined ? { PG_URL: pgUrl } : { PG_URL: pgUrl, PGPASSWORD: pgPassword };
  await psql(ctx, 'catalog', { ...baseEnv, PSQL_FILE: path.resolve(CATALOG_SNAPSHOT_SQL) }, { timeoutMs, cwd: catalogDir });
  const ledgerQuery = path.join(workDir, 'ledger-query.sql');
  writePrivate(ledgerQuery, `${LEDGER_VERSIONS_SQL}\n`);
  const ledgerFile = path.join(workDir, LEDGER_FILE);
  await psql(ctx, 'count', { ...baseEnv, PSQL_FILE: ledgerQuery }, { timeoutMs, stdoutFile: ledgerFile });
  const cronQuery = path.join(workDir, 'cron-jobs-query.sql');
  writePrivate(cronQuery, `${CRON_JOBS_SQL}\n`);
  const cronFile = path.join(workDir, CRON_JOBS_FILE);
  await psql(ctx, 'count', { ...baseEnv, PSQL_FILE: cronQuery }, { timeoutMs, stdoutFile: cronFile });
  const fixupsFile = path.join(workDir, RESTORE_FIXUPS_FILE);
  await mustRun(ctx, PYTHON_COMMAND, [RESTORE_FIXUPS_BUILDER_SCRIPT, catalogDir, schemaFile, fixupsFile], { timeoutMs });
  const csvLineCounts = {};
  for (const name of CATALOG_CSV_FILES) csvLineCounts[name] = countFileLines(path.join(catalogDir, name));
  return {
    csvLineCounts,
    ledgerText: readTextOr(ledgerFile, ''),
    cronJobsText: readTextOr(cronFile, ''),
    fixupsBytes: fileSize(fixupsFile),
  };
}

function logCatalog(ctx, capture, checked) {
  const csv = CATALOG_CSV_FILES.map((name) => `${name}=${capture.csvLineCounts[name] ?? 'なし'}`).join(' ');
  ctx.log(`[db-backup] catalog: ${csv}`);
  if (checked.ok) {
    ctx.log(`[db-backup] catalog: 台帳 ${checked.ledger.versions_count} 版 (最大 ${checked.ledger.max_version})・cron のジョブ ${checked.cron_jobs} 本・fixups.sql ${capture.fixupsBytes} bytes`);
  }
}

/** ローカルのスタックを起こして接続先を返す (§4.8 の 1)。psql と python3 の確認 → start → env */
async function localPgUrl(ctx, slot, timeoutMs) {
  const versionResult = await psql(ctx, 'version', undefined, { timeoutMs });
  ctx.log(`[db-backup] ${String(versionResult.stdout).trim()}`);
  const pythonResult = await mustRun(ctx, PYTHON_COMMAND, ['--version'], { timeoutMs });
  ctx.log(`[db-backup] ${String(pythonResult.stdout).trim()}`);
  const slotEnv = { [LOCAL_SLOT_ENV]: String(slot) };
  await mustRun(ctx, 'bash', [SUPABASE_LOCAL_SCRIPT, 'start'], { timeoutMs, env: slotEnv });
  const envResult = await mustRun(ctx, 'bash', [SUPABASE_LOCAL_SCRIPT, 'env'], { timeoutMs, env: slotEnv });
  const url = parseLocalDbUrl(envResult.stdout);
  if (url === null) throw new StageFailure('restore_env_failed');
  return `${url}${LOCAL_PG_SSLMODE_QUERY}`;
}

/** 復元の前に空にする (§4.8 の 2) */
async function resetForRestore(ctx, { pgUrl, managedTables, workDir, timeoutMs }) {
  const resetFile = path.join(workDir, 'reset.sql');
  writePrivate(resetFile, buildResetSql(managedTables));
  await psql(ctx, 'reset', { PG_URL: pgUrl, PSQL_FILE: resetFile }, { timeoutMs });
}

/** roles → restore → fixups (§4.8 の 3〜5) */
async function restoreDatabase(ctx, { pgUrl, plainDir, workDir, timeoutMs }) {
  const rolesStderr = path.join(workDir, 'roles.stderr');
  await psql(ctx, 'roles', { PG_URL: pgUrl, PSQL_FILE: path.join(plainDir, 'roles.sql') }, { timeoutMs, stderrFile: rolesStderr });
  const roleErrors = countRoleRestoreErrors(readTextOr(rolesStderr, ''));
  ctx.log(`[db-backup] roles.sql: すでにあるロール (${ROLES_TOLERATED_SQLSTATE}) ${roleErrors.tolerated} 件`);
  if (roleErrors.others.length > 0) {
    ctx.log(`[db-backup] roles.sql: 許さない SQLSTATE ${roleErrors.others.join(', ')}`);
    throw new StageFailure('restore_check_failed', { others: roleErrors.others });
  }
  await psql(
    ctx,
    'restore',
    { PG_URL: pgUrl, SCHEMA_FILE: path.join(plainDir, 'schema.sql'), DATA_FILE: path.join(plainDir, 'data.sql') },
    { timeoutMs },
  );
  await psql(ctx, 'reset', { PG_URL: pgUrl, PSQL_FILE: path.join(plainDir, RESTORE_FIXUPS_FILE) }, { timeoutMs });
}

/** 復元した後の数 (§4.8 の 6)。読めなければ restore_check_failed */
async function countRestored(ctx, { pgUrl, workDir, timeoutMs }) {
  const countFile = path.join(workDir, 'count.sql');
  writePrivate(countFile, `${RESTORE_COUNT_SQL}\n`);
  const result = await psql(ctx, 'count', { PG_URL: pgUrl, PSQL_FILE: countFile }, { timeoutMs });
  const counts = parseRestoreCounts(result.stdout);
  if (counts === null) throw new StageFailure('restore_check_failed');
  return counts;
}

/** 復元した DB のカタログを取り、verify_baseline.py で比べる (§4.8 の 7)。errors が 0 でなければ restore_check_failed */
async function verifyRestoredCatalog(ctx, { pgUrl, catalogDir, workDir, timeoutMs, fullOutput }) {
  const restoredDir = path.join(workDir, RESTORED_CATALOG_DIR);
  fs.mkdirSync(restoredDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await psql(ctx, 'catalog', { PG_URL: pgUrl, PSQL_FILE: path.resolve(CATALOG_SNAPSHOT_SQL) }, { timeoutMs, cwd: restoredDir });
  const result = await ctx.run(PYTHON_COMMAND, [CATALOG_VERIFY_SCRIPT, catalogDir, restoredDir], { timeoutMs });
  if (fullOutput) {
    for (const line of String(result.stdout).split('\n')) if (line.trim() !== '') ctx.log(line);
  }
  if (result.code !== 0 && result.code !== EXIT_CODES.failed) throw new CommandFailedError(PYTHON_COMMAND, result.code);
  const summary = parseCatalogVerifySummary(result.stdout);
  if (summary !== null) ctx.log(`[db-backup] verify_baseline: errors=${summary.errors} warnings=${summary.warnings}`);
  if (result.code !== 0 || summary === null || summary.errors !== 0) {
    throw new StageFailure('restore_check_failed', { catalog_errors: summary?.errors ?? null, catalog_warnings: summary?.warnings ?? null });
  }
  return summary;
}

/** cron_jobs.sql を確定させずに流す (roundtrip-local だけ。§4.8 の 8) */
async function cronDryRun(ctx, { pgUrl, cronJobsFile, timeoutMs }) {
  await psql(ctx, 'cron_dry_run', { PG_URL: pgUrl, PSQL_FILE: cronJobsFile }, { timeoutMs });
}

function migrationFileNames() {
  try {
    return fs.readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }
}

/** §4.8 の 6〜8 の突き合わせ (数・カタログ・台帳・cron)。restore_check の段。失敗は StageFailure か子の失敗の例外 */
async function checkRestored(ctx, { pgUrl, plainDir, catalogDir, workDir, timeoutMs, fullOutput, expected, partial }) {
  const counts = await countRestored(ctx, { pgUrl, workDir, timeoutMs });
  partial.counts = counts;
  ctx.log(`[db-backup] 復元した数: 表 ${counts.public_tables}・利用者 ${counts.auth_users}・監査行 ${counts.audit_rows}`);
  const countCheck = restoreChecks(expected.dumped, counts);
  if (!countCheck.ok) {
    ctx.log(`[db-backup] 数が合いません: 期待 ${JSON.stringify(countCheck.expected)}・実際 ${JSON.stringify(countCheck.actual)}`);
    throw new StageFailure('restore_check_failed');
  }
  const summary = await verifyRestoredCatalog(ctx, { pgUrl, catalogDir, workDir, timeoutMs, fullOutput });
  partial.catalog_errors = summary.errors;
  partial.catalog_warnings = summary.warnings;
  const versions = parseLedgerVersions(readTextOr(path.join(plainDir, LEDGER_FILE), ''));
  if (versions === null) throw new StageFailure('restore_check_failed');
  partial.ledger_versions = versions.length;
  const ledger = ledgerChecks(expected.ledger, versions, migrationFileNames());
  if (!ledger.ok) {
    ctx.log(`[db-backup] 台帳が合いません: 期待 ${JSON.stringify(ledger.expected)}・実際 ${JSON.stringify(ledger.actual)}・ファイルの無い版 ${ledger.versions_without_files.join(', ') || '(なし)'}`);
    throw new StageFailure('restore_check_failed');
  }
  const cron = cronJobsChecks(expected.cron_jobs, readTextOr(path.join(plainDir, CRON_JOBS_FILE), ''));
  if (!cron.ok) {
    ctx.log(`[db-backup] cron のジョブの数が合いません: 期待 ${cron.expected}・実際 ${cron.actual ?? '読めない'}`);
    throw new StageFailure('restore_check_failed');
  }
  partial.cron_jobs = cron.cron_jobs;
  return counts;
}

function restoreCheckResult(result, partial, startedMs, endedMs) {
  return {
    result,
    public_tables: partial.counts?.public_tables ?? 0,
    auth_users: partial.counts?.auth_users ?? 0,
    audit_rows: partial.counts?.audit_rows ?? 0,
    catalog_errors: partial.catalog_errors ?? null,
    catalog_warnings: partial.catalog_warnings ?? null,
    ledger_versions: partial.ledger_versions ?? null,
    cron_jobs: partial.cron_jobs ?? null,
    duration_seconds: seconds(startedMs, endedMs),
  };
}

function reasonOf(stage, error) {
  return error instanceof StageFailure ? error.reason : classifyFailure(stage, error);
}

// ───────────────────────────────────────────────────────────────────────────
// run (取得の 1 本道)
// ───────────────────────────────────────────────────────────────────────────

export async function runBackup(options, deps) {
  const { run, env, now, log } = deps;
  const ctx = { run, env, log };
  const startedAt = now();
  const startedMs = startedAt.getTime();
  const plan = planRun({ now: startedAt, tierOverride: options.tier });
  const identity = runIdentityFromEnv(env);
  const tuningResolved = resolveRunTuning(env);
  let tuning = tuningResolved.ok ? tuningResolved.tuning : defaultTuning();
  /** 層ごとの最初の失敗 (監査行に書く stage / reason と details の補い) */
  const tierFailures = new Map();
  const failed = [];
  const warnings = [];
  let configFailed = false;
  let linked = false;
  let auditWritten = false;
  let poolerUrl = null;
  let workDir = null;
  /** 監査行の completed の details の材料 */
  let archiveInfo = null;
  let dumped = null;
  let inventory;
  const restoreResults = new Map();

  const failTier = (tier, stage, reason, extra = {}) => {
    const entry = { tier, stage, reason };
    if (extra.missing) entry.missing = [...extra.missing];
    failed.push(entry);
    if (!tierFailures.has(tier)) tierFailures.set(tier, { stage, reason, ...extra });
  };
  const failAll = (stage, reason, extra = {}) => {
    for (const tier of plan.tiers) failTier(tier, stage, reason, extra);
  };
  const timed = async (stage, fn) => {
    const t0 = now().getTime();
    await fn();
    log(`[db-backup] ${stage}: 終わりました (${seconds(t0, now().getTime())} 秒)`);
  };

  log(`[db-backup] 取得を始めます: ${plan.jst_date} (JST)・層 ${plan.tiers.join(', ')}・${plan.basename}`);

  try {
    // link
    try {
      await timed('link', () =>
        mustRun(ctx, 'npx', supabaseCli('link', '--project-ref', SUPABASE_PROJECT_REF), { timeoutMs: stageTimeoutMs('link', tuning) }),
      );
      linked = true;
    } catch (error) {
      failAll('link', reasonOf('link', error));
      return finishRun();
    }

    workDir = makeWorkDir(deps);

    // config
    const config = checkConfig(env);
    if (!config.ok) {
      configFailed = true;
      log(`[db-backup] config: 設定がそろっていません (名前: ${config.missing.join(', ')})`);
      failAll('config', 'not_configured', { missing: config.missing });
      await writeAudit();
      return finishRun();
    }
    tuning = tuningResolved.ok ? tuningResolved.tuning : tuning;
    const bucket = env.BACKUP_R2_BUCKET.trim();
    const endpoint = r2EndpointUrl(env.BACKUP_R2_ACCOUNT_ID.trim());
    const awsEnv = awsCommandEnv(env);
    const awsTail = ['--endpoint-url', endpoint, '--region', R2_REGION];

    // stats / dump / catalog / verify / archive / encrypt / upload: どれかが失敗すれば全層を失敗にして audit へ
    let stage = 'stats';
    let source;
    let ledger;
    let cronJobs;
    let dataScan;
    const archivePath = path.join(workDir, `${plan.basename}${FILE_SUFFIXES.archive}`);
    const shaPath = path.join(workDir, `${plan.basename}${FILE_SUFFIXES.sha256}`);
    const manifestPath = path.join(workDir, `${plan.basename}${FILE_SUFFIXES.manifest}`);
    const localFiles = { archive: archivePath, sha256: shaPath, manifest: manifestPath };
    try {
      poolerUrl = fs.readFileSync(SUPABASE_TEMP_POOLER_URL_FILE, 'utf8').trim();
      const pgUrl = `${poolerUrl}${REMOTE_PG_SSLMODE_QUERY}`;
      const pgPassword = env.SUPABASE_DB_PASSWORD;
      const postgresVersion = fs.readFileSync(SUPABASE_TEMP_POSTGRES_VERSION_FILE, 'utf8').trim();

      await timed('stats', async () => {
        const statsFile = path.join(workDir, 'stats.txt');
        await mustRun(
          ctx,
          'bash',
          [IMAGE_PULL_FALLBACK_SCRIPT, '--step', 'db-backup stats', '--stdout', statsFile, '--', 'bash', '-c', STATS_DOCKER_SCRIPT],
          { timeoutMs: stageTimeoutMs('stats', tuning), env: { PG_IMAGE_TAG: postgresVersion, PG_URL: pgUrl, STATS_SQL, PGPASSWORD: pgPassword } },
        );
        source = parseSourceStats(readTextOr(statsFile, ''));
        if (source === null) throw new StageFailure('stats_failed');
        log(`[db-backup] stats (記録だけ): 表 ${source.public_tables}・利用者 ${source.auth_users}・DB ${source.db_size_bytes} bytes`);
      });

      stage = 'dump';
      await timed('dump', () => dumpDatabase(ctx, { linked: true }, workDir, stageTimeoutMs('dump', tuning)));

      stage = 'catalog';
      await timed('catalog', async () => {
        const capture = await captureCatalog(ctx, {
          pgUrl, pgPassword, workDir, schemaFile: path.join(workDir, 'schema.sql'), timeoutMs: stageTimeoutMs('catalog', tuning),
        });
        const checked = checkCatalogCapture(capture);
        logCatalog(ctx, capture, checked);
        if (!checked.ok) throw new StageFailure('catalog_failed');
        ledger = checked.ledger;
        cronJobs = checked.cron_jobs;
      });

      stage = 'verify';
      await timed('verify', async () => {
        const schemaScan = await scanSchemaSql(fileLines(path.join(workDir, 'schema.sql')));
        dataScan = await scanDataSql(fileLines(path.join(workDir, 'data.sql')));
        const fileSizes = {};
        for (const name of DUMP_FILES) fileSizes[name] = fileSize(path.join(workDir, name));
        const verified = verifyDumpFiles({ fileSizes, data: dataScan, schema: schemaScan });
        if (!verified.ok) {
          log(`[db-backup] verify: ダンプがそろっていません (期待 ${verified.expected}・実際 ${verified.actual})`);
          throw new StageFailure('dump_incomplete', { expected: verified.expected, actual: verified.actual });
        }
        dumped = verified.dumped;
        log(`[db-backup] verify: 表 ${dumped.public_tables}・利用者 ${dumped.auth_users}・監査行 ${dumped.audit_rows}`);
      });

      stage = 'archive';
      const zstPath = path.join(workDir, `${plan.basename}.tar.zst`);
      await timed('archive', () =>
        mustRun(ctx, 'bash', ['-c', ARCHIVE_SCRIPT, 'archive', workDir, `-${tuning.zstdLevel}`, zstPath, ...ARCHIVE_ENTRIES], {
          timeoutMs: stageTimeoutMs('archive', tuning),
        }),
      );

      stage = 'encrypt';
      await timed('encrypt', async () => {
        await mustRun(ctx, 'age', ['-r', env.BACKUP_AGE_RECIPIENT.trim(), '-o', archivePath, zstPath], { timeoutMs: stageTimeoutMs('encrypt', tuning) });
        fs.rmSync(zstPath, { force: true });
        const digest = await sha256OfFile(archivePath);
        writePrivate(shaPath, `${digest}  ${path.basename(archivePath)}\n`);
        const sizeBytes = fileSize(archivePath);
        archiveInfo = { sha256: digest, size_bytes: sizeBytes };
        const manifest = buildManifest({
          captured_at: startedAt.toISOString(),
          jst_date: plan.jst_date,
          tiers: [...plan.tiers],
          basename: plan.basename,
          git_sha: identity.git_sha,
          supabase_cli: SUPABASE_CLI_VERSION,
          postgres_version: postgresVersion,
          age_recipient: env.BACKUP_AGE_RECIPIENT.trim(),
          excluded_tables: [...DUMP_EXCLUDED_TABLES],
          data_schemas: [...DATA_DUMP_SCHEMAS],
          source,
          dumped,
          ledger,
          cron_jobs: cronJobs,
          files: [
            { name: path.basename(archivePath), size_bytes: sizeBytes, sha256: digest },
            { name: path.basename(shaPath), size_bytes: fileSize(shaPath), sha256: null },
          ],
        });
        writePrivate(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        log(`[db-backup] 書庫: ${sizeBytes} bytes・sha256 ${digest.slice(0, DIGEST_PREFIX_LENGTH)}`);
      });

      stage = 'upload';
      await timed('upload', () =>
        sendToTier(ctx, { tier: 'daily', plan, localFiles, bucket, awsEnv, awsTail, timeoutMs: stageTimeoutMs('upload', tuning), mismatchReason: 'upload_size_mismatch' }),
      );
    } catch (error) {
      failAll(stage, reasonOf(stage, error), error instanceof StageFailure ? pickNumbers(error.info) : {});
      await writeAudit();
      return finishRun();
    }

    // copy (層ごと)
    const copiedTiers = [];
    for (const tier of plan.tiers.filter((t) => t !== 'daily')) {
      try {
        await timed(`copy ${tier}`, () =>
          sendToTier(ctx, { tier, plan, localFiles, bucket, awsEnv, awsTail, timeoutMs: stageTimeoutMs('copy', tuning), mismatchReason: 'copy_failed' }),
        );
        copiedTiers.push(tier);
      } catch (error) {
        failTier(tier, 'copy', reasonOf('copy', error));
      }
    }

    // inventory (失敗しても進む)
    try {
      const counts = {};
      for (const tier of BACKUP_TIERS) {
        const result = await mustRun(
          ctx,
          'aws',
          ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', `${tier}/`, '--no-paginate', '--query', 'KeyCount', '--output', 'text', ...awsTail],
          { timeoutMs: stageTimeoutMs('inventory', tuning), env: awsEnv },
        );
        const value = parseDecimalInteger(String(result.stdout).trim());
        if (value === null) throw new StageFailure('inventory_failed');
        counts[`${tier}_objects`] = value;
      }
      inventory = counts;
      log(`[db-backup] inventory: daily ${counts.daily_objects}・weekly ${counts.weekly_objects}・annual ${counts.annual_objects}`);
    } catch {
      warnings.push({ stage: 'inventory', reason: 'inventory_failed' });
      log('[db-backup] 警告: inventory が取れませんでした (取得は続けます)');
    }

    // restore_check (copy に成功した weekly / annual があるときだけ 1 回)
    if (copiedTiers.length > 0) {
      const checkStarted = now().getTime();
      const timeoutMs = stageTimeoutMs('restore_check', tuning);
      const partial = {};
      let pgUrl;
      try {
        pgUrl = await localPgUrl(ctx, LOCAL_SLOT_DEFAULT, timeoutMs);
      } catch (error) {
        for (const tier of copiedTiers) failTier(tier, 'restore_check', reasonOf('restore_env', error));
        pgUrl = null;
      }
      if (pgUrl !== null) {
        try {
          await resetForRestore(ctx, { pgUrl, managedTables: managedTablesInDump(dataScan), workDir, timeoutMs });
          await restoreDatabase(ctx, { pgUrl, plainDir: workDir, workDir, timeoutMs });
          await checkRestored(ctx, {
            pgUrl, plainDir: workDir, catalogDir: path.join(workDir, CATALOG_DIR), workDir, timeoutMs, fullOutput: false,
            expected: { dumped, ledger, cron_jobs: cronJobs }, partial,
          });
          const checks = restoreCheckResult('passed', partial, checkStarted, now().getTime());
          for (const tier of copiedTiers) restoreResults.set(tier, checks);
          log(`[db-backup] restore_check: 合格 (${checks.duration_seconds} 秒)`);
        } catch (error) {
          for (const tier of copiedTiers) failTier(tier, 'restore_check', reasonOf('restore_check', error));
        }
      }
    }

    await writeAudit();
    return finishRun();
  } finally {
    if (workDir !== null) removeWorkDir(workDir, log);
  }

  function pickNumbers(info) {
    const out = {};
    if (Number.isInteger(info?.expected)) out.expected = info.expected;
    if (Number.isInteger(info?.actual)) out.actual = info.actual;
    return out;
  }

  function completedTiers() {
    return plan.tiers.filter((tier) => !tierFailures.has(tier));
  }

  async function writeAudit() {
    if (!linked || workDir === null) return;
    const durationSeconds = seconds(startedMs, now().getTime());
    try {
      const rows = plan.tiers.map((tier) => {
        const failure = tierFailures.get(tier);
        if (failure) {
          const details = {
            tier, stage: failure.stage, reason: failure.reason, duration_seconds: durationSeconds, ...identity,
          };
          if (failure.missing) details.missing = [...failure.missing];
          if (Number.isInteger(failure.expected)) details.expected = failure.expected;
          if (Number.isInteger(failure.actual)) details.actual = failure.actual;
          if (archiveInfo && (failure.stage === 'copy' || failure.stage === 'restore_check')) {
            details.key = plan.keys[tier].archive;
            details.copied_from = plan.keys.daily.archive;
          }
          return { tier, result: 'failed', details: buildFailedDetails(details) };
        }
        const details = {
          tier,
          key: plan.keys[tier].archive,
          sha256: archiveInfo.sha256,
          size_bytes: archiveInfo.size_bytes,
          captured_at: startedAt.toISOString(),
          duration_seconds: durationSeconds,
          public_tables: dumped.public_tables,
          auth_users: dumped.auth_users,
          ...identity,
        };
        if (tier !== 'daily') details.copied_from = plan.keys.daily.archive;
        if (restoreResults.has(tier)) details.restore_check = restoreResults.get(tier);
        if (tier === 'daily' && inventory) details.inventory = inventory;
        return { tier, result: 'completed', details: buildCompletedDetails(details) };
      });
      const auditFile = path.join(workDir, 'audit.sql');
      writePrivate(auditFile, buildAuditSql(rows));
      await psql(
        ctx,
        'audit',
        { PG_URL: `${poolerUrl ?? readTextOr(SUPABASE_TEMP_POOLER_URL_FILE, '').trim()}${REMOTE_PG_SSLMODE_QUERY}`, PGPASSWORD: env.SUPABASE_DB_PASSWORD, PSQL_FILE: auditFile },
        { timeoutMs: stageTimeoutMs('audit', tuning) },
      );
      auditWritten = true;
      log(`[db-backup] audit: ${rows.length} 行を書きました (${rows.map((r) => backupAuditActionType(r.tier, r.result)).join(', ')})`);
    } catch (error) {
      const reason = classifyFailure('audit', error);
      for (const tier of plan.tiers) failed.push({ tier, stage: 'audit', reason });
      log(`[db-backup] audit: 監査行を書けませんでした (reason ${reason})`);
    }
  }

  function finishRun() {
    const exitCode = configFailed ? EXIT_CODES.not_configured : failed.length > 0 ? EXIT_CODES.failed : EXIT_CODES.ok;
    const completed = linked ? completedTiers() : [];
    log(`[db-backup] 終わりました: 終了 ${exitCode}・成功した層 ${completed.join(', ') || '(なし)'}・失敗 ${failed.length} 件`);
    return { ok: exitCode === EXIT_CODES.ok, exitCode, plan, completed, failed, warnings, auditWritten };
  }
}

/** 手元の 3 ファイルを層のキーへ送り (aws s3 cp)、head-object の大きさを突き合わせる (upload と copy が同じ形。§4.4) */
async function sendToTier(ctx, { tier, plan, localFiles, bucket, awsEnv, awsTail, timeoutMs, mismatchReason }) {
  const suffixes = Object.keys(FILE_SUFFIXES);
  for (const suffix of suffixes) {
    await mustRun(ctx, 'aws', ['s3', 'cp', localFiles[suffix], r2ObjectUri(bucket, plan.keys[tier][suffix]), ...awsTail], { timeoutMs, env: awsEnv });
  }
  for (const suffix of suffixes) {
    const key = plan.keys[tier][suffix];
    const result = await mustRun(ctx, 'aws', ['s3api', 'head-object', '--bucket', bucket, '--key', key, ...awsTail], { timeoutMs, env: awsEnv });
    let remoteSize = null;
    try {
      const parsed = JSON.parse(String(result.stdout));
      remoteSize = Number.isInteger(parsed?.ContentLength) ? parsed.ContentLength : null;
    } catch {
      remoteSize = null;
    }
    if (remoteSize !== fileSize(localFiles[suffix])) {
      ctx.log(`[db-backup] ${tier}: ${FILE_SUFFIXES[suffix]} の大きさが合いません`);
      throw new StageFailure(mismatchReason);
    }
    ctx.log(`[db-backup] ${tier}: ${key} (${remoteSize} bytes)`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// restore (オーナーが手元で流す)
// ───────────────────────────────────────────────────────────────────────────

export async function restoreFromArchive(options, deps) {
  const { run, env, now, log } = deps;
  const logError = deps.logError ?? log;
  const ctx = { run, env, log };
  const fail = (stage, reason, exitCode = EXIT_CODES.failed) => {
    logError(`[db-backup restore] 失敗: 段 ${stage}・reason ${reason}`);
    return { ok: false, exitCode, stage, reason };
  };

  const config = checkRestoreConfig(env);
  if (!config.ok) {
    logError(`[db-backup restore] 手元のシェルの設定がそろっていません (名前: ${config.missing.join(', ')})。手順書 §5`);
    return fail('config', 'not_configured', EXIT_CODES.not_configured);
  }
  const tuning = config.tuning;
  const keys = siblingKeys(options.key);
  if (keys === null) return fail('config', 'not_configured', EXIT_CODES.usage);
  const bucket = env.BACKUP_R2_BUCKET.trim();
  const awsEnv = awsCommandEnv(env);
  const awsTail = ['--endpoint-url', r2EndpointUrl(env.BACKUP_R2_ACCOUNT_ID.trim()), '--region', R2_REGION];

  const workDir = makeWorkDir(deps);
  const plainDir = path.join(workDir, 'plain');
  const startedMs = now().getTime();
  let stage = 'download';
  const partial = {};
  try {
    const local = {};
    for (const suffix of Object.keys(FILE_SUFFIXES)) {
      const key = keys[suffix];
      local[suffix] = path.join(workDir, key.slice(key.lastIndexOf('/') + 1));
      await mustRun(ctx, 'aws', ['s3', 'cp', r2ObjectUri(bucket, key), local[suffix], ...awsTail], {
        timeoutMs: restoreStageTimeoutMs('download', tuning), env: awsEnv,
      });
    }

    stage = 'checksum';
    const actual = await sha256OfFile(local.archive);
    const checksum = verifyChecksum({ sha256FileText: readTextOr(local.sha256, ''), actualSha256: actual });
    if (!checksum.ok) {
      logError(`[db-backup restore] ダイジェストが合いません: .sha256 ${checksum.expectedPrefix}・取ったファイル ${checksum.actualPrefix}`);
      throw new StageFailure('checksum_mismatch');
    }

    stage = 'decrypt';
    const zstPath = local.archive.slice(0, -'.age'.length);
    await mustRun(ctx, 'age', ['-d', '-i', options.identityFile, '-o', zstPath, local.archive], { timeoutMs: restoreStageTimeoutMs('decrypt', tuning) });

    stage = 'extract';
    const tarPath = zstPath.slice(0, -'.zst'.length);
    await mustRun(ctx, 'zstd', ['-q', '-d', '-o', tarPath, zstPath], { timeoutMs: restoreStageTimeoutMs('extract', tuning) });
    fs.mkdirSync(plainDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await mustRun(ctx, 'tar', ['-C', plainDir, '-xf', tarPath], { timeoutMs: restoreStageTimeoutMs('extract', tuning) });
    fs.rmSync(zstPath, { force: true });
    fs.rmSync(tarPath, { force: true });
    const missingEntries = ARCHIVE_ENTRIES.filter((name) => !fs.existsSync(path.join(plainDir, name)));
    if (missingEntries.length > 0) {
      logError(`[db-backup restore] 書庫に無いもの: ${missingEntries.join(', ')}`);
      throw new StageFailure('extract_failed');
    }

    stage = 'restore_env';
    const pgUrl = await localPgUrl(ctx, options.slot, restoreStageTimeoutMs('restore_env', tuning));

    stage = 'restore';
    const restoreTimeout = restoreStageTimeoutMs('restore', tuning);
    const dataScan = await scanDataSql(fileLines(path.join(plainDir, 'data.sql')));
    await resetForRestore(ctx, { pgUrl, managedTables: managedTablesInDump(dataScan), workDir, timeoutMs: restoreTimeout });
    await restoreDatabase(ctx, { pgUrl, plainDir, workDir, timeoutMs: restoreTimeout });

    stage = 'restore_check';
    let manifest;
    try {
      manifest = JSON.parse(readTextOr(local.manifest, ''));
    } catch {
      throw new StageFailure('restore_check_failed');
    }
    if (!manifest || typeof manifest !== 'object' || !manifest.dumped || !manifest.ledger || !Number.isInteger(manifest.cron_jobs)) {
      throw new StageFailure('restore_check_failed');
    }
    await checkRestored(ctx, {
      pgUrl, plainDir, catalogDir: path.join(plainDir, CATALOG_DIR), workDir, timeoutMs: restoreStageTimeoutMs('restore_check', tuning), fullOutput: true,
      expected: { dumped: manifest.dumped, ledger: manifest.ledger, cron_jobs: manifest.cron_jobs }, partial,
    });
    const checks = restoreCheckResult('passed', partial, startedMs, now().getTime());
    log(`[db-backup restore] 復元できました: ${JSON.stringify(checks)}`);
    log(`[db-backup restore] ローカルのスタック (枠 ${options.slot}) は止めていません。止めるときは ${LOCAL_SLOT_ENV}=${options.slot} bash ${SUPABASE_LOCAL_SCRIPT} stop`);
    return { ok: true, exitCode: EXIT_CODES.ok, checks };
  } catch (error) {
    const reason = reasonOf(stage, error);
    const result = fail(stage, reason);
    if (stage === 'restore_check') result.checks = restoreCheckResult('failed', partial, startedMs, now().getTime());
    return result;
  } finally {
    removeWorkDir(workDir, log);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// roundtrip-local (PR の往復の検査)
// ───────────────────────────────────────────────────────────────────────────

/** 往復の検査の種まき (利用者 1 人と監査行 1 行。record_backup_audit を通す) */
export const ROUNDTRIP_SEED_SQL = [
  'BEGIN;',
  "INSERT INTO auth.users (instance_id, id, aud, role, email, created_at, updated_at) VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'roundtrip-' || gen_random_uuid()::text || '@example.test', now(), now());",
  "SELECT public.record_backup_audit('backup.daily.completed', '{\"roundtrip\": true}'::jsonb);",
  'COMMIT;',
].join('\n');

export async function roundtripLocal(options, deps) {
  const { run, env, now, log } = deps;
  const ctx = { run, env, log };
  const tuning = defaultTuning();
  const workDir = makeWorkDir(deps);
  const startedMs = now().getTime();
  const partial = {};
  let stage = 'restore_env';
  try {
    const pgUrl = await localPgUrl(ctx, options.slot, stageTimeoutMs('restore_check', tuning));
    stage = 'restore_check';
    const seedFile = path.join(workDir, 'seed.sql');
    writePrivate(seedFile, `${ROUNDTRIP_SEED_SQL}\n`);
    await psql(ctx, 'count', { PG_URL: pgUrl, PSQL_FILE: seedFile }, { timeoutMs: stageTimeoutMs('restore_check', tuning) });

    stage = 'dump';
    // CLI の db dump --db-url は sslmode のクエリを受けないので、`supabase-local.sh env` の URL そのままを渡す (ローカルのスタックの接続先で秘密ではない)
    const rawDbUrl = pgUrl.slice(0, -LOCAL_PG_SSLMODE_QUERY.length);
    await dumpDatabase(ctx, { dbUrl: rawDbUrl }, workDir, stageTimeoutMs('dump', tuning));

    stage = 'catalog';
    const capture = await captureCatalog(ctx, { pgUrl, workDir, schemaFile: path.join(workDir, 'schema.sql'), timeoutMs: stageTimeoutMs('catalog', tuning) });
    const checked = checkCatalogCapture(capture);
    logCatalog(ctx, capture, checked);
    if (!checked.ok) throw new StageFailure('catalog_failed');

    stage = 'verify';
    const schemaScan = await scanSchemaSql(fileLines(path.join(workDir, 'schema.sql')));
    const dataScan = await scanDataSql(fileLines(path.join(workDir, 'data.sql')));
    const fileSizes = {};
    for (const name of DUMP_FILES) fileSizes[name] = fileSize(path.join(workDir, name));
    const verified = verifyDumpFiles({ fileSizes, data: dataScan, schema: schemaScan });
    if (!verified.ok) {
      log(`[db-backup roundtrip] verify: ダンプがそろっていません (期待 ${verified.expected}・実際 ${verified.actual})`);
      throw new StageFailure('dump_incomplete');
    }

    stage = 'restore_check';
    const timeoutMs = stageTimeoutMs('restore_check', tuning);
    await resetForRestore(ctx, { pgUrl, managedTables: managedTablesInDump(dataScan), workDir, timeoutMs });
    await restoreDatabase(ctx, { pgUrl, plainDir: workDir, workDir, timeoutMs });
    await checkRestored(ctx, {
      pgUrl, plainDir: workDir, catalogDir: path.join(workDir, CATALOG_DIR), workDir, timeoutMs, fullOutput: true,
      expected: { dumped: verified.dumped, ledger: checked.ledger, cron_jobs: checked.cron_jobs }, partial,
    });
    await cronDryRun(ctx, { pgUrl, cronJobsFile: path.join(workDir, CRON_JOBS_FILE), timeoutMs });
    const checks = restoreCheckResult('passed', partial, startedMs, now().getTime());
    log(`[db-backup roundtrip] 往復できました: ${JSON.stringify(checks)}`);
    return { ok: true, exitCode: EXIT_CODES.ok, checks };
  } catch (error) {
    const reason = reasonOf(stage, error);
    log(`[db-backup roundtrip] 失敗: 段 ${stage}・reason ${reason}`);
    return { ok: false, exitCode: EXIT_CODES.failed, reason, checks: restoreCheckResult('failed', partial, startedMs, now().getTime()) };
  } finally {
    removeWorkDir(workDir, log);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function writeResultFile(file, report) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  fs.renameSync(tmp, file);
}

async function runReportIssue(args, { env, github, log, logError }) {
  const report = parseRunReport(readTextOr(args.resultFile, null));
  const plan = planBackupIssue({ report, runOutcome: args.runOutcome, runUrl: args.runUrl });
  let op = 'list';
  try {
    const existing = github.listOpenIssues().find((issue) => String(issue.body ?? '').includes(BACKUP_ISSUE_MARKER));
    const action = planIssueAction({ existing, hasProblems: plan.hasProblems });
    if (action === 'create') {
      op = 'create';
      log(`[db-backup] Issue を作りました: #${github.createIssue(plan.title, plan.body)}`);
    } else if (action === 'update') {
      op = 'update';
      github.updateIssue(existing.number, plan.body);
      log(`[db-backup] Issue #${existing.number} を更新しました`);
    } else if (action === 'close') {
      op = 'close';
      github.closeIssue(existing.number, `DB バックアップの取得が成功したので閉じます。\n\n実行ログ: ${args.runUrl}`);
      log(`[db-backup] Issue #${existing.number} を閉じました`);
    } else {
      log('[db-backup] Issue: 何もしません (問題なし・開いている Issue なし)');
    }
    return EXIT_CODES.ok;
  } catch (error) {
    logError(`[db-backup] GitHub の API に失敗した (${op}): ${redactForLog(error?.message ?? String(error), env)}`);
    return EXIT_CODES.failed;
  }
}

/** scripts/backup-db.mjs の本体 */
export async function runCli(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const logError = deps.logError ?? ((line) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const run = deps.run ?? createCommandRunner(process.env);
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      logError(`${error.message}\n\n${USAGE}`);
      return EXIT_CODES.usage;
    }
    throw error;
  }
  const runDeps = { run, env, now, log, logError };
  switch (args.command) {
    case 'help':
      log(USAGE);
      return EXIT_CODES.ok;
    case 'run': {
      const jstDate = planRun({ now: now(), tierOverride: args.tier }).jst_date;
      const backup = deps.runBackup ?? runBackup;
      let report = unexpectedFailureReport({ jstDate });
      let exitCode = EXIT_CODES.failed;
      try {
        const result = await backup({ tier: args.tier }, runDeps);
        report = toRunReport(result);
        exitCode = result.exitCode;
      } catch (error) {
        logError(`[db-backup] 段の失敗として記録できずに終わりました: ${redactForLog(error?.message ?? String(error), env)}`);
        report = unexpectedFailureReport({ jstDate });
        exitCode = EXIT_CODES.failed;
      } finally {
        if (args.resultFile !== null) writeResultFile(args.resultFile, report);
      }
      return exitCode;
    }
    case 'restore':
      return (await restoreFromArchive({ key: args.key, identityFile: args.identityFile, slot: args.slot }, runDeps)).exitCode;
    case 'roundtrip-local':
      return (await roundtripLocal({ slot: args.slot }, runDeps)).exitCode;
    case 'report-issue': {
      if (!isNonEmpty(env.GITHUB_REPOSITORY)) {
        logError('環境変数 GITHUB_REPOSITORY (owner/repo) が必要です');
        return EXIT_CODES.usage;
      }
      const github = deps.github ?? createGitHub({ repo: env.GITHUB_REPOSITORY });
      return runReportIssue(args, { env, github, log, logError });
    }
    case 'r2-config': {
      fs.mkdirSync(args.outDir, { recursive: true });
      const lifecycleFile = path.join(args.outDir, 'r2-lifecycle.json');
      fs.writeFileSync(lifecycleFile, `${JSON.stringify(buildR2LifecycleConfig(), null, 2)}\n`, 'utf8');
      for (const command of buildR2LockCommands({ bucket: args.bucket, lifecycleFile })) log(command.join(' '));
      return EXIT_CODES.ok;
    }
    default:
      return EXIT_CODES.usage;
  }
}
