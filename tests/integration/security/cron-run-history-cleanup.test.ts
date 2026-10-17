/**
 * #1125 (B) pg_cron の実行履歴の掃除 (migration 20261018020000_cleanup_cron_run_history.sql・設計 operator/11 §5.3・§11.3・段 D) の結合テスト
 *
 * 関数 public.cleanup_cron_run_history() と pg_cron のジョブ cleanup-cron-run-history の、実際の動きを確かめる。
 * 書き方の取り決めは tests/cron-run-history-cleanup-contract.test.ts。
 *
 * 確かめること (it の頭の記号は設計 §11.3 の記号):
 *   A-1: 関数は SECURITY DEFINER・search_path 空・所有者 postgres。EXECUTE はどのロールにも付かず (PUBLIC にも無い)、anon / service_role の RPC は 42501
 *   B-1: 30 日より古い実行履歴 (end_time が無い行は start_time で判断) と台帳の行だけを消し、新しい行は残す。戻り値は消した件数
 *   B-2: pg_cron の無い DB (cron. を存在しない名前に差し替えたコピー) では、実行履歴に触れず台帳だけを掃除する
 *   C-1: ジョブ cleanup-cron-run-history が決めた名前・時刻・command で 1 つ登録されている。migration を 2 回流しても 1 つ。同じ関数を呼ぶ別名のジョブは登録解除される
 *   D-1: rollback で関数とジョブが消え、台帳と実行履歴の行は残る。もう一度 migration を流すと戻る
 *
 * 関数は、この DB にある本物の古い行 (ほかのテスト・ローカルの動作が残したもの) も消す。そのため、最初に 1 回呼んで古い行を片付けてから
 * (ローカルの Supabase なので害は無い。結合テストは 1 本ずつ動く: vitest.integration.config.ts)、このテストが入れた行 (名前の印 TAG) の消え方を、
 * 件数まで確かめる。このテストが作った行 (ジョブ・実行履歴・台帳) は、終わりに必ず消す。時刻の計算は DB の時計 (now()) で行う。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/cron-run-history-cleanup.test.ts
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
const VERSION = '20261018020000';
const NAME = 'cleanup_cron_run_history';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/rollbacks/${VERSION}_${NAME}.down.sql`), 'utf8');

const FUNCTION_NAME = 'cleanup_cron_run_history';
const REGPROC = `public.${FUNCTION_NAME}()`;
const JOB_NAME = 'cleanup-cron-run-history';
const JOB_SCHEDULE = '35 18 * * *';
const JOB_COMMAND = 'SELECT public.cleanup_cron_run_history();';
const PERMISSION_DENIED_SQLSTATE = '42501';
/** PostgREST が RPC の関数を見つけられないときのコード (migration を流した直後のスキーマキャッシュの更新待ち) */
const SCHEMA_CACHE_MISS_CODE = 'PGRST202';
const SCHEMA_CACHE_RETRIES = 20;
const SCHEMA_CACHE_RETRY_DELAY_MS = 500;

const RUN = randomBytes(4).toString('hex');
/** このテストが入れた行の名前の印 (ジョブ名・台帳の job_name に入れる) */
const TAG = `t1125d-${RUN}`;
/** 1 月 1 日にしか動かない予定 (テスト中に pg_cron が実行することはない) */
const NEVER_SOON = '0 0 1 1 *';
/** ジョブの command に入れる印。実行履歴の行の command にも入れて、後片付けで見分ける */
const COMMAND_MARK = `T1125D-TEST-${RUN}`;

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

// ---------------------------------------------------------------
// 準備: ジョブ・実行履歴・台帳
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

/** テスト用のジョブを登録して jobid を返す (名前に TAG・command に印) */
async function scheduleTestJob(suffix: string, command = `SELECT 1 /* ${COMMAND_MARK} */`): Promise<{ jobid: number; name: string }> {
  const name = `${TAG}-${suffix}`;
  const rows = await asPostgres(`SELECT cron.schedule(${lit(name)}, ${lit(NEVER_SOON)}, ${lit(command)}) AS jobid;`);
  return { jobid: Number(rows[0].jobid), name };
}

/**
 * 実行履歴に 1 行入れる。start / end は DB の now() からの差 (例: "interval '31 days'")。end が null なら end_time を NULL のままにする
 * (worker が途中で落ちた行)。入れた runid を返す
 */
