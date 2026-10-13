/**
 * #1498 運営の LLM 使用量を DB の中で集計する関数 public.llm_usage_summary(...) の回帰テスト (実 DB)
 *
 * 背景:
 *   GET /api/super-admin/llm/usage は llm_usage_logs の行を 5,000 行 (MAX_ROWS) まで読んで集計していた。行は PostgREST の
 *   max_rows (既定 1,000) でも打ち切られるので、異常使用 (1 人・JST の 1 日に 5,000 回超) は判定できず (バナーが出ない)、
 *   1,000 行を超える期間の合計も実際より小さく出ていた。
 *   migration 20261011110000_llm_usage_summary.sql で、DB の中で集計して 1 つの JSONB で返す関数を足した。
 *
 * 確かめること (ローカル Supabase の実 DB で。行は機能名 (function_name) をこの実行だけのものにして、他のデータと分ける):
 *   A. 打ち切りが無い: 1 万行を超える行を全部数え、同じ JST の 1 日に 5,001 回の人は異常、5,000 回ちょうどの人は異常でない
 *   B. 日の区切りは JST: UTC では同じ日でも JST 0 時の前後は別の日、UTC では別の日でも JST では同じ日なら 1 日に数える。
 *      期間の合計がしきい値を超えても、どの日もしきい値以下なら異常でない。日次の系列も JST の暦日
 *   C. 集計の中身: 実行ごとの合計行 (is_summary = true) を数えない・トークン / コストの NULL は 0・モデル別 / 機能別・
 *      期間は開始の時刻以上・終わりの時刻未満・model / provider で絞れる
 *   D. 上位の人数: 多い順に p_top_users_limit 人まで。user_id が NULL の行は 1 人にまとめる。上位に入らない異常の人も返す
 *   E. 引数の誤り (期間が逆・人数が範囲の外・しきい値が負) は 22023
 *   F. 未ログイン (anon)・ログインユーザー (authenticated) は呼べない (42501)。EXECUTE は service_role だけ・
 *      SECURITY INVOKER・search_path 固定 (postgres-meta で読み取りだけ確かめる)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。本番には接続しない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/llm-usage-summary.test.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const RPC = 'llm_usage_summary';
const FUNCTION_SIGNATURE = 'public.llm_usage_summary(timestamptz, timestamptz, text, text, text, integer, integer)';
/** PostgreSQL の「権限が無い」(insufficient_privilege) */
const PERMISSION_DENIED = '42501';
/** PostgreSQL の「引数の値が正しくない」(invalid_parameter_value) */
const INVALID_PARAMETER = '22023';
/** 異常のしきい値 (1 人・JST の 1 日あたり。設計書 operator/03-ui-spec.md「1 ユーザー 5,000 req/日超」。手で書いた期待値) */
const ANOMALY_DAILY_REQUESTS = 5000;
/** 上位の人数 (route が渡す値。手で書いた期待値) */
const TOP_USERS_LIMIT = 50;
/** PostgREST の max_rows の既定 (Supabase)。以前の集計はこの行数で打ち切られていた */
const POSTGREST_DEFAULT_MAX_ROWS = 1000;
/** 1 回の insert で送る行の数 (リクエストの大きさを抑える) */
const INSERT_CHUNK_ROWS = 2500;

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const sr = client(serviceKey);

/** ローカルスタックの postgres-meta で読み取りの SQL を流す */
async function pgQuery<T>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

const TS = Date.now();
/** この実行の行を他のデータと分けるための機能名 (節ごとに別にして、節どうしの数が混ざらないようにする) */
const FN_BULK = `it-1498-bulk-${TS}`;
const FN_JST = `it-1498-jst-${TS}`;
const FN_AGG = `it-1498-agg-${TS}`;
const FN_AGG_OTHER = `it-1498-agg-other-${TS}`;
const FN_TOP = `it-1498-top-${TS}`;
const ALL_FUNCTIONS = [FN_BULK, FN_JST, FN_AGG, FN_AGG_OTHER, FN_TOP];

/** 集計の期間 (広め。行の created_at はこの中) */
const PERIOD_FROM = '2026-09-30T15:00:00.000Z'; // JST 10/1 0:00
const PERIOD_TO_EXCLUSIVE = '2026-10-14T15:00:00.000Z'; // JST 10/15 0:00

