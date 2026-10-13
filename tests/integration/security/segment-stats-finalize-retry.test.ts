/**
 * #1500 比較ランキングの確定の回 (JST 0:05) の再試行を足す migration の回帰テスト
 *
 * migration 20261011120000_segment_stats_finalize_retry.sql は次を作る (count_meals_per_user の作り直しは
 * tests/integration/security/count-meals-per-user.test.ts が確かめる):
 *   - 表 public.segment_stats_finalized_periods: 確定の回をやり終えた期間 (種類・開始日)。service_role だけ
 *   - public.calculate_segment_stats_finalize_retry_bodies(p_at): public.calculate_segment_stats_request_bodies(p_at) のうち
 *     { periodType, previousPeriod: true } だけ (期間が切り替わってから 1 時間以内の種類だけ。それ以外の時刻は空)
 *   - public.invoke_calculate_segment_stats_finalize_retry(): Vault の app_cron_secret を Bearer に付けて、上の本文 (時刻は now()) ごとに
 *     Edge Function calculate-segment-stats を net.http_post で呼ぶ (public.invoke_calculate_segment_stats と同じ形)
 *   - pg_cron のジョブ calculate-segment-stats-finalize-retry: JST 0:20 と 0:35 (UTC 15:20 と 15:35)
 *
 * 確認すること (ローカル Supabase の DB で):
 *   A. ジョブが 1 つだけ、UTC 15:20 と 15:35・postgres の権限・有効で登録されている。migration を流し直しても 1 つのまま
 *   B. Vault に app_cron_secret が無いと、関数は例外で失敗し、要求を 1 つも積まない
 *   C. app_cron_secret があると、本文の配列 (時刻は now()) の順に POST を積む。どれも previousPeriod: true。Bearer は Vault の値
 *   D. anon / authenticated / service_role は 2 つの関数を EXECUTE できない (呼べるのは所有者 postgres = pg_cron のジョブだけ)
 *   E. 再試行の本文は時刻で決まる: JST 0 時台は、切り替わった種類の確定の回の本文だけ。1 時以降・期間の途中は空
 *   F. 表は service_role だけが読み書きでき、anon / authenticated は読めない。(種類, 開始日) で 1 行
 *
 * 本番には接続しない。関数の呼び先は本番の URL に固定されているので、B / C は 1 つのトランザクションの中で関数を呼んで
 * 結果を取り出し、最後に例外でロールバックする (pg_net の待ち行列 net.http_request_queue への行はコミットされないので、
 * pg_net は実際には送らない。テスト用に作った Vault の値もロールバックで消える)。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/segment-stats-finalize-retry.test.ts
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261011120000_segment_stats_finalize_retry.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');
const MIGRATIONS_DIR = 'supabase/migrations';

/** `--` から行末までのコメントを除く */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** SQL が CREATE OR REPLACE する public の関数の名前 */
function replacedFunctionNames(sql: string): Set<string> {
  return new Set([...stripLineComments(sql).matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)\s*\(/gi)].map((m) => m[1]));
}

/**
 * 本 migration より後の migration のうち、本 migration が作る関数を作り直すもの (番号の順)。
 * A で本 migration を流し直すと、それらの関数が本 migration の時点の定義に戻る
 * (例: 20261011130000_count_meals_per_user_exclude_hidden.sql の count_meals_per_user。#1445)。
 * 同じ DB を使うほかのテストが最新の定義を前提にしているので、流し直したあとにこれらを番号の順に流して最新の定義へ戻す
 */
const LATER_REDEFINING_MIGRATIONS: Array<{ file: string; sql: string }> = (() => {
  const own = path.basename(MIGRATION_FILE);
  const ownFunctions = replacedFunctionNames(MIGRATION_SQL);
  return fs
    .readdirSync(path.join(REPO_ROOT, MIGRATIONS_DIR))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name) && name > own)
    .sort()
    .map((name) => ({ file: `${MIGRATIONS_DIR}/${name}`, sql: fs.readFileSync(path.join(REPO_ROOT, MIGRATIONS_DIR, name), 'utf8') }))
    .filter(({ sql }) => [...replacedFunctionNames(sql)].some((fn) => ownFunctions.has(fn)));
})();