async function insertRun(jobid: number, start: string, end: string | null): Promise<string> {
  const rows = await asPostgres<{ runid: string | number }>(`
    INSERT INTO cron.job_run_details (runid, jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
    VALUES (${nextRunId()}, ${jobid}, 1, current_database(), current_user, ${lit(`SELECT 1 /* ${COMMAND_MARK} */`)}, 'succeeded', ${lit('テスト')},
            now() - ${start}, ${end === null ? 'NULL' : `now() - ${end}`})
    RETURNING runid;
  `);
  const runid = String(rows[0].runid);
  createdRunIds.push(runid);
  return runid;
}

/** 台帳に 1 行入れる (表の権限は所有者 postgres だけ)。alerted_at は DB の now() からの差。入れた item_id を返す */
async function insertLedger(label: string, alertedAgo: string): Promise<string> {
  const itemId = `${TAG}-${label}`;
  await asPostgres(`
    INSERT INTO public.cron_failure_alerts (source, item_id, job_name, failed_at, alerted_at)
    VALUES ('pg_cron', ${lit(itemId)}, ${lit(`${TAG}-job`)}, now() - ${alertedAgo}, now() - ${alertedAgo});
  `);
  return itemId;
}

async function survivingRuns(): Promise<string[]> {
  if (createdRunIds.length === 0) return [];
  const rows = await asPostgres<{ runid: string | number }>(
    `SELECT runid FROM cron.job_run_details WHERE command LIKE ${lit(`%${COMMAND_MARK}%`)} ORDER BY runid;`,
  );
  return rows.map((row) => String(row.runid));
}

async function survivingLedger(): Promise<string[]> {
  const rows = await asPostgres<{ item_id: string }>(
    `SELECT item_id FROM public.cron_failure_alerts WHERE job_name = ${lit(`${TAG}-job`)} ORDER BY item_id;`,
  );
  return rows.map((row) => row.item_id);
}

interface CleanupResult {
  run_details_deleted: number;
  alerts_deleted: number;
}

/** 所有者 postgres (= pg_cron と同じ立場) で関数を呼ぶ。service_role には EXECUTE が無い */
async function callCleanup(): Promise<CleanupResult> {
  const rows = await asPostgres<CleanupResult>(`SELECT run_details_deleted, alerts_deleted FROM public.${FUNCTION_NAME}();`);
  expect(rows).toHaveLength(1);
  return { run_details_deleted: Number(rows[0].run_details_deleted), alerts_deleted: Number(rows[0].alerts_deleted) };
}

async function jobsNamed(name: string): Promise<Array<{ jobid: number; schedule: string; command: string; active: boolean; username: string }>> {
  return asPostgres(`SELECT jobid::int AS jobid, schedule, command, active, username FROM cron.job WHERE jobname = ${lit(name)} ORDER BY jobid;`);
}