/** user_id (llm_usage_logs.user_id に外部キーは無いので、使い捨ての UUID でよい) */
const U_OVER = randomUUID(); // 同じ JST の日に 5,001 回
const U_EXACT = randomUUID(); // 同じ JST の日に 5,000 回ちょうど
const U_SPLIT = randomUUID(); // JST 0 時をまたいで 2 + 1 回 (UTC では同じ日)
const U_SAME_JST_DAY = randomUUID(); // JST 8:59 と 9:00 で 2 + 1 回 (UTC では別の日)
const U_TWO_DAYS = randomUUID(); // 2 日に 2 回ずつ (期間の合計は 4 回)
const U_AGG = randomUUID();

interface SummaryUser {
  user_id: string | null;
  requests: number;
  cost_usd: number;
}
interface Summary {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Array<{ model: string; requests: number; tokens: number; cost_usd: number }>;
  by_function: Array<{ function_name: string; requests: number; cost_usd: number }>;
  top_users: SummaryUser[];
  timeseries: Array<{ date: string; requests: number; cost_usd: number }>;
  anomalous_users: Array<SummaryUser & { max_daily_requests: number }>;
}

type LogRow = Record<string, unknown>;

/** llm_usage_logs の 1 行。既定は「gpt-5-mini を 1 回呼んだ」行 (is_summary = false) */
function logRow(functionName: string, userId: string | null, createdAt: string, overrides: LogRow = {}): LogRow {
  return {
    function_name: functionName,
    execution_id: randomUUID(),
    user_id: userId,
    provider: 'openai',
    endpoint: '/v1/chat/completions',
    model: 'gpt-5-mini',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    estimated_cost_usd: 0.001,
    is_summary: false,
    success: true,
    created_at: createdAt,
    ...overrides,
  };
}

function repeat(count: number, make: (i: number) => LogRow): LogRow[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

async function insertRows(rows: LogRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    const { error } = await sr.from('llm_usage_logs').insert(rows.slice(i, i + INSERT_CHUNK_ROWS));
    if (error) throw new Error(`llm_usage_logs insert: ${error.message}`);
  }
}

async function summary(args: Record<string, unknown>): Promise<Summary> {
  const { data, error } = await sr.rpc(RPC, { p_from: PERIOD_FROM, p_to_exclusive: PERIOD_TO_EXCLUSIVE, ...args });
  expect(error, error?.message).toBeNull();
  return data as Summary;
}

/** JST 10/8 12:00 の 1 秒ずつずらした時刻 (どれも JST の同じ日) */
const jstNoonOct8 = (i: number) => new Date(Date.parse('2026-10-08T03:00:00.000Z') + i * 1000).toISOString();

