/**
 * #1406 セグメント統計 (比較ランキング) の集計を、pg_cron で 1 時間ごと (毎時 5 分) に呼ぶ migration の回帰テスト
 *
 * migration 20261009100000_schedule_calculate_segment_stats.sql は次の 3 つを作る:
 *   - public.calculate_segment_stats_request_bodies(p_at): 時刻 p_at に送る本文の配列。daily / weekly / monthly の
 *     { periodType } と、p_at (JST) が期間の始まりから 1 時間以内の種類だけ { periodType, previousPeriod: true }
 *   - public.invoke_calculate_segment_stats(): Vault の app_cron_secret を読み、Authorization: Bearer に付けて、
 *     上の本文 (時刻は now()) ごとに Edge Function calculate-segment-stats を net.http_post で呼ぶ
 *     (既存の public.invoke_catalog_import と同じ形)。app_cron_secret が無ければ RAISE EXCEPTION で失敗する
 *   - pg_cron のジョブ calculate-segment-stats: 毎時 5 分に上の関数を呼ぶ (以前の名前 calculate-segment-stats-daily は外す)
 *
 * 確認すること (ローカル Supabase の DB で):
 *   A. ジョブが 1 つだけ、毎時 5 分・postgres の権限・有効で登録されている。以前の名前のジョブは無い。
 *      migration を流し直しても 1 つのまま。以前の名前のジョブが残っていても、流し直すと外れる
 *   B. Vault に app_cron_secret が無いと、関数は例外で失敗し、要求を 1 つも積まない
 *      (例外で終わるので、pg_cron のジョブとして動いたときは実行履歴 cron.job_run_details に failed として残る)
 *   C. app_cron_secret があると、Edge Function calculate-segment-stats への POST を、本文の配列 (時刻は now()) の順に積む。
 *      daily / weekly / monthly の { periodType } が必ず含まれる。Bearer は Vault の値
 *   D. anon / authenticated / service_role は 2 つの関数を EXECUTE できない (呼べるのは所有者 postgres = pg_cron のジョブだけ)
 *   E. 本文の配列は時刻で決まる: JST 0 時台 (日の切り替わり直後) は daily の直前の期間を足し、月曜 0 時台は weekly、
 *      1 日 0 時台は monthly も足す。1 時ちょうど以降は足さない
 *
 * 本番には接続しない。関数の呼び先は本番の URL に固定されているので (呼び先を差し替えられないようにするため)、
 * B / C は 1 つのトランザクションの中で関数を呼んで結果を取り出し、最後に例外でロールバックする
 * (pg_net の要求の待ち行列 net.http_request_queue への行はコミットされないので、pg_net は実際には送らない。
 *  テスト用に作った Vault の値もロールバックで消える)。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。
 * 複数の文を 1 回の要求で流すと 1 つのトランザクションになる。migration と同じ postgres ロールで流す (SET LOCAL ROLE postgres)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/schedule-calculate-segment-stats-cron.test.ts
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261009100000_schedule_calculate_segment_stats.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');

const JOB_NAME = 'calculate-segment-stats';
/** 毎日 1 回だったころのジョブ名 (migration が外す) */
const OLD_JOB_NAME = 'calculate-segment-stats-daily';
/** 毎時 5 分 (UTC。JST も毎時 5 分) */
const JOB_SCHEDULE = '5 * * * *';
/** 以前のスケジュール (毎日 UTC 19:00)。A で「以前の名前のジョブが残っている」状態を作るのに使う */
const OLD_JOB_SCHEDULE = '0 19 * * *';
const FUNCTION_SIGNATURE = 'public.invoke_calculate_segment_stats()';
const BODIES_SIGNATURE = 'public.calculate_segment_stats_request_bodies(timestamptz)';
const EDGE_FUNCTION_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/calculate-segment-stats';
const PERIOD_TYPES = ['daily', 'weekly', 'monthly'];
/** 関数が pg_net に渡す応答の待ち時間の上限 (ミリ秒)。migration の c_timeout_ms と同じ */
const EXPECTED_TIMEOUT_MS = 400000;
/** B / C で、ロールバックさせる例外の目印 (この後ろに結果の JSON を付ける) */
const RESULT_MARK = 'I1406_RESULT:';

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

interface JobRow {
  jobid: number | string;
  schedule: string;
  command: string;
  username: string;
  active: boolean;
}

async function scheduledJobs(jobName: string = JOB_NAME): Promise<JobRow[]> {
  const rows = await asPostgres(`
    SELECT jobid, schedule, command, username, active
    FROM cron.job
    WHERE jobname = ${lit(jobName)}
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
            to_regprocedure(${lit(BODIES_SIGNATURE)})::text AS bodies_fn;`,
  );
  if (!rows[0]?.cron_job || !rows[0]?.queue) {
    throw new Error('cron.job / net.http_request_queue がありません。ローカル DB に pg_cron / pg_net が入っていません。');
  }
  if (!rows[0]?.fn || !rows[0]?.bodies_fn) {
    throw new Error(`${FUNCTION_SIGNATURE} / ${BODIES_SIGNATURE} がありません。${MIGRATION_FILE} がローカル DB に適用されていません。`);
  }
}, 30_000);

