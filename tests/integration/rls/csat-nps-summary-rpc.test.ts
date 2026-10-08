/**
 * #1217 NPS / CSAT 集計の関数 (get_csat_summary / get_nps_summary) の定義・権限・集計結果・RLS のテスト
 *
 * 修正前、GET /api/admin/finance/nps (src/app/api/admin/finance/nps/route.ts) は nps_surveys / csat_feedbacks の
 * 該当行を全部読み込み、件数・平均・分布を JavaScript で数えていた (行数の上限なし。API の最大行数を超えると黙って切り詰め)。
 * 修正後 (20261008120100_csat_nps_summary_rpc.sql) は、数える処理を DB の関数にする。
 *   - get_csat_summary(p_from, p_to)              : csat_feedbacks を created_at の期間で絞り、回答数・合計・星 1〜5 の件数を 1 行で返す
 *   - get_nps_summary(p_from, p_to, p_plan_key)   : nps_surveys を sent_at の期間・plan_key で絞り、送信数・回答数・推奨者/中立/批判者・合計を 1 行で返す
 *
 * 確認すること:
 *   A. カタログ: SECURITY INVOKER・STABLE・search_path が空・戻り値の列。EXECUTE を持つのは所有者と authenticated だけ
 *   B. 集計結果: 期間の両端を含む・期間の外を含まない・NULL は絞らない・未回答の行は回答数以下に入らない・プランで絞れる
 *   C. RLS: 関数は呼び出しユーザーの権限で動く (一般ユーザーは自分の CSAT だけ・NPS は 0 件。サポート担当・admin は全件)
 *   D. 権限: anon は呼べない (42501)
 *   E. 旧実装との同値性: ユーザーごとに、「関数 + 丸め (src/lib/admin/nps-summary.ts)」の結果が、
 *      修正前の「同じユーザーの権限で全行を読んで JS で数える」結果 (tests/helpers/legacy-nps-summary.ts) と一致する。
 *      誰が何を見られるか (finance ロールの扱い=#1311 を含む) には依存しない。RLS の見え方は変えていないことの確認
 *   F. 件数が多くても数え切れる: API の 1 回の応答で返す最大行数 (既定 1000 行) を超える 1,100 行でも、
 *      関数は切り詰めずに正確に数える (修正前は 1000 行で黙って打ち切られた)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/csat-nps-summary-rpc.test.ts
 *
 * カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import {
  CsatSummaryRowSchema,
  NpsSummaryRowSchema,
  buildCsatSummary,
  buildNpsSummary,
  firstRpcRow,
  type CsatSummaryRow,
  type NpsSummaryRow,
} from '../../../src/lib/admin/nps-summary';
import { legacyCsatSummary, legacyNpsSummary } from '../../helpers/legacy-nps-summary';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

// ---------------------------------------------------------------
// A. カタログ
// ---------------------------------------------------------------
describe('#1217 A. 集計の関数の定義と権限 (カタログ)', () => {
  it('2 本とも SECURITY INVOKER・STABLE・search_path が空で、戻り値の列が期待どおり', async () => {
    const rows = await pgQuery(`
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS identity_args,
             pg_get_function_result(p.oid) AS result,
             p.pronargdefaults,
             p.prosecdef,
             p.provolatile,
             p.proconfig
        FROM pg_proc AS p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('get_csat_summary', 'get_nps_summary')
       ORDER BY p.proname
    `);

    expect(rows).toEqual([
      {
        proname: 'get_csat_summary',
        identity_args: 'p_from timestamp with time zone, p_to timestamp with time zone',
        result:
          'TABLE(total_responses bigint, score_sum bigint, score_1_count bigint, score_2_count bigint, score_3_count bigint, score_4_count bigint, score_5_count bigint)',
        pronargdefaults: 2, // 引数は省略できる (省略 = 絞らない)
        prosecdef: false, // SECURITY INVOKER: 呼び出したユーザーの権限で動く (RLS が効く)
        provolatile: 's', // STABLE
        proconfig: ['search_path=""'],
      },
      {
        proname: 'get_nps_summary',
        identity_args: 'p_from timestamp with time zone, p_to timestamp with time zone, p_plan_key text',
        result:
          'TABLE(sent_count bigint, total_responses bigint, promoters bigint, passives bigint, detractors bigint, score_sum bigint)',
        pronargdefaults: 3,
        prosecdef: false,
        provolatile: 's',
        proconfig: ['search_path=""'],
      },
    ]);
  });

  it('EXECUTE を持つのは所有者 (postgres) と authenticated だけ。PUBLIC・anon・service_role は持たない', async () => {
    const rows = await pgQuery<{ proname: string; executors: string[] }>(`
      SELECT p.proname,
             coalesce(
               (SELECT array_agg(g ORDER BY g)
                  FROM (SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS g
                          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                         WHERE a.privilege_type = 'EXECUTE') AS s),
               '{}') AS executors
        FROM pg_proc AS p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('get_csat_summary', 'get_nps_summary')
       ORDER BY p.proname
    `);

    expect(rows).toEqual([
      { proname: 'get_csat_summary', executors: ['authenticated', 'postgres'] },
      { proname: 'get_nps_summary', executors: ['authenticated', 'postgres'] },
    ]);
  });
});

// ---------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------
interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const MARK = `rls-1217-summary-${TS}`; // comment の接頭辞。後片付けで「このテストが入れた行だけ」を特定する印
const MARK_ANY = 'rls-1217-summary-'; // 前回の実行が途中で落ちて残した行の掃除用
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];
const createdCsatIds: string[] = [];
const createdNpsIds: string[] = [];

async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `rls-1217-sum-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `sum-1217-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function insertCsat(userId: string, score: number, createdAt: string): Promise<void> {
  const { data, error } = await srAdmin
    .from('csat_feedbacks')
    .insert({ user_id: userId, score, comment: `${MARK} csat ${score}`, created_at: createdAt })
    .select('id')
    .single();
  if (error || !data) throw new Error(`csat_feedbacks insert: ${error?.message}`);
  createdCsatIds.push(data.id as string);
}

interface NpsSeed {
  userId: string;
  score: number;
  sentAt: string;
  respondedAt: string | null;
  planKey: string | null;
}

async function insertNps(seed: NpsSeed): Promise<void> {
  const { data, error } = await srAdmin
    .from('nps_surveys')
    .insert({
      user_id: seed.userId,
      score: seed.score,
      comment: `${MARK} nps ${seed.score}`,
      plan_key: seed.planKey,
      sent_at: seed.sentAt,
      responded_at: seed.respondedAt,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`nps_surveys insert: ${error?.message}`);
  createdNpsIds.push(data.id as string);
}

// 本物のデータや他のテストと重ならないよう、2031 年の日付を使う
const W = { from: '2031-03-01T00:00:00Z', to: '2031-03-31T23:59:59Z' }; // 3 月まるごと (両端ちょうどの行を入れてある)
const W2 = { from: '2031-03-11T00:00:00Z', to: '2031-03-13T23:59:59Z' }; // 3 月の中ほど
const FROM_ONLY = '2031-03-13T00:00:00Z'; // これ以降 (上限なし)
const EMPTY = { from: '2040-01-01T00:00:00Z', to: '2040-12-31T23:59:59Z' }; // 行が 1 つも無い期間

let staffSupport: TestUser; // サポート担当 (roles = ['support'])
let staffAdmin: TestUser; // admin
let userA: TestUser; // 一般ユーザー
let userB: TestUser; // 一般ユーザー
let financeUser: TestUser; // finance ロール (API ルートは通すが RLS は許していない。#1311)

beforeAll(async () => {
  // 前回の実行が途中で落ちて残した行を掃除する (期間の合計を数える検証が、残りの行で狂わないように)
  await srAdmin.from('csat_feedbacks').delete().like('comment', `${MARK_ANY}%`);
  await srAdmin.from('nps_surveys').delete().like('comment', `${MARK_ANY}%`);

  [staffSupport, staffAdmin, userA, userB, financeUser] = await Promise.all([
    createUser('support', ['support']),
    createUser('admin', ['admin']),
    createUser('a', ['user']),
    createUser('b', ['user']),
    createUser('fin', ['finance']),
  ]);

  // CSAT (user, score, created_at)。W の内側 7 行 + 外側 2 行
  await insertCsat(userA.id, 5, '2031-03-10T09:00:00Z');
  await insertCsat(userA.id, 4, '2031-03-11T09:00:00Z');
  await insertCsat(userA.id, 4, '2031-03-12T09:00:00Z');
  await insertCsat(userB.id, 1, '2031-03-13T09:00:00Z');
  await insertCsat(userB.id, 3, '2031-03-14T09:00:00Z');
  await insertCsat(userA.id, 2, W.from); // 期間の始まりちょうど (含む)
  await insertCsat(userB.id, 5, W.to); // 期間の終わりちょうど (含む)
  await insertCsat(userA.id, 1, '2031-02-28T23:59:59Z'); // 期間の 1 秒前 (含まない)
  await insertCsat(userB.id, 1, '2031-04-01T00:00:00Z'); // 期間の 1 秒後 (含まない)

  // NPS。W の内側 9 行 (回答 7・未回答 2) + 外側 2 行。
  // 未回答の行にも score が入る (nps_surveys.score は NOT NULL)。回答として数えると結果が狂うよう、わざと大きい値と中くらいの値にしてある
  const nps: NpsSeed[] = [
    { userId: userA.id, score: 10, sentAt: W.from, respondedAt: '2031-03-02T00:00:00Z', planKey: 'pro' }, // 期間の始まりちょうど (含む)
    { userId: userA.id, score: 9, sentAt: '2031-03-05T00:00:00Z', respondedAt: '2031-03-06T00:00:00Z', planKey: 'pro' }, // 推奨者の下限
    { userId: userB.id, score: 8, sentAt: '2031-03-06T00:00:00Z', respondedAt: '2031-03-07T00:00:00Z', planKey: 'free' }, // 中立の上限
    { userId: userB.id, score: 7, sentAt: '2031-03-07T00:00:00Z', respondedAt: '2031-03-08T00:00:00Z', planKey: 'free' }, // 中立の下限
    { userId: userA.id, score: 6, sentAt: '2031-03-08T00:00:00Z', respondedAt: '2031-03-09T00:00:00Z', planKey: 'pro' }, // 批判者の上限
    { userId: userB.id, score: 0, sentAt: '2031-03-09T00:00:00Z', respondedAt: '2031-03-10T00:00:00Z', planKey: 'free' }, // 批判者の下限
    { userId: userA.id, score: 5, sentAt: '2031-03-10T00:00:00Z', respondedAt: null, planKey: 'pro' }, // 未回答
    { userId: userB.id, score: 10, sentAt: '2031-03-11T00:00:00Z', respondedAt: null, planKey: 'free' }, // 未回答 (推奨者に数えてはいけない)
    { userId: userA.id, score: 9, sentAt: W.to, respondedAt: '2031-04-02T00:00:00Z', planKey: null }, // 期間の終わりちょうど (含む)。プランなし
    // 送信日が期間の外。回答日 (responded_at) は期間の中 → 期間は送信日 (sent_at) で見るので含まない
    { userId: userA.id, score: 10, sentAt: '2031-02-28T23:59:59Z', respondedAt: '2031-03-03T00:00:00Z', planKey: 'pro' },
    { userId: userB.id, score: 0, sentAt: '2031-04-01T00:00:00Z', respondedAt: '2031-04-02T00:00:00Z', planKey: 'free' },
  ];
  for (const seed of nps) await insertNps(seed);
}, 120_000);

afterAll(async () => {
  // 外部キー (user_id → auth.users、ON DELETE なし) があるため、行を先に消してからユーザーを消す
  if (createdCsatIds.length > 0) await srAdmin.from('csat_feedbacks').delete().in('id', createdCsatIds);
  if (createdNpsIds.length > 0) await srAdmin.from('nps_surveys').delete().in('id', createdNpsIds);
  await srAdmin.from('csat_feedbacks').delete().like('comment', `${MARK}%`);
  await srAdmin.from('nps_surveys').delete().like('comment', `${MARK}%`);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

// ---------------------------------------------------------------
// 関数の呼び出しヘルパー
// ---------------------------------------------------------------
type Bound = string | null;

/** get_csat_summary を呼び、戻り値の 1 行を検証して返す */
async function csatRow(c: SupabaseClient, from: Bound, to: Bound): Promise<CsatSummaryRow> {
  const { data, error } = await c.rpc('get_csat_summary', { p_from: from, p_to: to });
  expect(error).toBeNull();
  expect(Array.isArray(data) ? data.length : -1, '戻り値は 1 行の配列').toBe(1);
  return CsatSummaryRowSchema.parse(firstRpcRow(data));
}

