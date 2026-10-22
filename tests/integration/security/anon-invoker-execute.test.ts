/**
 * #1821 SECURITY INVOKER の関数に anon の EXECUTE が残っていないことの回帰テスト
 *
 * 背景: #1103 (7) (anon-definer-execute.test.ts) は SECURITY DEFINER の関数だけを見ていた。
 * Supabase は public スキーマに関数を作ると、anon / authenticated / service_role へ EXECUTE を自動で付け
 * (ALTER DEFAULT PRIVILEGES。本番も同じ)、PostgreSQL は PUBLIC (全員) にも EXECUTE を付ける。
 * SECURITY INVOKER の関数は呼び出し元 (anon) の権限と RLS のもとで動くが、anon に EXECUTE が残っていると、
 * anon キー (公開鍵) だけで /rest/v1/rpc/<関数> から直接呼べる。
 *
 * 修正前 (本番の 2026-10-17 の読み取りと、ローカルのベースライン + migration) は、anon が EXECUTE できる public の
 * SECURITY INVOKER の関数が 38 本あった。
 *   - トリガー関数 (RETURNS trigger) 26 本: トリガーとして動くときは EXECUTE を確かめず、RPC としては呼べない。
 *       許可一覧に入れず、除外の条件 (戻り値の型が trigger / event_trigger) で扱う
 *   - それ以外の 12 本: 未ログインの呼び出し元が無い。20261017210000_revoke_anon_execute_on_invoker_functions.sql で
 *       anon と PUBLIC の EXECUTE を外した (authenticated / service_role はそのまま)
 *
 * 期待する挙動 (20261017210000 の後):
 *   - A: anon が EXECUTE できる public の SECURITY INVOKER の関数 (トリガー関数を除く) は、このファイルの許可一覧のものだけ
 *        (いまは 0 本)。新しい関数が既定の権限のまま作られると、このテストが落ちる
 *   - B: 外した 12 本の EXECUTE 権限 (anon / authenticated / service_role / PUBLIC) が決定表のとおり
 *   - C: PostgREST (/rest/v1/rpc) で、anon は 12 本を呼べない (42501、HTTP 401 / 403)。
 *        ログインした利用者と service_role は従来どおり呼べる (検索の関数が本文で呼ぶ normalize_dish_name も含む)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST / RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/anon-invoker-execute.test.ts
 *
 * 関数の権限の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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

/** ローカルスタックの postgres-meta で SQL を実行する (カタログの確認だけに使う。読み取り専用) */
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

// ================================================================
// 許可一覧
// ================================================================

/**
 * 未ログインの anon が EXECUTE してよい、public の SECURITY INVOKER の関数 (トリガー関数を除く)。キーは `名前(引数の型)`。
 *
 * いまは 0 本。ここに足すのは、未ログインの画面・API・Edge Function が anon のクライアントで実際にその関数を呼ぶときだけ。
 * 値に、呼び出し元 (ファイル) を書く。
 * 呼び出し元が無い、またはログイン後・service_role でしか呼ばれないなら、足さずに migration で
 * `REVOKE EXECUTE ON FUNCTION public.<関数>(<型>) FROM anon, PUBLIC;` を入れる
 * (authenticated / service_role へは Supabase の既定の権限で直接 GRANT されているので、PUBLIC を外しても残る)。
 * トリガー関数は足さない (下の除外の条件で外している)。
 */
const ANON_EXECUTABLE_INVOKER_ALLOWLIST: Record<string, string> = {};

/**
 * 除外の条件: 戻り値の型が trigger / event_trigger の関数。
 * トリガーとして動くときは EXECUTE の権限を確かめず、PostgREST は RPC として出さない (直接呼ぶこともできない)ので、
 * anon の EXECUTE が残っていても /rest/v1/rpc からは呼べない。
 */
const EXCLUDED_RETURN_TYPES = ['trigger', 'event_trigger'] as const;

/** public の SECURITY INVOKER の普通の関数 (prokind = 'f'。拡張機能が持つ関数は除く) の行 */
interface InvokerFnRow {
  sig: string;
  rettype: string;
  public_exec: boolean;
}

