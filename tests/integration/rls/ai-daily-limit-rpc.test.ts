/**
 * #1149 (T40) AI の 1 日の利用回数の上限 (consume_ai_usage / refund_ai_usage / ai_daily_limits) のテスト (実 DB)
 *
 * 20261011020000_ai_daily_limits.sql が足すもの:
 *   - ai_daily_limits(plan_key PK, daily_limit (NULL は無制限), updated_at, updated_by)。既定は free = 10
 *   - consume_ai_usage(p_user_id, p_feature) -> jsonb   上限の判定と記録を 1 回で (上限なら記録せずに allowed: false)
 *   - consume_ai_usage_at(p_user_id, p_feature, p_at)    本体 (時刻を引数で受ける。API からは呼べない)
 *   - refund_ai_usage(p_user_id, p_feature, p_usage_date) -> boolean   数えた 1 回を戻す (0 より下にしない)
 *
 * 確認すること:
 *   A. 定義と権限 (カタログ): RLS 有効・ポリシー無し・テーブル権限は service_role だけ。関数は SECURITY DEFINER・search_path が空。
 *      EXECUTE は consume / refund が service_role、本体は所有者だけ。既定の行 free = 10
 *   B. 上限の境目: 9・10 回目は許可 (used が 9・10)、11 回目は止め (記録しない。回数は 10 のまま)。機能をまたいで合計で数える
 *   C. JST の日の境目: 上限に達した日の 23:59:59.999 (UTC 14:59:59.999) は止め、0:00 (UTC 15:00) は翌日として許可
 *   D. 同時実行: 上限 10 の利用者に同時に 15 本 → 許可はちょうど 10 本、止めは 5 本、回数は 10
 *   E. 上限に数えない機能 (nutrition_advice_auto): 上限に達していても許可し、記録する。合計に入れない
 *   F. プランごとの上限: 自分の行が無いプランは free の値。行の値 (保存した値) が次の判定から効く。NULL は無制限、0 は 1 回目から止め
 *   G. 数え戻し: 数えた日の回数を 1 減らす。0 より下にしない。別の日・別の機能は変えない
 *   H. クライアント (anon / authenticated) は、関数もテーブルも使えない
 *   I. 引数の検証
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-daily-limit-rpc.test.ts
 * 時刻を指定する consume_ai_usage_at と、カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。
 * 本番には接続しない。free の行の値はほかのテストも前提にするので変えない (プランごとの上限は pro の行で確かめ、終わったら元に戻す)。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ローカルスタックの Kong -> PostgREST は、使い回した最初の 1 回が 502 になることがある。データベースの結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(150 * (attempt + 1));
  }
};

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      fetch: fetchRetryingGateway502,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES && Date.now() - startedAt < 1500) {
      await sleep(150 * (attempt + 1));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
    return body as T[];
  }
}

// ---------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
/** 既定の free の上限 (migration の既定の行) */
const FREE_LIMIT = 10;
/** プランごとの上限を確かめるのに使うプラン (free の行は変えない) */
const PLAN_FOR_LIMITS = 'pro';
/** 同時実行の本数 (上限より多く) */
const CONCURRENT_CALLS = 15;

const createdUserIds: string[] = [];
let seq = 0;
/** テストの前の pro の行 (終わったら元に戻す) */
let originalPlanRow: { plan_key: string; daily_limit: number | null } | null = null;

interface TestUser {
  userId: string;
  jwt: string | null;
}

async function createUser(label: string, options: { withJwt?: boolean } = {}): Promise<TestUser> {
  const email = `rls-1149-${label}-${TS}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: `limit-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!options.withJwt) return { userId, jwt: null };
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { userId, jwt: signIn.data.session.access_token };
}

interface ConsumeResult {
  allowed: boolean;
  metered: boolean;
  plan: string | null;
  limit: number | null;
  used: number | null;
  usage_date: string;
}

async function consume(userId: string, feature: string): Promise<ConsumeResult> {
  const { data, error } = await srAdmin.rpc('consume_ai_usage', { p_user_id: userId, p_feature: feature });
  if (error) throw new Error(`consume_ai_usage ${feature}: ${error.code} ${error.message}`);
  return data as ConsumeResult;
}

/** 時刻を指定して数える (本体を postgres-meta 経由で呼ぶ。API からは呼べない) */
async function consumeAt(userId: string, feature: string, at: string): Promise<ConsumeResult> {
  const rows = await pgQuery<{ result: ConsumeResult }>(
    `SELECT public.consume_ai_usage_at('${userId}'::uuid, '${feature}', '${at}'::timestamptz) AS result`,
  );
  return rows[0].result;
}