async function cleanup(): Promise<void> {
  await asPostgres(`DELETE FROM cron.job_run_details WHERE command LIKE ${lit(`%${COMMAND_MARK}%`)};`);
  await asPostgres(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE ${lit(`${TAG}-%`)} OR command LIKE ${lit(`%${COMMAND_MARK}%`)};`);
  await asPostgres(`
    DO $t1125d$ BEGIN
      IF to_regclass('public.cron_failure_alerts') IS NOT NULL THEN
        DELETE FROM public.cron_failure_alerts WHERE job_name LIKE ${lit(`%${TAG}%`)};
      END IF;
    END $t1125d$;
  `);
  await dropNoCronCopy();
}

// ---------------------------------------------------------------
// B-2: pg_cron の無い DB のコピー
// ---------------------------------------------------------------
const NO_CRON_PREFIX = 't1125d_nocron_';
const ABSENT_PREFIX = 't1125d_absent_';

/**
 * migration のコピー: cron. を存在しない public.t1125d_absent_ に、関数の名前を t1125d_nocron_ 付きに置き換える。
 * 台帳 public.cron_failure_alerts は本物のまま (台帳の掃除が cron に依らないことを、本物の表で確かめる)
 */
function noCronCopy(sql: string): string {
  return sql
    .replace(/\bcron\./g, `public.${ABSENT_PREFIX}`)
    .replace(new RegExp(`\\bpublic\\.${FUNCTION_NAME}\\b`, 'g'), `public.${NO_CRON_PREFIX}${FUNCTION_NAME}`);
}

async function dropNoCronCopy(): Promise<void> {
  await asPostgres(`DROP FUNCTION IF EXISTS public.${NO_CRON_PREFIX}${FUNCTION_NAME}();`);
}

beforeAll(async () => {
  // 前回の異常終了の残りを片付ける (名前の印は実行ごとに違うので、昔の TAG の残りは別の印で拾う)
  await asPostgres(`SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 't1125d-%' OR command LIKE '%T1125D-TEST-%';`);
  await asPostgres(`DELETE FROM cron.job_run_details WHERE command LIKE '%T1125D-TEST-%';`);
  await asPostgres(`DELETE FROM public.cron_failure_alerts WHERE job_name LIKE '%t1125d-%';`);
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
describe('#1125 (B) 段 D A. 関数の権限', () => {
  it('A-1: cleanup_cron_run_history は SECURITY DEFINER・search_path 空・所有者 postgres。EXECUTE はどのロールにも付かず (PUBLIC にも無い)、anon / service_role の RPC は 42501', async () => {
    const attrs = await pgQuery<{ prosecdef: boolean; config: string; owner: string }>(`
      SELECT p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS config, pg_get_userbyid(p.proowner)::text AS owner
        FROM pg_proc p WHERE p.oid = to_regprocedure(${lit(REGPROC)});
    `);
    expect(attrs, '関数が無い').toHaveLength(1);
    expect(attrs[0]).toEqual({ prosecdef: true, config: 'search_path=""', owner: 'postgres' });

    const privileges = await pgQuery<{ role: string; allowed: boolean }>(`
      SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(REGPROC)})::oid, 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;
    `);
    expect(Object.fromEntries(privileges.map((row) => [row.role, row.allowed]))).toEqual({ anon: false, authenticated: false, service_role: false });
    const publicGrants = await pgQuery<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.oid = to_regprocedure(${lit(REGPROC)})::oid AND a.grantee = 0;
    `);
    expect(publicGrants[0].n, 'PUBLIC に EXECUTE が残っている').toBe(0);

    for (const [label, db] of [['anon', anon], ['service_role', sr]] as const) {
      const { error } = await withSchemaCacheRetry(() => db.rpc(FUNCTION_NAME));
      expect(error?.code, `${label}: RPC`).toBe(PERMISSION_DENIED_SQLSTATE);
    }
  });
});

