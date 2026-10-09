/**
 * #1157 運用アラート (エラー急増メール) の DB 側の部品の回帰テスト
 *   public.ops_alert_state / claim_ops_alert / release_ops_alert / app_log_error_counts
 *   (supabase/migrations/20261008200900_ops_alert_state.sql)
 *
 * 背景: Vercel Cron が 15 分おきに GET /api/cron/app-log-alerts を呼び、直近 15 分の app_logs.level='error' が
 * しきい値を超えていたら、運用のメールアドレスに 1 通知らせる。同じアラートは 60 分以内に送り直さない。
 * その「数える」「送ってよいか決める」を DB 側で行う関数と、「最後に送った時刻」の表をここで確かめる。
 *
 * 期待する挙動:
 *   - ops_alert_state は service_role だけが読み書きできる。anon / authenticated は表も 3 本の関数も 42501
 *   - claim_ops_alert: 行が無ければ INSERT して時刻を返す。前回からクールダウン分たっていなければ NULL (何も変えない)。
 *       たっていれば更新して新しい時刻を返す。同時に何本呼んでも、権利を取れるのは 1 本だけ (Vercel Cron の二重起動対策)
 *   - release_ops_alert: claim が返した時刻と同じ行だけを消す (別の実行が取り直した新しい行は消さない)。
 *       返したあとは、すぐにもう一度 claim できる
 *   - app_log_error_counts: 窓の中の level='error' だけを function_name ごとに数える (warn / info と、窓の外は数えない)。
 *       多い順に limit 行まで返し、どの行にも全体の件数 total_count が付く。返す列は function_name / error_count / total_count だけで、
 *       ログの本文・ユーザー ID は読み出さない。窓・limit が範囲外なら 22023
 *
 * 共有の DB には他のテストや開発サーバーのログも入っているので、自分が入れた行は専用の function_name と request_id の目印で
 * 識別し、他の行との合計は下限だけを確かめる。ログの行は終了時に目印で削除する。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ops-alert-state.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数 / クライアント
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

// ---------------------------------------------------------------
// テストユーザー (authenticated の権限確認用。使い捨て)
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-ops-alert';
let userId: string;
let userJwt: string;

// ---------------------------------------------------------------
// 目印
// ---------------------------------------------------------------
/** ops_alert_state に入れるキー。この実行のものだけを後片付けで消せるよう、共通の接頭辞を付ける */
const KEY_PREFIX = 'rls-1157-ops-alert-';
const key = (label: string) => `${KEY_PREFIX}${TS}-${label}`;
/** 種にした app_logs の request_id (後片付けの目印) */
const LOG_MARK = `rls-1157-ops-alert-${TS}`;
const FN_A = `rls-1157-fn-a-${TS}`;
const FN_B = `rls-1157-fn-b-${TS}`;
const FN_C = `rls-1157-fn-c-${TS}`;

const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// ---------------------------------------------------------------
// 呼び出しの小さなヘルパー
// ---------------------------------------------------------------
async function claim(alertKey: string, cooldownMinutes?: number | null, who: SupabaseClient = srAdmin) {
  return who.rpc('claim_ops_alert', {
    p_alert_key: alertKey,
    ...(cooldownMinutes === undefined ? {} : { p_cooldown_minutes: cooldownMinutes }),
  });
}

async function release(alertKey: string, claimedAt: string, who: SupabaseClient = srAdmin) {
  return who.rpc('release_ops_alert', { p_alert_key: alertKey, p_claimed_at: claimedAt });
}

async function counts(windowMinutes?: number | null, limit?: number | null, who: SupabaseClient = srAdmin) {
  return who.rpc('app_log_error_counts', {
    ...(windowMinutes === undefined ? {} : { p_window_minutes: windowMinutes }),
    ...(limit === undefined ? {} : { p_limit: limit }),
  });
}

async function stateRow(alertKey: string): Promise<{ alert_key: string; last_sent_at: string } | null> {
  const { data, error } = await srAdmin
    .from('ops_alert_state')
    .select('alert_key, last_sent_at')
    .eq('alert_key', alertKey)
    .maybeSingle();
  if (error) throw new Error(`select ops_alert_state: ${error.message}`);
  return data as { alert_key: string; last_sent_at: string } | null;
}

/** 行の last_sent_at を直接書き換えて、「前回の送信が N 分前だった」状態を作る */
async function setLastSentAt(alertKey: string, iso: string) {
  const { error } = await srAdmin.from('ops_alert_state').upsert({ alert_key: alertKey, last_sent_at: iso });
  if (error) throw new Error(`upsert ops_alert_state: ${error.message}`);
}