beforeAll(async () => {
  await insertRows([
    // A. 打ち切りが無いこと (計 10,001 行)
    ...repeat(ANOMALY_DAILY_REQUESTS + 1, (i) => logRow(FN_BULK, U_OVER, jstNoonOct8(i))),
    ...repeat(ANOMALY_DAILY_REQUESTS, (i) => logRow(FN_BULK, U_EXACT, jstNoonOct8(i))),
    // B. JST の日の区切り (しきい値は 2 にして呼ぶ)
    logRow(FN_JST, U_SPLIT, '2026-10-07T14:59:58.000Z'), // JST 10/7 23:59:58
    logRow(FN_JST, U_SPLIT, '2026-10-07T14:59:59.999Z'), // JST 10/7 23:59:59.999
    logRow(FN_JST, U_SPLIT, '2026-10-07T15:00:00.000Z'), // JST 10/8 0:00 (UTC では 10/7)
    logRow(FN_JST, U_SAME_JST_DAY, '2026-10-07T23:58:00.000Z'), // JST 10/8 8:58 (UTC 10/7)
    logRow(FN_JST, U_SAME_JST_DAY, '2026-10-07T23:59:59.000Z'), // JST 10/8 8:59:59 (UTC 10/7)
    logRow(FN_JST, U_SAME_JST_DAY, '2026-10-08T00:00:00.000Z'), // JST 10/8 9:00 (UTC 10/8)
    logRow(FN_JST, U_TWO_DAYS, '2026-10-09T03:00:00.000Z'), // JST 10/9
    logRow(FN_JST, U_TWO_DAYS, '2026-10-09T04:00:00.000Z'), // JST 10/9
    logRow(FN_JST, U_TWO_DAYS, '2026-10-10T03:00:00.000Z'), // JST 10/10
    logRow(FN_JST, U_TWO_DAYS, '2026-10-10T04:00:00.000Z'), // JST 10/10
    // C. 集計の中身 (1 回の実行 = gpt-5-mini 2 回 + grok 1 回 + その合計行。Edge Function はこの 4 行を入れる)
    logRow(FN_AGG, U_AGG, '2026-10-08T03:00:00.000Z', { total_tokens: 150, estimated_cost_usd: 0.5 }),
    logRow(FN_AGG, U_AGG, '2026-10-08T03:00:01.000Z', { total_tokens: 150, estimated_cost_usd: 0.25 }),
    logRow(FN_AGG, U_AGG, '2026-10-08T03:00:02.000Z', {
      provider: 'xai',
      model: 'grok-4-1-fast-non-reasoning',
      total_tokens: null,
      estimated_cost_usd: null, // 単価表に無いモデルは推定コストが入らない
    }),
    logRow(FN_AGG, U_AGG, '2026-10-08T03:00:03.000Z', {
      provider: 'mixed',
      endpoint: 'summary',
      model: 'mixed',
      total_tokens: 600,
      estimated_cost_usd: 0.75,
      is_summary: true,
    }),
    // 期間の端 (開始の時刻ちょうどは入る・終わりの時刻ちょうどは入らない)
    logRow(FN_AGG_OTHER, U_AGG, '2026-10-01T15:00:00.000Z', { model: 'gpt-4o' }), // JST 10/2 0:00
    logRow(FN_AGG_OTHER, U_AGG, '2026-10-05T14:59:59.999Z', { model: 'gpt-4o' }), // JST 10/5 23:59:59.999
    logRow(FN_AGG_OTHER, U_AGG, '2026-10-05T15:00:00.000Z', { model: 'gpt-4o' }), // JST 10/6 0:00
    // D. 上位の人数と user_id の NULL
    ...repeat(3, (i) => logRow(FN_TOP, null, jstNoonOct8(i))),
    ...repeat(2, (i) => logRow(FN_TOP, U_AGG, jstNoonOct8(i))),
    logRow(FN_TOP, U_OVER, jstNoonOct8(0)),
  ]);
}, 240_000);

afterAll(async () => {
  for (const fn of ALL_FUNCTIONS) {
    await sr.from('llm_usage_logs').delete().eq('function_name', fn);
  }
}, 120_000);

describe('llm_usage_summary: 打ち切りが無い (#1498)', () => {
  it(`A-1: ${POSTGREST_DEFAULT_MAX_ROWS} 行・5,000 行を超える行を全部数える。同じ JST の日に 5,001 回は異常、5,000 回ちょうどは異常でない`, async () => {
    const s = await summary({ p_function_name: FN_BULK, p_top_users_limit: TOP_USERS_LIMIT, p_anomaly_daily_requests: ANOMALY_DAILY_REQUESTS });

    expect(s.total_requests).toBe(2 * ANOMALY_DAILY_REQUESTS + 1);
    expect(s.total_requests).toBeGreaterThan(POSTGREST_DEFAULT_MAX_ROWS);
    expect(s.total_tokens).toBe((2 * ANOMALY_DAILY_REQUESTS + 1) * 150);
    expect(s.top_users.map((u) => [u.user_id, u.requests])).toEqual([
      [U_OVER, ANOMALY_DAILY_REQUESTS + 1],
      [U_EXACT, ANOMALY_DAILY_REQUESTS],
    ]);
    expect(s.anomalous_users.map((u) => [u.user_id, u.max_daily_requests, u.requests])).toEqual([
      [U_OVER, ANOMALY_DAILY_REQUESTS + 1, ANOMALY_DAILY_REQUESTS + 1],
    ]);
    expect(s.timeseries).toEqual([{ date: '2026-10-08', requests: 2 * ANOMALY_DAILY_REQUESTS + 1, cost_usd: expect.any(Number) }]);
  });

  it('A-2: しきい値の既定は 5,000 (引数を省いても同じ判定)', async () => {
    const s = await summary({ p_function_name: FN_BULK });
    expect(s.anomalous_users.map((u) => u.user_id)).toEqual([U_OVER]);
  });
});

