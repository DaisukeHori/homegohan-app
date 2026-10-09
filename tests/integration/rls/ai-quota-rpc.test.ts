/**
 * #1177 (T26) プランの判定 (get_effective_plan) と、AI の利用回数の記録 (consume_ai_quota) のテスト
 *
 * 20261008140300_ai_quota_foundation.sql が足すもの:
 *   - ai_plan_limits(plan_key PK, daily_limit, monthly_limit)  プランごとの上限。NULL = 無制限。いまは全プラン NULL
 *   - ai_usage_counters(user_id, usage_date (JST), feature, count)  PK(user_id, usage_date, feature)
 *   - get_effective_plan(p_user_id) -> text    個人の契約 -> 家族 -> 組織 -> 'free'
 *   - consume_ai_quota(p_user_id, p_feature) -> jsonb   原子的に +1 して {allowed, remaining, ...} を返す
 *   - consume_ai_quota_at(p_user_id, p_feature, p_at)   本体 (時刻を引数で受ける。API からは呼べない)
 *
 * 確認すること:
 *   A. 定義と権限 (カタログ): SECURITY DEFINER・search_path が空・戻り値。EXECUTE は service_role だけ (本体は誰にも付けない)。
 *      テーブルは RLS 有効・ポリシー無し・クライアントのテーブル権限なし。シードは全プラン NULL (無制限)
 *   B. get_effective_plan: 状態ごとの解決 (trialing / active / grace / past_due だけ有効)、優先順位、解散・脱退した所属は見ない
 *   C. 無制限の経路 (いまの本番の挙動): 常に許可・回数は増える・機能ごとに別の行・行が無いプランも無制限・引数の検証
 *   D. 上限の経路 (いまは通らないが、T40 で上限を入れたとき効く): 日次・月次・機能をまたいだ合計・拒否した呼び出しは数えない
 *   E. JST の日付と月の変わり目: 日本時間の 0 時 (= UTC の 15 時) で日が替わり、月も替わる
 *   F. 同時実行: 無制限なら加算が 1 つも失われない。上限があれば、同時に来ても上限を超えて許可しない
 *   G. クライアント (anon / authenticated) は、関数もテーブルも使えない。アカウントを消せば計測も消える
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-quota-rpc.test.ts
 *
 * 時刻を指定する consume_ai_quota_at と、カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが
 * 必要) で行う。本番には接続しない。
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ローカルスタックの Kong -> PostgREST の接続は、しばらく使っていないと切られていることがあり、
 * 使い回した最初の 1 回が 502 になる。データベースの結果ではないので、数回だけやり直す。
 */
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
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
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

interface TestUser {
  userId: string;
  jwt: string | null;
}

interface QuotaResult {
  allowed: boolean;
  remaining: number | null;
  plan_key: string;
  limit_kind?: 'daily' | 'monthly';
  limit?: number;
  reset_at?: string;
}

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdLimitPlanKeys: string[] = [];
let seq = 0;

async function createUser(label: string, options: { withJwt?: boolean } = {}): Promise<TestUser> {
  const email = `rls-1177-${label}-${TS}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);

  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: `quota-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);

  if (!options.withJwt) return { userId, jwt: null };
  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { userId, jwt: signIn.data.session.access_token };
}

/** 上限のテスト用のプラン。組織の plan は自由な文字列なので、実在のプランに触れずに上限を試せる */
async function createLimitedOrgUser(
  label: string,
  limits: { daily?: number | null; monthly?: number | null },
): Promise<{ user: TestUser; planKey: string; orgId: string }> {
  const planKey = `t1177-${label}-${TS}-${++seq}`;
  const { error: limitError } = await srAdmin
    .from('ai_plan_limits')
    .upsert({ plan_key: planKey, daily_limit: limits.daily ?? null, monthly_limit: limits.monthly ?? null });
  if (limitError) throw new Error(`ai_plan_limits ${label}: ${limitError.message}`);
  createdLimitPlanKeys.push(planKey);

  const orgId = await createOrg(planKey);
  const user = await createUser(label);
  await joinOrg(user.userId, orgId);
  return { user, planKey, orgId };
}

async function createOrg(plan: string | null): Promise<string> {
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `T1177 org ${TS}-${++seq}`, plan })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  createdOrgIds.push(data.id);
  return data.id as string;
}

async function joinOrg(userId: string, orgId: string | null) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({ organization_id: orgId, org_role: orgId ? 'member' : null })
    .eq('id', userId);
  if (error) throw new Error(`user_profiles.organization_id: ${error.message}`);
}

