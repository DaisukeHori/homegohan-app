/**
 * #1125 (B) 定期処理の失敗の監視 (migration 20261017220000_cron_failure_monitoring.sql・設計 operator/11 §5.1・§5.2・§11.3) の結合テスト
 *
 * 台帳 public.cron_failure_alerts と関数 5 本 (cron_failure_candidates / cron_failure_counts / mark_cron_failures_alerted /
 * unmark_cron_failures_alerted / pg_cron_last_run_at) の、実際の動きを確かめる。書き方の取り決めは tests/cron-failure-monitoring-contract.test.ts。
 *
 * 確かめること (it の頭の記号は設計 §11.3 の記号):
 *   A-1: 台帳は anon / authenticated / service_role から直接読み書きできない (42501)。関数 4 本は service_role だけ、candidates は service_role でも 42501
 *   B-1: 失敗した pg_cron の実行と cron の route の 500 (app_logs) を数え、client の行・内部エラーの文ではない行 (dead の文など)・7 日より古い行は数えない
 *   B-2: mark は候補の全部を台帳に書き、書けた件数を返す。2 回目は 0 行
 *   B-3: unmark は同じ alerted_at の行だけを消す
 *   B-4: 登録解除されたジョブの失敗は jobid:<n> の名前になる
 *   B-5: route の名前の 3 つの形の 500 の行 (cron/<名前>・GET /api/cron/<名前>) は候補に入り、形の違う名前は入らない
 *   B-6: 窓を持たない: 台帳に無い失敗は 1 分前・1 日前・6 日 23 時間前のどれも候補に入り、7 日 1 分前は入らない
 *   B-7: pg_cron の無い DB (cron. を存在しない名前に差し替えたコピー) では、candidates は Vercel Cron の分だけを返し、pg_cron_last_run_at は (false, 0, NULL)
 *   C-1: pg_cron_last_run_at は cron_available true・有効なジョブ数・最新の start_time を返す
 *   F-1: rollback で関数 5 本と台帳が消え (pg_cron のジョブと ops_alert_state の行は残り)、もう一度 migration を流すと戻る
 *
 * 数える関数は、この DB にある本物の行 (ほかのテスト・ローカルの動作が残した失敗) も数える。そのため、このテストは自分が入れた行を
 * 名前の印 (TAG) で見分け、件数は自分の名前の分だけを比べる。mark は本物の候補の全部に印を付けるが、B-3 の unmark が同じ alerted_at で外して元に戻す。
 * このテストが作った行 (ジョブ・実行履歴・app_logs・台帳) は、終わりに必ず消す。時刻の計算は DB の時計 (now()) で行う (テストを流す機械の時計とずれても境界が動かない)。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/cron-failure-monitoring.test.ts
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261017220000';
const NAME = 'cron_failure_monitoring';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/rollbacks/${VERSION}_${NAME}.down.sql`), 'utf8');

/** src/lib/api/errors.ts の INTERNAL_ERROR_LOG_MESSAGE と同じ文 (契約テストが migration の定数との一致を固定している) */
const INTERNAL_ERROR_MESSAGE = '内部エラーのため 500 を返しました';
/** operator/10 のメールの worker が dead にした行の文。内部エラーの文ではないので、候補に入らない (S-03) */
const DEAD_LETTER_MESSAGE = 'メールを届けられませんでした (dead)';
const TABLE = 'cron_failure_alerts';
const COUNT_LIMIT_MAX = 100;
const LIMIT_OUT_OF_RANGE_SQLSTATE = '22023';
const PERMISSION_DENIED_SQLSTATE = '42501';
/** PostgREST が RPC の関数を見つけられないときのコード (migration を流した直後のスキーマキャッシュの更新待ち) */
const SCHEMA_CACHE_MISS_CODE = 'PGRST202';
const SCHEMA_CACHE_RETRIES = 20;
const SCHEMA_CACHE_RETRY_DELAY_MS = 500;

const FUNCTIONS = [
  'cron_failure_candidates()',
  'cron_failure_counts(integer)',
  'mark_cron_failures_alerted(timestamp with time zone, integer)',
  'unmark_cron_failures_alerted(timestamp with time zone)',
  'pg_cron_last_run_at()',
] as const;
const SERVICE_ROLE_ONLY_FUNCTIONS = FUNCTIONS.filter((fn) => fn !== 'cron_failure_candidates()');
const REGPROC_ARGS = {
  'cron_failure_candidates()': 'public.cron_failure_candidates()',
  'cron_failure_counts(integer)': 'public.cron_failure_counts(integer)',
  'mark_cron_failures_alerted(timestamp with time zone, integer)': 'public.mark_cron_failures_alerted(timestamptz, integer)',
  'unmark_cron_failures_alerted(timestamp with time zone)': 'public.unmark_cron_failures_alerted(timestamptz)',
  'pg_cron_last_run_at()': 'public.pg_cron_last_run_at()',
} as const;