/**
 * anon が EXECUTE できる public の SECURITY INVOKER の関数 (拡張機能が持つ関数は除く)。
 * includeExcluded が true なら、除外の条件 (トリガー関数) に当たるものも返す (除外の条件が効いていることの番兵に使う)
 */
async function anonExecutableInvokerFunctions(includeExcluded: boolean): Promise<InvokerFnRow[]> {
  const excluded = EXCLUDED_RETURN_TYPES.map((t) => `'${t}'::regtype`).join(', ');
  return pgQuery<InvokerFnRow>(`
    SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
           p.prorettype::regtype::text AS rettype,
           EXISTS (
             SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT p.prosecdef
      AND p.prokind = 'f'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      ${includeExcluded ? '' : `AND p.prorettype NOT IN (${excluded})`}
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
    ORDER BY 1
  `);
}

describe('#1821 A: anon が EXECUTE できる SECURITY INVOKER の関数 (トリガー関数を除く) は許可一覧のものだけ', () => {
  it('A1: 許可一覧に無い SECURITY INVOKER の関数が、anon に EXECUTE を許していない', async () => {
    const rows = await anonExecutableInvokerFunctions(false);
    const allowed = new Set(Object.keys(ANON_EXECUTABLE_INVOKER_ALLOWLIST));
    const unexpected = rows
      .filter((r) => !allowed.has(r.sig))
      .map((r) => `${r.sig}${r.public_exec ? ' (PUBLIC に EXECUTE が付いている)' : ''}`);
    expect(
      unexpected,
      [
        '許可一覧に無い SECURITY INVOKER の関数を、未ログインの anon が /rest/v1/rpc から直接呼べる。',
        'Supabase は関数の作成時に anon / authenticated / service_role へ EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付ける。',
        'その関数を作る migration に、引数の型まで書いた完全形で次を足す (既に本番に入っている関数なら、新しい migration で)。',
        '  REVOKE EXECUTE ON FUNCTION public.<関数>(<型>) FROM anon, PUBLIC;',
        '未ログインの画面・API が anon のクライアントで呼ぶ関数なら、呼び出し元を添えて、このファイルの許可一覧に足す。',
      ].join('\n'),
    ).toEqual([]);
  });

  it('A1b: 許可一覧の関数は、いまも anon が呼べる (意図して外したなら許可一覧からも消す)', async () => {
    const rows = await anonExecutableInvokerFunctions(false);
    const actual = new Set(rows.map((r) => r.sig));
    const missing = Object.keys(ANON_EXECUTABLE_INVOKER_ALLOWLIST).filter((sig) => !actual.has(sig));
    expect(
      missing,
      '許可一覧の関数が、存在しない・SECURITY INVOKER でない・トリガー関数である・anon が EXECUTE できない。',
    ).toEqual([]);
  });

  it('A2: 除外の条件で外しているのはトリガー関数だけ (除外の条件が普通の関数を隠していない。番兵として、トリガー関数を実際に拾えている)', async () => {
    const all = await anonExecutableInvokerFunctions(true);
    const counted = new Set((await anonExecutableInvokerFunctions(false)).map((r) => r.sig));
    const excludedRows = all.filter((r) => !counted.has(r.sig));
    // 除外したものは、どれも戻り値の型が trigger / event_trigger
    expect(
      excludedRows.filter((r) => !(EXCLUDED_RETURN_TYPES as readonly string[]).includes(r.rettype)).map((r) => r.sig),
    ).toEqual([]);
    // 番兵: 修正前から残しているトリガー関数 (updated_at を更新するだけ) を、除外の側で拾えている。
    // 拾えていなければ、問い合わせが壊れて何も返さず、A1 が素通りしている
    expect(excludedRows.map((r) => r.sig)).toContain('update_updated_at_column()');
  });
});

// ================================================================
// B: 外した 12 本の EXECUTE 権限 (決定表)
// ================================================================

interface AclRow {
  sig: string;
  secdef: boolean;
  anon_exec: boolean;
  auth_exec: boolean;
  sr_exec: boolean;
  public_exec: boolean;
}