describe('llm_usage_summary: 日の区切りは JST', () => {
  const threshold = 2;

  it('B-1: UTC では同じ日でも JST 0 時の前後は別の日に数え、UTC では別の日でも JST で同じ日なら 1 日に数える', async () => {
    const s = await summary({ p_function_name: FN_JST, p_anomaly_daily_requests: threshold });

    // U_SPLIT: JST 10/7 に 2 回・10/8 に 1 回 (UTC ではどれも 10/7 で 3 回) → 異常でない
    // U_SAME_JST_DAY: JST 10/8 に 3 回 (UTC では 10/7 に 2 回・10/8 に 1 回) → 異常
    // U_TWO_DAYS: 2 回ずつ 2 日 (期間の合計は 4 回) → 異常でない
    expect(s.anomalous_users.map((u) => [u.user_id, u.max_daily_requests, u.requests])).toEqual([[U_SAME_JST_DAY, 3, 3]]);
  });

  it('B-2: 日次の系列も JST の暦日でまとめる (UTC の暦日なら 10/7 に入る行を 10/8 に入れる)', async () => {
    const s = await summary({ p_function_name: FN_JST, p_anomaly_daily_requests: threshold });

    expect(s.timeseries.map((t) => [t.date, t.requests])).toEqual([
      ['2026-10-07', 2],
      ['2026-10-08', 4],
      ['2026-10-09', 2],
      ['2026-10-10', 2],
    ]);
  });
});

describe('llm_usage_summary: 集計の中身', () => {
  it('C-1: 実行ごとの合計行 (is_summary = true) を数えず、トークン・コストの NULL は 0 として足す', async () => {
    const s = await summary({ p_function_name: FN_AGG });

    expect(s.total_requests).toBe(3);
    expect(s.total_tokens).toBe(300);
    expect(s.total_cost_usd).toBe(0.75);
    expect(s.by_model).toEqual([
      { model: 'gpt-5-mini', requests: 2, tokens: 300, cost_usd: 0.75 },
      { model: 'grok-4-1-fast-non-reasoning', requests: 1, tokens: 0, cost_usd: 0 },
    ]);
    expect(s.by_function).toEqual([{ function_name: FN_AGG, requests: 3, cost_usd: 0.75 }]);
    expect(s.by_model.map((m) => m.model)).not.toContain('mixed');
  });

  it('C-2: model / provider で絞れる', async () => {
    expect((await summary({ p_function_name: FN_AGG, p_provider: 'xai' })).total_requests).toBe(1);
    expect((await summary({ p_function_name: FN_AGG, p_provider: 'openai' })).total_requests).toBe(2);
    expect((await summary({ p_function_name: FN_AGG, p_model: 'gpt-5-mini' })).total_requests).toBe(2);
    expect((await summary({ p_function_name: FN_AGG, p_model: 'no-such-model' })).total_requests).toBe(0);
  });

  it('C-3: 期間は開始の時刻以上・終わりの時刻未満 (route は開始日の JST 0 時と、終了日の翌日の JST 0 時を渡す)', async () => {
    const s = await summary({
      p_function_name: FN_AGG_OTHER,
      p_from: '2026-10-01T15:00:00.000Z', // JST 10/2 0:00
      p_to_exclusive: '2026-10-05T15:00:00.000Z', // JST 10/6 0:00
    });

    expect(s.total_requests).toBe(2);
    expect(s.timeseries.map((t) => t.date)).toEqual(['2026-10-02', '2026-10-05']);
  });

  it('C-4: 行の無い期間は 0 と空の配列を返す (NULL にしない)', async () => {
    const s = await summary({ p_function_name: `it-1498-none-${TS}` });

    expect(s).toEqual({
      total_requests: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      by_model: [],
      by_function: [],
      top_users: [],
      timeseries: [],
      anomalous_users: [],
    });
  });
});