async function counters(userId: string): Promise<Array<{ usage_date: string; feature: string; count: number }>> {
  const { data, error } = await srAdmin
    .from('ai_usage_counters')
    .select('usage_date, feature, count')
    .eq('user_id', userId)
    .order('usage_date', { ascending: true })
    .order('feature', { ascending: true });
  if (error) throw new Error(`ai_usage_counters: ${error.message}`);
  return data ?? [];
}

const totalOf = (rows: Array<{ count: number }>) => rows.reduce((sum, row) => sum + row.count, 0);

async function setPlanLimit(dailyLimit: number | null | 'none'): Promise<void> {
  if (dailyLimit === 'none') {
    const { error } = await srAdmin.from('ai_daily_limits').delete().eq('plan_key', PLAN_FOR_LIMITS);
    if (error) throw new Error(`ai_daily_limits delete: ${error.message}`);
    return;
  }
  const { error } = await srAdmin
    .from('ai_daily_limits')
    .upsert({ plan_key: PLAN_FOR_LIMITS, daily_limit: dailyLimit, updated_at: new Date().toISOString() }, { onConflict: 'plan_key' });
  if (error) throw new Error(`ai_daily_limits upsert: ${error.message}`);
}

beforeAll(async () => {
  const { data, error } = await srAdmin.from('ai_daily_limits').select('plan_key, daily_limit').eq('plan_key', PLAN_FOR_LIMITS).maybeSingle();
  if (error) throw new Error(`ai_daily_limits: ${error.message}`);
  originalPlanRow = data;
});

afterAll(async () => {
  const failures: string[] = [];
  // pro の行を元に戻す (無かったなら消す)
  const restore = originalPlanRow
    ? await srAdmin.from('ai_daily_limits').upsert(originalPlanRow, { onConflict: 'plan_key' })
    : await srAdmin.from('ai_daily_limits').delete().eq('plan_key', PLAN_FOR_LIMITS);
  if (restore.error) failures.push(`ai_daily_limits: ${restore.error.message}`);
  // ユーザーを消すと、記録 (ai_usage_counters)・契約 (personal_subscriptions)・プロフィールは CASCADE で消える
  for (const id of createdUserIds) {
    const { error } = await srAdmin.auth.admin.deleteUser(id);
    if (error) failures.push(`auth.users ${id}: ${error.message}`);
  }
  if (failures.length > 0) throw new Error(`テストが作った行を消せませんでした: ${failures.join(' / ')}`);
}, 120_000);

// ---------------------------------------------------------------
// A. 定義と権限
// ---------------------------------------------------------------
describe('#1149 A. テーブル・関数の定義と権限 (カタログ)', () => {
  it('上限の表は RLS 有効・ポリシー無し。テーブル権限は service_role だけ。既定の行 free = 10', async () => {
    const rls = await pgQuery<{ relrowsecurity: boolean }>(`SELECT c.relrowsecurity FROM pg_class AS c WHERE c.oid = 'public.ai_daily_limits'::regclass`);
    expect(rls).toEqual([{ relrowsecurity: true }]);
    const policies = await pgQuery<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_daily_limits'`);
    expect(policies[0].n).toBe(0);

    const privileges = await pgQuery<{ role: string; priv: string; ok: boolean }>(`
      SELECT r AS role, p AS priv, has_table_privilege(r, 'public.ai_daily_limits', p) AS ok
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r,
             unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
    `);
    for (const row of privileges) expect(row.ok, `${row.role} の ${row.priv}`).toBe(row.role === 'service_role');

    const { data } = await srAdmin.from('ai_daily_limits').select('daily_limit').eq('plan_key', 'free').single();
    expect(data?.daily_limit).toBe(FREE_LIMIT);
  });

  it('3 本の関数は SECURITY DEFINER・search_path が空・VOLATILE。EXECUTE は consume / refund が service_role、本体は所有者だけ', async () => {
    const rows = await pgQuery<{ proname: string; identity_args: string; result: string; prosecdef: boolean; provolatile: string; proconfig: string[]; executors: string[] }>(`
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS identity_args,
             pg_get_function_result(p.oid) AS result,
             p.prosecdef,
             p.provolatile,
             p.proconfig,
             coalesce(
               (SELECT array_agg(g ORDER BY g)
                  FROM (SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS g
                          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                         WHERE a.privilege_type = 'EXECUTE') AS s),
               '{}') AS executors
        FROM pg_proc AS p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('consume_ai_usage', 'consume_ai_usage_at', 'refund_ai_usage')
       ORDER BY p.proname
    `);
    expect(rows).toEqual([
      { proname: 'consume_ai_usage', identity_args: 'p_user_id uuid, p_feature text', result: 'jsonb', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], executors: ['postgres', 'service_role'] },
      { proname: 'consume_ai_usage_at', identity_args: 'p_user_id uuid, p_feature text, p_at timestamp with time zone', result: 'jsonb', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], executors: ['postgres'] },
      { proname: 'refund_ai_usage', identity_args: 'p_user_id uuid, p_feature text, p_usage_date date', result: 'boolean', prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], executors: ['postgres', 'service_role'] },
    ]);
  });

  it('上限には負の値・空のプランを入れられない (CHECK)', async () => {
    expect((await srAdmin.from('ai_daily_limits').insert({ plan_key: `t1149_${TS}`, daily_limit: -1 })).error?.code).toBe('23514');
    expect((await srAdmin.from('ai_daily_limits').insert({ plan_key: '  ', daily_limit: 1 })).error?.code).toBe('23514');
  });
});