// ---------------------------------------------------------------
// A. ジョブの登録
// ---------------------------------------------------------------
describe('#1406 A. pg_cron のジョブ', () => {
  it(`${JOB_NAME} が 1 つだけ、毎時 5 分に、postgres の権限で、有効な状態で登録されている。以前の名前 ${OLD_JOB_NAME} のジョブは無い`, async () => {
    const jobs = await scheduledJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ schedule: JOB_SCHEDULE, username: 'postgres', active: true });
    expect(jobs[0].command.trim()).toBe(`SELECT ${FUNCTION_SIGNATURE}`);
    expect(await scheduledJobs(OLD_JOB_NAME)).toHaveLength(0);
  });

  it('migration を流し直しても、ジョブは 1 つのまま (同じ名前のジョブを外してから登録する)', async () => {
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);

    const jobs = await scheduledJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ schedule: JOB_SCHEDULE, username: 'postgres', active: true });
  }, 30_000);

  it(`以前の名前 ${OLD_JOB_NAME} のジョブ (毎日 1 回だったころの migration を流した DB) が残っていても、流し直すと外れて 1 つになる`, async () => {
    await asPostgres(`SELECT cron.schedule(${lit(OLD_JOB_NAME)}, ${lit(OLD_JOB_SCHEDULE)}, $$ SELECT ${FUNCTION_SIGNATURE} $$);`);
    expect(await scheduledJobs(OLD_JOB_NAME)).toHaveLength(1);

    await asPostgres(MIGRATION_SQL);

    expect(await scheduledJobs(OLD_JOB_NAME)).toHaveLength(0);
    const jobs = await scheduledJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ schedule: JOB_SCHEDULE, username: 'postgres', active: true });
  }, 30_000);
});