/** 代表者として家族を作る (create_family_group は、代表者の active なメンバー行も作る) */
async function createFamily(rep: TestUser, planKey: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt!).rpc('create_family_group', {
    p_name: `#1177 ${TS}-${++seq}`,
    p_plan_key: planKey,
  });
  if (error || !data) throw new Error(`create_family_group: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return familyId;
}

async function setSubscription(userId: string, planKey: string, status: string): Promise<void> {
  const { data: existing } = await srAdmin.from('personal_subscriptions').select('id').eq('user_id', userId).limit(1);
  if (existing && existing.length > 0) {
    const { error } = await srAdmin.from('personal_subscriptions').update({ status }).eq('user_id', userId);
    if (error) throw new Error(`personal_subscriptions update: ${error.message}`);
    return;
  }
  const { error } = await srAdmin.from('personal_subscriptions').insert({ user_id: userId, plan_key: planKey, status });
  if (error) throw new Error(`personal_subscriptions insert: ${error.message}`);
}

async function effectivePlan(userId: string): Promise<string> {
  const { data, error } = await srAdmin.rpc('get_effective_plan', { p_user_id: userId });
  if (error) throw new Error(`get_effective_plan: ${error.message}`);
  return data as string;
}

async function consume(userId: string, feature: string): Promise<QuotaResult> {
  const { data, error } = await srAdmin.rpc('consume_ai_quota', { p_user_id: userId, p_feature: feature });
  if (error) throw new Error(`consume_ai_quota ${feature}: ${error.code} ${error.message}`);
  return data as QuotaResult;
}

/** 時刻を指定して数える (本体を postgres-meta 経由で呼ぶ。API からは呼べない) */
async function consumeAt(userId: string, feature: string, at: string): Promise<QuotaResult> {
  const rows = await pgQuery<{ r: QuotaResult }>(
    `SELECT public.consume_ai_quota_at('${userId}'::uuid, '${feature}', '${at}'::timestamptz) AS r`,
  );
  return rows[0].r;
}

interface CounterRow {
  usage_date: string;
  feature: string;
  count: number;
}

async function counters(userId: string): Promise<CounterRow[]> {
  const { data, error } = await srAdmin
    .from('ai_usage_counters')
    .select('usage_date, feature, count')
    .eq('user_id', userId)
    .order('usage_date', { ascending: true })
    .order('feature', { ascending: true });
  if (error) throw new Error(`ai_usage_counters: ${error.message}`);
  return (data ?? []) as CounterRow[];
}

const total = (rows: CounterRow[]) => rows.reduce((sum, row) => sum + row.count, 0);

afterAll(async () => {
  // 上限の行 -> 家族 -> ユーザー -> 組織 の順に消す。
  //   - 家族を先に消す: family_groups.representative_id は auth.users への ON DELETE RESTRICT なので、
  //     代表者のユーザーは、家族が残っていると消せない (メンバー行は CASCADE、プロフィールの family_id は SET NULL)。
  //   - ユーザーを消すと、計測 (ai_usage_counters)・契約 (personal_subscriptions)・プロフィールは CASCADE で消える。
  //   - 組織は、ユーザーのプロフィール (organization_id は SET NULL) が無くなってから消す。
  // 消せなかったら、行が残ったことが分かるように失敗させる (黙って残さない)。
  const failures: string[] = [];
  const check = (label: string, error: { message: string } | null) => {
    if (error) failures.push(`${label}: ${error.message}`);
  };

  if (createdLimitPlanKeys.length > 0) {
    check('ai_plan_limits', (await srAdmin.from('ai_plan_limits').delete().in('plan_key', createdLimitPlanKeys)).error);
  }
  if (createdFamilyIds.length > 0) {
    // create_family_group が足した監査ログ (membership_audit) も消す
    check('membership_audit', (await srAdmin.from('membership_audit').delete().in('scope_id', createdFamilyIds)).error);
    check('family_groups', (await srAdmin.from('family_groups').delete().in('id', createdFamilyIds)).error);
  }
  for (const id of createdUserIds) {
    check(`auth.users ${id}`, (await srAdmin.auth.admin.deleteUser(id)).error);
  }
  if (createdOrgIds.length > 0) {
    check('organizations', (await srAdmin.from('organizations').delete().in('id', createdOrgIds)).error);
  }

  if (failures.length > 0) throw new Error(`テストが作った行を消せませんでした: ${failures.join(' / ')}`);
}, 120_000);

// ---------------------------------------------------------------
// A. 定義と権限 (カタログ)
// ---------------------------------------------------------------
describe('#1177 A. テーブル・関数の定義と権限 (カタログ)', () => {
  it('2 つのテーブルは RLS 有効・ポリシー無し・主キーが期待どおり', async () => {
    const rls = await pgQuery<{ relname: string; relrowsecurity: boolean }>(`
      SELECT c.relname, c.relrowsecurity
        FROM pg_class AS c
       WHERE c.oid IN ('public.ai_plan_limits'::regclass, 'public.ai_usage_counters'::regclass)
       ORDER BY c.relname
    `);
    expect(rls).toEqual([
      { relname: 'ai_plan_limits', relrowsecurity: true },
      { relname: 'ai_usage_counters', relrowsecurity: true },
    ]);

    const policies = await pgQuery<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND tablename IN ('ai_plan_limits', 'ai_usage_counters')
    `);
    expect(policies[0].n, 'クライアント向けのポリシーは作らない').toBe(0);

    const pks = await pgQuery<{ table_name: string; columns: string[] }>(`
      SELECT c.conrelid::regclass::text AS table_name,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
        FROM pg_constraint AS c
       WHERE c.contype = 'p'
         AND c.conrelid IN ('public.ai_plan_limits'::regclass, 'public.ai_usage_counters'::regclass)
       ORDER BY 1
    `);
    expect(pks).toEqual([
      { table_name: 'ai_plan_limits', columns: ['plan_key'] },
      { table_name: 'ai_usage_counters', columns: ['user_id', 'usage_date', 'feature'] },
    ]);
  });

  it('テーブル権限は service_role だけ (anon / authenticated は何も持たない)', async () => {
    const rows = await pgQuery<{ role: string; tbl: string; priv: string; ok: boolean }>(`
      SELECT r.role, t.tbl, p.priv, has_table_privilege(r.role, t.tbl, p.priv) AS ok
        FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
        CROSS JOIN (VALUES ('public.ai_plan_limits'), ('public.ai_usage_counters')) AS t(tbl)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
    `);
    expect(rows).toHaveLength(24);
    for (const row of rows) {
      expect(row.ok, `${row.role} の ${row.priv} on ${row.tbl}`).toBe(row.role === 'service_role');
    }
  });

  it('3 本の関数は SECURITY DEFINER・search_path が空で、戻り値が期待どおり', async () => {
    const rows = await pgQuery(`
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS identity_args,
             pg_get_function_result(p.oid) AS result,
             p.prosecdef,
             p.provolatile,
             p.proconfig
        FROM pg_proc AS p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('get_effective_plan', 'consume_ai_quota', 'consume_ai_quota_at')
       ORDER BY p.proname
    `);
    expect(rows).toEqual([
      {
        proname: 'consume_ai_quota',
        identity_args: 'p_user_id uuid, p_feature text',
        result: 'jsonb',
        prosecdef: true,
        provolatile: 'v', // 書き込む関数なので VOLATILE (STABLE にするとロック前のスナップショットで数えてしまう)
        proconfig: ['search_path=""'],
      },
      {
        proname: 'consume_ai_quota_at',
        identity_args: 'p_user_id uuid, p_feature text, p_at timestamp with time zone',
        result: 'jsonb',
        prosecdef: true,
        provolatile: 'v',
        proconfig: ['search_path=""'],
      },
      {
        proname: 'get_effective_plan',
        identity_args: 'p_user_id uuid',
        result: 'text',
        prosecdef: true,
        provolatile: 's',
        proconfig: ['search_path=""'],
      },
    ]);
  });

  it('EXECUTE を持つのは所有者と service_role だけ。本体 (consume_ai_quota_at) は所有者だけ', async () => {
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
         AND p.proname IN ('get_effective_plan', 'consume_ai_quota', 'consume_ai_quota_at')
       ORDER BY p.proname
    `);
    expect(rows).toEqual([
      { proname: 'consume_ai_quota', executors: ['postgres', 'service_role'] },
      { proname: 'consume_ai_quota_at', executors: ['postgres'] },
      { proname: 'get_effective_plan', executors: ['postgres', 'service_role'] },
    ]);
  });

  it('シード: 公式の 9 プラン (free を含む) すべてに上限の行があり、どれも NULL (無制限)', async () => {
    // docs/design/operator/CLAUDE.md の「9 種公式 plan_key」。T40 で上限の数値を入れるときは、このテストの期待値も変える
    const officialPlans = [
      'free',
      'pro',
      'family_basic',
      'family_pro',
      'family_addon',
      'org_starter',
      'org_standard',
      'org_pro',
      'org_enterprise',
    ];

    const { data: limits, error } = await srAdmin
      .from('ai_plan_limits')
      .select('plan_key, daily_limit, monthly_limit')
      .in('plan_key', officialPlans);
    if (error) throw new Error(error.message);

    expect((limits ?? []).map((l) => l.plan_key).sort()).toEqual([...officialPlans].sort());
    for (const limit of limits ?? []) {
      expect(limit.daily_limit, `${limit.plan_key}.daily_limit`).toBeNull();
      expect(limit.monthly_limit, `${limit.plan_key}.monthly_limit`).toBeNull();
    }
  });

  it('上限と回数の列には負の値・不正な機能名を入れられない (CHECK)', async () => {
    const planKey = `t1177-check-${TS}`;
    createdLimitPlanKeys.push(planKey);
    const negativeDaily = await srAdmin.from('ai_plan_limits').insert({ plan_key: planKey, daily_limit: -1 });
    expect(negativeDaily.error?.code).toBe('23514');
    const negativeMonthly = await srAdmin.from('ai_plan_limits').insert({ plan_key: planKey, monthly_limit: -1 });
    expect(negativeMonthly.error?.code).toBe('23514');

    const user = await createUser('check');
    const badFeature = await srAdmin
      .from('ai_usage_counters')
      .insert({ user_id: user.userId, usage_date: '2026-10-08', feature: 'Bad-Feature', count: 1 });
    expect(badFeature.error?.code).toBe('23514');
    const negativeCount = await srAdmin
      .from('ai_usage_counters')
      .insert({ user_id: user.userId, usage_date: '2026-10-08', feature: 'ok_feature', count: -1 });
    expect(negativeCount.error?.code).toBe('23514');
  });
});

// ---------------------------------------------------------------
// B. get_effective_plan
// ---------------------------------------------------------------
describe('#1177 B. get_effective_plan: いま効いているプラン', () => {
  it('契約も所属も無ければ free。NULL と実在しないユーザーも free', async () => {
    const user = await createUser('plan-free');
    expect(await effectivePlan(user.userId)).toBe('free');

    const { data: nullUser, error } = await srAdmin.rpc('get_effective_plan', { p_user_id: null });
    expect(error).toBeNull();
    expect(nullUser).toBe('free');
    expect(await effectivePlan(randomUUID())).toBe('free');
  });

  it('個人の契約は trialing / active / grace / past_due のときだけ有効。paused / cancelled / expired は見ない', async () => {
    const user = await createUser('plan-personal');

    for (const status of ['trialing', 'active', 'grace', 'past_due']) {
      await setSubscription(user.userId, 'pro', status);
      expect(await effectivePlan(user.userId), `status=${status}`).toBe('pro');
    }

    for (const status of ['paused', 'cancelled', 'expired']) {
      // paused は paused_until が必須 (CHECK ps_paused_until_required)
      const patch = status === 'paused' ? { status, paused_until: new Date(Date.now() + 86_400_000).toISOString() } : { status };
      const { error } = await srAdmin.from('personal_subscriptions').update(patch).eq('user_id', user.userId);
      if (error) throw new Error(`personal_subscriptions ${status}: ${error.message}`);
      expect(await effectivePlan(user.userId), `status=${status}`).toBe('free');
    }
  });

  it('優先順位: 個人の契約 > 家族 > 組織 > free。外れた所属・解散した家族 / 組織は見ない', async () => {
    const orgId = await createOrg('org_standard');
    const user = await createUser('plan-order', { withJwt: true });
    await joinOrg(user.userId, orgId);

    // 組織だけ
    expect(await effectivePlan(user.userId)).toBe('org_standard');

    // 家族 (family_basic) に入ると、家族が組織より優先される
    const familyId = await createFamily(user, 'family_basic');
    expect(await effectivePlan(user.userId)).toBe('family_basic');

    // 個人の契約があれば、それが最優先
    await setSubscription(user.userId, 'pro', 'active');
    expect(await effectivePlan(user.userId)).toBe('pro');

    // 個人の契約が終われば家族に戻る
    await setSubscription(user.userId, 'pro', 'expired');
    expect(await effectivePlan(user.userId)).toBe('family_basic');

    // 家族が解散すれば (メンバー行が active のまま残っていても) 組織に戻る
    const { error: dissolveError } = await srAdmin
      .from('family_groups')
      .update({ status: 'dissolved', dissolved_at: new Date().toISOString() })
      .eq('id', familyId);
    if (dissolveError) throw new Error(`family_groups dissolve: ${dissolveError.message}`);
    expect(await effectivePlan(user.userId)).toBe('org_standard');

    // 家族が active に戻っても、本人が抜けた (status != active) なら見ない
    const { error: reopenError } = await srAdmin
      .from('family_groups')
      .update({ status: 'active', dissolved_at: null })
      .eq('id', familyId);
    if (reopenError) throw new Error(`family_groups reopen: ${reopenError.message}`);
    expect(await effectivePlan(user.userId)).toBe('family_basic');
    const { error: leaveError } = await srAdmin
      .from('family_members')
      .update({ status: 'left', removed_at: new Date().toISOString() })
      .eq('family_id', familyId)
      .eq('user_id', user.userId);
    if (leaveError) throw new Error(`family_members leave: ${leaveError.message}`);
    expect(await effectivePlan(user.userId)).toBe('org_standard');

    // 組織が解散すれば free
    const { error: orgError } = await srAdmin
      .from('organizations')
      .update({ status: 'dissolved', dissolved_at: new Date().toISOString() })
      .eq('id', orgId);
    if (orgError) throw new Error(`organizations dissolve: ${orgError.message}`);
    expect(await effectivePlan(user.userId)).toBe('free');
  });

  it('plan が NULL の組織は free。所属を外せば free', async () => {
    const orgId = await createOrg(null);
    const user = await createUser('plan-null-org');
    await joinOrg(user.userId, orgId);
    expect(await effectivePlan(user.userId)).toBe('free');

    const paidOrgId = await createOrg('org_pro');
    await joinOrg(user.userId, paidOrgId);
    expect(await effectivePlan(user.userId)).toBe('org_pro');

    await joinOrg(user.userId, null);
    expect(await effectivePlan(user.userId)).toBe('free');
  });
});

// ---------------------------------------------------------------
// C. 無制限の経路
// ---------------------------------------------------------------
describe('#1177 C. 無制限の経路 (いまの本番の挙動)', () => {
  it('free のユーザー: 常に許可され、残りは null (無制限)。回数は増える', async () => {
    const user = await createUser('unlimited');

    const first = await consume(user.userId, 'menu_generation');
    expect(first).toEqual({ allowed: true, remaining: null, plan_key: 'free' });

    for (let i = 0; i < 4; i++) {
      expect(await consume(user.userId, 'menu_generation')).toEqual({ allowed: true, remaining: null, plan_key: 'free' });
    }
    const rows = await counters(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'menu_generation', count: 5 });
  });

  it('機能ごとに別の行で数える。同じ機能は 1 行に足される', async () => {
    const user = await createUser('features');
    await consume(user.userId, 'photo_analysis');
    await consume(user.userId, 'consultation');
    await consume(user.userId, 'consultation');
    await consume(user.userId, 'menu_generation');

    const rows = await counters(user.userId);
    expect(rows.map((r) => [r.feature, r.count])).toEqual([
      ['consultation', 2],
      ['menu_generation', 1],
      ['photo_analysis', 1],
    ]);
  });

  it('組織のプランでも同じ。有料のプランでも、いまは上限の行が NULL なので無制限', async () => {
    const orgId = await createOrg('org_enterprise');
    const user = await createUser('unlimited-org');
    await joinOrg(user.userId, orgId);

    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: null, plan_key: 'org_enterprise' });
  });

  it('上限の行が無いプラン (subscription_plans に無い値) も無制限として扱う', async () => {
    const planKey = `t1177-no-limit-row-${TS}`;
    const orgId = await createOrg(planKey);
    const user = await createUser('no-limit-row');
    await joinOrg(user.userId, orgId);

    const { data: rows } = await srAdmin.from('ai_plan_limits').select('plan_key').eq('plan_key', planKey);
    expect(rows).toEqual([]);
    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: null, plan_key: planKey });
  });

  it('日付は JST の暦日で記録する (同じトランザクションの now() から求めた JST の日付と一致する)', async () => {
    const user = await createUser('jst-today');
    const rows = await pgQuery<{ usage_date: string; expected: string }>(`
      SELECT public.consume_ai_quota('${user.userId}'::uuid, 'photo_analysis');
      SELECT c.usage_date::text AS usage_date, ((now() AT TIME ZONE 'Asia/Tokyo')::date)::text AS expected
        FROM public.ai_usage_counters AS c
       WHERE c.user_id = '${user.userId}'::uuid AND c.feature = 'photo_analysis'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].usage_date).toBe(rows[0].expected);
  });

  it('引数の検証: 機能名は小文字・数字・アンダースコア (先頭は英字、64 文字まで)。NULL のユーザーは 22023', async () => {
    const user = await createUser('invalid-args');

    for (const feature of ['', 'Bad-Name', 'UPPER', '1leading_digit', 'has space', 'x'.repeat(65)]) {
      const { error } = await srAdmin.rpc('consume_ai_quota', { p_user_id: user.userId, p_feature: feature });
      expect(error?.code, `feature=${JSON.stringify(feature)}`).toBe('22023');
    }
    const ok64 = await srAdmin.rpc('consume_ai_quota', { p_user_id: user.userId, p_feature: 'x'.repeat(64) });
    expect(ok64.error).toBeNull();

    const nullUser = await srAdmin.rpc('consume_ai_quota', { p_user_id: null, p_feature: 'consultation' });
    expect(nullUser.error?.code).toBe('22023');
    const nullFeature = await srAdmin.rpc('consume_ai_quota', { p_user_id: user.userId, p_feature: null });
    expect(nullFeature.error?.code).toBe('22023');

    // 不正な呼び出しは数えない
    expect(total(await counters(user.userId))).toBe(1);
  });

  it('実在しないユーザーは外部キー違反 (23503)。回数の行を作らない', async () => {
    const ghost = randomUUID();
    const { error } = await srAdmin.rpc('consume_ai_quota', { p_user_id: ghost, p_feature: 'consultation' });
    expect(error?.code).toBe('23503');
    expect(await counters(ghost)).toEqual([]);
  });
});

