/**
 * #1125 (B) pg_cron の実行履歴の掃除 (migration 20261018020000_cleanup_cron_run_history.sql・設計 operator/11 §5.3・§11.1・段 D) の
 * ソース走査 contract テスト (DB には接続しない)。
 *
 * 実際の動き (消す範囲・権限・ジョブの登録・rollback) は tests/integration/security/cron-run-history-cleanup.test.ts で確かめる。
 * ここでは、DB を立てなくても通常のテストで止められる「書き方の取り決め」を固定する。
 *
 *   1. migration と rollback が同じ名前で対になっていて、1・2 行目の見出しと案内が正しい
 *   2. cleanup_cron_run_history は SECURITY DEFINER・search_path 空・参照が完全修飾・動的 SQL なし・EXECUTE は誰にも付けない (完全形の REVOKE)
 *   3. 消すのは cron.job_run_details と台帳 public.cron_failure_alerts の 2 表だけ。消す条件は「30 日より古い」で、終わっていない行は start_time で判断する
 *   4. 保持 30 日 (c_retention) は、段 A の cron_failure_candidates の見る範囲 7 日 (c_lookback = アプリの CRON_FAILURE_LOOKBACK_DAYS) より長い
 *   5. pg_cron のジョブ cleanup-cron-run-history: 35 18 * * * (03:35 JST)・command が決めたとおり・同名と同じ関数を呼ぶジョブを先に登録解除・cron.job の守り・NOTICE に command を載せない
 *   6. rollback がジョブの登録解除と関数の DROP を行い、台帳と cron.job_run_details の行には触れない
 *   7. 設計書 docs/design/operator/08-cron-batches.md に cleanup-cron-run-history と migration の名前が書かれている
 *
 * アプリ側の値 (CRON_FAILURE_LOOKBACK_DAYS) はここで書き直さず、cron-failure.ts から import して突き合わせる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { collectMigrationCronJobs, stripSqlComments } from './helpers/migration-cron-jobs';
import { CRON_FAILURE_LOOKBACK_DAYS } from '../src/lib/ops-alerts/cron-failure';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261018020000';
const NAME = 'cleanup_cron_run_history';
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.down.sql`;
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);
const STAGE_A_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '20261017220000_cron_failure_monitoring.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'design', 'operator', '08-cron-batches.md');

const FUNCTION_NAME = 'cleanup_cron_run_history';
const SIGNATURE = `public.${FUNCTION_NAME}()`;
const JOB_NAME = 'cleanup-cron-run-history';
/** 毎日 03:35 JST = 18:35 UTC (pg_cron の cron.timezone は GMT) */
const JOB_SCHEDULE = '35 18 * * *';
const JOB_COMMAND = `SELECT ${SIGNATURE.replace('()', '();')}`;
/** 保持する日数 (設計 §5.3。app_logs の 30 日と同じ) */
const RETENTION_DAYS = 30;
/** REVOKE で外すロール (完全形。Supabase の自動の GRANT と PostgreSQL の PUBLIC を両方外す) */
const REVOKED_ROLES = 'PUBLIC, anon, authenticated, service_role';
/** 消してよい表 (これ以外の表の DELETE を足したら、設計 §5.3 の範囲を超える) */
const DELETABLE_TABLES = ['cron.job_run_details', 'public.cron_failure_alerts'] as const;

const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
const code = stripSqlComments(migration);
const rollbackCode = stripSqlComments(rollback);