// ---------------------------------------------------------------
// B. 消す範囲
// ---------------------------------------------------------------
describe('#1125 (B) 段 D B. 消す範囲', () => {
  it('B-1: 30 日より古い実行履歴 (end_time が無い行は start_time で判断) と台帳の行だけを消し、新しい行は残す。戻り値は消した件数', async () => {
    // この DB にある本物の古い行を先に片付けて、あとの件数を自分の行だけにする
    await callCleanup();
    const job = await scheduleTestJob('j1');

    const oldFinished = await insertRun(job.jobid, "interval '31 days'", "interval '31 days'");
    const oldNoEnd = await insertRun(job.jobid, "interval '31 days'", null); // worker が落ちて end_time が NULL のまま
    const justOver = await insertRun(job.jobid, "interval '30 days 1 minute'", "interval '30 days 1 minute'");
    const justUnder = await insertRun(job.jobid, "interval '29 days 23 hours'", "interval '29 days 23 hours'");
    const recentNoEnd = await insertRun(job.jobid, "interval '29 days'", null);
    const longRunStillNew = await insertRun(job.jobid, "interval '40 days'", "interval '20 days'"); // 終わった時刻が新しい
    const recent = await insertRun(job.jobid, "interval '1 hour'", "interval '1 hour'");

    const ledgerOld = await insertLedger('old', "interval '31 days'");
    const ledgerJustOver = await insertLedger('just-over', "interval '30 days 1 minute'");
    const ledgerJustUnder = await insertLedger('just-under', "interval '29 days 23 hours'");
    const ledgerRecent = await insertLedger('recent', "interval '1 hour'");

    // 新しい行 (29 日より新しいもの) は、掃除のあとも全部残る (本物の行も含めた全体で確かめる)
    const newerRuns = await asPostgres<{ runid: string | number }>(
      `SELECT runid FROM cron.job_run_details WHERE coalesce(end_time, start_time) >= now() - interval '29 days' ORDER BY runid;`,
    );
    const newerLedger = await asPostgres<{ source: string; item_id: string }>(
      `SELECT source, item_id FROM public.cron_failure_alerts WHERE alerted_at >= now() - interval '29 days' ORDER BY source, item_id;`,
    );

    const result = await callCleanup();
    expect(result).toEqual({ run_details_deleted: 3, alerts_deleted: 2 });

    const survivors = await survivingRuns();
    expect(survivors).toEqual([justUnder, recentNoEnd, longRunStillNew, recent].sort());
    for (const gone of [oldFinished, oldNoEnd, justOver]) expect(survivors, `古い実行履歴 ${gone} が残っている`).not.toContain(gone);
    const ledgerSurvivors = await survivingLedger();
    expect(ledgerSurvivors).toEqual([ledgerJustUnder, ledgerRecent].sort());
    for (const gone of [ledgerOld, ledgerJustOver]) expect(ledgerSurvivors, `古い台帳の行 ${gone} が残っている`).not.toContain(gone);

    const afterRuns = await asPostgres<{ runid: string | number }>(`SELECT runid FROM cron.job_run_details ORDER BY runid;`);
    const afterRunIds = new Set(afterRuns.map((row) => String(row.runid)));
    for (const row of newerRuns) expect(afterRunIds.has(String(row.runid)), `新しい実行履歴 ${row.runid} が消えた`).toBe(true);
    const afterLedger = await asPostgres<{ source: string; item_id: string }>(`SELECT source, item_id FROM public.cron_failure_alerts;`);
    const afterLedgerKeys = new Set(afterLedger.map((row) => `${row.source}/${row.item_id}`));
    for (const row of newerLedger) expect(afterLedgerKeys.has(`${row.source}/${row.item_id}`), `新しい台帳の行 ${row.item_id} が消えた`).toBe(true);

    // 2 回目は消すものが無い (冪等)
    expect(await callCleanup()).toEqual({ run_details_deleted: 0, alerts_deleted: 0 });
    // ジョブ本体 (cron.job) には触れない
    expect(await jobsNamed(job.name)).toHaveLength(1);
  });

  it('B-2: pg_cron の無い DB では、実行履歴には触れず、台帳だけを掃除する。本物の関数・ジョブには触れない', async () => {
    const copy = noCronCopy(MIGRATION_SQL);
    // 置き換えたあとのコピーに、元の cron. と本物の関数名が残っていないこと (残っていると、本物の関数・cron に触れる)
    expect(copy).not.toMatch(/\bcron\./);
    expect(copy).not.toMatch(new RegExp(`\\bpublic\\.${FUNCTION_NAME}\\b`));
    expect(copy).toContain(`to_regclass('public.${ABSENT_PREFIX}job_run_details')`);
    await expect(asPostgres(`SELECT 1 FROM public.${ABSENT_PREFIX}job_run_details;`)).rejects.toThrow(new RegExp(`${ABSENT_PREFIX}job_run_details`));

    const job = await scheduleTestJob('j2');
    const oldRun = await insertRun(job.jobid, "interval '31 days'", "interval '31 days'");
    const ledgerOld = await insertLedger('copy-old', "interval '31 days'");
    const ledgerNew = await insertLedger('copy-new', "interval '1 hour'");
    const jobsBefore = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM cron.job;`);

    try {
      await asPostgres(copy);
      const rows = await asPostgres<CleanupResult>(`SELECT run_details_deleted, alerts_deleted FROM public.${NO_CRON_PREFIX}${FUNCTION_NAME}();`);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].run_details_deleted), 'cron の無い DB では実行履歴を消さない').toBe(0);
      expect(Number(rows[0].alerts_deleted)).toBeGreaterThanOrEqual(1);
    } finally {
      await dropNoCronCopy();
    }
    // 実行履歴は残り、台帳は古い行だけが消えた。コピーはジョブを登録していない
    expect(await survivingRuns()).toContain(oldRun);
    const ledger = await survivingLedger();
    expect(ledger).toContain(ledgerNew);
    expect(ledger).not.toContain(ledgerOld);
    const jobsAfter = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM cron.job;`);
    expect(jobsAfter[0].n).toBe(jobsBefore[0].n);
    // 本物の関数は変わらず 1 つ
    const real = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ${lit(FUNCTION_NAME)};`);
    expect(real[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------
// C. ジョブ
// ---------------------------------------------------------------
describe('#1125 (B) 段 D C. pg_cron のジョブ', () => {
  it('C-1: ジョブ cleanup-cron-run-history が決めた名前・時刻 (35 18 * * *)・command で 1 つ登録されている。migration を 2 回流しても 1 つ。同じ関数を呼ぶ別名のジョブは登録解除される', async () => {
    const before = await jobsNamed(JOB_NAME);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ schedule: JOB_SCHEDULE, command: JOB_COMMAND, active: true, username: 'postgres' });

    // 同じ関数を呼ぶ別名のジョブと、関係の無いジョブを置いてから、migration をもう 2 回流す
    const duplicate = await scheduleTestJob('dup', `${JOB_COMMAND} /* ${COMMAND_MARK} */`);
    const unrelated = await scheduleTestJob('unrelated');
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);

    const after = await jobsNamed(JOB_NAME);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ schedule: JOB_SCHEDULE, command: JOB_COMMAND, active: true });
    expect(await jobsNamed(duplicate.name), '同じ関数を呼ぶ別名のジョブは登録解除される').toHaveLength(0);
    expect(await jobsNamed(unrelated.name), '関係の無いジョブは残る').toHaveLength(1);
    // 同じ関数を呼ぶジョブは、全体でも 1 つだけ
    const callers = await asPostgres<{ n: number }>(`SELECT count(*)::int AS n FROM cron.job WHERE command ~* '[[:<:]]${FUNCTION_NAME}[[:>:]]';`);
    expect(callers[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------
// D. rollback
// ---------------------------------------------------------------
describe('#1125 (B) 段 D D. rollback', () => {
  it('D-1: rollback で関数とジョブが消え、台帳と実行履歴の行は残る (何度流しても同じ)。もう一度 migration を流すと戻る', async () => {
    const runsBefore = await survivingRuns();
    const ledgerBefore = await survivingLedger();
    expect(runsBefore.length).toBeGreaterThan(0);
    expect(ledgerBefore.length).toBeGreaterThan(0);
    const totals = await asPostgres<{ runs: number; ledger: number }>(`
      SELECT (SELECT count(*)::int FROM cron.job_run_details) AS runs, (SELECT count(*)::int FROM public.cron_failure_alerts) AS ledger;
    `);

    await asPostgres(ROLLBACK_SQL);
    await asPostgres(ROLLBACK_SQL); // 冪等

    const fn = await pgQuery<{ present: boolean }>(`SELECT to_regprocedure(${lit(REGPROC)}) IS NOT NULL AS present;`);
    expect(fn[0].present).toBe(false);
    expect(await jobsNamed(JOB_NAME)).toHaveLength(0);
    // 台帳と実行履歴は 1 行も減らない (rollback は行を消さない)
    expect(await survivingRuns()).toEqual(runsBefore);
    expect(await survivingLedger()).toEqual(ledgerBefore);
    const totalsAfter = await asPostgres<{ runs: number; ledger: number }>(`
      SELECT (SELECT count(*)::int FROM cron.job_run_details) AS runs, (SELECT count(*)::int FROM public.cron_failure_alerts) AS ledger;
    `);
    expect(totalsAfter[0].runs).toBeGreaterThanOrEqual(totals[0].runs);
    expect(totalsAfter[0].ledger).toBeGreaterThanOrEqual(totals[0].ledger);

    // もう一度 migration を流すと戻る (権限も元のとおり)
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);
    const restored = await pgQuery<{ present: boolean; service_role: boolean; anon: boolean }>(`
      SELECT to_regprocedure(${lit(REGPROC)}) IS NOT NULL AS present,
             has_function_privilege('service_role', to_regprocedure(${lit(REGPROC)})::oid, 'EXECUTE') AS service_role,
             has_function_privilege('anon', to_regprocedure(${lit(REGPROC)})::oid, 'EXECUTE') AS anon;
    `);
    expect(restored[0]).toEqual({ present: true, service_role: false, anon: false });
    const job = await jobsNamed(JOB_NAME);
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ schedule: JOB_SCHEDULE, command: JOB_COMMAND, active: true });
    expect(await callCleanup()).toEqual({ run_details_deleted: 0, alerts_deleted: 0 });
  });
});