// ---------------------------------------------------------------
// D. 上限の経路
// ---------------------------------------------------------------
describe('#1177 D. 上限の経路 (いまは通らない。T40 で上限を入れたとき効く)', () => {
  it('日次の上限 3: 3 回目まで許可 (残りが減る)、4 回目から拒否。拒否は数えない', async () => {
    const { user, planKey } = await createLimitedOrgUser('daily', { daily: 3 });

    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: 2, plan_key: planKey });
    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: 1, plan_key: planKey });
    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: 0, plan_key: planKey });

    const denied = await consume(user.userId, 'consultation');
    expect(denied).toMatchObject({ allowed: false, remaining: 0, plan_key: planKey, limit_kind: 'daily', limit: 3 });
    expect(denied.reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T15:00:00Z$/); // 次の JST の 0 時 = UTC の 15 時
    await consume(user.userId, 'consultation');

    expect(total(await counters(user.userId))).toBe(3);
  });

  it('上限は機能をまたいだ合計。別のユーザー・別のプランには影響しない', async () => {
    const { user, planKey } = await createLimitedOrgUser('sum', { daily: 3 });
    const other = await createLimitedOrgUser('sum-other', { daily: 3 });

    expect((await consume(user.userId, 'consultation')).allowed).toBe(true);
    expect((await consume(user.userId, 'photo_analysis')).allowed).toBe(true);
    expect((await consume(user.userId, 'menu_generation')).allowed).toBe(true);
    // 4 回目は、まだ使っていない機能でも拒否
    expect(await consume(user.userId, 'image_generation')).toMatchObject({ allowed: false, plan_key: planKey });

    // 同じプランでも別のユーザーは別に数える
    expect((await consume(other.user.userId, 'consultation')).allowed).toBe(true);
    expect(total(await counters(user.userId))).toBe(3);
    expect(total(await counters(other.user.userId))).toBe(1);
  });

  it('上限 0 は最初から拒否する', async () => {
    const { user } = await createLimitedOrgUser('zero', { daily: 0 });
    expect(await consume(user.userId, 'consultation')).toMatchObject({ allowed: false, limit_kind: 'daily', limit: 0 });
    expect(await counters(user.userId)).toEqual([]);
  });

  it('月次の上限 4 (日次は無し): 日をまたいだ合計で数える。拒否の理由は monthly', async () => {
    const { user, planKey } = await createLimitedOrgUser('monthly', { monthly: 4 });

    // 2026-10 の 1 日・2 日・3 日 (JST) に 1 回ずつ + 15 日に 1 回
    expect(await consumeAt(user.userId, 'consultation', '2026-10-01T03:00:00Z')).toEqual({ allowed: true, remaining: 3, plan_key: planKey });
    expect(await consumeAt(user.userId, 'consultation', '2026-10-02T03:00:00Z')).toEqual({ allowed: true, remaining: 2, plan_key: planKey });
    expect(await consumeAt(user.userId, 'photo_analysis', '2026-10-03T03:00:00Z')).toEqual({ allowed: true, remaining: 1, plan_key: planKey });
    expect(await consumeAt(user.userId, 'consultation', '2026-10-15T03:00:00Z')).toEqual({ allowed: true, remaining: 0, plan_key: planKey });

    const denied = await consumeAt(user.userId, 'consultation', '2026-10-20T03:00:00Z');
    expect(denied).toMatchObject({ allowed: false, remaining: 0, limit_kind: 'monthly', limit: 4, plan_key: planKey });
    expect(denied.reset_at).toBe('2026-10-31T15:00:00Z'); // 11/1 の JST 0 時

    // 翌月になれば数え直し
    expect(await consumeAt(user.userId, 'consultation', '2026-11-01T03:00:00Z')).toEqual({ allowed: true, remaining: 3, plan_key: planKey });
    expect(total(await counters(user.userId))).toBe(5);
  });

  it('日次と月次の両方: 残りは少ない方。どちらかに達したら拒否 (日次を先に見る)', async () => {
    const { user, planKey } = await createLimitedOrgUser('both', { daily: 2, monthly: 3 });

    // 10/10 に 2 回 (日次の上限に達する)。残りは min(日次 2-1, 月次 3-1) = 1、次は min(0, 1) = 0
    expect(await consumeAt(user.userId, 'consultation', '2026-10-10T03:00:00Z')).toEqual({ allowed: true, remaining: 1, plan_key: planKey });
    expect(await consumeAt(user.userId, 'consultation', '2026-10-10T04:00:00Z')).toEqual({ allowed: true, remaining: 0, plan_key: planKey });
    expect(await consumeAt(user.userId, 'consultation', '2026-10-10T05:00:00Z')).toMatchObject({ allowed: false, limit_kind: 'daily' });

    // 翌日 (JST) は日次が戻り、月次の残りは 3-2-1 = 0
    expect(await consumeAt(user.userId, 'consultation', '2026-10-11T03:00:00Z')).toEqual({ allowed: true, remaining: 0, plan_key: planKey });
    // その日はまだ日次に余裕があるが、月次の 3 回に達したので拒否 (理由は monthly)
    expect(await consumeAt(user.userId, 'consultation', '2026-10-11T04:00:00Z')).toMatchObject({ allowed: false, limit_kind: 'monthly', limit: 3 });
  });

  it('上限を引き上げれば、拒否されていたユーザーがまた使える。上限の行を消せば無制限に戻る', async () => {
    const { user, planKey } = await createLimitedOrgUser('raise', { daily: 1 });
    expect((await consume(user.userId, 'consultation')).allowed).toBe(true);
    expect((await consume(user.userId, 'consultation')).allowed).toBe(false);

    const raised = await srAdmin.from('ai_plan_limits').update({ daily_limit: 3 }).eq('plan_key', planKey);
    expect(raised.error).toBeNull();
    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: 1, plan_key: planKey });

    const removed = await srAdmin.from('ai_plan_limits').delete().eq('plan_key', planKey);
    expect(removed.error).toBeNull();
    expect(await consume(user.userId, 'consultation')).toEqual({ allowed: true, remaining: null, plan_key: planKey });
  });
});

