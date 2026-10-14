/**
 * #1312 買い物リストの再生成 (replace_active_shopping_list) と「レシピから追加」(get_or_create_active_shopping_list) の
 * 競合・原子性・権限の回帰テスト
 *
 * 修正前の問題:
 *   再生成 (Edge Function regenerate-shopping-list-v2。service role) は、PostgREST への別々の HTTP 呼び出しで
 *     1) 今のアクティブなリストを archived にする  2) 新しいアクティブなリストを INSERT する
 *   と処理していた。その間に POST /api/shopping-list/add-recipe が「アクティブなリストが無い」と判定して自分のリストを
 *   INSERT すると、再生成の 2) が部分ユニーク索引 idx_shopping_lists_active_unique (user_id) WHERE status = 'active' の
 *   23505 で失敗し、再生成のリクエストが failed になった (add-recipe 側は 23505 を受けたら再取得するので失敗しない)。
 *
 * 修正後 (20261008120000_shopping_list_active_lock.sql):
 *   - replace_active_shopping_list (service_role のみ): ユーザーごとの advisory lock を取り、アーカイブと INSERT を
 *     1 トランザクションで行う
 *   - get_or_create_active_shopping_list (authenticated / service_role): あれば返し、無ければ同じ advisory lock を取って
 *     もう一度確かめてから作る。p_user_id は呼び出した本人でなければ 42501 (FORBIDDEN)
 *   - どちらも、ロックを取らない書き込み (デプロイ途中の古い add-recipe など) が先にコミットしても 23505 にならない
 *
 * 競合の再現のしかた (タイミングに頼らない):
 *   postgres-meta (/pg/query) で「トランザクションを開いたまま pg_sleep する」接続を 1 本作り (= ロックを持った状態を作り)、
 *   pg_sleep に入ったのを pg_stat_activity で確かめてから、もう一方の処理を本物の経路 (PostgREST) で呼ぶ。
 *   待たされること (ロックが効いていること) と、待ったあとに失敗せず正しい結果になることを確かめる。
 *   これとは別に、20 回の反復で再生成と add-recipe を一斉に走らせる素直な並行テストも置く (C-7)。再生成は Edge Function が
 *   呼ぶ共有モジュール (supabase/functions/_shared/shopping-list-replace.ts)、add-recipe は route が呼ぶ
 *   getOrCreateActiveShoppingList を、そのまま使う。
 *
 * 修正前の動きの再現 (red):
 *   SHOPPING_LIST_RACE_LEGACY=1 を付けると、C-7 の再生成と add-recipe を、修正前と同じ手順
 *   (supabase-js でアーカイブ -> INSERT、SELECT -> INSERT) に差し替える。再生成の INSERT が 23505 で失敗する反復が出る。
 *   D-1 は、その 23505 が起きる順序を決定的に作り、前提 (部分ユニーク索引があること) を固定する。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/shopping-list-active-lock.test.ts
 *
 * 関数定義・権限の確認 (has_function_privilege など) と、ロックを持った状態の再現用の接続は、ローカルスタックの
 * postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
import { getOrCreateActiveShoppingList } from '../../../src/lib/shopping-list/active-list';
import { replaceActiveShoppingList } from '../../../supabase/functions/_shared/shopping-list-replace';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

/** 修正前の手順 (アーカイブ -> INSERT、SELECT -> INSERT) で C-7 を実行する (red の再現用。CI では使わない) */
const LEGACY = process.env.SHOPPING_LIST_RACE_LEGACY === '1';

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

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json() };
}