const JOB_NAME = 'calculate-segment-stats-finalize-retry';
/** UTC 15:20 と 15:35 = JST 0:20 と 0:35 */
const JOB_SCHEDULE = '20,35 15 * * *';
const FUNCTION_SIGNATURE = 'public.invoke_calculate_segment_stats_finalize_retry()';
const BODIES_SIGNATURE = 'public.calculate_segment_stats_finalize_retry_bodies(timestamptz)';
const TABLE = 'segment_stats_finalized_periods';
const EDGE_FUNCTION_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/calculate-segment-stats';
/** 関数が pg_net に渡す応答の待ち時間の上限 (ミリ秒)。migration の c_timeout_ms と同じ */
const EXPECTED_TIMEOUT_MS = 400000;
/** B / C で、ロールバックさせる例外の目印 (この後ろに結果の JSON を付ける) */
const RESULT_MARK = 'I1500_RESULT:';
/** PostgreSQL の「権限が無い」(insufficient_privilege) */
const PERMISSION_DENIED = '42501';
/** PostgreSQL の「一意制約違反」(unique_violation) */
const UNIQUE_VIOLATION = '23505';

type PgResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; status: number; message: string };

/** ローカルスタックの postgres-meta で SQL を流す。失敗は例外にせず、エラー文を返す */
async function pgQueryRaw(query: string): Promise<PgResult> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await res.json();
  if (res.ok) return { ok: true, rows: body as Record<string, unknown>[] };
  const message = (body as { message?: unknown; error?: unknown } | null)?.message ?? (body as { error?: unknown } | null)?.error;
  return { ok: false, status: res.status, message: typeof message === 'string' ? message : JSON.stringify(body) };
}

async function pgQuery(query: string): Promise<Record<string, unknown>[]> {
  const result = await pgQueryRaw(query);
  if (!result.ok) throw new Error(`pg/query ${result.status}: ${result.message}`);
  return result.rows;
}

/** migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres(sql: string): Promise<Record<string, unknown>[]> {
  return pgQuery(`SET LOCAL ROLE postgres;\n${sql}`);
}

/** SQL の文字列リテラルにする (テストが決めた固定の文字列だけを渡す) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

interface JobRow {
  jobid: number | string;
  schedule: string;
  command: string;
  username: string;
  active: boolean;
}

async function scheduledJobs(): Promise<JobRow[]> {
  const rows = await asPostgres(`
    SELECT jobid, schedule, command, username, active
    FROM cron.job
    WHERE jobname = ${lit(JOB_NAME)}
    ORDER BY jobid;
  `);
  return rows as unknown as JobRow[];
}

/** net.http_request_queue の行数 (B で「要求を積まない」ことの確認に使う。B はロールバックするので前後で比べる) */
async function queuedRequestCount(): Promise<number> {
  const rows = await asPostgres(`SELECT count(*)::int AS n FROM net.http_request_queue;`);
  return Number(rows[0].n);
}

beforeAll(async () => {
  const rows = await pgQuery(
    `SELECT to_regclass('cron.job')::text AS cron_job, to_regclass('net.http_request_queue')::text AS queue,
            to_regprocedure(${lit(FUNCTION_SIGNATURE)})::text AS fn,
            to_regprocedure(${lit(BODIES_SIGNATURE)})::text AS bodies_fn,
            to_regclass(${lit(`public.${TABLE}`)})::text AS finalized_table;`,
  );
  if (!rows[0]?.cron_job || !rows[0]?.queue) {
    throw new Error('cron.job / net.http_request_queue がありません。ローカル DB に pg_cron / pg_net が入っていません。');
  }
  if (!rows[0]?.fn || !rows[0]?.bodies_fn || !rows[0]?.finalized_table) {
    throw new Error(`${FUNCTION_SIGNATURE} / ${BODIES_SIGNATURE} / public.${TABLE} がありません。${MIGRATION_FILE} がローカル DB に適用されていません。`);
  }
}, 30_000);