const RUN = randomBytes(4).toString('hex');
/** このテストが入れた行の名前の印 (ジョブ名・function_name・source に入れる) */
const TAG = `t1125-${RUN}`;
/** 1 月 1 日にしか動かない予定 (テスト中に pg_cron が実行することはない) */
const NEVER_SOON = '0 0 1 1 *';
/** ジョブの command に入れる印。実行履歴の行の command にも入れて、後片付けで見分ける */
const COMMAND_MARK = `T1125-TEST-${RUN}`;
/** B-2 / B-3 で台帳に書く alerted_at。本物の権利の時刻 (今) と重ならない昔の日付に、実行ごとの値を入れる */
const alertedAt = (extraMs: number) => new Date(Date.UTC(2001, 1, 3, 4, 5, 6, (Number.parseInt(RUN.slice(0, 4), 16) % 900) + extraMs)).toISOString();
const ALERTED_AT_FIRST = alertedAt(0);
const ALERTED_AT_SECOND = alertedAt(1);

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}
const sr = client(serviceKey);
const anon = client(anonKey);

/** ローカルスタックの postgres-meta で SQL を流す (テストの準備・確認・migration の実行にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

/** 本番の migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return pgQuery<T>(`SET LOCAL ROLE postgres;\n${sql}`);
}

/** SQL の文字列リテラルにする (テストが決めた固定の文字列だけを渡す) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** migration を流した直後は、PostgREST が関数を見つけられない (PGRST202) ことがある。その場合だけ、最大 10 秒待ってやり直す */
async function withSchemaCacheRetry<T extends { error: PostgrestError | null }>(call: () => PromiseLike<T>): Promise<T> {
  let last = await call();
  for (let attempt = 0; attempt < SCHEMA_CACHE_RETRIES && last.error?.code === SCHEMA_CACHE_MISS_CODE; attempt += 1) {
    await sleep(SCHEMA_CACHE_RETRY_DELAY_MS);
    last = await call();
  }
  return last;
}

interface CountRow {
  source: string;
  job_name: string;
  failed_count: number;
  total_count: number;
}

async function counts(limit = COUNT_LIMIT_MAX): Promise<CountRow[]> {
  const { data, error } = await withSchemaCacheRetry(() => sr.rpc('cron_failure_counts', { p_limit: limit }));
  if (error) throw new Error(`cron_failure_counts: ${error.code} ${error.message}`);
  return data as CountRow[];
}

/** このテストの名前 (TAG を含むもの) の行だけ。名前順 */
function mine(rows: CountRow[]): CountRow[] {
  return rows
    .filter((row) => row.job_name.includes(TAG))
    .map((row) => ({ source: row.source, job_name: row.job_name, failed_count: Number(row.failed_count), total_count: Number(row.total_count) }))
    .sort((a, b) => (a.source + a.job_name).localeCompare(b.source + b.job_name));
}

/** counts の戻りのうち、このテストの名前の (source, job_name, failed_count) だけ */
function brief(rows: CountRow[]): Array<[string, string, number]> {
  return mine(rows).map((row) => [row.source, row.job_name, row.failed_count]);
}

// ---------------------------------------------------------------
// 準備: ジョブ・実行履歴・app_logs
// ---------------------------------------------------------------
const createdRunIds: string[] = [];

/**
 * 実行履歴に入れる runid。postgres ロールは cron.runid_seq (本物の実行が使う連番) を使えない (42501) ので、runid は自分で決める。
 * 本物の連番 (1 から数える) と重ならない大きな値に、実行ごとの値 (RUN) を入れて、1 行ずつ増やす
 */
const RUNID_FLOOR = 9_000_000_000_000;
const RUNID_RUN_SPAN = 1_000_000;
const RUNID_PER_RUN = 1_000;
let runIdCounter = 0;
function nextRunId(): number {
  runIdCounter += 1;
  return RUNID_FLOOR + (Number.parseInt(RUN, 16) % RUNID_RUN_SPAN) * RUNID_PER_RUN + runIdCounter;
}
const createdLogIds: string[] = [];

/** テスト用のジョブを登録して jobid を返す (名前に TAG・command に印) */
async function scheduleTestJob(suffix: string): Promise<{ jobid: number; name: string }> {
  const name = `${TAG}-${suffix}`;
  const rows = await asPostgres(`SELECT cron.schedule(${lit(name)}, ${lit(NEVER_SOON)}, ${lit(`SELECT 1 /* ${COMMAND_MARK} */`)}) AS jobid;`);
  return { jobid: Number(rows[0].jobid), name };
}

/** 実行履歴に 1 行入れる。start は DB の now() からの差 (例: "interval '1 hour'")。入れた runid を返す */
async function insertRun(jobid: number, status: 'failed' | 'succeeded', ago: string): Promise<string> {
  const rows = await asPostgres<{ runid: string | number }>(`
    INSERT INTO cron.job_run_details (runid, jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
    VALUES (${nextRunId()}, ${jobid}, 1, current_database(), current_user, ${lit(`SELECT 1 /* ${COMMAND_MARK} */`)}, ${lit(status)}, ${lit('テスト')},
            now() - ${ago}, now() - ${ago})
    RETURNING runid;
  `);
  const runid = String(rows[0].runid);
  createdRunIds.push(runid);
  return runid;
}