// ---------------------------------------------------------------
// B / C. 関数が積む要求 (どちらもロールバックするので、本番へは送らない)
// ---------------------------------------------------------------
describe('#1406 B. Vault に app_cron_secret が無いとき', () => {
  it('関数は例外で失敗し (pg_cron のジョブとして動いたときは、実行履歴 cron.job_run_details に failed として残る)、要求を 1 つも積まない', async () => {
    const before = await queuedRequestCount();

    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
      SELECT ${FUNCTION_SIGNATURE};
    `);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('app_cron_secret not found in Vault');
    // 失敗したトランザクションはロールバックされる (Vault の行を消したのも元に戻る)
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

describe('#1406 C. Vault に app_cron_secret があるとき', () => {
  it('calculate-segment-stats への POST を、本文の配列 (時刻は now()) の順に積む。daily / weekly / monthly の { periodType } を必ず含む。Bearer は Vault の値', async () => {
    const secret = `i1406-test-${randomBytes(8).toString('hex')}`;

    // 関数を呼び、積んだ要求を JSON にして例外で返す (例外でトランザクションごとロールバックされ、要求は送られない)
    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      DO $test$
      DECLARE
        v_ids bigint[];
        v_requests jsonb;
        v_expected jsonb;
      BEGIN
        DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
        PERFORM vault.create_secret(${lit(secret)}, 'app_cron_secret', 'i1406 integration test (rolled back)');
        v_ids := ${FUNCTION_SIGNATURE};
        -- 関数と同じトランザクションなので now() は同じ時刻。関数が使ったはずの本文の配列
        v_expected := to_jsonb(public.calculate_segment_stats_request_bodies(now()));
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'method', q.method,
                   'url', q.url,
                   'headers', q.headers,
                   'body', convert_from(q.body, 'UTF8')::jsonb,
                   'timeout_milliseconds', q.timeout_milliseconds
                 ) ORDER BY q.id)
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

    // 本文の配列 (E で時刻ごとの中身を確かめる) を、その順に 1 つずつ送る
    expect(expected.length).toBeGreaterThanOrEqual(PERIOD_TYPES.length);
    expect(ids).toHaveLength(expected.length);
    expect(requests).toHaveLength(expected.length);
    expect(requests.map((r) => r.body)).toEqual(expected);
    // どの時刻でも、3 つの種類の「今の期間」は必ず含む
    expect(requests.map((r) => r.body).filter((b) => !('previousPeriod' in b))).toEqual(
      PERIOD_TYPES.map((periodType) => ({ periodType })),
    );
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe(EDGE_FUNCTION_URL);
      expect(request.headers).toMatchObject({
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      });
      expect(request.timeout_milliseconds).toBe(EXPECTED_TIMEOUT_MS);
    }

    // ロールバックされたので、テスト用の Vault の値は残っていない
    const leftovers = await asPostgres(`SELECT count(*)::int AS n FROM vault.secrets WHERE description LIKE 'i1406 integration test%';`);
    expect(Number(leftovers[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------
// D. 権限
// ---------------------------------------------------------------
describe('#1406 D. 関数の権限', () => {
  it.each(
    ['anon', 'authenticated', 'service_role'].flatMap((role) => [
      [role, FUNCTION_SIGNATURE],
      [role, BODIES_SIGNATURE],
    ]),
  )('%s は %s を EXECUTE できない', async (role, signature) => {
    const rows = await pgQuery(
      `SELECT has_function_privilege(${lit(role)}, ${lit(signature)}, 'EXECUTE') AS can_execute;`,
    );
    expect(rows[0].can_execute).toBe(false);
  });

  it('本文の配列を作る関数は SECURITY INVOKER (表を読まない)・所有者は postgres・search_path は空・STABLE', async () => {
    const rows = await pgQuery(`
      SELECT p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             p.provolatile AS volatility
      FROM pg_proc p
      WHERE p.oid = to_regprocedure(${lit(BODIES_SIGNATURE)});
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ security_definer: false, owner: 'postgres', volatility: 's' });
    expect(rows[0].config).toEqual(['search_path=""']);
  });

  it('関数は SECURITY DEFINER で、所有者は postgres、search_path は空', async () => {
    const rows = await pgQuery(`
      SELECT p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
      FROM pg_proc p
      WHERE p.oid = to_regprocedure(${lit(FUNCTION_SIGNATURE)});
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ security_definer: true, owner: 'postgres' });
    expect(rows[0].config).toEqual(['search_path=""']);
  });
});

// ---------------------------------------------------------------
// E. 時刻ごとの本文の配列
// ---------------------------------------------------------------
describe('#1406 E. 本文の配列は時刻で決まる (期間が切り替わってから 1 時間以内の種類だけ、直前の期間を足す)', () => {
  const current = PERIOD_TYPES.map((periodType) => ({ periodType }));
  const previous = (periodType: string) => ({ periodType, previousPeriod: true });

  async function bodiesAt(at: string): Promise<Record<string, unknown>[]> {
    const rows = await asPostgres(
      `SELECT to_jsonb(public.calculate_segment_stats_request_bodies(${lit(at)}::timestamptz)) AS bodies;`,
    );
    return rows[0].bodies as Record<string, unknown>[];
  }

  // [時刻 (UTC), 説明, 足される直前の期間の種類]
  const cases: Array<[string, string, string[]]> = [
    ['2027-01-31T15:05:00Z', 'JST 月曜 2027-02-01 0:05 (日・週・月が同時に切り替わった直後)', ['daily', 'weekly', 'monthly']],
    ['2027-01-31T15:00:00Z', 'JST 月曜 2027-02-01 0:00 ちょうど', ['daily', 'weekly', 'monthly']],
    ['2027-01-31T15:59:59Z', 'JST 月曜 2027-02-01 0:59:59', ['daily', 'weekly', 'monthly']],
    ['2027-01-31T16:00:00Z', 'JST 月曜 2027-02-01 1:00 ちょうど (1 時間を過ぎた)', []],
    ['2027-01-31T14:59:59Z', 'JST 日曜 2027-01-31 23:59:59 (まだ切り替わっていない)', []],
    ['2026-10-12T15:05:00Z', 'JST 火曜 2026-10-13 0:05 (日だけ切り替わる)', ['daily']],
    ['2026-10-11T15:05:00Z', 'JST 月曜 2026-10-12 0:05 (日と週)', ['daily', 'weekly']],
    ['2026-10-31T15:05:00Z', 'JST 日曜 2026-11-01 0:05 (日と月)', ['daily', 'monthly']],
    ['2026-10-12T19:05:00Z', 'JST 火曜 2026-10-13 4:05 (日の切り替わりから 4 時間)', []],
    ['2026-10-12T03:05:00Z', 'JST 月曜 2026-10-12 12:05', []],
  ];

  it.each(cases)('%s (%s)', async (at, _label, previousTypes) => {
    const bodies = await bodiesAt(at);
    const expected = PERIOD_TYPES.flatMap((periodType) =>
      previousTypes.includes(periodType) ? [{ periodType }, previous(periodType)] : [{ periodType }],
    );
    expect(bodies).toEqual(expected);
    expect(bodies.filter((b) => !('previousPeriod' in b))).toEqual(current);
  });

  it('時刻が NULL なら例外にする (本文を空で返して、黙って何も集計しない状態にしない)', async () => {
    const result = await pgQueryRaw(`SET LOCAL ROLE postgres; SELECT public.calculate_segment_stats_request_bodies(NULL);`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('p_at must not be null');
  });
});