// ---------------------------------------------------------------
// A. ジョブの登録
// ---------------------------------------------------------------
describe('#1500 A. pg_cron のジョブ', () => {
  it(`${JOB_NAME} が 1 つだけ、UTC 15:20 と 15:35 (JST 0:20 と 0:35) に、postgres の権限で、有効な状態で登録されている`, async () => {
    const jobs = await scheduledJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ schedule: JOB_SCHEDULE, username: 'postgres', active: true });
    expect(jobs[0].command.trim()).toBe(`SELECT ${FUNCTION_SIGNATURE}`);
  });

  it('migration を流し直しても、ジョブは 1 つのまま (同じ名前のジョブを外してから登録する)。表の行も消えない', async () => {
    const before = await asPostgres(`SELECT count(*)::int AS n FROM public.${TABLE};`);

    try {
      await asPostgres(MIGRATION_SQL);
      await asPostgres(MIGRATION_SQL);

      const jobs = await scheduledJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ schedule: JOB_SCHEDULE, username: 'postgres', active: true });
      const after = await asPostgres(`SELECT count(*)::int AS n FROM public.${TABLE};`);
      expect(Number(after[0].n)).toBe(Number(before[0].n));
    } finally {
      // 流し直しで古い定義に戻った関数を、後の migration の定義へ戻す (同じ DB を使うほかのテストのため。#1445)
      for (const later of LATER_REDEFINING_MIGRATIONS) await asPostgres(later.sql);
    }
  }, 30_000);

  it('流し直したあと、後の migration が作り直した関数は最新の定義に戻っている (count_meals_per_user は隠した行も除く。#1445)', async () => {
    // 前提: 後の migration (20261011130000_count_meals_per_user_exclude_hidden.sql) を拾えている
    expect(LATER_REDEFINING_MIGRATIONS.map((m) => path.basename(m.file))).toContain('20261011130000_count_meals_per_user_exclude_hidden.sql');
    const [row] = await asPostgres(`SELECT pg_get_functiondef('public.count_meals_per_user()'::regprocedure) AS def;`);
    const def = String(row.def).replace(/\s+/g, ' ');
    expect(def).toMatch(/WHERE m\.is_sandbox = false AND m\.hidden_at IS NULL/);
  });
});