interface CountRow {
  function_name: string | null;
  error_count: number;
  total_count: number;
}

function asCountRows(data: unknown): CountRow[] {
  expect(Array.isArray(data)).toBe(true);
  return data as CountRow[];
}

const byName = (rows: CountRow[], name: string) => rows.find((r) => r.function_name === name);

/** 42501 (permission denied)。PostgREST は表も関数も、権限が無ければこのコードで返す */
function expectPermissionDenied(result: { error: { code?: string; message?: string } | null }) {
  expect(result.error, '権限エラーになるはず').not.toBeNull();
  expect(result.error?.code).toBe('42501');
}

// ---------------------------------------------------------------
// セットアップ / 後片付け
// ---------------------------------------------------------------
async function purge() {
  await srAdmin.from('ops_alert_state').delete().like('alert_key', `${KEY_PREFIX}%`);
  await srAdmin.from('app_logs').delete().like('request_id', 'rls-1157-ops-alert-%');
}

async function seedLog(row: {
  level: 'debug' | 'info' | 'warn' | 'error';
  function_name: string | null;
  created_at: string;
}) {
  const { error } = await srAdmin.from('app_logs').insert({
    level: row.level,
    source: 'api-route',
    function_name: row.function_name,
    message: 'rls-1157 ops alert seed',
    request_id: LOG_MARK,
    created_at: row.created_at,
  });
  // 握りつぶすと、行が入らないままテストが空振りで通る
  if (error) throw new Error(`app_logs seed: ${error.message}`);
}

beforeAll(async () => {
  // 前回の実行が途中で止まっていた場合の取り残しを先に消す。
  // 表がまだ無い (migration の前) ときの削除エラーは、ここでは無視する (赤の確認で、本来の失敗を見せるため)
  await purge().catch(() => {});

  const email = `rls-1157-ops-alert-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  userJwt = signIn.data.session.access_token;
}, 60_000);

afterAll(async () => {
  await purge().catch(() => {});
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
});

// ================================================================
// A. 権限: service_role だけ
// ================================================================
describe('ops_alert_state と 3 本の関数は service_role だけが使える', () => {
  it('A-1: anon は表を読み書きできない (42501)', async () => {
    const a = anon();
    expectPermissionDenied(await a.from('ops_alert_state').select('alert_key'));
    expectPermissionDenied(await a.from('ops_alert_state').insert({ alert_key: key('anon-insert') }));
    expectPermissionDenied(await a.from('ops_alert_state').update({ last_sent_at: ago(0) }).eq('alert_key', key('x')));
    expectPermissionDenied(await a.from('ops_alert_state').delete().eq('alert_key', key('x')));
  });

  it('A-2: authenticated も表を読み書きできない (42501)', async () => {
    const u = client(anonKey, userJwt);
    expectPermissionDenied(await u.from('ops_alert_state').select('alert_key'));
    expectPermissionDenied(await u.from('ops_alert_state').insert({ alert_key: key('user-insert') }));
    expectPermissionDenied(await u.from('ops_alert_state').update({ last_sent_at: ago(0) }).eq('alert_key', key('x')));
    expectPermissionDenied(await u.from('ops_alert_state').delete().eq('alert_key', key('x')));
    // 書き込めていないこと (権限エラーのあとに行が残っていない)
    expect(await stateRow(key('user-insert'))).toBeNull();
    expect(await stateRow(key('anon-insert'))).toBeNull();
  });

  it('A-3: anon / authenticated は 3 本の関数も呼べない (42501)', async () => {
    for (const who of [anon(), client(anonKey, userJwt)]) {
      expectPermissionDenied(await claim(key('rpc-denied'), 60, who));
      expectPermissionDenied(await release(key('rpc-denied'), ago(0), who));
      expectPermissionDenied(await counts(15, 10, who));
    }
    // 権限エラーで claim が実行されていないこと
    expect(await stateRow(key('rpc-denied'))).toBeNull();
  });

  it('A-4: カタログ上も、RLS 有効・全拒否ポリシーあり・anon / authenticated / PUBLIC に権限なし・service_role にだけ付いている', async () => {
    // has_table_privilege に複数の権限を渡すと「どれか 1 つでもあれば true」になる。
    // anon / authenticated は「どれも無い」ことを、service_role は「4 つとも有る」ことを確かめる
    const [table] = await pgQuery<{
      rls: boolean;
      anon_any: boolean;
      auth_any: boolean;
      service_all: boolean;
    }>(`
      SELECT c.relrowsecurity AS rls,
             has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon_any,
             has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS auth_any,
             (has_table_privilege('service_role', c.oid, 'SELECT')
              AND has_table_privilege('service_role', c.oid, 'INSERT')
              AND has_table_privilege('service_role', c.oid, 'UPDATE')
              AND has_table_privilege('service_role', c.oid, 'DELETE')) AS service_all
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'ops_alert_state'
    `);
    expect(table, 'ops_alert_state が無い').toBeDefined();
    expect(table.rls).toBe(true);
    expect(table.anon_any).toBe(false);
    expect(table.auth_any).toBe(false);
    expect(table.service_all).toBe(true);

    const policies = await pgQuery<{ policyname: string; cmd: string; roles: string }>(`
      SELECT policyname, cmd, roles::text AS roles FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'ops_alert_state'
    `);
    expect(policies.map((p) => p.policyname)).toEqual(['ops_alert_state_deny_client_access']);
    expect(policies[0].cmd).toBe('ALL');

    const fns = await pgQuery<{
      sig: string;
      secdef: boolean;
      public_exec: boolean;
      anon_exec: boolean;
      auth_exec: boolean;
      service_exec: boolean;
      search_path: string | null;
    }>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             p.prosecdef AS secdef,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
             (SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS search_path
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('claim_ops_alert', 'release_ops_alert', 'app_log_error_counts')
       ORDER BY 1
    `);
    expect(fns.map((f) => f.sig)).toEqual([
      'app_log_error_counts(integer,integer)',
      'claim_ops_alert(text,integer)',
      'release_ops_alert(text,timestamp with time zone)',
    ]);
    for (const f of fns) {
      expect(f.secdef, `${f.sig} は SECURITY INVOKER`).toBe(false);
      expect(f.public_exec, `${f.sig}: PUBLIC に EXECUTE が付いている`).toBe(false);
      expect(f.anon_exec, `${f.sig}: anon に EXECUTE が付いている`).toBe(false);
      expect(f.auth_exec, `${f.sig}: authenticated に EXECUTE が付いている`).toBe(false);
      expect(f.service_exec, `${f.sig}: service_role に EXECUTE が無い`).toBe(true);
      expect(f.search_path, `${f.sig}: search_path が固定されていない`).toBe('search_path=""');
    }
  });
});