/** get_nps_summary を呼び、戻り値の 1 行を検証して返す */
async function npsRow(c: SupabaseClient, from: Bound, to: Bound, plan: string | null = null): Promise<NpsSummaryRow> {
  const { data, error } = await c.rpc('get_nps_summary', { p_from: from, p_to: to, p_plan_key: plan });
  expect(error).toBeNull();
  expect(Array.isArray(data) ? data.length : -1, '戻り値は 1 行の配列').toBe(1);
  return NpsSummaryRowSchema.parse(firstRpcRow(data));
}

const csatDist = (r: CsatSummaryRow) => [r.score_1_count, r.score_2_count, r.score_3_count, r.score_4_count, r.score_5_count];

const ZERO_CSAT: CsatSummaryRow = {
  total_responses: 0,
  score_sum: 0,
  score_1_count: 0,
  score_2_count: 0,
  score_3_count: 0,
  score_4_count: 0,
  score_5_count: 0,
};

const ZERO_NPS: NpsSummaryRow = {
  sent_count: 0,
  total_responses: 0,
  promoters: 0,
  passives: 0,
  detractors: 0,
  score_sum: 0,
};

// ---------------------------------------------------------------
// B. 集計結果 (サポート担当 = 全件が見える立場で呼ぶ)
// ---------------------------------------------------------------
describe('#1217 B. get_csat_summary の集計結果', () => {
  it('期間 W の回答数・合計・星ごとの件数が数えたとおり (両端ちょうどの行は含み、1 秒外の行は含まない)', async () => {
    const r = await csatRow(asUser(staffSupport.jwt), W.from, W.to);
    // 内側: 5, 4, 4, 1, 3, 2 (始まりちょうど), 5 (終わりちょうど) = 7 件・合計 24
    expect(r.total_responses).toBe(7);
    expect(r.score_sum).toBe(24);
    expect(csatDist(r)).toEqual([1, 1, 1, 2, 2]);
  });

  it('期間を狭めると、その中の行だけ数える (W2: 4, 4, 1)', async () => {
    const r = await csatRow(asUser(staffSupport.jwt), W2.from, W2.to);
    expect(r.total_responses).toBe(3);
    expect(r.score_sum).toBe(9);
    expect(csatDist(r)).toEqual([1, 0, 0, 2, 0]);
  });

  it('下限だけ (上限は NULL) なら、それ以降をすべて数える', async () => {
    const r = await csatRow(asUser(staffSupport.jwt), FROM_ONLY, null);
    // 3/13 の 1, 3/14 の 3, 3/31 の 5, 4/1 の 1
    expect(r.total_responses).toBe(4);
    expect(r.score_sum).toBe(10);
    expect(csatDist(r)).toEqual([2, 0, 1, 0, 1]);
  });

  it('上限だけ (下限は NULL) なら、それ以前をすべて数える', async () => {
    const { count } = await srAdmin
      .from('csat_feedbacks')
      .select('id', { count: 'exact', head: true })
      .lte('created_at', '2031-02-28T23:59:59Z');
    const r = await csatRow(asUser(staffSupport.jwt), null, '2031-02-28T23:59:59Z');
    expect(r.total_responses).toBe(count);
    expect(r.total_responses).toBeGreaterThanOrEqual(1); // このテストが入れた 2/28 23:59:59 の行は少なくとも入る
  });

  it('両方 NULL ・引数なしなら、期間で絞らずに全件を数える', async () => {
    const { count } = await srAdmin.from('csat_feedbacks').select('id', { count: 'exact', head: true });
    const bothNull = await csatRow(asUser(staffSupport.jwt), null, null);
    expect(bothNull.total_responses).toBe(count);

    const { data, error } = await asUser(staffSupport.jwt).rpc('get_csat_summary');
    expect(error).toBeNull();
    expect(CsatSummaryRowSchema.parse(firstRpcRow(data))).toEqual(bothNull);
  });

  it('行が 1 つも無い期間・上限が下限より前の期間は、0 行ではなく全部 0 の 1 行を返す', async () => {
    expect(await csatRow(asUser(staffSupport.jwt), EMPTY.from, EMPTY.to)).toEqual(ZERO_CSAT);
    expect(await csatRow(asUser(staffSupport.jwt), W.to, W.from)).toEqual(ZERO_CSAT);
  });

  it('返す列は決まった 7 列だけ (他の列を漏らさない)', async () => {
    const { data, error } = await asUser(staffSupport.jwt).rpc('get_csat_summary', { p_from: W.from, p_to: W.to });
    expect(error).toBeNull();
    expect(Object.keys((data as Array<Record<string, unknown>>)[0]).sort()).toEqual(
      ['score_1_count', 'score_2_count', 'score_3_count', 'score_4_count', 'score_5_count', 'score_sum', 'total_responses'],
    );
  });
});