// ---------------------------------------------------------------
// E. JST の日付と月の変わり目
// ---------------------------------------------------------------
describe('#1177 E. JST の 0 時 (= UTC の 15 時) で日と月が替わる', () => {
  it('日の境目: UTC 14:59:59.999 は JST のその日、UTC 15:00:00 は JST の翌日として数える', async () => {
    const user = await createUser('jst-day');

    await consumeAt(user.userId, 'consultation', '2026-10-08T00:00:00Z'); // JST 10/8 09:00
    await consumeAt(user.userId, 'consultation', '2026-10-08T14:59:59.999Z'); // JST 10/8 23:59:59.999
    await consumeAt(user.userId, 'consultation', '2026-10-08T15:00:00Z'); // JST 10/9 00:00:00
    await consumeAt(user.userId, 'consultation', '2026-10-07T15:00:00Z'); // JST 10/8 00:00:00 (UTC の暦日は 10/7)

    const rows = await counters(user.userId);
    expect(rows.map((r) => [r.usage_date, r.count])).toEqual([
      ['2026-10-08', 3],
      ['2026-10-09', 1],
    ]);
  });

  it('日次の上限: JST の 23:59 までは前日の分、0 時を過ぎれば数え直し', async () => {
    const { user } = await createLimitedOrgUser('jst-daily', { daily: 2 });

    expect((await consumeAt(user.userId, 'consultation', '2026-10-08T14:58:00Z')).allowed).toBe(true);
    expect((await consumeAt(user.userId, 'consultation', '2026-10-08T14:59:00Z')).allowed).toBe(true);
    const denied = await consumeAt(user.userId, 'consultation', '2026-10-08T14:59:59.999Z');
    expect(denied).toMatchObject({ allowed: false, limit_kind: 'daily', limit: 2 });
    expect(denied.reset_at).toBe('2026-10-08T15:00:00Z');

    // 0 時ちょうどから翌日
    expect(await consumeAt(user.userId, 'consultation', '2026-10-08T15:00:00Z')).toMatchObject({ allowed: true, remaining: 1 });
    expect(await consumeAt(user.userId, 'consultation', '2026-10-08T15:00:01Z')).toMatchObject({ allowed: true, remaining: 0 });
    expect(await consumeAt(user.userId, 'consultation', '2026-10-09T14:59:59Z')).toMatchObject({ allowed: false, limit_kind: 'daily' });
  });

  it('月の境目: JST の月末までは当月、翌月 1 日の 0 時 (= UTC の 15 時) から翌月として数える', async () => {
    const { user } = await createLimitedOrgUser('jst-month', { monthly: 2 });

    expect((await consumeAt(user.userId, 'consultation', '2026-10-31T14:58:00Z')).allowed).toBe(true); // JST 10/31 23:58
    expect((await consumeAt(user.userId, 'consultation', '2026-10-31T14:59:00Z')).allowed).toBe(true);
    const denied = await consumeAt(user.userId, 'consultation', '2026-10-31T14:59:59.999Z');
    expect(denied).toMatchObject({ allowed: false, limit_kind: 'monthly', limit: 2 });
    expect(denied.reset_at).toBe('2026-10-31T15:00:00Z');

    // 11/1 の JST 0 時 (UTC では 10/31 の 15 時) から翌月。10 月の分は数えない
    expect(await consumeAt(user.userId, 'consultation', '2026-10-31T15:00:00Z')).toMatchObject({ allowed: true, remaining: 1 });
    expect(await consumeAt(user.userId, 'consultation', '2026-11-30T14:59:59Z')).toMatchObject({ allowed: true, remaining: 0 });
    // 12/1 の JST 0 時で、11 月の分も数えなくなる
    expect(await consumeAt(user.userId, 'consultation', '2026-11-30T15:00:00Z')).toMatchObject({ allowed: true, remaining: 1 });

    const rows = await counters(user.userId);
    expect(rows.map((r) => [r.usage_date, r.count])).toEqual([
      ['2026-10-31', 2],
      ['2026-11-01', 1],
      ['2026-11-30', 1],
      ['2026-12-01', 1],
    ]);
  });

  it('年またぎ: 12/31 の JST 23:59 は当年、UTC 15:00 から翌年。うるう日も正しい', async () => {
    const user = await createUser('jst-year');
    await consumeAt(user.userId, 'consultation', '2026-12-31T14:59:59Z');
    await consumeAt(user.userId, 'consultation', '2026-12-31T15:00:00Z');
    await consumeAt(user.userId, 'consultation', '2028-02-28T15:00:00Z'); // JST 2028-02-29 (うるう日)
    await consumeAt(user.userId, 'consultation', '2028-02-29T15:00:00Z'); // JST 2028-03-01

    const rows = await counters(user.userId);
    expect(rows.map((r) => r.usage_date)).toEqual(['2026-12-31', '2027-01-01', '2028-02-29', '2028-03-01']);
  });
});