// ---------------------------------------------------------------
// B. 上限の境目
// ---------------------------------------------------------------
describe('#1149 B. 上限の境目 (free = 1 日 10 回)', () => {
  it('9・10 回目は許可、11 回目は止め (記録しない)。機能をまたいで合計で数える。究極モードも 1 回の操作は 1 回', async () => {
    const user = await createUser('boundary');
    const features = ['menu_generation', 'photo_analysis', 'consultation'];
    for (let i = 1; i <= FREE_LIMIT - 2; i++) await consume(user.userId, features[i % features.length]);

    const ninth = await consume(user.userId, 'menu_generation');
    expect(ninth).toMatchObject({ allowed: true, metered: true, plan: 'free', limit: FREE_LIMIT, used: FREE_LIMIT - 1 });
    const tenth = await consume(user.userId, 'image_generation');
    expect(tenth).toMatchObject({ allowed: true, limit: FREE_LIMIT, used: FREE_LIMIT });
    const eleventh = await consume(user.userId, 'consultation');
    expect(eleventh).toMatchObject({ allowed: false, metered: true, plan: 'free', limit: FREE_LIMIT, used: FREE_LIMIT });
    expect(eleventh.usage_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 止めた呼び出しは記録しない (回数は 10 のまま)。もう一度呼んでも同じ
    expect(totalOf(await counters(user.userId))).toBe(FREE_LIMIT);
    expect((await consume(user.userId, 'photo_analysis')).allowed).toBe(false);
    expect(totalOf(await counters(user.userId))).toBe(FREE_LIMIT);
  });
});

// ---------------------------------------------------------------
// C. JST の日の境目
// ---------------------------------------------------------------
describe('#1149 C. JST の 0 時 (= UTC の 15 時) で上限が戻る', () => {
  it('上限に達した日の 23:59:59.999 は止め、翌日の 0:00 は許可。usage_date は JST の暦日', async () => {
    const user = await createUser('jst');
    for (let i = 0; i < FREE_LIMIT; i++) {
      const result = await consumeAt(user.userId, 'menu_generation', '2026-10-11T00:00:00Z'); // JST 10/11 09:00
      expect(result.allowed).toBe(true);
    }
    const lastSecond = await consumeAt(user.userId, 'menu_generation', '2026-10-11T14:59:59.999Z'); // JST 10/11 23:59:59.999
    expect(lastSecond).toMatchObject({ allowed: false, usage_date: '2026-10-11', used: FREE_LIMIT });
    // UTC の暦日は 10/10 だが、JST では 10/11 の 0:00 (同じ日に数える)
    expect(await consumeAt(user.userId, 'menu_generation', '2026-10-10T15:00:00Z')).toMatchObject({ allowed: false, usage_date: '2026-10-11' });

    const nextDay = await consumeAt(user.userId, 'menu_generation', '2026-10-11T15:00:00Z'); // JST 10/12 00:00
    expect(nextDay).toMatchObject({ allowed: true, usage_date: '2026-10-12', used: 1 });
    expect((await counters(user.userId)).map((r) => [r.usage_date, r.count])).toEqual([
      ['2026-10-11', FREE_LIMIT],
      ['2026-10-12', 1],
    ]);
  });
});

// ---------------------------------------------------------------
// D. 同時実行
// ---------------------------------------------------------------
describe('#1149 D. 同時実行', () => {
  it(`上限 ${FREE_LIMIT} の利用者に同時に ${CONCURRENT_CALLS} 本: 許可はちょうど ${FREE_LIMIT} 本、回数は ${FREE_LIMIT} (上限を超えない)`, async () => {
    const user = await createUser('race');
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CALLS }, (_, i) => consume(user.userId, i % 2 === 0 ? 'menu_generation' : 'photo_analysis')),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(FREE_LIMIT);
    expect(results.filter((r) => !r.allowed)).toHaveLength(CONCURRENT_CALLS - FREE_LIMIT);
    // 許可した呼び出しの used は 1〜10 が 1 つずつ (直列に判定された)
    expect(results.filter((r) => r.allowed).map((r) => r.used).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: FREE_LIMIT }, (_, i) => i + 1),
    );
    expect(totalOf(await counters(user.userId))).toBe(FREE_LIMIT);
  });
});