describe('#1217 B. get_nps_summary の集計結果', () => {
  it('期間 W の送信数・回答数・推奨者/中立/批判者・合計が数えたとおり (未回答は回答数以下に入らない)', async () => {
    const r = await npsRow(asUser(staffSupport.jwt), W.from, W.to);
    expect(r).toEqual({
      sent_count: 9, // 期間内に送った 9 件 (未回答 2 件を含む)
      total_responses: 7, // 回答済み
      promoters: 3, // 10, 9, 9 (未回答の 10 は数えない)
      passives: 2, // 8, 7
      detractors: 2, // 6, 0
      score_sum: 49, // 10 + 9 + 8 + 7 + 6 + 0 + 9 (未回答の 5 と 10 は足さない)
    });
  });

  it('期間は送信日 (sent_at) で見る (送信が期間の外なら、回答日が期間の中でも含まない)', async () => {
    // 2/28 23:59:59 に送って 3/3 に回答した 10 点は、W に入らない (入るなら推奨者が 4 になる)
    const r = await npsRow(asUser(staffSupport.jwt), W.from, W.to);
    expect(r.promoters).toBe(3);
    expect(r.sent_count).toBe(9);
  });

  it('plan_key で絞れる (pro / free / プランなしは全プランのときだけ入る)', async () => {
    const pro = await npsRow(asUser(staffSupport.jwt), W.from, W.to, 'pro');
    expect(pro).toEqual({ sent_count: 4, total_responses: 3, promoters: 2, passives: 0, detractors: 1, score_sum: 25 });

    const free = await npsRow(asUser(staffSupport.jwt), W.from, W.to, 'free');
    expect(free).toEqual({ sent_count: 4, total_responses: 3, promoters: 0, passives: 2, detractors: 1, score_sum: 15 });

    // 存在しないプランは 0 件 (plan_key が NULL の行は、プランを指定したときは入らない)
    expect(await npsRow(asUser(staffSupport.jwt), W.from, W.to, 'enterprise')).toEqual(ZERO_NPS);
  });

  it('下限だけ・上限だけ・両方 NULL でも数えられる', async () => {
    const fromOnly = await npsRow(asUser(staffSupport.jwt), '2031-03-31T00:00:00Z', null);
    // 3/31 23:59:59 送信の 9 点 (回答済み) と、4/1 送信の 0 点 (回答済み)
    expect(fromOnly).toEqual({ sent_count: 2, total_responses: 2, promoters: 1, passives: 0, detractors: 1, score_sum: 9 });

    const { count } = await srAdmin
      .from('nps_surveys')
      .select('id', { count: 'exact', head: true })
      .lte('sent_at', '2031-02-28T23:59:59Z');
    const toOnly = await npsRow(asUser(staffSupport.jwt), null, '2031-02-28T23:59:59Z');
    expect(toOnly.sent_count).toBe(count);

    const { count: all } = await srAdmin.from('nps_surveys').select('id', { count: 'exact', head: true });
    expect((await npsRow(asUser(staffSupport.jwt), null, null)).sent_count).toBe(all);

    const { data, error } = await asUser(staffSupport.jwt).rpc('get_nps_summary');
    expect(error).toBeNull();
    expect(NpsSummaryRowSchema.parse(firstRpcRow(data)).sent_count).toBe(all);
  });

  it('行が 1 つも無い期間・上限が下限より前の期間は、全部 0 の 1 行を返す', async () => {
    expect(await npsRow(asUser(staffSupport.jwt), EMPTY.from, EMPTY.to)).toEqual(ZERO_NPS);
    expect(await npsRow(asUser(staffSupport.jwt), W.to, W.from)).toEqual(ZERO_NPS);
  });

  it('返す列は決まった 6 列だけ (他の列を漏らさない)', async () => {
    const { data, error } = await asUser(staffSupport.jwt).rpc('get_nps_summary', { p_from: W.from, p_to: W.to });
    expect(error).toBeNull();
    expect(Object.keys((data as Array<Record<string, unknown>>)[0]).sort()).toEqual(
      ['detractors', 'passives', 'promoters', 'score_sum', 'sent_count', 'total_responses'],
    );
  });
});