/**
 * 20261017210000 で anon と PUBLIC の EXECUTE を外した関数と、呼び出し元。
 * authenticated・service_role は「この修正では変えない」(どちらも呼べるまま)。
 * secdef: いまの SECURITY DEFINER かどうか (省くと false = SECURITY INVOKER のまま)。
 *   create_org_invite は #1917 (20261022180000_org_tables_rpc_only_writes.sql) で SECURITY DEFINER にした
 *   (CREATE OR REPLACE は EXECUTE の権限を引き継ぐので、anon・PUBLIC は外れたまま)。
 */
const REVOKED_INVOKER_FUNCTIONS: Array<{ sig: string; why: string; secdef?: boolean }> = [
  {
    sig: 'create_org_invite(uuid,text,org_role_enum,text)',
    why: 'POST /api/org/invites がログインした組織の owner / admin のクライアントで呼ぶ (src/lib/membership/org-invite.ts)',
    secdef: true,
  },
  {
    sig: 'get_7d_checkin_averages(uuid,date)',
    why: 'GET /api/performance/analyze・/api/performance/checkins がログインした利用者のクライアントで呼ぶ',
  },
  {
    sig: 'user_has_non_sandbox_activity()',
    why: 'ハンズオンツアーの判定 (src/lib/handson-tour) がログインした利用者のクライアントで呼ぶ (auth.uid() を使う)',
  },
  {
    sig: 'normalize_dish_name(text)',
    why: '検索の関数 (SECURITY INVOKER) が本文で呼ぶ。呼び出し元の権限で呼ばれる',
  },
  {
    sig: 'search_dataset_ingredients_by_embedding(vector,integer)',
    why: 'Edge Function (create-derived-recipe・_shared/nutrition-calculator.ts) が service_role / 利用者の JWT で呼ぶ',
  },
  {
    sig: 'search_ingredients_by_text_similarity(text,numeric,integer)',
    why: 'Edge Function (_shared/ingredient-matcher.ts) が service_role / 利用者の JWT で呼ぶ',
  },
  {
    sig: 'search_ingredients_full_by_embedding(vector,integer)',
    why: 'Edge Function (_shared/ingredient-matcher.ts) が service_role / 利用者の JWT で呼ぶ',
  },
  {
    sig: 'search_menu_examples(vector,integer,text,numeric,text[])',
    why: 'Edge Function (generate-menu-v4 / v5) が service_role で呼ぶ',
  },
  {
    sig: 'search_recipes_hybrid(text,vector,integer,numeric)',
    why: 'Edge Function (knowledge-gpt) が service_role で呼ぶ',
  },
  {
    sig: 'search_recipes_with_nutrition(text,numeric,integer)',
    why: 'Edge Function (_shared/evidence-verifier.ts) が service_role / 利用者の JWT で呼ぶ',
  },
  {
    sig: 'search_similar_dataset_ingredients(text,numeric,integer)',
    why: 'Edge Function (create-derived-recipe) が service_role で呼ぶ',
  },
  {
    sig: 'search_similar_dataset_recipes(text,numeric,integer)',
    why: 'Edge Function (_shared/nutrition-calculator.ts) が service_role / 利用者の JWT で呼ぶ',
  },
];