// ================================================================
// B. claim_ops_alert: 送る権利を 1 つだけ取る
// ================================================================
describe('claim_ops_alert', () => {
  it('B-1: 行が無ければ権利を取れて、その時刻が行に入る', async () => {
    const k = key('b1');
    const { data, error } = await claim(k, 60);
    expect(error).toBeNull();
    expect(typeof data).toBe('string');

    const row = await stateRow(k);
    expect(row).not.toBeNull();
    // 返った時刻と行の時刻が同じ (release に渡す「取った印」になる)
    expect(new Date(row!.last_sent_at).getTime()).toBe(new Date(data as string).getTime());
    // DB の「今」に近い
    expect(Math.abs(new Date(data as string).getTime() - Date.now())).toBeLessThan(2 * MIN);
  });

  it('B-2: クールダウン中の 2 回目は NULL で、行は変わらない', async () => {
    const k = key('b2');
    const first = await claim(k, 60);
    expect(first.error).toBeNull();
    const before = await stateRow(k);

    const second = await claim(k, 60);
    expect(second.error).toBeNull();
    expect(second.data).toBeNull();
    expect(await stateRow(k)).toEqual(before);
  });

  it('B-3: キーが違えば別のアラートとして、それぞれ権利を取れる', async () => {
    const a = await claim(key('b3-a'), 60);
    const b = await claim(key('b3-b'), 60);
    expect(typeof a.data).toBe('string');
    expect(typeof b.data).toBe('string');
  });

  it('B-4: 前回から 61 分たっていれば取り直せる。59 分なら取れない (クールダウン 60 分)', async () => {
    const k = key('b4');

    await setLastSentAt(k, ago(59 * MIN));
    const tooEarly = await claim(k, 60);
    expect(tooEarly.error).toBeNull();
    expect(tooEarly.data).toBeNull();
    expect(new Date((await stateRow(k))!.last_sent_at).getTime()).toBeLessThan(Date.now() - 58 * MIN);

    await setLastSentAt(k, ago(61 * MIN));
    const ok = await claim(k, 60);
    expect(ok.error).toBeNull();
    expect(typeof ok.data).toBe('string');
    // 行の時刻が今に更新されている
    expect(new Date((await stateRow(k))!.last_sent_at).getTime()).toBeGreaterThan(Date.now() - 2 * MIN);
  });

  it('B-5: クールダウンの分数は引数で変えられる (既定は 60 分)', async () => {
    const k = key('b5');
    await setLastSentAt(k, ago(2 * MIN));
    // 既定 (60 分) では取れない
    expect((await claim(k)).data).toBeNull();
    // 1 分なら取れる
    expect(typeof (await claim(k, 1)).data).toBe('string');
  });

  it('B-6: 同時に 10 本呼んでも、権利を取れるのは 1 本だけ (行が無い状態から)', async () => {
    const k = key('b6');
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(k, 60)));

    for (const r of results) expect(r.error).toBeNull();
    const winners = results.filter((r) => r.data !== null);
    expect(winners).toHaveLength(1);
    expect(new Date((await stateRow(k))!.last_sent_at).getTime()).toBe(new Date(winners[0].data as string).getTime());
  });

  it('B-7: 同時に 10 本呼んでも、権利を取れるのは 1 本だけ (前回から時間がたった行を取り直す場合)', async () => {
    const k = key('b7');
    await setLastSentAt(k, ago(120 * MIN));
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(k, 60)));

    for (const r of results) expect(r.error).toBeNull();
    const winners = results.filter((r) => r.data !== null);
    expect(winners).toHaveLength(1);
    expect(new Date((await stateRow(k))!.last_sent_at).getTime()).toBe(new Date(winners[0].data as string).getTime());
  });

  it('B-8: 不正な引数は 22023 で、行も作らない', async () => {
    for (const badKey of ['', '   ']) {
      const r = await claim(badKey, 60);
      expect(r.error?.code, `キー ${JSON.stringify(badKey)}`).toBe('22023');
    }
    for (const bad of [0, -1, 10081, null]) {
      const k = key(`b8-${String(bad)}`);
      const r = await claim(k, bad);
      expect(r.error?.code, `クールダウン ${String(bad)}`).toBe('22023');
      expect(await stateRow(k)).toBeNull();
    }
  });
});