/** カタログの確認やロックの観測に使う (読み取りだけ) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-slist-lock-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `slist-lock-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

interface ListRow {
  id: string;
  user_id: string;
  title: string | null;
  start_date: string;
  end_date: string;
  status: string | null;
  servings_config: unknown;
  created_at: string;
  updated_at: string;
}

async function listsOf(userId: string): Promise<ListRow[]> {
  const { data, error } = await srAdmin
    .from('shopping_lists')
    .select('id, user_id, title, start_date, end_date, status, servings_config, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listsOf: ${error.message}`);
  return (data ?? []) as ListRow[];
}

async function activeListsOf(userId: string): Promise<ListRow[]> {
  return (await listsOf(userId)).filter((l) => l.status === 'active');
}

async function itemNamesOf(listId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('shopping_list_items').select('item_name').eq('shopping_list_id', listId);
  if (error) throw new Error(`itemNamesOf: ${error.message}`);
  return ((data ?? []) as Array<{ item_name: string }>).map((i) => i.item_name).sort();
}

async function addItem(api: SupabaseClient, listId: string, name: string): Promise<void> {
  const { error } = await api
    .from('shopping_list_items')
    .insert({ shopping_list_id: listId, item_name: name, normalized_name: name, source: 'manual', category: 'その他' });
  if (error) throw error;
}

async function deleteListsOf(userId: string): Promise<void> {
  // 食材は shopping_lists の ON DELETE CASCADE で一緒に消える
  const { error } = await srAdmin.from('shopping_lists').delete().eq('user_id', userId);
  if (error) throw new Error(`deleteListsOf: ${error.message}`);
}

const DAY1 = '2026-10-01';
const DAY7 = '2026-10-07';

// ---------------------------------------------------------------
// 修正前の手順 (D-1 と、SHOPPING_LIST_RACE_LEGACY=1 のときの C-7 で使う)。この migration の関数に依存しない
// ---------------------------------------------------------------

/** 修正前の再生成 1): 今のアクティブなリストをアーカイブする (Edge Function は結果のエラーを見ていなかった) */
async function legacyArchive(userId: string) {
  return srAdmin
    .from('shopping_lists')
    .update({ status: 'archived', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('status', 'active');
}

/** 修正前の再生成 2): 新しいアクティブなリストを INSERT する */
async function legacyInsert(userId: string) {
  return srAdmin
    .from('shopping_lists')
    .insert({
      user_id: userId,
      start_date: '2026-10-08',
      end_date: '2026-10-14',
      status: 'active',
      servings_config: null,
      title: 'regen-list',
    })
    .select('id')
    .single();
}

/** 修正前の再生成: 別々の HTTP 呼び出しで 1) -> 2) */
async function legacyRegenerate(userId: string): Promise<string> {
  await legacyArchive(userId);
  const { data, error } = await legacyInsert(userId);
  if (error) throw error;
  return (data as { id: string }).id;
}

/** 修正前の add-recipe のリスト取得 (#1214: SELECT -> 無ければ INSERT -> 23505 なら再取得) */
async function legacyGetOrCreate(api: SupabaseClient, userId: string): Promise<{ id: string }> {
  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: existing, error: selectError } = await api
      .from('shopping_lists')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (selectError) throw selectError;
    if (existing) return { id: (existing as { id: string }).id };
    const { data: created, error: insertError } = await api
      .from('shopping_lists')
      .insert({ user_id: userId, status: 'active', title: 'add-recipe-list', start_date: DAY1, end_date: DAY7 })
      .select('id')
      .single();
    if (!insertError) return { id: (created as { id: string }).id };
    if ((insertError as { code?: string }).code !== '23505') throw insertError;
    lastConflict = insertError;
  }
  throw lastConflict;
}

/** 再生成が呼ぶ RPC (service role) */
function replaceList(
  userId: string,
  over: { title?: string | null; start?: string | null; end?: string | null; servings?: unknown } = {},
) {
  return srAdmin.rpc('replace_active_shopping_list', {
    p_user_id: userId,
    p_title: over.title === undefined ? 'regen-list' : over.title,
    p_start_date: over.start === undefined ? '2026-10-08' : over.start,
    p_end_date: over.end === undefined ? '2026-10-14' : over.end,
    p_servings_config: over.servings === undefined ? null : over.servings,
  });
}

/** add-recipe が呼ぶ RPC を、任意のクライアントで直接呼ぶ */
function getOrCreate(api: SupabaseClient, userId: string, title = 'add-recipe-list') {
  return api.rpc('get_or_create_active_shopping_list', {
    p_user_id: userId,
    p_title: title,
    p_start_date: DAY1,
    p_end_date: DAY7,
  });
}

// ---------------------------------------------------------------
// ロックを持った状態の再現
// ---------------------------------------------------------------
const HOLD_SECONDS = 6;
/** 待たされていることを確かめるまでの時間。HOLD_SECONDS より十分短くする */
const PENDING_CHECK_MS = 1500;

interface Outcome {
  ok: boolean;
  message: string | null;
}

interface Holder {
  /** statements の実行が済み、pg_sleep に入った (= ロックやコミット前の行を持ったまま開いている) と解決する */
  sleeping: Promise<void>;
  /** トランザクションが終わった (コミットされた) と解決する */
  done: Promise<Outcome>;
  isDone: () => boolean;
}