describe('#1821 B: 外した関数の EXECUTE 権限 (決定表)', () => {
  let acl: AclRow[] = [];

  beforeAll(async () => {
    const names = [...new Set(REVOKED_INVOKER_FUNCTIONS.map((e) => e.sig.split('(')[0]))];
    acl = await pgQuery<AclRow>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             p.prosecdef AS secdef,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (${names.map((n) => `'${n}'`).join(', ')})
      ORDER BY 1
    `);
  });

  for (const expected of REVOKED_INVOKER_FUNCTIONS) {
    it(`B: ${expected.sig} — anon・PUBLIC は不可、authenticated・service_role は可 (${expected.why})`, () => {
      const row = acl.find((r) => r.sig === expected.sig);
      expect(row, `${expected.sig} が見つからない`).toBeDefined();
      expect(row!.secdef, expected.secdef ? 'SECURITY DEFINER (#1917)' : 'SECURITY INVOKER のまま').toBe(expected.secdef ?? false);
      expect(row!.public_exec, 'PUBLIC (全員) に EXECUTE が付いていない').toBe(false);
      expect(row!.anon_exec, 'anon').toBe(false);
      expect(row!.auth_exec, 'authenticated').toBe(true);
      expect(row!.sr_exec, 'service_role').toBe(true);
    });
  }

  it('B2: 決定表の関数は、どれも 1 本ずつ見つかる (同名の別の引数の関数が無い)', () => {
    expect(acl.map((r) => r.sig).sort()).toEqual(REVOKED_INVOKER_FUNCTIONS.map((e) => e.sig).sort());
  });
});

// ================================================================
// C: PostgREST を通した挙動
// ================================================================

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** 引数に渡すだけの小さな埋め込み (次元を問わない vector 型の引数に渡る。中身は見ない) */
const TINY_EMBEDDING = '[0.1,0.2,0.3]';
/** 検索の関数に渡す件数の上限 (結果の中身は見ない。呼べることだけを確かめる) */
const SEARCH_LIMIT = 3;
/** 検索の関数に渡す類似度のしきい値 (結果の中身は見ない) */
const SEARCH_THRESHOLD = 0.3;
/** get_7d_checkin_averages に渡す基準日。C4 はこの日の記録を 1 件だけ入れて、7 日の集計に 1 件が入ることを確かめる */
const AVERAGES_DATE = '2026-10-17';
/** C4 で入れる記録の運動の分数 (集計の total_training_minutes にそのまま出る) */
const CHECKIN_TRAINING_MINUTES = 30;
const LONG = 120_000;

let userId = '';
let userJwt = '';

async function createFixture(): Promise<void> {
  const email = `sec-anon-invoker-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: userId, nickname: 'anon-invoker', age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  userJwt = signIn.data.session.access_token;
}

async function cleanupFixture(): Promise<void> {
  if (!userId) return;
  await srAdmin.from('user_performance_checkins').delete().eq('user_id', userId);
  await srAdmin.auth.admin.deleteUser(userId); // user_profiles は CASCADE
}

/** 外した 12 本の呼び方。PostgREST の引数名は関数の引数名と同じ */
const REVOKED_RPC_CALLS: Array<{ name: string; args?: Record<string, unknown> }> = [
  {
    name: 'create_org_invite',
    args: { p_organization_id: ZERO_UUID, p_email: 'x@homegohan.test', p_role: 'member', p_custom_message: null },
  },
  { name: 'get_7d_checkin_averages', args: { p_user_id: ZERO_UUID, p_date: AVERAGES_DATE } },
  { name: 'user_has_non_sandbox_activity' },
  { name: 'normalize_dish_name', args: { name: 'カレー' } },
  { name: 'search_dataset_ingredients_by_embedding', args: { query_embedding: TINY_EMBEDDING, match_count: SEARCH_LIMIT } },
  {
    name: 'search_ingredients_by_text_similarity',
    args: { query_name: 'にんじん', similarity_threshold: SEARCH_THRESHOLD, result_limit: SEARCH_LIMIT },
  },
  { name: 'search_ingredients_full_by_embedding', args: { query_embedding: TINY_EMBEDDING, match_count: SEARCH_LIMIT } },
  {
    name: 'search_menu_examples',
    args: {
      query_embedding: TINY_EMBEDDING,
      match_count: SEARCH_LIMIT,
      filter_meal_type_hint: null,
      filter_max_sodium: null,
      filter_theme_tags: null,
    },
  },
  {
    name: 'search_recipes_hybrid',
    args: { query_text: 'カレー', query_embedding: TINY_EMBEDDING, match_count: SEARCH_LIMIT, similarity_threshold: SEARCH_THRESHOLD },
  },
  {
    name: 'search_recipes_with_nutrition',
    args: { query_name: 'カレー', similarity_threshold: SEARCH_THRESHOLD, result_limit: SEARCH_LIMIT },
  },
  {
    name: 'search_similar_dataset_ingredients',
    args: { query_name: 'にんじん', similarity_threshold: SEARCH_THRESHOLD, result_limit: SEARCH_LIMIT },
  },
  {
    name: 'search_similar_dataset_recipes',
    args: { query_name: 'カレー', similarity_threshold: SEARCH_THRESHOLD, result_limit: SEARCH_LIMIT },
  },
];

describe('#1821 C: PostgREST を通した挙動', () => {
  beforeAll(createFixture, LONG);
  afterAll(cleanupFixture, LONG);

  it('C0: 呼び方の一覧は、決定表の 12 本と同じ関数を指す', () => {
    expect(REVOKED_RPC_CALLS.map((c) => c.name).sort()).toEqual(
      REVOKED_INVOKER_FUNCTIONS.map((e) => e.sig.split('(')[0]).sort(),
    );
  });

  for (const fn of REVOKED_RPC_CALLS) {
    it(`C1: anon は ${fn.name} を呼べない (42501、HTTP 401 / 403)`, async () => {
      const { data, error, status } = await anon().rpc(fn.name, fn.args);
      expect(error?.code, `${fn.name}: ${error?.message}`).toBe('42501');
      expect([401, 403]).toContain(status);
      expect(data).toBeNull();
    });
  }

  it('C2: ログインした利用者は、normalize_dish_name を従来どおり呼べる (括弧の中を落として正規化した名前が返る)', async () => {
    const { data, error } = await asUser(userJwt).rpc('normalize_dish_name', { name: 'カレー（中辛）' });
    expect(error, error?.message).toBeNull();
    expect(data).toBe('カレー');
  });

  it('C3: ログインした利用者と service_role は、本文で normalize_dish_name を呼ぶ検索の関数を従来どおり呼べる', async () => {
    for (const who of [
      { label: 'authenticated', api: asUser(userJwt) },
      { label: 'service_role', api: srAdmin },
    ]) {
      for (const name of ['search_similar_dataset_recipes', 'search_similar_dataset_ingredients', 'search_recipes_with_nutrition']) {
        const call = REVOKED_RPC_CALLS.find((c) => c.name === name)!;
        const { data, error } = await who.api.rpc(call.name, call.args);
        expect(error, `${who.label}: ${name}: ${error?.message}`).toBeNull();
        expect(Array.isArray(data), `${who.label}: ${name}`).toBe(true);
      }
    }
  });

  it('C4: ログインした利用者は、user_has_non_sandbox_activity と get_7d_checkin_averages を従来どおり呼べる', async () => {
    // 記録の無い利用者なので、通常の利用の記録は無い
    const activity = await asUser(userJwt).rpc('user_has_non_sandbox_activity');
    expect(activity.error, activity.error?.message).toBeNull();
    expect(activity.data).toBe(false);

    // 記録が無いと集計は 0 行 (GROUP BY の結果が空)。1 件入れて、本人の JWT で集計に入ることを確かめる
    const empty = await asUser(userJwt).rpc('get_7d_checkin_averages', { p_user_id: userId, p_date: AVERAGES_DATE });
    expect(empty.error, empty.error?.message).toBeNull();
    expect(empty.data).toEqual([]);

    const { error: insertError } = await srAdmin
      .from('user_performance_checkins')
      .insert({ user_id: userId, checkin_date: AVERAGES_DATE, training_minutes: CHECKIN_TRAINING_MINUTES });
    expect(insertError, insertError?.message).toBeNull();

    const averages = await asUser(userJwt).rpc('get_7d_checkin_averages', { p_user_id: userId, p_date: AVERAGES_DATE });
    expect(averages.error, averages.error?.message).toBeNull();
    expect(averages.data).toHaveLength(1);
    expect(averages.data[0]).toMatchObject({ checkin_count: 1, total_training_minutes: CHECKIN_TRAINING_MINUTES });
  });

  it('C5: ログインした利用者が create_org_invite を呼ぶと、権限 (42501) ではなく関数の中の判定 (NOT_ORG_ADMIN) で止まる (EXECUTE は残っている)', async () => {
    const call = REVOKED_RPC_CALLS.find((c) => c.name === 'create_org_invite')!;
    const { error } = await asUser(userJwt).rpc(call.name, call.args);
    expect(error, '組織に属さない利用者は関数の中で断られる').not.toBeNull();
    expect(error?.code, error?.message).toBe('P0001');
    expect(error?.message).toContain('NOT_ORG_ADMIN');
  });
});