// ---------------------------------------------------------------
// C. RLS: 関数は呼び出しユーザーの権限で動く
// ---------------------------------------------------------------
describe('#1217 C. RLS は呼び出しユーザーの権限で効く (SECURITY INVOKER)', () => {
  it('admin もサポート担当と同じく、全員分の CSAT / NPS を数えられる', async () => {
    expect(await csatRow(asUser(staffAdmin.jwt), W.from, W.to)).toEqual(await csatRow(asUser(staffSupport.jwt), W.from, W.to));
    const admin = await npsRow(asUser(staffAdmin.jwt), W.from, W.to);
    expect(admin).toEqual(await npsRow(asUser(staffSupport.jwt), W.from, W.to));
    expect(admin.sent_count).toBe(9);
  });

  it('一般ユーザーの CSAT は自分の分だけ (他人の行は数えない)', async () => {
    const a = await csatRow(asUser(userA.jwt), W.from, W.to);
    // A の W 内: 5, 4, 4, 2 (始まりちょうど)
    expect(a.total_responses).toBe(4);
    expect(a.score_sum).toBe(15);
    expect(csatDist(a)).toEqual([0, 1, 0, 2, 1]);

    const b = await csatRow(asUser(userB.jwt), W.from, W.to);
    // B の W 内: 1, 3, 5 (終わりちょうど)
    expect(b.total_responses).toBe(3);
    expect(b.score_sum).toBe(9);
    expect(csatDist(b)).toEqual([1, 0, 1, 0, 1]);
  });

  it('一般ユーザーの NPS は 0 件 (nps_surveys は運営の SELECT ポリシーしか無く、自分の行も読めない)。送信数にも漏れない', async () => {
    expect(await npsRow(asUser(userA.jwt), W.from, W.to)).toEqual(ZERO_NPS);
    expect(await npsRow(asUser(userB.jwt), W.from, W.to)).toEqual(ZERO_NPS);
    expect(await npsRow(asUser(userA.jwt), null, null)).toEqual(ZERO_NPS);
  });

  it('一般ユーザーが期間を NULL (全期間) にしても、見えるのは自分の CSAT だけ', async () => {
    const { data: own } = await asUser(userA.jwt).from('csat_feedbacks').select('id');
    const all = await csatRow(asUser(userA.jwt), null, null);
    expect(all.total_responses).toBe((own ?? []).length);
  });
});