/** 別の接続で statements を実行し、そのあと holdSeconds 秒 pg_sleep してトランザクションを開いたままにする */
function holdOpen(statements: string, holdSeconds = HOLD_SECONDS): Holder {
  const marker = `slist-holder-${randomBytes(6).toString('hex')}`;
  const sql = `/* ${marker} */
    ${statements}
    SELECT pg_sleep(${holdSeconds});
    SELECT 'held' AS result;`;

  const state: { outcome: Outcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): Outcome => {
    const body = res.body as { error?: unknown } | null;
    const outcome: Outcome = res.ok
      ? { ok: true, message: null }
      : { ok: false, message: typeof body?.error === 'string' ? body.error : JSON.stringify(body) };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (state.outcome) {
        // pg_sleep に入る前に終わった = statements が失敗している (理由を示して止める)
        throw new Error(`先に開いた接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      }
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(50);
    }
    throw new Error('先に開いた接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { sleeping, done, isDone: () => state.outcome !== null };
}

/** 利用者本人になりすまして SQL を実行する (PostgREST が JWT から作る状態と同じ) */
const asUserSql = (userId: string) => `
    SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: userId, role: 'authenticated' })}', true);
    SET LOCAL ROLE authenticated;`;

/** service_role になりすまして SQL を実行する */
const asServiceRoleSql = `
    SELECT set_config('request.jwt.claims', '${JSON.stringify({ role: 'service_role' })}', true);
    SET LOCAL ROLE service_role;`;

/** そのユーザーの買い物リストの advisory lock を、関数を通さずに直接取る (キーが関数と同じであることの確認用) */
const takeLockSql = (userId: string) =>
  `SELECT pg_advisory_xact_lock(hashtextextended('shopping_lists:${userId}', 0));`;

/** 完了するまで結果を待たずに、完了したかどうかだけを観測できるようにする */
function track<T>(pending: PromiseLike<T>) {
  const state = { settled: false };
  const promise = Promise.resolve(pending).then((value) => {
    state.settled = true;
    return value;
  });
  return { state, promise };
}

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  for (const id of createdUserIds) {
    await srAdmin.from('shopping_lists').delete().eq('user_id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

// ---------------------------------------------------------------
// A: 権限
// ---------------------------------------------------------------
describe('#1312 A: 関数の属性と権限', () => {
  it('A-1: SECURITY DEFINER・search_path 固定・所有者 postgres。replace は service_role のみ、get_or_create は authenticated と service_role', async () => {
    const rows = await pgQuery<{
      name: string;
      sig: string;
      secdef: boolean;
      config: string[] | null;
      owner: string;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
      public_exec: boolean;
    }>(`
      SELECT p.proname AS name,
             p.oid::regprocedure::text AS sig,
             p.prosecdef AS secdef,
             p.proconfig AS config,
             pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0
             ) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('replace_active_shopping_list', 'get_or_create_active_shopping_list')
      ORDER BY 1
    `);

    expect(rows.map((r) => r.sig)).toEqual([
      'get_or_create_active_shopping_list(uuid,text,date,date)',
      'replace_active_shopping_list(uuid,text,date,date,jsonb)',
    ]);
    for (const row of rows) {
      expect(row.secdef).toBe(true);
      expect(row.config).toEqual(['search_path=""']);
      expect(row.owner).toBe('postgres');
      expect(row.anon_exec).toBe(false);
      expect(row.public_exec).toBe(false);
      expect(row.sr_exec).toBe(true);
    }
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.get_or_create_active_shopping_list.auth_exec).toBe(true);
    expect(byName.replace_active_shopping_list.auth_exec).toBe(false);
  });

  it('A-2: anon は 2 つの RPC を呼べない (42501)', async () => {
    const user = await createUser('a2');

    const replace = await anon().rpc('replace_active_shopping_list', {
      p_user_id: user.id,
      p_title: 'x',
      p_start_date: DAY1,
      p_end_date: DAY7,
      p_servings_config: null,
    });
    const get = await getOrCreate(anon(), user.id);

    expect(replace.error?.code).toBe('42501');
    expect(get.error?.code).toBe('42501');
    expect(await listsOf(user.id)).toHaveLength(0);
  });

  it('A-3: authenticated は replace_active_shopping_list を呼べない (自分の user_id でも 42501)。何も変わらない', async () => {
    const user = await createUser('a3');
    const own = await getOrCreate(asUser(user.jwt), user.id, 'own-list');
    expect(own.error).toBeNull();

    const res = await asUser(user.jwt).rpc('replace_active_shopping_list', {
      p_user_id: user.id,
      p_title: 'hijack',
      p_start_date: DAY1,
      p_end_date: DAY7,
      p_servings_config: null,
    });

    expect(res.data).toBeNull();
    expect(res.error?.code).toBe('42501');
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: own.data, title: 'own-list', status: 'active' });
  });

  it('A-4: get_or_create は、本人以外の user_id を 42501 (FORBIDDEN) で拒否し、何も作らず、他人のリストの id も返さない', async () => {
    const attacker = await createUser('a4-attacker');
    const victim = await createUser('a4-victim');
    const victimList = await getOrCreate(asUser(victim.jwt), victim.id, 'victim-list');
    const noListVictim = await createUser('a4-victim-nolist');

    const readsExisting = await getOrCreate(asUser(attacker.jwt), victim.id);
    const createsForOther = await getOrCreate(asUser(attacker.jwt), noListVictim.id);

    for (const res of [readsExisting, createsForOther]) {
      expect(res.data).toBeNull();
      expect(res.error?.code).toBe('42501');
      expect(res.error?.message).toBe('FORBIDDEN');
    }
    expect(await listsOf(attacker.id)).toHaveLength(0);
    expect(await listsOf(noListVictim.id)).toHaveLength(0);
    const victimLists = await listsOf(victim.id);
    expect(victimLists).toHaveLength(1);
    expect(victimLists[0]).toMatchObject({ id: victimList.data, title: 'victim-list', status: 'active' });
  });

  it('A-5: get_or_create は、本人なら呼べ、service_role は任意のユーザーを指定できる', async () => {
    const user = await createUser('a5');
    const other = await createUser('a5-other');

    const own = await getOrCreate(asUser(user.jwt), user.id, 'own');
    const viaServiceRole = await getOrCreate(srAdmin, other.id, 'by-service-role');

    expect(own.error).toBeNull();
    expect(viaServiceRole.error).toBeNull();
    expect((await activeListsOf(user.id)).map((l) => l.id)).toEqual([own.data]);
    expect((await activeListsOf(other.id)).map((l) => l.id)).toEqual([viaServiceRole.data]);
  });

  it('A-6: user_id が NULL なら、利用者は 42501、service_role は 22023 (何も作らない)', async () => {
    const user = await createUser('a6');

    const asAuthenticated = await asUser(user.jwt).rpc('get_or_create_active_shopping_list', {
      p_user_id: null,
      p_title: 'x',
      p_start_date: DAY1,
      p_end_date: DAY7,
    });
    const asServiceRole = await srAdmin.rpc('get_or_create_active_shopping_list', {
      p_user_id: null,
      p_title: 'x',
      p_start_date: DAY1,
      p_end_date: DAY7,
    });
    const replaceNull = await replaceList(null as unknown as string);

    expect(asAuthenticated.error?.code).toBe('42501');
    expect(asServiceRole.error?.code).toBe('22023');
    expect(replaceNull.error?.code).toBe('22023');
    expect(await listsOf(user.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// B: 振る舞い (順番に呼ぶ)
// ---------------------------------------------------------------
describe('#1312 B: 振る舞い', () => {
  it('B-1: replace は、リストが無いユーザーに新しいアクティブなリストを作り、id を返す (人数設定も保存する)', async () => {
    const user = await createUser('b1');
    const servings = { default: 3, byDayMeal: { monday: { dinner: 2 } } };

    const res = await replaceList(user.id, { title: 'my-regen', start: '2026-10-08', end: '2026-10-14', servings });

    expect(res.error).toBeNull();
    expect(typeof res.data).toBe('string');
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      id: res.data,
      user_id: user.id,
      title: 'my-regen',
      start_date: '2026-10-08',
      end_date: '2026-10-14',
      status: 'active',
      servings_config: servings,
    });
  });

  it('B-2: replace は、今のアクティブなリストをアーカイブして新しいリストを作る (食材は旧リストに残り、アクティブは 1 つ)', async () => {
    const user = await createUser('b2');
    const first = await replaceList(user.id, { title: 'first' });
    const firstId = first.data as string;
    await addItem(srAdmin, firstId, '牛乳');
    await addItem(srAdmin, firstId, '卵');
    const before = (await listsOf(user.id))[0];

    const second = await replaceList(user.id, { title: 'second' });

    expect(second.error).toBeNull();
    expect(second.data).not.toBe(firstId);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(2);
    const active = lists.filter((l) => l.status === 'active');
    expect(active.map((l) => l.id)).toEqual([second.data]);
    const archived = lists.find((l) => l.id === firstId)!;
    expect(archived.status).toBe('archived');
    expect(new Date(archived.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
    expect(await itemNamesOf(firstId)).toEqual(['卵', '牛乳']);
    expect(await itemNamesOf(second.data as string)).toEqual([]);
  });

  it('B-3: replace は、アーカイブ済みのリストしか無いユーザーでも新しいリストを作り、他のユーザーのリストには触れない', async () => {
    const user = await createUser('b3');
    const other = await createUser('b3-other');
    const otherList = await getOrCreate(srAdmin, other.id, 'other-list');
    await replaceList(user.id, { title: 'old' });
    await replaceList(user.id, { title: 'older' }); // 1 つ前のリストは archived になる

    const res = await replaceList(user.id, { title: 'newest' });

    expect(res.error).toBeNull();
    expect((await listsOf(user.id)).map((l) => l.status).sort()).toEqual(['active', 'archived', 'archived']);
    expect((await activeListsOf(user.id)).map((l) => l.title)).toEqual(['newest']);
    const otherLists = await listsOf(other.id);
    expect(otherLists).toHaveLength(1);
    expect(otherLists[0]).toMatchObject({ id: otherList.data, status: 'active', title: 'other-list' });
  });

  it('B-4: replace は、引数が不正 (日付が無い) なら 22023 で、今のアクティブなリストをアーカイブしない', async () => {
    const user = await createUser('b4');
    const first = await replaceList(user.id, { title: 'keep-me' });

    const noEnd = await replaceList(user.id, { end: null });
    const noStart = await replaceList(user.id, { start: null });

    expect(noEnd.error?.code).toBe('22023');
    expect(noStart.error?.code).toBe('22023');
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: first.data, title: 'keep-me', status: 'active' });
  });

  it('B-5: get_or_create は、リストが無ければ作り、あれば同じ id を返す (title・日付は最初のものが残る)', async () => {
    const user = await createUser('b5');
    const api = asUser(user.jwt);

    const created = await getOrCreate(api, user.id, 'first-title');
    const again = await getOrCreate(api, user.id, 'second-title');

    expect(created.error).toBeNull();
    expect(again.error).toBeNull();
    expect(again.data).toBe(created.data);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      id: created.data,
      title: 'first-title',
      start_date: DAY1,
      end_date: DAY7,
      status: 'active',
      user_id: user.id,
    });
  });

  it('B-6: get_or_create は、アーカイブ済みのリストしか無ければ、新しいアクティブなリストを作る', async () => {
    const user = await createUser('b6');
    const old = await replaceList(user.id, { title: 'old' });
    await replaceList(user.id, { title: 'current' });
    await srAdmin.from('shopping_lists').update({ status: 'archived' }).eq('user_id', user.id).eq('status', 'active');
    expect(await activeListsOf(user.id)).toHaveLength(0);

    const res = await getOrCreate(asUser(user.jwt), user.id, 'fresh');

    expect(res.error).toBeNull();
    expect(res.data).not.toBe(old.data);
    expect((await activeListsOf(user.id)).map((l) => [l.id, l.title])).toEqual([[res.data, 'fresh']]);
  });

  it('B-7: 共通ヘルパー getOrCreateActiveShoppingList は、利用者の JWT でこの関数を呼び、リストの id を返す', async () => {
    const user = await createUser('b7');

    const first = await getOrCreateActiveShoppingList(asUser(user.jwt), user.id);
    const second = await getOrCreateActiveShoppingList(asUser(user.jwt), user.id);

    expect(second.id).toBe(first.id);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: first.id, title: '買い物リスト', status: 'active' });
    // 今日から 7 日間 (今日を含めて +6 日)
    const days = Math.round(
      (Date.parse(`${lists[0].end_date}T00:00:00Z`) - Date.parse(`${lists[0].start_date}T00:00:00Z`)) / 86_400_000,
    );
    expect(days).toBe(6);
  });

  it('B-8: Edge Function の共有モジュール replaceActiveShoppingList は、本物の DB 関数を呼び、title を「開始〜終了の買い物リスト」にして人数設定を保存し、作ったリストの id を返す', async () => {
    const user = await createUser('b8');
    const servings = { default: 2, byDayMeal: { monday: { dinner: 3 } } };

    const first = await replaceActiveShoppingList(srAdmin, {
      userId: user.id,
      startDate: '2026-10-08',
      endDate: '2026-10-14',
      servingsConfig: servings,
    });
    // 人数設定を渡さない (undefined) 場合は null で保存される
    const second = await replaceActiveShoppingList(srAdmin, {
      userId: user.id,
      startDate: '2026-10-15',
      endDate: '2026-10-21',
    });

    expect(second).not.toBe(first);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(2);
    expect(lists.find((l) => l.id === first)).toMatchObject({
      status: 'archived',
      title: '2026-10-08〜2026-10-14の買い物リスト',
      servings_config: servings,
    });
    expect(lists.find((l) => l.id === second)).toMatchObject({
      status: 'active',
      title: '2026-10-15〜2026-10-21の買い物リスト',
      start_date: '2026-10-15',
      end_date: '2026-10-21',
      servings_config: null,
    });
  });

  it('B-9: 日付が不正で失敗した場合は、そのエラーがそのまま投げられ、今のアクティブなリストはアーカイブされない (旧手順は先にアーカイブしていた)', async () => {
    const user = await createUser('b9');
    const keep = await replaceActiveShoppingList(srAdmin, {
      userId: user.id,
      startDate: '2026-10-08',
      endDate: '2026-10-14',
    });

    const failure = await replaceActiveShoppingList(srAdmin, {
      userId: user.id,
      startDate: 'not-a-date',
      endDate: '2026-10-14',
    }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );

    expect(failure).not.toBeNull();
    // 22xxx = data exception (日付の書式が不正)
    expect(failure?.code).toMatch(/^22/);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: keep, status: 'active' });
  });
});

// ---------------------------------------------------------------
// C: 競合
// ---------------------------------------------------------------
describe('#1312 C: 再生成と「レシピから追加」の競合', () => {
  it('C-1: add-recipe がリストを作ったトランザクションが開いている間、再生成は待たされ、コミット後にそのリストをアーカイブして新しいリストを作る (23505 にならない)', async () => {
    const user = await createUser('c1');
    const holder = holdOpen(`${asUserSql(user.id)}
      SELECT public.get_or_create_active_shopping_list('${user.id}'::uuid, 'add-recipe-list', DATE '${DAY1}', DATE '${DAY7}');`);
    await holder.sleeping;

    const regen = track(replaceList(user.id, { title: 'regen-list' }));
    await sleep(PENDING_CHECK_MS);
    expect(holder.isDone(), '前提: add-recipe 側のトランザクションがまだ開いている').toBe(false);
    expect(regen.state.settled, '再生成は add-recipe のロックを待っている').toBe(false);

    expect((await holder.done).ok).toBe(true);
    const res = await regen.promise;

    expect(res.error).toBeNull();
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(2);
    expect((await activeListsOf(user.id)).map((l) => [l.id, l.title])).toEqual([[res.data, 'regen-list']]);
    expect(lists.find((l) => l.title === 'add-recipe-list')?.status).toBe('archived');
  });

  it('C-2: 再生成がリストを作ったトランザクションが開いている間、add-recipe は待たされ、コミット後にそのリストを使う (23505 にならず、リストは 1 つ)', async () => {
    const user = await createUser('c2');
    const holder = holdOpen(`${asServiceRoleSql}
      SELECT public.replace_active_shopping_list('${user.id}'::uuid, 'regen-list', DATE '2026-10-08', DATE '2026-10-14', NULL);`);
    await holder.sleeping;

    const addRecipe = track(getOrCreate(asUser(user.jwt), user.id));
    await sleep(PENDING_CHECK_MS);
    expect(holder.isDone(), '前提: 再生成側のトランザクションがまだ開いている').toBe(false);
    expect(addRecipe.state.settled, 'add-recipe は再生成のロックを待っている').toBe(false);

    expect((await holder.done).ok).toBe(true);
    const res = await addRecipe.promise;

    expect(res.error).toBeNull();
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: res.data, title: 'regen-list', status: 'active' });
  });

  it('C-3: 再生成の途中 (コミット前) でも、アクティブなリストがあれば add-recipe は待たずにそのリストを返す。食材はアーカイブされたリストに残る (再生成の少し前に追加したのと同じ)', async () => {
    const user = await createUser('c3');
    const old = await replaceList(user.id, { title: 'old-list' });
    const oldId = old.data as string;
    const holder = holdOpen(`${asServiceRoleSql}
      SELECT public.replace_active_shopping_list('${user.id}'::uuid, 'regen-list', DATE '2026-10-08', DATE '2026-10-14', NULL);`);
    await holder.sleeping;

    // 再生成はまだコミットしていないので、今のアクティブなリストは old-list のまま見える
    const res = await getOrCreate(asUser(user.jwt), user.id);
    expect(holder.isDone(), '前提: 再生成側のトランザクションがまだ開いている').toBe(false);
    expect(res.error).toBeNull();
    expect(res.data).toBe(oldId);
    await addItem(asUser(user.jwt), oldId, 'added-during-regen');

    expect((await holder.done).ok).toBe(true);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(2);
    const active = lists.filter((l) => l.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe('regen-list');
    expect(lists.find((l) => l.id === oldId)?.status).toBe('archived');
    // 追加した食材は消えず、アーカイブされたリストに残る
    expect(await itemNamesOf(oldId)).toEqual(['added-during-regen']);
  });

  it('C-4: ロックはユーザーごと。同じキーを持っている間、同じユーザーの両方の関数は待たされ、別のユーザーは待たされない', async () => {
    const userA = await createUser('c4-a');
    const userB = await createUser('c4-b');
    // 関数を通さずにキーそのものを取る (関数が同じキー 'shopping_lists:<user_id>' を使っていることの確認)
    const holder = holdOpen(takeLockSql(userA.id));
    await holder.sleeping;

    // 別のユーザーは待たされない
    const forB = await getOrCreate(asUser(userB.jwt), userB.id);
    expect(forB.error).toBeNull();
    expect(holder.isDone(), '前提: ロックを持った接続がまだ開いている').toBe(false);

    // 同じユーザーは、get_or_create も replace も待たされる
    const addRecipe = track(getOrCreate(asUser(userA.jwt), userA.id));
    const regen = track(replaceList(userA.id, { title: 'regen-list' }));
    await sleep(PENDING_CHECK_MS);
    expect(holder.isDone(), '前提: ロックを持った接続がまだ開いている').toBe(false);
    expect(addRecipe.state.settled, 'get_or_create はロックを待っている').toBe(false);
    expect(regen.state.settled, 'replace はロックを待っている').toBe(false);

    expect((await holder.done).ok).toBe(true);
    const [addRes, regenRes] = await Promise.all([addRecipe.promise, regen.promise]);

    // どちらの順に入っても失敗せず、アクティブなリストは 1 つで、それは再生成が作ったもの
    expect(addRes.error).toBeNull();
    expect(regenRes.error).toBeNull();
    expect((await activeListsOf(userA.id)).map((l) => l.id)).toEqual([regenRes.data]);
  });

  it('C-5: ロックを取らない書き込み (デプロイ途中の古い add-recipe など) が先にコミットしても、再生成は 23505 にならず、そのリストをアーカイブして新しいリストを作る', async () => {
    const user = await createUser('c5');
    // 旧 add-recipe と同じ、ロックを取らない INSERT。コミット前のまま開いておく
    const holder = holdOpen(`
      INSERT INTO public.shopping_lists (user_id, title, start_date, end_date, status)
      VALUES ('${user.id}', 'lockless-list', DATE '${DAY1}', DATE '${DAY7}', 'active');`);
    await holder.sleeping;

    const regen = track(replaceList(user.id, { title: 'regen-list' }));
    await sleep(PENDING_CHECK_MS);
    expect(holder.isDone(), '前提: ロックを取らない書き込みがまだ開いている').toBe(false);
    expect(regen.state.settled, '再生成は未コミットの行との衝突を待っている').toBe(false);

    expect((await holder.done).ok).toBe(true);
    const res = await regen.promise;

    expect(res.error).toBeNull();
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(2);
    expect((await activeListsOf(user.id)).map((l) => [l.id, l.title])).toEqual([[res.data, 'regen-list']]);
    expect(lists.find((l) => l.title === 'lockless-list')?.status).toBe('archived');
  });

  it('C-6: ロックを取らない書き込みが先にコミットしても、add-recipe は 23505 にならず、そのリストを返す', async () => {
    const user = await createUser('c6');
    const holder = holdOpen(`
      INSERT INTO public.shopping_lists (user_id, title, start_date, end_date, status)
      VALUES ('${user.id}', 'lockless-list', DATE '${DAY1}', DATE '${DAY7}', 'active');`);
    await holder.sleeping;

    const addRecipe = track(getOrCreate(asUser(user.jwt), user.id));
    await sleep(PENDING_CHECK_MS);
    expect(holder.isDone(), '前提: ロックを取らない書き込みがまだ開いている').toBe(false);
    expect(addRecipe.state.settled, 'add-recipe は未コミットの行との衝突を待っている').toBe(false);

    expect((await holder.done).ok).toBe(true);
    const res = await addRecipe.promise;

    expect(res.error).toBeNull();
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: res.data, title: 'lockless-list', status: 'active' });
  });

  describe('C-7: 再生成と add-recipe を一斉に走らせる (20 回)', () => {
    const ITERATIONS = 20;
    const ADD_RECIPES_PER_ITERATION = 3;

    async function regenerate(userId: string): Promise<string> {
      if (LEGACY) return legacyRegenerate(userId);
      // Edge Function (regenerate-shopping-list-v2) が呼ぶのと同じ共有モジュール + service role のクライアント
      return replaceActiveShoppingList(srAdmin, {
        userId,
        startDate: '2026-10-08',
        endDate: '2026-10-14',
        servingsConfig: null,
      });
    }

    async function addRecipe(api: SupabaseClient, userId: string, itemName: string, delayMs: number): Promise<void> {
      await sleep(delayMs);
      // route と同じ手順: アクティブなリストを取得 (無ければ作成) -> 食材を追加
      const list = LEGACY ? await legacyGetOrCreate(api, userId) : await getOrCreateActiveShoppingList(api, userId);
      await addItem(api, list.id, itemName);
    }

    /** 反復ごとに、リストが無い / アクティブなリストがある / アーカイブ済みだけ、を入れ替える (直接 INSERT。migration の関数に依存しない) */
    async function seedState(userId: string, iteration: number): Promise<void> {
      await deleteListsOf(userId);
      if (iteration % 3 === 0) return;
      const { error } = await srAdmin.from('shopping_lists').insert({
        user_id: userId,
        title: iteration % 3 === 1 ? 'seed-active' : 'seed-archived',
        start_date: DAY1,
        end_date: DAY7,
        status: iteration % 3 === 1 ? 'active' : 'archived',
      });
      if (error) throw new Error(`seedState: ${error.message}`);
    }

    it(`C-7: ${LEGACY ? '【修正前の手順】' : ''}どの反復でも、両方が失敗せず、アクティブなリストは 1 つで、追加した食材は失われない`, async () => {
      const user = await createUser('c7');
      const api = asUser(user.jwt);
      const failures: string[] = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        await seedState(user.id, i);

        // 開始のタイミングをずらして、アーカイブ -> INSERT の間に add-recipe が入る組み合わせを作る
        const outcomes = await Promise.allSettled([
          regenerate(user.id),
          ...Array.from({ length: ADD_RECIPES_PER_ITERATION }, (_, k) =>
            addRecipe(api, user.id, `item-${i}-${k}`, (i * 3 + k * 4) % 14),
          ),
        ]);

        const [regenOutcome, ...addOutcomes] = outcomes;
        if (regenOutcome.status === 'rejected') {
          const reason = regenOutcome.reason as { code?: string; message?: string };
          failures.push(`#${i} 再生成が失敗: ${reason.code ?? ''} ${reason.message ?? String(reason)}`);
        }
        addOutcomes.forEach((outcome, k) => {
          if (outcome.status === 'rejected') {
            const reason = outcome.reason as { code?: string; message?: string };
            failures.push(`#${i} add-recipe(${k}) が失敗: ${reason.code ?? ''} ${reason.message ?? String(reason)}`);
          }
        });
        if (regenOutcome.status !== 'fulfilled') continue;

        const active = await activeListsOf(user.id);
        if (active.length !== 1) {
          failures.push(`#${i} アクティブなリストが ${active.length} 個`);
        } else if (active[0].id !== regenOutcome.value) {
          failures.push(`#${i} アクティブなリストが再生成の作ったリストでない`);
        }
        // 食材は、アクティブなリストかアーカイブされたリストのどちらかに必ず残っている
        const lists = await listsOf(user.id);
        const names = (await Promise.all(lists.map((l) => itemNamesOf(l.id)))).flat().filter((n) => n.startsWith(`item-${i}-`));
        const expected = addOutcomes.filter((o) => o.status === 'fulfilled').length;
        if (names.length !== expected) failures.push(`#${i} 食材が ${names.length} 件 (期待 ${expected} 件)`);
      }

      expect(failures, failures.join('\n')).toEqual([]);
    }, 120_000);
  });
});