// ---------------------------------------------------------------
// F. 同時実行
// ---------------------------------------------------------------
describe('#1177 F. 同時実行', () => {
  it('無制限: 同時に 12 本数えても、加算が 1 つも失われない (機能別の行も正しい)', async () => {
    const user = await createUser('race-unlimited');
    const features = ['consultation', 'photo_analysis', 'menu_generation'];

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        srAdmin.rpc('consume_ai_quota', { p_user_id: user.userId, p_feature: features[i % features.length] }),
      ),
    );
    for (const { data, error } of results) {
      expect(error).toBeNull();
      expect(data).toEqual({ allowed: true, remaining: null, plan_key: 'free' });
    }

    const rows = await counters(user.userId);
    expect(total(rows)).toBe(12);
    expect(rows.map((r) => [r.feature, r.count])).toEqual([
      ['consultation', 4],
      ['menu_generation', 4],
      ['photo_analysis', 4],
    ]);
  });

  it('日次の上限 5: 機能をまたいで同時に 12 本来ても、許可はちょうど 5 本。数えるのも 5 回', async () => {
    const { user } = await createLimitedOrgUser('race-daily', { daily: 5 });
    const features = ['consultation', 'photo_analysis', 'menu_generation'];

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        srAdmin.rpc('consume_ai_quota', { p_user_id: user.userId, p_feature: features[i % features.length] }),
      ),
    );
    const outcomes = results.map(({ data, error }) => {
      expect(error).toBeNull();
      return data as QuotaResult;
    });

    expect(outcomes.filter((o) => o.allowed)).toHaveLength(5);
    const denied = outcomes.filter((o) => !o.allowed);
    expect(denied).toHaveLength(7);
    for (const o of denied) expect(o).toMatchObject({ remaining: 0, limit_kind: 'daily', limit: 5 });
    // 許可された呼び出しの「残り」は 4, 3, 2, 1, 0 が 1 回ずつ (直列化されている)
    expect(
      outcomes
        .filter((o) => o.allowed)
        .map((o) => o.remaining)
        .sort(),
    ).toEqual([0, 1, 2, 3, 4]);

    expect(total(await counters(user.userId))).toBe(5);
  });

  it('月次の上限 4: 同時に 10 本来ても、許可はちょうど 4 本', async () => {
    const { user } = await createLimitedOrgUser('race-monthly', { monthly: 4 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => srAdmin.rpc('consume_ai_quota', { p_user_id: user.userId, p_feature: 'consultation' })),
    );
    const outcomes = results.map(({ data, error }) => {
      expect(error).toBeNull();
      return data as QuotaResult;
    });
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(4);
    expect(outcomes.filter((o) => !o.allowed).every((o) => o.limit_kind === 'monthly')).toBe(true);
    expect(total(await counters(user.userId))).toBe(4);
  });

  it('別のユーザーは待ち合わない: 2 人が同時に上限いっぱいまで使っても、それぞれ上限どおり', async () => {
    const a = await createLimitedOrgUser('race-a', { daily: 3 });
    const b = await createLimitedOrgUser('race-b', { daily: 3 });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        srAdmin.rpc('consume_ai_quota', { p_user_id: (i % 2 === 0 ? a : b).user.userId, p_feature: 'consultation' }),
      ),
    );
    for (const { error } of results) expect(error).toBeNull();
    expect(total(await counters(a.user.userId))).toBe(3);
    expect(total(await counters(b.user.userId))).toBe(3);
  });
});