// ---------------------------------------------------------------
// E. 上限に数えない機能
// ---------------------------------------------------------------
describe('#1149 E. 上限に数えない機能 (画面を開くと自動で呼ばれる AI)', () => {
  it('nutrition_advice_auto は、上限に達していても許可して記録する。合計に入れない', async () => {
    const user = await createUser('unmetered');
    for (let i = 0; i < 3; i++) expect((await consume(user.userId, 'nutrition_advice_auto')).metered).toBe(false);
    // 自動の 3 回は合計に入らないので、押した操作は 10 回まで使える
    for (let i = 0; i < FREE_LIMIT; i++) expect((await consume(user.userId, 'consultation')).allowed).toBe(true);
    expect((await consume(user.userId, 'consultation')).allowed).toBe(false);
    // 上限に達したあとも、自動の呼び出しは止めない
    expect(await consume(user.userId, 'nutrition_advice_auto')).toMatchObject({ allowed: true, metered: false, limit: null });

    const rows = await counters(user.userId);
    expect(rows.find((r) => r.feature === 'nutrition_advice_auto')?.count).toBe(4);
    expect(rows.find((r) => r.feature === 'consultation')?.count).toBe(FREE_LIMIT);
  });
});

// ---------------------------------------------------------------
// F. プランごとの上限 (運営画面で保存した値)
// ---------------------------------------------------------------
describe('#1149 F. プランごとの上限', () => {
  const withProPlan = async (label: string) => {
    const user = await createUser(label);
    const { error } = await srAdmin.from('personal_subscriptions').insert({ user_id: user.userId, plan_key: PLAN_FOR_LIMITS, status: 'active' });
    if (error) throw new Error(`personal_subscriptions: ${error.message}`);
    return user;
  };

  it('自分の行が無いプランは free の値を使う', async () => {
    await setPlanLimit('none');
    const user = await withProPlan('fallback');
    const first = await consume(user.userId, 'menu_generation');
    expect(first).toMatchObject({ allowed: true, plan: PLAN_FOR_LIMITS, limit: FREE_LIMIT });
  });

  it('保存した値 (2 回) が次の判定から効く。3 回目は止め', async () => {
    const user = await withProPlan('saved');
    await setPlanLimit(2);
    expect(await consume(user.userId, 'menu_generation')).toMatchObject({ allowed: true, limit: 2, used: 1 });
    expect(await consume(user.userId, 'menu_generation')).toMatchObject({ allowed: true, limit: 2, used: 2 });
    expect(await consume(user.userId, 'menu_generation')).toMatchObject({ allowed: false, limit: 2, used: 2 });

    // 上限を上げると、同じ日のうちに続きを使える
    await setPlanLimit(3);
    expect(await consume(user.userId, 'menu_generation')).toMatchObject({ allowed: true, limit: 3, used: 3 });
  });

  it('NULL は無制限 (free の上限を超えても許可)。0 は 1 回目から止め', async () => {
    const user = await withProPlan('unlimited');
    await setPlanLimit(null);
    for (let i = 0; i < FREE_LIMIT + 1; i++) expect((await consume(user.userId, 'photo_analysis')).allowed).toBe(true);
    expect(await consume(user.userId, 'photo_analysis')).toMatchObject({ allowed: true, limit: null, used: FREE_LIMIT + 2 });

    const blocked = await withProPlan('zero');
    await setPlanLimit(0);
    expect(await consume(blocked.userId, 'photo_analysis')).toMatchObject({ allowed: false, limit: 0, used: 0 });
    expect(await counters(blocked.userId)).toEqual([]);
  });
});