// ---------------------------------------------------------------
// D: 修正前の動きの再現 (前提の固定)
// ---------------------------------------------------------------
describe('#1312 D: 修正前の手順では 23505 になる順序 (前提の確認。この migration の関数には依存しない)', () => {
  it('D-1: アーカイブ -> add-recipe がリストを作る -> INSERT の順に並ぶと、修正前の再生成の INSERT は部分ユニーク索引の 23505 で失敗する', async () => {
    const user = await createUser('d1');
    const api = asUser(user.jwt);
    const seed = await srAdmin
      .from('shopping_lists')
      .insert({ user_id: user.id, title: 'before', start_date: DAY1, end_date: DAY7, status: 'active' });
    expect(seed.error).toBeNull();

    // 修正前の再生成 1) アーカイブ
    expect((await legacyArchive(user.id)).error).toBeNull();
    // 間に add-recipe が入る: アクティブなリストが無いので自分で作る (#1214 以降の add-recipe の動き)
    const created = await legacyGetOrCreate(api, user.id);
    // 修正前の再生成 2) INSERT
    const insert = await legacyInsert(user.id);

    expect(insert.data).toBeNull();
    expect(insert.error?.code).toBe('23505');
    expect(insert.error?.message).toContain('idx_shopping_lists_active_unique');
    // add-recipe が作ったリストだけがアクティブなまま残る (データは壊れないが、再生成のリクエストは失敗する)
    expect((await activeListsOf(user.id)).map((l) => l.id)).toEqual([created.id]);
  });
});