describe('llm_usage_summary: 上位の人数', () => {
  it('D-1: 多い順に p_top_users_limit 人まで。user_id が NULL の行は 1 人にまとめる', async () => {
    const all = await summary({ p_function_name: FN_TOP });
    expect(all.top_users.map((u) => [u.user_id, u.requests])).toEqual([
      [null, 3],
      [U_AGG, 2],
      [U_OVER, 1],
    ]);

    const top1 = await summary({ p_function_name: FN_TOP, p_top_users_limit: 1 });
    expect(top1.top_users.map((u) => u.user_id)).toEqual([null]);
    // 合計は人数で絞らない
    expect(top1.total_requests).toBe(6);
  });

  it('D-2: 上位に入らない異常の人も anomalous_users に載せる (しきい値 1 で、上位 1 人だけにしたとき)', async () => {
    const s = await summary({ p_function_name: FN_TOP, p_top_users_limit: 1, p_anomaly_daily_requests: 1 });

    expect(s.top_users.map((u) => u.user_id)).toEqual([null]);
    expect(s.anomalous_users.map((u) => [u.user_id, u.max_daily_requests])).toEqual([
      [null, 3],
      [U_AGG, 2],
    ]);
  });
});

describe('llm_usage_summary: 引数の誤り', () => {
  it.each([
    ['期間が逆', { p_from: PERIOD_TO_EXCLUSIVE, p_to_exclusive: PERIOD_FROM }],
    ['期間の長さが 0', { p_from: PERIOD_FROM, p_to_exclusive: PERIOD_FROM }],
    ['開始が NULL', { p_from: null }],
    ['上位の人数が 0', { p_top_users_limit: 0 }],
    ['上位の人数が多すぎる', { p_top_users_limit: 1001 }],
    ['しきい値が負', { p_anomaly_daily_requests: -1 }],
  ])('E: %s は 22023', async (_label, args) => {
    const { data, error } = await sr.rpc(RPC, { p_from: PERIOD_FROM, p_to_exclusive: PERIOD_TO_EXCLUSIVE, ...args });
    expect(error?.code, error?.message).toBe(INVALID_PARAMETER);
    expect(data).toBeNull();
  });
});

describe('llm_usage_summary: 権限', () => {
  const createdUserIds: string[] = [];
  let userJwt = '';

  beforeAll(async () => {
    const email = `it1498-user-${TS}@homegohan.test`;
    const password = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
    const { data, error } = await sr.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    createdUserIds.push(data.user.id);
    const signIn = await client(anonKey).auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
    userJwt = signIn.data.session.access_token;
  }, 120_000);

  afterAll(async () => {
    for (const id of createdUserIds) await sr.auth.admin.deleteUser(id);
  }, 120_000);

  it('F-1: 未ログイン (anon) は呼べない (42501)', async () => {
    const { data, error } = await client(anonKey).rpc(RPC, { p_from: PERIOD_FROM, p_to_exclusive: PERIOD_TO_EXCLUSIVE });
    expect(error?.code, error?.message).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it('F-2: ログインユーザー (authenticated) も呼べない (42501)。全利用者の使用量を読めない', async () => {
    const { data, error } = await client(anonKey, userJwt).rpc(RPC, { p_from: PERIOD_FROM, p_to_exclusive: PERIOD_TO_EXCLUSIVE });
    expect(error?.code, error?.message).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it('F-3: EXECUTE は service_role だけ (PUBLIC / anon / authenticated には無い)。SECURITY INVOKER で search_path を固定している', async () => {
    const [row] = await pgQuery<Record<string, boolean>>(`
      SELECT
        has_function_privilege('anon', '${FUNCTION_SIGNATURE}', 'EXECUTE') AS anon,
        has_function_privilege('authenticated', '${FUNCTION_SIGNATURE}', 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', '${FUNCTION_SIGNATURE}', 'EXECUTE') AS service_role,
        EXISTS (
          SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = '${FUNCTION_SIGNATURE}'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        ) AS public_execute,
        (SELECT prosecdef FROM pg_proc WHERE oid = '${FUNCTION_SIGNATURE}'::regprocedure) AS security_definer,
        (SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = '${FUNCTION_SIGNATURE}'::regprocedure) AS search_path_fixed
    `);
    expect(row).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
      public_execute: false,
      security_definer: false,
      search_path_fixed: true,
    });
  });
});