// ---------------------------------------------------------------
// D. 権限
// ---------------------------------------------------------------
describe('#1217 D. 権限: anon は呼べない', () => {
  it('get_csat_summary: anon は permission denied (42501)', async () => {
    const { data, error } = await anon().rpc('get_csat_summary', { p_from: W.from, p_to: W.to });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('get_nps_summary: anon は permission denied (42501)', async () => {
    const { data, error } = await anon().rpc('get_nps_summary', { p_from: W.from, p_to: W.to, p_plan_key: null });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});

// ---------------------------------------------------------------
// E. 旧実装 (全行を読んで JS で数える) との同値性
// ---------------------------------------------------------------
/** 修正前の route.ts と同じ問い合わせで、そのユーザーの権限で見える行を全部読んで、旧実装の式で数える (CSAT) */
async function legacyCsatFor(c: SupabaseClient, from: Bound, to: Bound) {
  let q = c.from('csat_feedbacks').select('id, score, comment, ticket_id, created_at');
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);
  const { data, error } = await q.order('created_at', { ascending: false });
  expect(error).toBeNull();
  return legacyCsatSummary((data ?? []) as Array<{ score: number }>);
}

/** 同じく NPS (回答済みの行 + 送信数) */
async function legacyNpsFor(c: SupabaseClient, from: Bound, to: Bound, plan: string | null) {
  let q = c.from('nps_surveys').select('id, score, comment, plan_key, responded_at').not('responded_at', 'is', null);
  if (from) q = q.gte('sent_at', from);
  if (to) q = q.lte('sent_at', to);
  if (plan) q = q.eq('plan_key', plan);
  const { data, error } = await q.order('responded_at', { ascending: false });
  expect(error).toBeNull();

  let sent = c.from('nps_surveys').select('id', { count: 'exact', head: true });
  if (from) sent = sent.gte('sent_at', from);
  if (to) sent = sent.lte('sent_at', to);
  if (plan) sent = sent.eq('plan_key', plan);
  const { count, error: sentError } = await sent;
  expect(sentError).toBeNull();

  return legacyNpsSummary((data ?? []) as Array<{ score: number }>, count ?? 0);
}

describe('#1217 E. 関数 + 丸めの結果が、修正前 (同じユーザーの権限で全行を読んで JS で数える) と一致する', () => {
  const periods: Array<{ name: string; from: Bound; to: Bound }> = [
    { name: '3 月まるごと', from: W.from, to: W.to },
    { name: '3 月の中ほど', from: W2.from, to: W2.to },
    { name: '3/13 以降', from: FROM_ONLY, to: null },
    { name: '行の無い期間', from: EMPTY.from, to: EMPTY.to },
  ];
  const plans: Array<string | null> = [null, 'pro', 'free', 'enterprise'];

  // finance は API ルートは通るが RLS が許していない (#1311)。見え方がどうであっても「関数 = 旧実装」が成り立つことだけを確かめる
  const personas = (): Array<{ name: string; user: TestUser }> => [
    { name: 'サポート担当', user: staffSupport },
    { name: 'admin', user: staffAdmin },
    { name: '一般ユーザー A', user: userA },
    { name: '一般ユーザー B', user: userB },
    { name: 'finance', user: financeUser },
  ];

  // 問い合わせが多い (ユーザー 5 × 期間 4 × プラン 4) ので、ユーザーごとに並列で流す
  it('CSAT: どのユーザー・どの期間でも、画面に出る数字 (回答数・平均・分布) が一致する', { timeout: 120_000 }, async () => {
    for (const { name, user } of personas()) {
      const c = asUser(user.jwt);
      await Promise.all(
        periods.map(async (p) => {
          const viaRpc = buildCsatSummary(await csatRow(c, p.from, p.to), []);
          const { recent_feedbacks: _recent, ...summary } = viaRpc;
          void _recent;
          expect(summary, `${name} / ${p.name}`).toEqual(await legacyCsatFor(c, p.from, p.to));
        }),
      );
    }
  });

  it('NPS: どのユーザー・どの期間・どのプランでも、画面に出る数字 (回答数・NPS・平均・回答率) が一致する', { timeout: 120_000 }, async () => {
    for (const { name, user } of personas()) {
      const c = asUser(user.jwt);
      await Promise.all(
        periods.flatMap((p) =>
          plans.map(async (plan) => {
            const viaRpc = buildNpsSummary(await npsRow(c, p.from, p.to, plan), []);
            const { recent_comments: _recent, ...summary } = viaRpc;
            void _recent;
            expect(summary, `${name} / ${p.name} / プラン ${plan ?? '指定なし'}`).toEqual(
              await legacyNpsFor(c, p.from, p.to, plan),
            );
          }),
        ),
      );
    }
  });

  it('サポート担当の 3 月の数字は、手で数えた値と一致する (旧実装と関数が揃って間違っていないことの確認)', async () => {
    const c = asUser(staffSupport.jwt);
    const nps = buildNpsSummary(await npsRow(c, W.from, W.to), []);
    expect(nps).toMatchObject({
      total_responses: 7,
      promoters: 3,
      passives: 2,
      detractors: 2,
      nps_score: 14.3, // (3 - 2) / 7 * 100 = 14.28...
      avg_score: 7, // 49 / 7
      response_rate: 77.8, // 7 / 9 * 100 = 77.77...
    });
    const csat = buildCsatSummary(await csatRow(c, W.from, W.to), []);
    expect(csat).toMatchObject({
      total_responses: 7,
      avg_score: 3.4, // 24 / 7 = 3.428...
      score_distribution: { '1': 1, '2': 1, '3': 1, '4': 2, '5': 2 },
    });
  });
});

// ---------------------------------------------------------------
// F. 件数が多くても数え切れる (API の 1 回の応答で返す最大行数を超える件数)
// ---------------------------------------------------------------
// Supabase の API (PostgREST) は、1 回の応答で返す行数に上限がある (既定 1000 行)。修正前の route は該当行を全部取って
// JavaScript で数えていたので、1000 行を超えると 1000 行ぶんしか数えなかった (エラーも出ない)。
// 関数は DB の中で数えて 1 行だけ返すので、この上限の影響を受けない。
// 他の検証の数字が狂わないよう、このブロックの中でだけ行を入れ、終わったら消す。
// 日付は 2030 年 6 月 (W などの期間とは重ならない)。
const BULK_ROWS = 1100; // 1000 を超える数。CSAT の 5 点 (5 × 220)・NPS の 0〜10 点 (11 × 100) に割り切れる
const BULK = { from: '2030-06-01T00:00:00Z', to: '2030-06-30T23:59:59Z' };
const MARK_BULK = `${MARK} bulk`;

describe('#1217 F. 1000 行を超える件数でも、切り詰めずに正確に数える', () => {
  beforeAll(async () => {
    const start = Date.UTC(2030, 5, 1);
    const csat = Array.from({ length: BULK_ROWS }, (_, i) => ({
      user_id: userA.id,
      score: 1 + (i % 5),
      comment: MARK_BULK,
      created_at: new Date(start + i * 60_000).toISOString(),
    }));
    const nps = Array.from({ length: BULK_ROWS }, (_, i) => ({
      user_id: userA.id,
      score: i % 11,
      comment: MARK_BULK,
      plan_key: 'pro',
      sent_at: new Date(start + i * 60_000).toISOString(),
      responded_at: new Date(start + i * 60_000 + 30_000).toISOString(),
    }));
    const csatInsert = await srAdmin.from('csat_feedbacks').insert(csat);
    if (csatInsert.error) throw new Error(`csat_feedbacks bulk insert: ${csatInsert.error.message}`);
    const npsInsert = await srAdmin.from('nps_surveys').insert(nps);
    if (npsInsert.error) throw new Error(`nps_surveys bulk insert: ${npsInsert.error.message}`);
  }, 120_000);

  afterAll(async () => {
    await srAdmin.from('csat_feedbacks').delete().eq('comment', MARK_BULK);
    await srAdmin.from('nps_surveys').delete().eq('comment', MARK_BULK);
  }, 120_000);

  it('CSAT: 1,100 行を、回答数・合計・星ごとの件数まで正確に数える', async () => {
    const r = await csatRow(asUser(staffSupport.jwt), BULK.from, BULK.to);
    expect(r).toEqual({
      total_responses: 1100,
      score_sum: 3300, // 220 × (1 + 2 + 3 + 4 + 5)
      score_1_count: 220,
      score_2_count: 220,
      score_3_count: 220,
      score_4_count: 220,
      score_5_count: 220,
    });
    expect(buildCsatSummary(r, [])).toMatchObject({ total_responses: 1100, avg_score: 3 });
  });

  it('NPS: 1,100 行を、送信数・回答数・推奨者/中立/批判者・合計まで正確に数える', async () => {
    const r = await npsRow(asUser(staffSupport.jwt), BULK.from, BULK.to);
    expect(r).toEqual({
      sent_count: 1100,
      total_responses: 1100,
      promoters: 200, // 9, 10 が 100 回ずつ
      passives: 200, // 7, 8 が 100 回ずつ
      detractors: 700, // 0〜6 が 100 回ずつ
      score_sum: 5500, // 100 × (0 + 1 + ... + 10)
    });
    // 回答数と送信数がそろう (修正前は回答数だけ 1000 で止まり、回答率が 100% にならなかった)
    expect(buildNpsSummary(r, [])).toMatchObject({
      total_responses: 1100,
      response_rate: 100,
      avg_score: 5,
      nps_score: -45.5, // (200 - 700) / 1100 × 100
    });
  });

  it('plan_key で絞っても同じ (pro だけの 1,100 行。free は 0 件)', async () => {
    const pro = await npsRow(asUser(staffSupport.jwt), BULK.from, BULK.to, 'pro');
    expect(pro.total_responses).toBe(1100);
    expect(await npsRow(asUser(staffSupport.jwt), BULK.from, BULK.to, 'free')).toEqual(ZERO_NPS);
  });
});