interface LogSpec {
  functionName: string;
  ago: string;
  level?: string;
  source?: string;
  message?: string;
}

/** app_logs に 1 行入れる。既定は level = error・source = TAG・message = 内部エラーの文。入れた id を返す */
async function insertLog(spec: LogSpec): Promise<string> {
  const rows = await asPostgres<{ id: string }>(`
    INSERT INTO public.app_logs (level, source, function_name, message, created_at)
    VALUES (${lit(spec.level ?? 'error')}, ${lit(spec.source ?? TAG)}, ${lit(spec.functionName)}, ${lit(spec.message ?? INTERNAL_ERROR_MESSAGE)}, now() - ${spec.ago})
    RETURNING id;
  `);
  createdLogIds.push(rows[0].id);
  return rows[0].id;
}

interface LedgerRow {
  source: string;
  item_id: string;
  job_name: string;
  failed_at: string;
  alerted_at: string;
}

async function ledgerRows(): Promise<LedgerRow[]> {
  return asPostgres<LedgerRow>(`
    SELECT source, item_id, job_name, failed_at, alerted_at
      FROM public.cron_failure_alerts
     WHERE job_name LIKE ${lit(`%${TAG}%`)} OR item_id = ANY (ARRAY[${[...createdRunIds, ...createdLogIds].map(lit).join(', ') || "''"}])
     ORDER BY item_id;
  `);
}

async function cleanup(): Promise<void> {
  // 台帳 (rollback のテストが失敗して表が無いときは飛ばす)
  await asPostgres(`
    DO $t1125$ BEGIN
      IF to_regclass('public.cron_failure_alerts') IS NOT NULL THEN
        DELETE FROM public.cron_failure_alerts
         WHERE job_name LIKE ${lit(`%${TAG}%`)}
            OR item_id = ANY (ARRAY[${[...createdRunIds, ...createdLogIds].map(lit).join(', ') || "''"}])
            OR alerted_at IN (${lit(ALERTED_AT_FIRST)}::timestamptz, ${lit(ALERTED_AT_SECOND)}::timestamptz);
      END IF;
    END $t1125$;
  `);
  await asPostgres(`DELETE FROM cron.job_run_details WHERE command LIKE ${lit(`%${COMMAND_MARK}%`)};`);
  await asPostgres(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE ${lit(`${TAG}-%`)} OR command LIKE ${lit(`%${COMMAND_MARK}%`)};`);
  await asPostgres(`DELETE FROM public.app_logs WHERE source = ${lit(TAG)} OR function_name LIKE ${lit(`%${TAG}%`)};`);
  await asPostgres(`DELETE FROM public.ops_alert_state WHERE alert_key LIKE ${lit(`${TAG}%`)};`);
  // B-7 のコピー (失敗の途中で残ったときのため)
  await dropNoCronCopy();
}

// ---------------------------------------------------------------
// B-7: pg_cron の無い DB のコピー
// ---------------------------------------------------------------
const NO_CRON_PREFIX = 't1125_nocron_';
const ABSENT_PREFIX = 't1125_absent_';
const COPY_OBJECT_NAMES = [
  'cron_failure_candidates',
  'cron_failure_counts',
  'mark_cron_failures_alerted',
  'unmark_cron_failures_alerted',
  'pg_cron_last_run_at',
  'cron_failure_alerts',
] as const;

/** migration のコピー: cron. を存在しない public.t1125_absent_ に、関数 5 本と台帳の名前を t1125_nocron_ 付きに置き換える */
function noCronCopy(sql: string): string {
  let copy = sql.replace(/\bcron\./g, `public.${ABSENT_PREFIX}`);
  for (const name of COPY_OBJECT_NAMES) copy = copy.replace(new RegExp(`\\bpublic\\.${name}\\b`, 'g'), `public.${NO_CRON_PREFIX}${name}`);
  // 索引・ポリシーの名前も本物と重ねない (索引の名前はスキーマの中で一意。IF NOT EXISTS で黙って飛ばされるのを避ける)
  return copy
    .replace(/\bidx_cron_failure_alerts_alerted_at\b/g, `idx_${NO_CRON_PREFIX}alerted_at`)
    .replace(/\bcron_failure_alerts_deny_client_access\b/g, `${NO_CRON_PREFIX}deny_client_access`);
}

async function dropNoCronCopy(): Promise<void> {
  await asPostgres(`
    DROP FUNCTION IF EXISTS public.${NO_CRON_PREFIX}pg_cron_last_run_at();
    DROP FUNCTION IF EXISTS public.${NO_CRON_PREFIX}unmark_cron_failures_alerted(TIMESTAMPTZ);
    DROP FUNCTION IF EXISTS public.${NO_CRON_PREFIX}mark_cron_failures_alerted(TIMESTAMPTZ, INTEGER);
    DROP FUNCTION IF EXISTS public.${NO_CRON_PREFIX}cron_failure_counts(INTEGER);
    DROP FUNCTION IF EXISTS public.${NO_CRON_PREFIX}cron_failure_candidates();
    DROP TABLE IF EXISTS public.${NO_CRON_PREFIX}cron_failure_alerts;
  `);
}

beforeAll(async () => {
  // 前回の異常終了の残りを片付ける (名前の印は実行ごとに違うので、昔の TAG の残りは別の印で拾う)
  await asPostgres(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 't1125-%' OR command LIKE '%T1125-TEST-%';`);
  await asPostgres(`DELETE FROM cron.job_run_details WHERE command LIKE '%T1125-TEST-%';`);
  await asPostgres(`DELETE FROM public.app_logs WHERE source LIKE 't1125-%' OR function_name LIKE '%t1125-%';`);
  await asPostgres(`DELETE FROM public.cron_failure_alerts WHERE job_name LIKE '%t1125-%';`);
  await dropNoCronCopy();
}, 120_000);