// ---------------------------------------------------------------
// B / C. 関数が積む要求 (どちらもロールバックするので、本番へは送らない)
// ---------------------------------------------------------------
describe('#1500 B. Vault に app_cron_secret が無いとき', () => {
  it('関数は例外で失敗し、要求を 1 つも積まない (時刻によらない)', async () => {
    const before = await queuedRequestCount();

    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
      SELECT ${FUNCTION_SIGNATURE};
    `);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('app_cron_secret not found in Vault');
    expect(await queuedRequestCount()).toBe(before);
  });
});

interface QueuedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeout_milliseconds: number;
}

describe('#1500 C. Vault に app_cron_secret があるとき', () => {
  it('本文の配列 (時刻は now()) の順に POST を積む。どれも確定の回の本文。Bearer は Vault の値', async () => {
    const secret = `i1500-test-${randomBytes(8).toString('hex')}`;

    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      DO $test$
      DECLARE
        v_ids bigint[];
        v_requests jsonb;
        v_expected jsonb;
      BEGIN
        DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
        PERFORM vault.create_secret(${lit(secret)}, 'app_cron_secret', 'i1500 integration test (rolled back)');
        v_ids := ${FUNCTION_SIGNATURE};
        -- 関数と同じトランザクションなので now() は同じ時刻。関数が使ったはずの本文の配列
        v_expected := to_jsonb(public.calculate_segment_stats_finalize_retry_bodies(now()));
        SELECT coalesce(jsonb_agg(
                 jsonb_build_object(
                   'method', q.method,
                   'url', q.url,
                   'headers', q.headers,
                   'body', convert_from(q.body, 'UTF8')::jsonb,
                   'timeout_milliseconds', q.timeout_milliseconds
                 ) ORDER BY q.id), '[]'::jsonb)
          INTO v_requests
          FROM net.http_request_queue q
          WHERE q.id = ANY (v_ids);
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object('ids', to_jsonb(v_ids), 'requests', v_requests, 'expected', v_expected);
      END
      $test$;
    `);

    expect(result.ok, 'ロールバックのための例外で終わること').toBe(false);
    if (result.ok) return;
    const json = result.message.slice(result.message.indexOf(RESULT_MARK) + RESULT_MARK.length);
    const { ids, requests, expected } = JSON.parse(json) as {
      ids: number[];
      requests: QueuedRequest[];
      expected: Record<string, unknown>[];
    };

    // テストを流す時刻 (now()) によって、本文は 0〜3 個 (JST 0 時台以外は 0 個)。E で時刻ごとの中身を確かめる
    expect(ids).toHaveLength(expected.length);
    expect(requests.map((r) => r.body)).toEqual(expected);
    for (const body of expected) expect(body).toMatchObject({ previousPeriod: true });
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe(EDGE_FUNCTION_URL);
      expect(request.headers).toMatchObject({
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      });
      expect(request.timeout_milliseconds).toBe(EXPECTED_TIMEOUT_MS);
    }

    const leftovers = await asPostgres(`SELECT count(*)::int AS n FROM vault.secrets WHERE description LIKE 'i1500 integration test%';`);
    expect(Number(leftovers[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------
// D. 権限
// ---------------------------------------------------------------
describe('#1500 D. 関数の権限', () => {
  it.each(
    ['anon', 'authenticated', 'service_role'].flatMap((role) => [
      [role, FUNCTION_SIGNATURE],
      [role, BODIES_SIGNATURE],
    ]),
  )('%s は %s を EXECUTE できない', async (role, signature) => {
    const rows = await pgQuery(`SELECT has_function_privilege(${lit(role)}, ${lit(signature)}, 'EXECUTE') AS can_execute;`);
    expect(rows[0].can_execute).toBe(false);
  });

  it('本文の関数は SECURITY INVOKER・所有者は postgres・search_path は空・STABLE。呼び出しの関数は SECURITY DEFINER・所有者は postgres・search_path は空', async () => {
    const rows = await pgQuery(`
      SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner,
             p.proconfig AS config, p.provolatile AS volatility
      FROM pg_proc p
      WHERE p.oid IN (to_regprocedure(${lit(BODIES_SIGNATURE)}), to_regprocedure(${lit(FUNCTION_SIGNATURE)}))
      ORDER BY 1;
    `);
    const bySignature = new Map(rows.map((r) => [String(r.signature), r]));
    expect(bySignature.get('calculate_segment_stats_finalize_retry_bodies(timestamp with time zone)')).toMatchObject({
      security_definer: false,
      owner: 'postgres',
      volatility: 's',
      config: ['search_path=""'],
    });
    expect(bySignature.get('invoke_calculate_segment_stats_finalize_retry()')).toMatchObject({
      security_definer: true,
      owner: 'postgres',
      config: ['search_path=""'],
    });
  });
});

// ---------------------------------------------------------------
// E. 時刻ごとの再試行の本文
// ---------------------------------------------------------------
describe('#1500 E. 再試行の本文は時刻で決まる (期間が切り替わってから 1 時間以内の種類の、確定の回の本文だけ)', () => {
  const previous = (periodType: string) => ({ periodType, previousPeriod: true });

  async function bodiesAt(at: string): Promise<Record<string, unknown>[]> {
    const rows = await asPostgres(`SELECT to_jsonb(public.calculate_segment_stats_finalize_retry_bodies(${lit(at)}::timestamptz)) AS bodies;`);
    return rows[0].bodies as Record<string, unknown>[];
  }

  // [時刻 (UTC), 説明, 確定の回の本文を送る種類]
  const cases: Array<[string, string, string[]]> = [
    ['2027-01-31T15:20:00Z', 'JST 月曜 2027-02-01 0:20 (日・週・月が同時に切り替わった。1 回目の再試行)', ['daily', 'weekly', 'monthly']],
    ['2027-01-31T15:35:00Z', 'JST 月曜 2027-02-01 0:35 (2 回目の再試行)', ['daily', 'weekly', 'monthly']],
    ['2026-10-12T15:20:00Z', 'JST 火曜 2026-10-13 0:20 (日だけ切り替わる)', ['daily']],
    ['2026-10-11T15:35:00Z', 'JST 月曜 2026-10-12 0:35 (日と週)', ['daily', 'weekly']],
    ['2026-10-31T15:20:00Z', 'JST 日曜 2026-11-01 0:20 (日と月)', ['daily', 'monthly']],
    ['2027-01-31T16:00:00Z', 'JST 月曜 2027-02-01 1:00 ちょうど (窓を過ぎた)', []],
    ['2026-10-12T03:20:00Z', 'JST 月曜 2026-10-12 12:20 (期間の途中)', []],
  ];

  it.each(cases)('%s (%s)', async (at, _label, previousTypes) => {
    expect(await bodiesAt(at)).toEqual(previousTypes.map(previous));
  });

  it('時刻が NULL なら例外にする (本文を空で返して、黙って何も再試行しない状態にしない)', async () => {
    const result = await pgQueryRaw(`SET LOCAL ROLE postgres; SELECT public.calculate_segment_stats_finalize_retry_bodies(NULL);`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('p_at must not be null');
  });
});

// ---------------------------------------------------------------
// F. 確定の回をやり終えた期間の表
// ---------------------------------------------------------------
describe('#1500 F. 表 segment_stats_finalized_periods', () => {
  // 実際の期間と重ならない日付 (このテストが作って、最後に消す)
  const PERIOD = { period_type: 'weekly', period_start: '1999-01-04', period_end: '1999-01-10' };

  it('service_role は書いて読める。同じ (種類, 開始日) の 2 行目は一意制約で拒まれる', async () => {
    const sr = client(serviceKey);
    try {
      const { error: insertError } = await sr.from(TABLE).insert(PERIOD);
      expect(insertError).toBeNull();
      const { data, error } = await sr.from(TABLE).select('period_type, period_start, period_end, finalized_at').match(PERIOD);
      expect(error).toBeNull();
      expect(data).toEqual([{ ...PERIOD, finalized_at: expect.any(String) }]);

      const { error: duplicateError } = await sr.from(TABLE).insert({ ...PERIOD, period_end: '1999-01-11' });
      expect(duplicateError?.code, duplicateError?.message).toBe(UNIQUE_VIOLATION);
    } finally {
      await sr.from(TABLE).delete().eq('period_type', PERIOD.period_type).eq('period_start', PERIOD.period_start);
    }
  });

  it('未ログイン (anon) は読めず書けない (42501)', async () => {
    const anon = client(anonKey);
    const read = await anon.from(TABLE).select('period_type');
    expect(read.error?.code, read.error?.message).toBe(PERMISSION_DENIED);
    const write = await anon.from(TABLE).insert(PERIOD);
    expect(write.error?.code, write.error?.message).toBe(PERMISSION_DENIED);
  });

  it('権限: anon / authenticated には何も無く、service_role には SELECT / INSERT / UPDATE / DELETE。RLS が有効', async () => {
    const [row] = await pgQuery(`
      SELECT
        has_table_privilege('anon', 'public.${TABLE}', 'SELECT,INSERT,UPDATE,DELETE') AS anon,
        has_table_privilege('authenticated', 'public.${TABLE}', 'SELECT,INSERT,UPDATE,DELETE') AS authenticated,
        has_table_privilege('service_role', 'public.${TABLE}', 'SELECT') AS sr_select,
        has_table_privilege('service_role', 'public.${TABLE}', 'INSERT') AS sr_insert,
        has_table_privilege('service_role', 'public.${TABLE}', 'UPDATE') AS sr_update,
        has_table_privilege('service_role', 'public.${TABLE}', 'DELETE') AS sr_delete,
        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${TABLE}'::regclass) AS rls
    `);
    expect(row).toEqual({
      anon: false,
      authenticated: false,
      sr_select: true,
      sr_insert: true,
      sr_update: true,
      sr_delete: true,
      rls: true,
    });
  });
});