// ---------------------------------------------------------------
// G. 数え戻し
// ---------------------------------------------------------------
describe('#1149 G. 数え戻し (refund_ai_usage)', () => {
  it('数えた日の、その機能の回数を 1 減らす (上限に達していても、戻した分はまた使える)。0 より下にしない', async () => {
    const user = await createUser('refund');
    for (let i = 0; i < FREE_LIMIT; i++) await consume(user.userId, 'menu_generation');
    const denied = await consume(user.userId, 'menu_generation');
    expect(denied.allowed).toBe(false);

    const { data, error } = await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: 'menu_generation', p_usage_date: denied.usage_date });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(totalOf(await counters(user.userId))).toBe(FREE_LIMIT - 1);
    expect((await consume(user.userId, 'menu_generation')).allowed).toBe(true);

    // 別の機能・別の日の行は変えない (行が無ければ false)
    expect((await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: 'consultation', p_usage_date: denied.usage_date })).data).toBe(false);
    expect((await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: 'menu_generation', p_usage_date: '2000-01-01' })).data).toBe(false);
    expect(totalOf(await counters(user.userId))).toBe(FREE_LIMIT);
  });

  it('0 の行は 0 のまま (false)', async () => {
    const user = await createUser('refund-zero');
    const first = await consume(user.userId, 'shopping_list');
    expect((await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: 'shopping_list', p_usage_date: first.usage_date })).data).toBe(true);
    expect((await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: 'shopping_list', p_usage_date: first.usage_date })).data).toBe(false);
    expect((await counters(user.userId)).map((r) => r.count)).toEqual([0]);
  });
});

// ---------------------------------------------------------------
// H. クライアントからは使えない
// ---------------------------------------------------------------
describe('#1149 H. クライアント (anon / authenticated) の権限', () => {
  it('anon / authenticated は consume / refund を呼べない (42501)。上限の表を読めず、書けない', async () => {
    const attacker = await createUser('attacker', { withJwt: true });
    const victim = await createUser('victim');

    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(attacker.jwt!)],
    ] as const) {
      expect((await db.rpc('consume_ai_usage', { p_user_id: victim.userId, p_feature: 'consultation' })).error?.code, `${label}: consume`).toBe('42501');
      expect(
        (await db.rpc('refund_ai_usage', { p_user_id: victim.userId, p_feature: 'consultation', p_usage_date: '2026-10-11' })).error?.code,
        `${label}: refund`,
      ).toBe('42501');
      expect(
        (await db.rpc('consume_ai_usage_at', { p_user_id: victim.userId, p_feature: 'consultation', p_at: new Date().toISOString() })).error,
        `${label}: consume_ai_usage_at`,
      ).not.toBeNull();
      expect((await db.from('ai_daily_limits').select('*')).error?.code, `${label}: select ai_daily_limits`).toBe('42501');
      expect((await db.from('ai_daily_limits').upsert({ plan_key: 'free', daily_limit: null })).error?.code, `${label}: upsert ai_daily_limits`).toBe('42501');
    }
    expect(await counters(victim.userId)).toEqual([]);
    const { data } = await srAdmin.from('ai_daily_limits').select('daily_limit').eq('plan_key', 'free').single();
    expect(data?.daily_limit).toBe(FREE_LIMIT);
  });

  it('service_role でも本体 (consume_ai_usage_at) は API から呼べない', async () => {
    const user = await createUser('core-service');
    const { error } = await srAdmin.rpc('consume_ai_usage_at', { p_user_id: user.userId, p_feature: 'consultation', p_at: new Date().toISOString() });
    expect(error).not.toBeNull();
    expect(await counters(user.userId)).toEqual([]);
  });
});

// ---------------------------------------------------------------
// I. 引数の検証
// ---------------------------------------------------------------
describe('#1149 I. 引数の検証', () => {
  it('機能名の形式・NULL のユーザーは 22023。数えない', async () => {
    const user = await createUser('args');
    for (const feature of ['Bad-Feature', '1abc', '']) {
      const { error } = await srAdmin.rpc('consume_ai_usage', { p_user_id: user.userId, p_feature: feature });
      expect(error?.code, feature).toBe('22023');
    }
    expect((await srAdmin.rpc('consume_ai_usage', { p_user_id: null, p_feature: 'consultation' })).error?.code).toBe('22023');
    expect((await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: 'consultation', p_usage_date: null })).error?.code).toBe('22023');
    expect(await counters(user.userId)).toEqual([]);
  });
});