// ================================================================
// C. release_ops_alert: 送れなかったときに権利を返す
// ================================================================
describe('release_ops_alert', () => {
  it('C-1: claim が返した時刻で返すと行が消え、すぐにもう一度 claim できる', async () => {
    const k = key('c1');
    const token = (await claim(k, 60)).data as string;
    expect((await claim(k, 60)).data).toBeNull();

    const released = await release(k, token);
    expect(released.error).toBeNull();
    expect(released.data).toBe(true);
    expect(await stateRow(k)).toBeNull();

    expect(typeof (await claim(k, 60)).data).toBe('string');
  });

  it('C-2: 時刻が違えば何も消さない (別の実行が取り直した新しい行を守る)', async () => {
    const k = key('c2');
    const token = (await claim(k, 60)).data as string;

    // 別の実行が取り直した、という状態を作る (token より後の時刻の行。ミリ秒の丸めで token と偶然同じにならないよう 1 秒後にする)
    const newer = new Date(new Date(token).getTime() + 1000).toISOString();
    await setLastSentAt(k, newer);

    const released = await release(k, token);
    expect(released.error).toBeNull();
    expect(released.data).toBe(false);
    const row = await stateRow(k);
    expect(row).not.toBeNull();
    expect(new Date(row!.last_sent_at).getTime()).toBe(new Date(newer).getTime());
  });

  it('C-3: 行が無いキーを返しても false で、エラーにならない。ほかのキーの行は消えない', async () => {
    const other = key('c3-other');
    await claim(other, 60);

    const released = await release(key('c3-missing'), ago(0));
    expect(released.error).toBeNull();
    expect(released.data).toBe(false);
    expect(await stateRow(other)).not.toBeNull();
  });
});