afterAll(async () => {
  await cleanup();
  const left = await asPostgres(`SELECT jobid FROM cron.job WHERE jobname LIKE ${lit(`${TAG}-%`)} OR command LIKE ${lit(`%${COMMAND_MARK}%`)};`);
  expect(left, 'テスト用のジョブを消し切れていない').toEqual([]);
}, 120_000);

// ---------------------------------------------------------------
// A. 権限
// ---------------------------------------------------------------
describe('#1125 (B) A-1. 台帳と関数の権限', () => {
  it('台帳は anon / authenticated / service_role のどれにも表の権限が無く、REST でも 42501。RLS は有効', async () => {
    const roles = await pgQuery<{ role: string; privilege: string; allowed: boolean }>(`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.cron_failure_alerts', p) AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p;
    `);
    expect(roles).toHaveLength(12);
    expect(roles.filter((row) => row.allowed)).toEqual([]);
    const rls = await pgQuery<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cron_failure_alerts'::regclass;`);
    expect(rls[0].relrowsecurity).toBe(true);

    for (const [label, db] of [['anon', anon], ['service_role', sr]] as const) {
      const read = await db.from(TABLE).select('*').limit(1);
      expect(read.error?.code, `${label}: 台帳の SELECT`).toBe(PERMISSION_DENIED_SQLSTATE);
      const write = await db
        .from(TABLE)
        .insert({ source: 'pg_cron', item_id: `${TAG}-x`, job_name: `${TAG}-x`, failed_at: new Date().toISOString(), alerted_at: new Date().toISOString() });
      expect(write.error?.code, `${label}: 台帳の INSERT`).toBe(PERMISSION_DENIED_SQLSTATE);
    }
  });

  it('関数 5 本は SECURITY DEFINER・search_path 空・所有者 postgres。EXECUTE は 4 本が service_role だけ、candidates は誰にも付かない (PUBLIC にも無い)', async () => {
    for (const fn of FUNCTIONS) {
      const regproc = REGPROC_ARGS[fn];
      const attrs = await pgQuery<{ prosecdef: boolean; config: string; owner: string }>(`
        SELECT p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS config, pg_get_userbyid(p.proowner)::text AS owner
          FROM pg_proc p WHERE p.oid = to_regprocedure(${lit(regproc)});
      `);
      expect(attrs, `${fn} が無い`).toHaveLength(1);
      expect(attrs[0]).toEqual({ prosecdef: true, config: 'search_path=""', owner: 'postgres' });

      const privileges = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(regproc)})::oid, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;
      `);
      expect(Object.fromEntries(privileges.map((row) => [row.role, row.allowed])), fn).toEqual({
        anon: false,
        authenticated: false,
        service_role: SERVICE_ROLE_ONLY_FUNCTIONS.includes(fn),
      });
      const publicGrants = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = to_regprocedure(${lit(regproc)})::oid AND a.grantee = 0;
      `);
      expect(publicGrants[0].n, `${fn}: PUBLIC に EXECUTE が残っている`).toBe(0);
    }
  });

  it('RPC: anon は 4 本とも 42501、service_role も candidates は 42501。引数の範囲外 (limit 0・101・NULL の時刻) は 22023', async () => {
    const stamp = new Date().toISOString();
    expect((await withSchemaCacheRetry(() => anon.rpc('cron_failure_counts', { p_limit: 1 }))).error?.code).toBe(PERMISSION_DENIED_SQLSTATE);
    expect((await withSchemaCacheRetry(() => anon.rpc('mark_cron_failures_alerted', { p_alerted_at: stamp }))).error?.code).toBe(PERMISSION_DENIED_SQLSTATE);
    expect((await withSchemaCacheRetry(() => anon.rpc('unmark_cron_failures_alerted', { p_alerted_at: stamp }))).error?.code).toBe(PERMISSION_DENIED_SQLSTATE);
    expect((await withSchemaCacheRetry(() => anon.rpc('pg_cron_last_run_at'))).error?.code).toBe(PERMISSION_DENIED_SQLSTATE);
    expect((await withSchemaCacheRetry(() => sr.rpc('cron_failure_candidates'))).error?.code).toBe(PERMISSION_DENIED_SQLSTATE);

    for (const limit of [0, COUNT_LIMIT_MAX + 1, -1]) {
      expect((await sr.rpc('cron_failure_counts', { p_limit: limit })).error?.code, `counts limit ${limit}`).toBe(LIMIT_OUT_OF_RANGE_SQLSTATE);
      expect((await sr.rpc('mark_cron_failures_alerted', { p_alerted_at: stamp, p_limit: limit })).error?.code, `mark limit ${limit}`).toBe(LIMIT_OUT_OF_RANGE_SQLSTATE);
    }
    expect((await sr.rpc('mark_cron_failures_alerted', { p_alerted_at: null })).error?.code).toBe(LIMIT_OUT_OF_RANGE_SQLSTATE);
    expect((await sr.rpc('unmark_cron_failures_alerted', { p_alerted_at: null })).error?.code).toBe(LIMIT_OUT_OF_RANGE_SQLSTATE);
  });
});

