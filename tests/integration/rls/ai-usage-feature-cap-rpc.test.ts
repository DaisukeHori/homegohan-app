/**
 * #1142 究極モードの 1 日の上限 (consume_ai_usage_capped / consume_ai_usage_capped_at) のテスト (実 DB)
 *
 * 20261014100000_ai_usage_feature_daily_cap.sql が足すもの:
 *   - consume_ai_usage_capped(p_user_id, p_feature, p_feature_daily_cap) -> jsonb
 *       その日 (JST) のその機能の回数が p_feature_daily_cap に達していれば、記録せずに {allowed:false, capped_feature}。
 *       達していなければ consume_ai_usage と同じ判定と記録 (1 日の上限。上限に数える機能の合計)
 *   - consume_ai_usage_capped_at(p_user_id, p_feature, p_feature_daily_cap, p_at)   本体 (時刻を引数で受ける。API からは呼べない)
 *
 * 確認すること:
 *   A. 定義と権限 (カタログ): SECURITY DEFINER・search_path が空。EXECUTE は consume_ai_usage_capped が service_role、本体は所有者だけ
 *   B. 2 回目の究極モードが止まる (上限 1 回): 1 回目は許可して 1 日の上限の合計にも 1 回入る。2 回目は capped_feature 付きの止めで記録しない
 *   C. JST の日付が変わると戻る: 上限に達した日の 23:59:59.999 は止め、翌日の 0:00 は許可
 *   D. 通常のモード (menu_generation など) は影響を受けない: 究極モードの上限に達していても、1 日の上限まで使える
 *   E. 1 日の上限にも数える: 1 日の上限に達していたら、究極モードの上限の内でも止める (capped_feature は付けない)
 *   F. 同時実行: 究極モードを同時に 5 本 → 許可はちょうど 1 本、記録は 1 回
 *   G. 数え戻し: refund_ai_usage を同じ機能名で呼ぶと、究極モードの上限と 1 日の上限の両方から戻る
 *   H. クライアント (anon / authenticated) は呼べない。引数の検証 (22023)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-usage-feature-cap-rpc.test.ts
 * 時刻を指定する本体とカタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。
 * 本番には接続しない。ai_daily_limits (free の行) は変えない。
 *
 * billing/03 §6.5 の後の前提: プラン × 機能の行 (ai_plan_feature_caps) のあるプラン (free・pro・家族の 2 つ) の究極モードは、引数の上限
 * (p_feature_daily_cap = 環境変数の既定) を使わず行の値で判定する (tests/integration/rls/ai-plan-feature-caps-rpc.test.ts)。
 * 引数の上限で判定するのは、行の無いプラン (組織の plan) だけになった。このファイルはその経路を確かめるので、利用者を
 * 行の無い組織のプラン (org_standard) の組織のメンバーにする。組織の plan の 1 日の上限は、billing/03 の migration が
 * free を 3 にする前の free の値 (10) を写した行 ((5a)。組織の利用者の上限は変えない)。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { createPlaceholderOrgOwner, deletePlaceholderOrgOwner } from '../helpers/org-owner';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ローカルスタックの Kong -> PostgREST は、使い回した最初の 1 回が 502 になることがある。データベースの結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの間隔 (ミリ秒。回数ごとに伸ばす) */
const GATEWAY_RETRY_BASE_MS = 150;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
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