/** CREATE OR REPLACE FUNCTION public.cleanup_cron_run_history( の属性 (AS $$ の手前まで) と本体 */
function functionSource(): { header: string; body: string } {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION ${SIGNATURE.replace('()', '(')}`);
  expect(start, `${FUNCTION_NAME} の CREATE OR REPLACE FUNCTION が見つからない`).toBeGreaterThanOrEqual(0);
  const rest = code.slice(start);
  const opener = /\bAS\s+\$\$/.exec(rest);
  expect(opener, 'AS $$ が見つからない').not.toBeNull();
  const opened = opener as RegExpExecArray;
  const bodyStart = opened.index + opened[0].length;
  const bodyEnd = rest.indexOf('$$', bodyStart);
  expect(bodyEnd, '本体の終わりの $$ が見つからない').toBeGreaterThan(bodyStart);
  return { header: rest.slice(0, opened.index), body: rest.slice(bodyStart, bodyEnd) };
}

/** `<name> CONSTANT <type> := interval 'N days'` の N */
function retentionDays(sql: string, constant: string): number {
  const match = new RegExp(`\\b${constant}\\s+CONSTANT\\s+pg_catalog\\.interval\\s*:=\\s*interval '(\\d+) days'`).exec(sql);
  expect(match, `${constant} の interval 'N days' が見つからない`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

describe('#1125 (B) 実行履歴の掃除 (段 D) のソース走査', () => {
  it('migration と rollback が同じ名前で対になっていて、1・2 行目の見出しと案内が正しい', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const migrationLines = migration.split('\n');
    expect(migrationLines[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(migrationLines[1]).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK_FILE}`);
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    // 版の番号が重ならない (同じ版の migration が 2 つあると片方しか当たらない)
    const sameVersion = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.startsWith(`${VERSION}_`));
    expect(sameVersion).toEqual([MIGRATION_FILE]);
    // 台帳を作る段 A の migration より後に当たる (台帳 cron_failure_alerts を参照するため)
    expect(path.basename(STAGE_A_MIGRATION_PATH) < MIGRATION_FILE).toBe(true);
  });

  it('cleanup_cron_run_history は SECURITY DEFINER・search_path 空・参照が完全修飾・動的 SQL なし・EXECUTE は誰にも付けない (完全形の REVOKE)', () => {
    const { header, body } = functionSource();
    expect(header).toMatch(/\bSECURITY DEFINER\b/);
    expect(header).toMatch(/SET search_path = ''/);
    expect(header).not.toMatch(/SECURITY INVOKER/);
    expect(body, '動的 SQL なし').not.toMatch(/\bEXECUTE\b/i);
    // 表の参照 (FROM / JOIN / INTO / UPDATE) はスキーマ付き
    const unqualified = [...body.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_]\w*)(\.)?/gi)].filter((match) => !match[2]).map((match) => match[0]);
    expect(unqualified, 'スキーマ無しの表の参照').toEqual([]);
    // search_path が空なので、組み込み関数も pg_catalog 付き
    const bare = [...body.matchAll(/(?<![.\w])(now|count|to_regclass)\s*\(/gi)].map((match) => match[0]);
    expect(bare, 'pg_catalog 無しの組み込み関数').toEqual([]);
    expect(body).toContain('pg_catalog.now()');
    // 引数は無い (SQL に渡す文字列が無い)
    expect(header).toMatch(new RegExp(`public\\.${FUNCTION_NAME}\\(\\)`));

    expect(code).toContain(`REVOKE ALL ON FUNCTION ${SIGNATURE} FROM ${REVOKED_ROLES};`);
    // GRANT は 1 つも付けない (所有者 postgres = pg_cron だけ)
    expect(code).not.toMatch(/\bGRANT\b/i);
  });

  it('消すのは cron.job_run_details と台帳 public.cron_failure_alerts の 2 表だけ。条件は「30 日より古い」で、終わっていない行は start_time で判断する。INSERT・UPDATE・TRUNCATE は無い', () => {
    const { body } = functionSource();
    const deletes = [...code.matchAll(/\bDELETE\s+FROM\s+(\S+)/gi)].map((match) => match[1]);
    expect(deletes).toEqual([...DELETABLE_TABLES]);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE|TRUNCATE)\b/i);
    // WHERE の無い DELETE (全消し) を書いていない: DELETE ごとに、次の文の終わり (;) までに WHERE がある
    for (const statement of body.split(';').filter((part) => /\bDELETE\s+FROM\b/i.test(part))) {
      expect(statement, `WHERE の無い DELETE: ${statement.trim().slice(0, 60)}`).toMatch(/\bWHERE\b/i);
    }
    // 実行履歴: end_time が無い行は start_time で判断し、保持より古いものだけを消す
    expect(body).toMatch(
      /DELETE FROM cron\.job_run_details AS d\s+WHERE COALESCE\(d\.end_time, d\.start_time\) < pg_catalog\.now\(\) - c_retention;/,
    );
    // 台帳: alerted_at が保持より古いものだけを消す
    expect(body).toMatch(/DELETE FROM public\.cron_failure_alerts AS a WHERE a\.alerted_at < pg_catalog\.now\(\) - c_retention;/);
    // pg_cron の無い DB (cron スキーマが無い) では実行履歴に触れる前に飛ばす。台帳は cron に依らず掃除する
    const guardAt = body.indexOf("pg_catalog.to_regclass('cron.job_run_details') IS NOT NULL");
    const runsDeleteAt = body.indexOf('DELETE FROM cron.job_run_details');
    const alertsDeleteAt = body.indexOf('DELETE FROM public.cron_failure_alerts');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(runsDeleteAt).toBeGreaterThan(guardAt);
    expect(alertsDeleteAt).toBeGreaterThan(runsDeleteAt);
    // 戻り値は消した件数だけ (個人情報・コマンドを返さない)
    expect(functionSource().header).toMatch(/RETURNS TABLE \(run_details_deleted INTEGER, alerts_deleted INTEGER\)/);
  });

  it('保持 30 日 (cleanup_cron_run_history の c_retention) は、段 A の cron_failure_candidates の見る範囲 7 日 (c_lookback) より長い', () => {
    const { body } = functionSource();
    const retention = retentionDays(body, 'c_retention');
    expect(retention).toBe(RETENTION_DAYS);
    const lookback = retentionDays(stripSqlComments(fs.readFileSync(STAGE_A_MIGRATION_PATH, 'utf-8')), 'c_lookback');
    // 段 A の見る範囲は、アプリが文面に書く日数と同じ (cron-failure.ts)
    expect(lookback).toBe(CRON_FAILURE_LOOKBACK_DAYS);
    // 消す前に数え終える: 保持は見る範囲より長い
    expect(retention).toBeGreaterThan(lookback);
  });

  it('pg_cron のジョブ cleanup-cron-run-history: 35 18 * * * (03:35 JST)・command が決めたとおり・同名と同じ関数を呼ぶジョブを先に登録解除・cron.job の守り・NOTICE に command を載せない', () => {
    const jobs = collectMigrationCronJobs(MIGRATIONS_DIR);
    expect(jobs.unresolved, 'ジョブの名前が解けない呼び出し').toEqual([]);
    expect(jobs.names).toContain(JOB_NAME);

    const schedules = [...code.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)];
    expect(schedules.map((match) => [match[1], match[2], match[3]])).toEqual([[JOB_NAME, JOB_SCHEDULE, JOB_COMMAND]]);
    // 18:35 UTC = 03:35 JST (UTC + 9 時間)
    const [minute, hour] = JOB_SCHEDULE.split(' ').map(Number);
    const JST_OFFSET_HOURS = 9;
    const HOURS_PER_DAY = 24;
    expect(`${String((hour + JST_OFFSET_HOURS) % HOURS_PER_DAY).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).toBe('03:35');

    // 登録の前に、同名と、同じ関数を呼ぶジョブ (名前は問わない) を登録解除する
    const unscheduleAt = code.indexOf('PERFORM cron.unschedule(v_job.jobid);');
    const scheduleAt = code.indexOf('PERFORM cron.schedule(');
    expect(unscheduleAt).toBeGreaterThanOrEqual(0);
    expect(scheduleAt).toBeGreaterThan(unscheduleAt);
    expect(code).toContain(`jobname = '${JOB_NAME}'`);
    expect(code).toContain(`command ~* '[[:<:]]${FUNCTION_NAME}[[:>:]]'`);
    // pg_cron が無い DB では、cron.job を読む前に飛ばす
    const guardAt = code.indexOf("IF to_regclass('cron.job') IS NULL THEN");
    const readAt = code.indexOf('FROM cron.job');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(guardAt);
    expect(code).toMatch(/IF to_regclass\('cron\.job'\) IS NULL THEN[\s\S]*?RETURN;/);
    // 実行ログ (RAISE) に command を載せない
    const raises = [...code.matchAll(/RAISE NOTICE[^;]*;/g)].map((match) => match[0]);
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) expect(raise, 'NOTICE に command を載せない').not.toMatch(/command/i);
    // ジョブは 1 つだけ (cron.schedule は 1 回)
    expect(code.match(/cron\.schedule\(/g) ?? []).toHaveLength(1);
  });

  it('rollback がジョブの登録解除と関数の DROP を行い、台帳と cron.job_run_details の行には触れない', () => {
    expect(rollbackCode).toContain(`j.jobname = '${JOB_NAME}'`);
    expect(rollbackCode).toMatch(/cron\.unschedule\(/);
    expect(rollbackCode).toMatch(/IF to_regclass\('cron\.job'\) IS NULL THEN\s+RETURN;/);
    const drops = [...rollbackCode.matchAll(/DROP\s+(FUNCTION|TABLE)\s+IF EXISTS\s+([^;]+);/gi)].map(
      (match) => `${match[1].toUpperCase()} ${match[2].replace(/\s+/g, ' ').trim()}`,
    );
    expect(drops).toEqual([`FUNCTION ${SIGNATURE}`]);
    // 消した行は戻らないが、rollback 自身は行を消さない・変えない。台帳と実行履歴の表には触れない
    expect(rollbackCode).not.toMatch(/\b(DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
    expect(rollbackCode).not.toMatch(/cron_failure_alerts|job_run_details/i);
    // 登録解除は関数の DROP より前 (ジョブが消えた関数を呼ぶ窓を作らない)
    expect(rollbackCode.indexOf('cron.unschedule(')).toBeLessThan(rollbackCode.indexOf('DROP FUNCTION'));
  });

  it('docs/design/operator/08-cron-batches.md に cleanup-cron-run-history と migration の名前が書かれている', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf-8');
    expect(doc).toContain(`\`${JOB_NAME}\``);
    expect(doc).toContain(MIGRATION_FILE);
    expect(doc).toContain(`\`${SIGNATURE.replace('()', '')}`);
    // 「Supabase が自動でクリアする」は事実と違う (自動では消えない)。古い記述が残っていない
    expect(doc).not.toMatch(/job_run_details` は Supabase が自動でクリアする/);
  });
});