// ---------------------------------------------------------------
// B. 数える・印を付ける・外す
// ---------------------------------------------------------------
describe('#1125 (B) B. 数える・印を付ける・外す', () => {
  const vercelName = `cron/${TAG}-v`;
  let pgJob: { jobid: number; name: string };
  const pgRunIds: string[] = [];
  const vercelLogIds: string[] = [];

  it('B-1: 失敗した pg_cron の実行と cron の route の 500 を数え、client の行・dead の文の行・warn の行・7 日より古い行は数えない。件数の多い順で、limit は行数を絞る', async () => {
    pgJob = await scheduleTestJob('j1');
    // pg_cron: failed 3 (1 時間・2 時間・3 時間前) + succeeded 1 + 7 日より古い failed 1
    pgRunIds.push(await insertRun(pgJob.jobid, 'failed', "interval '1 hour'"));
    pgRunIds.push(await insertRun(pgJob.jobid, 'failed', "interval '2 hours'"));
    pgRunIds.push(await insertRun(pgJob.jobid, 'failed', "interval '3 hours'"));
    await insertRun(pgJob.jobid, 'succeeded', "interval '1 hour'");
    await insertRun(pgJob.jobid, 'failed', "interval '8 days'");
    // Vercel Cron: 内部エラーの文の error 2 行 (候補) と、数えない行
    vercelLogIds.push(await insertLog({ functionName: vercelName, ago: "interval '1 hour'" }));
    vercelLogIds.push(await insertLog({ functionName: vercelName, ago: "interval '2 hours'" }));
    await insertLog({ functionName: vercelName, ago: "interval '1 hour'", source: 'client' }); // S-17
    await insertLog({ functionName: vercelName, ago: "interval '1 hour'", message: DEAD_LETTER_MESSAGE }); // S-03
    await insertLog({ functionName: vercelName, ago: "interval '1 hour'", level: 'warn' });
    await insertLog({ functionName: vercelName, ago: "interval '8 days'" }); // S-10
    await insertLog({ functionName: `api/${TAG}-not-a-cron`, ago: "interval '1 hour'" }); // cron の route の名前の形ではない

    const rows = await counts();
    expect(brief(rows)).toEqual([
      ['pg_cron', pgJob.name, 3],
      ['vercel_cron', vercelName, 2],
    ]);
    // どの行にも全体の件数 total_count が付く。全体 (limit の上限に収まる範囲) の failed_count の合計と一致する
    const total = rows.reduce((sum, row) => sum + Number(row.failed_count), 0);
    if (rows.length < COUNT_LIMIT_MAX) {
      expect(new Set(rows.map((row) => Number(row.total_count)))).toEqual(new Set([total]));
    }
    expect(Number(mine(rows)[0].total_count)).toBeGreaterThanOrEqual(5);
    // 件数の多い順
    const failedCounts = rows.map((row) => Number(row.failed_count));
    expect(failedCounts).toEqual([...failedCounts].sort((a, b) => b - a));
    // limit は行数だけを絞り、total_count は絞らない
    const one = await counts(1);
    expect(one).toHaveLength(1);
    expect(Number(one[0].total_count)).toBe(total);
  });

  it('B-2: mark は候補の全部を台帳に書き、書けた件数を返す。台帳の alerted_at は渡した時刻。2 回目は 0 行', async () => {
    const marked = await withSchemaCacheRetry(() => sr.rpc('mark_cron_failures_alerted', { p_alerted_at: ALERTED_AT_FIRST, p_limit: COUNT_LIMIT_MAX }));
    expect(marked.error).toBeNull();
    expect(brief(marked.data as CountRow[])).toEqual([
      ['pg_cron', pgJob.name, 3],
      ['vercel_cron', vercelName, 2],
    ]);

    const ledger = (await ledgerRows()).filter((row) => row.job_name.includes(TAG));
    expect(ledger.map((row) => [row.source, row.item_id]).sort()).toEqual(
      [...pgRunIds.map((id) => ['pg_cron', id]), ...vercelLogIds.map((id) => ['vercel_cron', id])].sort(),
    );
    for (const row of ledger) expect(new Date(row.alerted_at).toISOString()).toBe(ALERTED_AT_FIRST);

    // 印を付けた失敗は候補から外れる (S-01 の翌日の回: below_threshold)
    expect(brief(await counts())).toEqual([]);
    const again = await sr.rpc('mark_cron_failures_alerted', { p_alerted_at: ALERTED_AT_FIRST, p_limit: COUNT_LIMIT_MAX });
    expect(again.error).toBeNull();
    expect(brief(again.data as CountRow[])).toEqual([]);
    expect((await ledgerRows()).filter((row) => row.job_name.includes(TAG))).toHaveLength(ledger.length);
  });

  it('B-3: unmark は同じ alerted_at の行だけを消す。別の alerted_at の行は残り、消した行は候補に戻る', async () => {
    const extraRun = await insertRun(pgJob.jobid, 'failed', "interval '30 minutes'");
    const second = await sr.rpc('mark_cron_failures_alerted', { p_alerted_at: ALERTED_AT_SECOND, p_limit: COUNT_LIMIT_MAX });
    expect(second.error).toBeNull();
    expect(brief(second.data as CountRow[])).toEqual([['pg_cron', pgJob.name, 1]]);

    const first = await sr.rpc('unmark_cron_failures_alerted', { p_alerted_at: ALERTED_AT_FIRST });
    expect(first.error).toBeNull();
    // このテストの 5 行 (本物の候補に印を付けていた分も含めて外れるので 5 以上)
    expect(Number(first.data)).toBeGreaterThanOrEqual(pgRunIds.length + vercelLogIds.length);

    const ledger = (await ledgerRows()).filter((row) => row.job_name.includes(TAG));
    expect(ledger.map((row) => row.item_id)).toEqual([extraRun]);
    expect(new Date(ledger[0].alerted_at).toISOString()).toBe(ALERTED_AT_SECOND);
    // 外した 5 行は候補に戻る (extraRun は印が残るので数えない)
    expect(brief(await counts())).toEqual([
      ['pg_cron', pgJob.name, 3],
      ['vercel_cron', vercelName, 2],
    ]);

    const secondOff = await sr.rpc('unmark_cron_failures_alerted', { p_alerted_at: ALERTED_AT_SECOND });
    expect(Number(secondOff.data)).toBeGreaterThanOrEqual(1);
    expect((await ledgerRows()).filter((row) => row.job_name.includes(TAG))).toEqual([]);
    expect(brief(await counts())).toEqual([
      ['pg_cron', pgJob.name, 4],
      ['vercel_cron', vercelName, 2],
    ]);
    // 何も無い時刻の unmark は 0 行 (エラーにならない)
    const none = await sr.rpc('unmark_cron_failures_alerted', { p_alerted_at: ALERTED_AT_SECOND });
    expect(none.error).toBeNull();
    expect(Number(none.data)).toBe(0);
  });

  it('B-4: 登録解除されたジョブの失敗は jobid:<n> の名前になる (S-16)', async () => {
    const gone = await scheduleTestJob('j2');
    const runid = await insertRun(gone.jobid, 'failed', "interval '1 hour'");
    await asPostgres(`SELECT cron.unschedule(${gone.jobid});`);

    const orphan = (await counts()).filter((row) => row.job_name === `jobid:${gone.jobid}`);
    expect(orphan.map((row) => [row.source, row.job_name, Number(row.failed_count)])).toEqual([['pg_cron', `jobid:${gone.jobid}`, 1]]);
    // 後片付けのために、台帳に書いておく (名前の印が無いので、item_id で消す)
    expect(createdRunIds).toContain(runid);
  });

  it('B-5: route の名前の 3 つの形 (cron/<名前>・cron/<名前>・GET /api/cron/<名前>) の 500 の行はどれも候補に入り、形の違う名前は入らない (S-18・S-20)', async () => {
    const accepted = [`cron/${TAG}-app-log-alerts`, `cron/${TAG}-backup-freshness`, `GET /api/cron/${TAG}-process-menu-queue`];
    const rejected = [`api/cron/${TAG}-x`, `cron-${TAG}-x`, `GET /api/crontab/${TAG}-x`, `${TAG}-cron/x`];
    for (const functionName of [...accepted, ...rejected]) await insertLog({ functionName, ago: "interval '1 hour'" });

    const watched = new Set([...accepted, ...rejected]);
    const found = brief(await counts()).filter(([, name]) => watched.has(name));
    expect([...found].sort()).toEqual(accepted.map((name) => ['vercel_cron', name, 1]).sort());
  });

  it('B-6: 窓を持たない。台帳に無い失敗は 1 分前・1 日前・6 日 23 時間前のどれも候補に入り、7 日 1 分前は入らない (S-04・S-10)。pg_cron の実行も同じ', async () => {
    const windowJob = await scheduleTestJob('j3');
    const windowName = `cron/${TAG}-window`;
    for (const ago of ["interval '1 minute'", "interval '1 day'", "interval '6 days 23 hours'", "interval '7 days 1 minute'"]) {
      await insertLog({ functionName: windowName, ago });
      await insertRun(windowJob.jobid, 'failed', ago);
    }
    const rows = brief(await counts()).filter(([, name]) => name === windowName || name === windowJob.name);
    expect(rows.sort()).toEqual([
      ['pg_cron', windowJob.name, 3],
      ['vercel_cron', windowName, 3],
    ].sort());
  });

  it('B-7: pg_cron の無い DB では、candidates は Vercel Cron の分だけを返し、pg_cron_last_run_at は (false, 0, NULL) を返す (R-13・S-08)。本物の関数・台帳・pg_cron には触れない', async () => {
    const copy = noCronCopy(MIGRATION_SQL);
    // 置き換えたあとのコピーに、元の cron. と 6 つの名前が残っていないこと (残っていると、本物の関数・台帳・cron に触れる)
    expect(copy).not.toMatch(/\bcron\./);
    for (const name of COPY_OBJECT_NAMES) expect(copy, `${name} の置き換え漏れ`).not.toMatch(new RegExp(`\\bpublic\\.${name}\\b`));
    expect(copy).toContain(`to_regclass('public.${ABSENT_PREFIX}job_run_details')`);
    // 対照: 差し替えた名前の表は本当に存在しない
    await expect(asPostgres(`SELECT 1 FROM public.${ABSENT_PREFIX}job_run_details;`)).rejects.toThrow(new RegExp(`${ABSENT_PREFIX}job_run_details`));

    try {
      await asPostgres(copy);
      // 本物の pg_cron の失敗の実行 (この DB には cron がある) があっても、コピーは数えない
      const copyOnlyJob = await scheduleTestJob('j4');
      await insertRun(copyOnlyJob.jobid, 'failed', "interval '1 hour'");
      const copyLogName = `cron/${TAG}-nocron`;
      await insertLog({ functionName: copyLogName, ago: "interval '1 hour'" });

      const candidates = await asPostgres<{ source: string; job_name: string }>(
        `SELECT source, job_name FROM public.${NO_CRON_PREFIX}cron_failure_candidates() WHERE job_name LIKE ${lit(`%${TAG}%`)} ORDER BY job_name;`,
      );
      expect(candidates).toContainEqual({ source: 'vercel_cron', job_name: copyLogName });
      expect(candidates.filter((row) => row.source === 'pg_cron'), 'cron の無い DB では pg_cron の分を数えない').toEqual([]);

      const lastRun = await asPostgres(`SELECT cron_available, active_jobs, last_run_at FROM public.${NO_CRON_PREFIX}pg_cron_last_run_at();`);
      expect(lastRun).toEqual([{ cron_available: false, active_jobs: 0, last_run_at: null }]);
      // コピーの counts は呼べる (cron の無い枝でも例外にならない)
      const copyCounts = await asPostgres<{ job_name: string; failed_count: number }>(
        `SELECT job_name, failed_count FROM public.${NO_CRON_PREFIX}cron_failure_counts(${COUNT_LIMIT_MAX}) WHERE job_name = ${lit(copyLogName)};`,
      );
      expect(copyCounts.map((row) => [row.job_name, Number(row.failed_count)])).toEqual([[copyLogName, 1]]);
    } finally {
      await dropNoCronCopy();
    }
    // 本物の関数・台帳・ジョブは変わらない
    const real = await asPostgres<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname IN ('cron_failure_candidates', 'cron_failure_counts', 'mark_cron_failures_alerted', 'unmark_cron_failures_alerted', 'pg_cron_last_run_at');
    `);
    expect(real[0].n).toBe(FUNCTIONS.length);
    expect(brief(await counts()).some(([, name]) => name === pgJob.name)).toBe(true);
  });
});

// ---------------------------------------------------------------
// C. pg_cron_last_run_at
// ---------------------------------------------------------------
describe('#1125 (B) C-1. pg_cron_last_run_at', () => {
  it('cron_available true・有効なジョブ数・最新の start_time を返す', async () => {
    const job = await scheduleTestJob('j5');
    // 実行履歴のどの行よりも新しい時刻 (1 日先) の行を入れ、最新の start_time になることを見る
    const rows = await asPostgres<{ runid: string | number }>(`
      INSERT INTO cron.job_run_details (runid, jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
      VALUES (${nextRunId()}, ${job.jobid}, 1, current_database(), current_user, ${lit(`SELECT 1 /* ${COMMAND_MARK} */`)}, 'succeeded', ${lit('テスト')},
              now() + interval '1 day', now() + interval '1 day')
      RETURNING runid;
    `);
    createdRunIds.push(String(rows[0].runid));
    // 時刻の表記 (タイムゾーン) に依らないよう、エポックのミリ秒で比べる
    const active = await asPostgres<{ n: number; latest_ms: string | number }>(`
      SELECT (SELECT count(*)::int FROM cron.job WHERE active) AS n,
             (SELECT (extract(epoch FROM max(start_time)) * 1000)::bigint FROM cron.job_run_details) AS latest_ms;
    `);

    const { data, error } = await withSchemaCacheRetry(() => sr.rpc('pg_cron_last_run_at'));
    expect(error).toBeNull();
    const result = data as Array<{ cron_available: boolean; active_jobs: number; last_run_at: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].cron_available).toBe(true);
    expect(result[0].active_jobs).toBe(active[0].n);
    expect(result[0].active_jobs).toBeGreaterThanOrEqual(1);
    // 1 日先に入れた行が最新の start_time (関数が返す時刻 = 実行履歴の最大の start_time)
    expect(new Date(result[0].last_run_at).getTime()).toBe(Number(active[0].latest_ms));
    expect(new Date(result[0].last_run_at).getTime()).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------
// F. rollback
// ---------------------------------------------------------------
describe('#1125 (B) F-1. rollback で関数 5 本と台帳が消え、もう一度 migration を流すと戻る', () => {
  it('rollback: 関数 5 本と台帳が消える。pg_cron のジョブ・実行履歴・app_logs・ops_alert_state の行は残る。何度流しても同じ', async () => {
    const stateKey = `${TAG}-state`;
    const { error: stateError } = await sr.from('ops_alert_state').upsert({ alert_key: stateKey });
    expect(stateError).toBeNull();
    // 実行履歴は pg_cron の本物のジョブが増やすので、全体の数ではなく、このテストが入れた行 (command の印) の数を見る
    const before = await asPostgres<{ jobs: number; runs: number; logs: number }>(`
      SELECT (SELECT count(*)::int FROM cron.job) AS jobs,
             (SELECT count(*)::int FROM cron.job_run_details WHERE command LIKE ${lit(`%${COMMAND_MARK}%`)}) AS runs,
             (SELECT count(*)::int FROM public.app_logs WHERE source = ${lit(TAG)}) AS logs;
    `);
    expect(before[0].runs).toBeGreaterThan(0);

    await asPostgres(ROLLBACK_SQL);
    await asPostgres(ROLLBACK_SQL); // 冪等

    const gone = await pgQuery<{ fn: string; present: boolean }>(`
      SELECT f AS fn, to_regprocedure('public.' || f) IS NOT NULL AS present
        FROM unnest(ARRAY[
          'cron_failure_candidates()', 'cron_failure_counts(integer)', 'mark_cron_failures_alerted(timestamptz, integer)',
          'unmark_cron_failures_alerted(timestamptz)', 'pg_cron_last_run_at()'
        ]) AS f;
    `);
    expect(gone.filter((row) => row.present)).toEqual([]);
    const table = await pgQuery<{ present: boolean }>(`SELECT to_regclass('public.cron_failure_alerts') IS NOT NULL AS present;`);
    expect(table[0].present).toBe(false);

    const after = await asPostgres<{ jobs: number; runs: number; logs: number }>(`
      SELECT (SELECT count(*)::int FROM cron.job) AS jobs,
             (SELECT count(*)::int FROM cron.job_run_details WHERE command LIKE ${lit(`%${COMMAND_MARK}%`)}) AS runs,
             (SELECT count(*)::int FROM public.app_logs WHERE source = ${lit(TAG)}) AS logs;
    `);
    expect(after).toEqual(before);
    const state = await asPostgres(`SELECT alert_key FROM public.ops_alert_state WHERE alert_key = ${lit(stateKey)};`);
    expect(state).toEqual([{ alert_key: stateKey }]);
  });

  it('rollback のあとにもう一度 migration を流すと戻り (何度流しても同じ)、権限も元のとおり。台帳は空で、関数は呼べる', async () => {
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL); // 冪等

    for (const fn of FUNCTIONS) {
      const row = await pgQuery<{ present: boolean; service_role: boolean; anon: boolean }>(`
        SELECT to_regprocedure(${lit(REGPROC_ARGS[fn])}) IS NOT NULL AS present,
               has_function_privilege('service_role', to_regprocedure(${lit(REGPROC_ARGS[fn])})::oid, 'EXECUTE') AS service_role,
               has_function_privilege('anon', to_regprocedure(${lit(REGPROC_ARGS[fn])})::oid, 'EXECUTE') AS anon;
      `);
      expect(row[0], fn).toEqual({ present: true, service_role: SERVICE_ROLE_ONLY_FUNCTIONS.includes(fn), anon: false });
    }
    const empty = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM public.cron_failure_alerts;`);
    expect(empty[0].n).toBe(0);
    const called = await withSchemaCacheRetry(() => sr.rpc('cron_failure_counts', { p_limit: 1 }));
    expect(called.error).toBeNull();
  });
});