// ---------------------------------------------------------------
// G. クライアントからは使えない
// ---------------------------------------------------------------
describe('#1177 G. クライアント (anon / authenticated) の権限とアカウント削除', () => {
  it('anon / authenticated は関数を呼べない (42501)。他人のユーザー ID を渡しても同じ', async () => {
    const attacker = await createUser('attacker', { withJwt: true });
    const victim = await createUser('victim');

    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(attacker.jwt!)],
    ] as const) {
      const consumeVictim = await db.rpc('consume_ai_quota', { p_user_id: victim.userId, p_feature: 'consultation' });
      expect(consumeVictim.error?.code, `${label}: consume_ai_quota`).toBe('42501');

      const planVictim = await db.rpc('get_effective_plan', { p_user_id: victim.userId });
      expect(planVictim.error?.code, `${label}: get_effective_plan`).toBe('42501');

      const core = await db.rpc('consume_ai_quota_at', {
        p_user_id: victim.userId,
        p_feature: 'consultation',
        p_at: new Date().toISOString(),
      });
      expect(core.error, `${label}: consume_ai_quota_at`).not.toBeNull();
    }
    expect(await counters(victim.userId)).toEqual([]);
  });

  it('service_role でも本体 (consume_ai_quota_at) は API から呼べない', async () => {
    const user = await createUser('core-service');
    const { error } = await srAdmin.rpc('consume_ai_quota_at', {
      p_user_id: user.userId,
      p_feature: 'consultation',
      p_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
    expect(await counters(user.userId)).toEqual([]);
  });

  it('anon / authenticated は 2 つのテーブルを読めず、書けない (42501)', async () => {
    const attacker = await createUser('table-attacker', { withJwt: true });

    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(attacker.jwt!)],
    ] as const) {
      const readCounters = await db.from('ai_usage_counters').select('*');
      expect(readCounters.error?.code, `${label}: select ai_usage_counters`).toBe('42501');
      const readLimits = await db.from('ai_plan_limits').select('*');
      expect(readLimits.error?.code, `${label}: select ai_plan_limits`).toBe('42501');

      const writeCounters = await db
        .from('ai_usage_counters')
        .insert({ user_id: attacker.userId, usage_date: '2026-10-08', feature: 'consultation', count: 1 });
      expect(writeCounters.error?.code, `${label}: insert ai_usage_counters`).toBe('42501');
      const writeLimits = await db.from('ai_plan_limits').update({ daily_limit: 1 }).eq('plan_key', 'free');
      expect(writeLimits.error?.code, `${label}: update ai_plan_limits`).toBe('42501');
    }
  });

  it('アカウントを消せば、そのユーザーの計測も消える (外部キーの CASCADE)', async () => {
    const user = await createUser('cascade');
    await consume(user.userId, 'consultation');
    expect(await counters(user.userId)).toHaveLength(1);

    const { error } = await srAdmin.auth.admin.deleteUser(user.userId);
    expect(error).toBeNull();
    expect(await counters(user.userId)).toEqual([]);
    // もう消えたので、afterAll の片付けの対象から外す
    createdUserIds.splice(createdUserIds.indexOf(user.userId), 1);
  });
});