/** postgres-meta の 502 をやり直す時間の上限 (ミリ秒。これより長くかかった 502 はやり直さない) */
const PG_QUERY_RETRY_WINDOW_MS = 1500;

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES && Date.now() - startedAt < PG_QUERY_RETRY_WINDOW_MS) {
      await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
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
/**
 * 利用者のプラン: プラン × 機能の行 (ai_plan_feature_caps) の無い組織のプラン (subscription_plans の plan_type = org。
 * 引数の上限 = 環境変数の既定で判定する経路。billing/03 §6.5)
 */
const ORG_PLAN = 'org_standard';
/**
 * 組織のプランの 1 日の上限: billing/03 の migration ((5a)) が、free を 3 にする前の free の値 (20261011020000_ai_daily_limits.sql の
 * 既定の行 = 10) を組織の plan の行に写したもの (組織の利用者の上限は変えない)
 */
const ORG_LIMIT = 10;
/** 究極モードの機能名 (_shared/ai-usage-core.ts の AI_ULTIMATE_MODE_FEATURE) */
const ULTIMATE = 'menu_generation_ultimate';
/** 究極モードの 1 日の上限の既定 (_shared/ai-usage-core.ts の AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT) */
const ULTIMATE_CAP = 1;
/** 同時実行の本数 (上限より多く) */
const CONCURRENT_CALLS = 5;

const createdUserIds: string[] = [];
let seq = 0;
/** 利用者を入れる組織 (beforeAll で作り、afterAll で利用者の後に消す) と、その持ち主 (owner_id は NOT NULL) */
let orgId: string | null = null;
let orgOwnerId: string | null = null;

beforeAll(async () => {
  orgOwnerId = await createPlaceholderOrgOwner(srAdmin, '1142');
  const { data, error } = await srAdmin
    .from('organizations')
    .insert({ name: `T1142 org ${TS}`, plan: ORG_PLAN, owner_id: orgOwnerId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  orgId = data.id as string;
});

interface TestUser {
  userId: string;
  jwt: string | null;
}

async function createUser(label: string, options: { withJwt?: boolean } = {}): Promise<TestUser> {
  const email = `rls-1142-${label}-${TS}-${++seq}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: userId, nickname: `ultimate-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // 組織のメンバーにする (get_effective_plan が ORG_PLAN を返す。service_role は特権列のガードに当たらない)
  const { error: orgError } = await srAdmin.from('user_profiles').update({ organization_id: orgId, org_role: 'member' }).eq('id', userId);
  if (orgError) throw new Error(`user_profiles.organization_id ${label}: ${orgError.message}`);
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
  capped_feature?: string;
}

async function consumeCapped(userId: string, feature: string = ULTIMATE, cap: number = ULTIMATE_CAP): Promise<ConsumeResult> {
  const { data, error } = await srAdmin.rpc('consume_ai_usage_capped', { p_user_id: userId, p_feature: feature, p_feature_daily_cap: cap });
  if (error) throw new Error(`consume_ai_usage_capped ${feature}: ${error.code} ${error.message}`);
  return data as ConsumeResult;
}

async function consume(userId: string, feature: string): Promise<ConsumeResult> {
  const { data, error } = await srAdmin.rpc('consume_ai_usage', { p_user_id: userId, p_feature: feature });
  if (error) throw new Error(`consume_ai_usage ${feature}: ${error.code} ${error.message}`);
  return data as ConsumeResult;
}

/** 時刻を指定して数える (本体を postgres-meta 経由で呼ぶ。API からは呼べない) */
async function consumeCappedAt(userId: string, at: string): Promise<ConsumeResult> {
  const rows = await pgQuery<{ result: ConsumeResult }>(
    `SELECT public.consume_ai_usage_capped_at('${userId}'::uuid, '${ULTIMATE}', ${ULTIMATE_CAP}, '${at}'::timestamptz) AS result`,
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
const countOf = async (userId: string, feature: string) => (await counters(userId)).find((r) => r.feature === feature)?.count ?? 0;

afterAll(async () => {
  const failures: string[] = [];
  // ユーザーを消すと、記録 (ai_usage_counters)・プロフィールは CASCADE で消える
  for (const id of createdUserIds) {
    const { error } = await srAdmin.auth.admin.deleteUser(id);
    if (error) failures.push(`auth.users ${id}: ${error.message}`);
  }
  // 組織 → 持ち主の順 (organizations.owner_id は ON DELETE RESTRICT)
  if (orgId) {
    const { error } = await srAdmin.from('organizations').delete().eq('id', orgId);
    if (error) failures.push(`organizations ${orgId}: ${error.message}`);
  }
  if (orgOwnerId) {
    try {
      await deletePlaceholderOrgOwner(srAdmin, orgOwnerId);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length > 0) throw new Error(`テストが作った行を消せませんでした: ${failures.join(' / ')}`);
}, 120_000);

// ---------------------------------------------------------------
// A. 定義と権限
// ---------------------------------------------------------------
describe('#1142 A. 関数の定義と権限 (カタログ)', () => {
  it('2 本の関数は SECURITY DEFINER・search_path が空・VOLATILE。EXECUTE は consume_ai_usage_capped が service_role、本体は所有者だけ', async () => {
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
         AND p.proname IN ('consume_ai_usage_capped', 'consume_ai_usage_capped_at')
       ORDER BY p.proname
    `);
    expect(rows).toEqual([
      {
        proname: 'consume_ai_usage_capped',
        identity_args: 'p_user_id uuid, p_feature text, p_feature_daily_cap integer',
        result: 'jsonb',
        prosecdef: true,
        provolatile: 'v',
        proconfig: ['search_path=""'],
        executors: ['postgres', 'service_role'],
      },
      {
        proname: 'consume_ai_usage_capped_at',
        identity_args: 'p_user_id uuid, p_feature text, p_feature_daily_cap integer, p_at timestamp with time zone',
        result: 'jsonb',
        prosecdef: true,
        provolatile: 'v',
        proconfig: ['search_path=""'],
        executors: ['postgres'],
      },
    ]);
  });
});

// ---------------------------------------------------------------
// B. 2 回目の究極モードが止まる
// ---------------------------------------------------------------
describe('#1142 B. 行の無いプラン (組織のプラン) の究極モードは 1 日 1 回まで (引数の上限)', () => {
  it('1 回目は許可して記録する (1 日の上限の合計にも 1 回入る)。2 回目は capped_feature 付きの止めで、記録しない', async () => {
    const user = await createUser('second');
    const first = await consumeCapped(user.userId);
    expect(first).toMatchObject({ allowed: true, metered: true, plan: ORG_PLAN, limit: ORG_LIMIT, used: 1 });
    expect(first.capped_feature).toBeUndefined();

    const second = await consumeCapped(user.userId);
    expect(second).toMatchObject({ allowed: false, metered: true, limit: ULTIMATE_CAP, used: 1, capped_feature: ULTIMATE });
    expect(second.usage_date).toBe(first.usage_date);

    // 止めた呼び出しは記録しない (究極モードの行は 1 のまま、合計も 1)
    expect(await counters(user.userId)).toEqual([{ usage_date: first.usage_date, feature: ULTIMATE, count: 1 }]);
    // 1 日の上限の合計にも、同じ 1 回が入っている (通常の操作の used が 2 になる)
    expect(await consume(user.userId, 'menu_generation')).toMatchObject({ allowed: true, used: 2 });
  });

  it('上限の値は引数で渡す: 2 なら 2 回目まで許可、3 回目で止め。0 なら 1 回目から止め', async () => {
    const user = await createUser('cap-arg');
    expect((await consumeCapped(user.userId, ULTIMATE, 2)).allowed).toBe(true);
    expect((await consumeCapped(user.userId, ULTIMATE, 2)).allowed).toBe(true);
    expect(await consumeCapped(user.userId, ULTIMATE, 2)).toMatchObject({ allowed: false, limit: 2, used: 2, capped_feature: ULTIMATE });

    const other = await createUser('cap-zero');
    expect(await consumeCapped(other.userId, ULTIMATE, 0)).toMatchObject({ allowed: false, limit: 0, used: 0, capped_feature: ULTIMATE });
    expect(await counters(other.userId)).toEqual([]);
  });
});

// ---------------------------------------------------------------
// C. JST の日の境目
// ---------------------------------------------------------------
describe('#1142 C. JST の 0 時 (= UTC の 15 時) で究極モードの上限が戻る', () => {
  it('上限に達した日の 23:59:59.999 は止め、翌日の 0:00 は許可。usage_date は JST の暦日', async () => {
    const user = await createUser('jst');
    expect(await consumeCappedAt(user.userId, '2026-10-11T00:00:00Z')).toMatchObject({ allowed: true, usage_date: '2026-10-11' }); // JST 10/11 09:00
    expect(await consumeCappedAt(user.userId, '2026-10-11T14:59:59.999Z')).toMatchObject({
      allowed: false,
      usage_date: '2026-10-11',
      capped_feature: ULTIMATE,
    }); // JST 10/11 23:59:59.999
    // UTC の暦日は 10/10 だが、JST では 10/11 の 0:00 (同じ日に数える)
    expect(await consumeCappedAt(user.userId, '2026-10-10T15:00:00Z')).toMatchObject({ allowed: false, usage_date: '2026-10-11' });

    expect(await consumeCappedAt(user.userId, '2026-10-11T15:00:00Z')).toMatchObject({ allowed: true, usage_date: '2026-10-12', used: 1 }); // JST 10/12 00:00
    expect((await counters(user.userId)).map((r) => [r.usage_date, r.feature, r.count])).toEqual([
      ['2026-10-11', ULTIMATE, 1],
      ['2026-10-12', ULTIMATE, 1],
    ]);
  });
});

// ---------------------------------------------------------------
// D. 通常のモードは影響を受けない
// ---------------------------------------------------------------
describe('#1142 D. 通常のモードは影響を受けない', () => {
  it('究極モードの上限に達していても、通常の献立生成とほかの機能は 1 日の上限 (合計) まで使える', async () => {
    const user = await createUser('normal');
    expect((await consumeCapped(user.userId)).allowed).toBe(true);
    expect((await consumeCapped(user.userId)).allowed).toBe(false);

    // 究極モードの 1 回を含めて、1 日の上限 (合計) まで
    for (let used = 2; used <= ORG_LIMIT; used++) {
      expect(await consume(user.userId, used % 2 === 0 ? 'menu_generation' : 'consultation'), `${used} 回目`).toMatchObject({ allowed: true, used });
    }
    expect(await consume(user.userId, 'menu_generation')).toMatchObject({ allowed: false, limit: ORG_LIMIT, used: ORG_LIMIT });
    expect(totalOf(await counters(user.userId))).toBe(ORG_LIMIT);
  });
});

// ---------------------------------------------------------------
// E. 1 日の上限にも数える
// ---------------------------------------------------------------
describe('#1142 E. 1 日の上限に達していたら、究極モードの上限の内でも止める', () => {
  it('1 日の上限を使い切ったあとの究極モードは、1 日の上限の止め (capped_feature なし)。記録しない', async () => {
    const user = await createUser('total');
    for (let i = 0; i < ORG_LIMIT; i++) expect((await consume(user.userId, 'photo_analysis')).allowed).toBe(true);

    const result = await consumeCapped(user.userId);
    expect(result).toMatchObject({ allowed: false, metered: true, plan: ORG_PLAN, limit: ORG_LIMIT, used: ORG_LIMIT });
    expect(result.capped_feature).toBeUndefined();
    expect(await countOf(user.userId, ULTIMATE)).toBe(0);
  });
});

// ---------------------------------------------------------------
// F. 同時実行
// ---------------------------------------------------------------
describe('#1142 F. 同時実行', () => {
  it(`究極モードを同時に ${CONCURRENT_CALLS} 本: 許可はちょうど ${ULTIMATE_CAP} 本、記録は ${ULTIMATE_CAP} 回 (上限を超えない)`, async () => {
    const user = await createUser('race');
    const results = await Promise.all(Array.from({ length: CONCURRENT_CALLS }, () => consumeCapped(user.userId)));
    expect(results.filter((r) => r.allowed)).toHaveLength(ULTIMATE_CAP);
    expect(results.filter((r) => !r.allowed && r.capped_feature === ULTIMATE)).toHaveLength(CONCURRENT_CALLS - ULTIMATE_CAP);
    expect(await countOf(user.userId, ULTIMATE)).toBe(ULTIMATE_CAP);
  });
});

// ---------------------------------------------------------------
// G. 数え戻し
// ---------------------------------------------------------------
describe('#1142 G. 数え戻し (refund_ai_usage)', () => {
  it('同じ機能名で戻すと、究極モードの上限と 1 日の上限の両方から戻る (もう一度使える)', async () => {
    const user = await createUser('refund');
    const first = await consumeCapped(user.userId);
    expect(first.allowed).toBe(true);
    const { data, error } = await srAdmin.rpc('refund_ai_usage', { p_user_id: user.userId, p_feature: ULTIMATE, p_usage_date: first.usage_date });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(await countOf(user.userId, ULTIMATE)).toBe(0);
    expect(await consumeCapped(user.userId)).toMatchObject({ allowed: true, used: 1 });
  });
});

// ---------------------------------------------------------------
// H. 権限・引数の検証
// ---------------------------------------------------------------
describe('#1142 H. クライアントの権限と引数の検証', () => {
  it('anon / authenticated は consume_ai_usage_capped も本体も呼べない。service_role でも本体は API から呼べない', async () => {
    const attacker = await createUser('attacker', { withJwt: true });
    const victim = await createUser('victim');
    for (const [label, db] of [
      ['anon', anon()],
      ['authenticated', asUser(attacker.jwt!)],
    ] as const) {
      expect(
        (await db.rpc('consume_ai_usage_capped', { p_user_id: victim.userId, p_feature: ULTIMATE, p_feature_daily_cap: ULTIMATE_CAP })).error?.code,
        `${label}: consume_ai_usage_capped`,
      ).toBe('42501');
      expect(
        (
          await db.rpc('consume_ai_usage_capped_at', {
            p_user_id: victim.userId,
            p_feature: ULTIMATE,
            p_feature_daily_cap: ULTIMATE_CAP,
            p_at: new Date().toISOString(),
          })
        ).error,
        `${label}: consume_ai_usage_capped_at`,
      ).not.toBeNull();
    }
    expect(
      (
        await srAdmin.rpc('consume_ai_usage_capped_at', {
          p_user_id: victim.userId,
          p_feature: ULTIMATE,
          p_feature_daily_cap: ULTIMATE_CAP,
          p_at: new Date().toISOString(),
        })
      ).error,
    ).not.toBeNull();
    expect(await counters(victim.userId)).toEqual([]);
  });

  it('機能名の形式・NULL のユーザー・負や NULL の上限は 22023。数えない', async () => {
    const user = await createUser('args');
    const call = (args: Record<string, unknown>) =>
      srAdmin.rpc('consume_ai_usage_capped', { p_user_id: user.userId, p_feature: ULTIMATE, p_feature_daily_cap: ULTIMATE_CAP, ...args });
    for (const feature of ['Bad-Feature', '1abc', '']) expect((await call({ p_feature: feature })).error?.code, feature).toBe('22023');
    expect((await call({ p_user_id: null })).error?.code).toBe('22023');
    expect((await call({ p_feature_daily_cap: -1 })).error?.code).toBe('22023');
    expect((await call({ p_feature_daily_cap: null })).error?.code).toBe('22023');
    expect(await counters(user.userId)).toEqual([]);
  });
});