// ================================================================
// D. app_log_error_counts: error を function_name ごとに数える
// ================================================================
describe('app_log_error_counts', () => {
  beforeAll(async () => {
    // 窓 (15 分) の中: FN_A 3 件、FN_B 2 件、関数名なし 1 件
    for (let i = 0; i < 3; i += 1) await seedLog({ level: 'error', function_name: FN_A, created_at: ago(10 * MIN) });
    for (let i = 0; i < 2; i += 1) await seedLog({ level: 'error', function_name: FN_B, created_at: ago(5 * MIN) });
    await seedLog({ level: 'error', function_name: null, created_at: ago(3 * MIN) });
    // 窓の外 (20 分前): FN_A 5 件。窓を 60 分にすると数えられる
    for (let i = 0; i < 5; i += 1) await seedLog({ level: 'error', function_name: FN_A, created_at: ago(20 * MIN) });
    // error 以外は数えない (窓の中の FN_B に warn 4 件 / info 3 件 / debug 1 件、FN_C は warn だけ)
    for (let i = 0; i < 4; i += 1) await seedLog({ level: 'warn', function_name: FN_B, created_at: ago(5 * MIN) });
    for (let i = 0; i < 3; i += 1) await seedLog({ level: 'info', function_name: FN_B, created_at: ago(5 * MIN) });
    await seedLog({ level: 'debug', function_name: FN_B, created_at: ago(5 * MIN) });
    for (let i = 0; i < 2; i += 1) await seedLog({ level: 'warn', function_name: FN_C, created_at: ago(5 * MIN) });
  }, 60_000);

  it('D-1: 窓 15 分の error だけを function_name ごとに数える (warn / info / debug と、窓の外は数えない)', async () => {
    const { data, error } = await counts(15, 100);
    expect(error).toBeNull();
    const rows = asCountRows(data);

    expect(byName(rows, FN_A)?.error_count).toBe(3);
    expect(byName(rows, FN_B)?.error_count).toBe(2);
    // error が 1 件も無い関数名は、グループ自体が出てこない
    expect(byName(rows, FN_C)).toBeUndefined();
    // 関数名なし (NULL) は 1 つのグループにまとまる。他のテストのログも混ざるので、自分の 1 件以上
    const nullRows = rows.filter((r) => r.function_name === null);
    expect(nullRows).toHaveLength(1);
    expect(nullRows[0].error_count).toBeGreaterThanOrEqual(1);
  });

  it('D-2: 窓を 60 分にすると、20 分前の error も数える', async () => {
    const { data, error } = await counts(60, 100);
    expect(error).toBeNull();
    const rows = asCountRows(data);

    expect(byName(rows, FN_A)?.error_count).toBe(8);
    expect(byName(rows, FN_B)?.error_count).toBe(2);
  });

  it('D-3: 多い順に並び、どの行にも同じ total_count が付き、全グループを返したときは件数の合計と一致する', async () => {
    const { data, error } = await counts(15, 100);
    expect(error).toBeNull();
    const rows = asCountRows(data);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].error_count).toBeGreaterThanOrEqual(rows[i].error_count);
    }
    const totals = new Set(rows.map((r) => r.total_count));
    expect(totals.size).toBe(1);
    // 共有の DB に他のグループが 100 を超えて混ざらない限り、全グループを返している
    if (rows.length < 100) {
      expect(rows.reduce((sum, r) => sum + r.error_count, 0)).toBe(rows[0].total_count);
    }
    // 自分が入れた 3 + 2 + 1 = 6 件は少なくとも含まれる
    expect(rows[0].total_count).toBeGreaterThanOrEqual(6);
  });

  it('D-4: limit で行数を絞っても、total_count は全グループの合計のまま (上位だけの合計にならない)', async () => {
    const full = asCountRows((await counts(15, 100)).data);
    const top1 = await counts(15, 1);
    expect(top1.error).toBeNull();
    const rows = asCountRows(top1.data);

    expect(rows).toHaveLength(1);
    // 上位 1 グループより大きい合計 = 他のグループも合計に入っている。
    // (同時に他のログが増えることがあるので、直前に全件取った合計以上であることを確かめる)
    expect(rows[0].total_count).toBeGreaterThanOrEqual(full[0].total_count);
    expect(rows[0].total_count).toBeGreaterThan(rows[0].error_count);
    // 先頭は、全件で最も多いグループと同じ件数
    expect(rows[0].error_count).toBeGreaterThanOrEqual(full[0].error_count);
  });

  it('D-5: 返す列は function_name / error_count / total_count だけで、件数は数値 (ログの本文・ユーザー ID は返さない)', async () => {
    const { data, error } = await counts(15, 5);
    expect(error).toBeNull();
    const rows = asCountRows(data);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['error_count', 'function_name', 'total_count']);
      expect(typeof row.error_count).toBe('number');
      expect(typeof row.total_count).toBe('number');
    }
  });

  it('D-6: 引数を省くと既定 (窓 15 分・10 行) で動く', async () => {
    const { data, error } = await counts();
    expect(error).toBeNull();
    const rows = asCountRows(data);
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it('D-7: 窓・limit が範囲外なら 22023', async () => {
    for (const bad of [0, -5, 1441, null]) {
      expect((await counts(bad, 10)).error?.code, `窓 ${String(bad)}`).toBe('22023');
    }
    for (const bad of [0, -1, 101, null]) {
      expect((await counts(15, bad)).error?.code, `limit ${String(bad)}`).toBe('22023');
    }
  });
});
