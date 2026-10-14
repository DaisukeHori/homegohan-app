/**
 * #1217 csat_feedbacks (CSAT フィードバック) の索引の回帰テスト
 *
 * 修正前、csat_feedbacks の索引は主キー (csat_feedbacks_pkey) だけだった。そのため次の 3 つが表全体の走査になった。
 *   (1) 集計 API (GET /api/admin/finance/nps。src/app/api/admin/finance/nps/route.ts) の
 *       「created_at の期間で絞って、新しい順に並べる」問い合わせ
 *   (2) RLS ポリシー csat_access ((user_id = auth.uid()) OR サポート担当・admin・super_admin) の下で、
 *       本人の行を user_id で引く問い合わせ
 *   (3) 外部キー csat_feedbacks_user_id_fkey (auth.users) の確認 (auth.users の行を消すたびに Postgres が内部で流す問い合わせ)
 *
 * 修正後 (20261007160300_csat_feedbacks_indexes.sql) は次の 2 本を足す。
 *   idx_csat_feedbacks_created_at  ON csat_feedbacks (created_at DESC)   ← (1)
 *   idx_csat_feedbacks_user_id     ON csat_feedbacks (user_id)           ← (2) と (3)
 * ticket_id の索引は足さない (ticket_id で引く問い合わせも RLS の条件も無いため)。
 *
 * 確認すること:
 *   A. カタログ: 2 本の索引があり、定義 (btree・列・DESC・部分索引でない) が期待どおりで、有効 (indisvalid)
 *   B. 実行計画: (1)(2)(3) の問い合わせが、その索引を使える
 *      enable_seqscan = off にして確かめる。索引が使える問い合わせなら、行数が少ない環境 (空のテーブル) でも索引が選ばれる
 *   C. 結果が変わらない: RLS の見え方 (本人は自分の行だけ・サポート担当は全件・匿名は 0 件) と、
 *      集計 API と同じ形の問い合わせ (期間 + 新しい順) の結果
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/csat-feedbacks-indexes.test.ts
 *
 * 実行計画・カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
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

/** ローカルスタックの postgres-meta でカタログ・実行計画を読む (読み取り専用の確認にだけ使う) */
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
const IDX_CREATED_AT = 'idx_csat_feedbacks_created_at';
const IDX_USER_ID = 'idx_csat_feedbacks_user_id';

describe('#1217 A. csat_feedbacks の索引 (カタログ)', () => {
  it('created_at (DESC) と user_id の索引があり、定義が期待どおりで、有効である', async () => {
    const rows = await pgQuery<{
      indexname: string;
      indexdef: string;
      indisvalid: boolean;
      indisready: boolean;
      indisunique: boolean;
    }>(`
      SELECT c.relname AS indexname,
             pg_get_indexdef(i.indexrelid) AS indexdef,
             i.indisvalid,
             i.indisready,
             i.indisunique
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'public.csat_feedbacks'::regclass
        AND c.relname IN ('${IDX_CREATED_AT}', '${IDX_USER_ID}')
      ORDER BY c.relname
    `);

    // btree・列・DESC・非 UNIQUE・部分索引でない (WHERE 句が付くと indexdef の末尾に出る)
    expect(rows).toEqual([
      {
        indexname: IDX_CREATED_AT,
        indexdef: `CREATE INDEX ${IDX_CREATED_AT} ON public.csat_feedbacks USING btree (created_at DESC)`,
        indisvalid: true,
        indisready: true,
        indisunique: false,
      },
      {
        indexname: IDX_USER_ID,
        indexdef: `CREATE INDEX ${IDX_USER_ID} ON public.csat_feedbacks USING btree (user_id)`,
        indisvalid: true,
        indisready: true,
        indisunique: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------
// B. 実行計画
// ---------------------------------------------------------------
// 実在しない uuid。実行計画を見るだけで、問い合わせは実行しない (EXPLAIN)
const PLAN_USER_ID = '00000000-0000-4000-8000-000000001217';

/**
 * EXPLAIN の結果 (テキスト) を返す。
 * 1 回の要求は 1 つの接続で 1 つの暗黙トランザクションとして流れるため、SET LOCAL は要求の終わりに消える。
 * asUserId を渡すと authenticated ロール + そのユーザーの JWT claims で計画を立てる (= RLS が効く)。
 */
async function explain(sql: string, asUserId?: string): Promise<string> {
  const roleSetup = asUserId
    ? `SET LOCAL ROLE authenticated;
       SELECT set_config('request.jwt.claims', '{"sub":"${asUserId}","role":"authenticated"}', true);`
    : '';
  const rows = await pgQuery<{ 'QUERY PLAN': string }>(`
    SET LOCAL enable_seqscan = off;
    ${roleSetup}
    EXPLAIN (COSTS OFF) ${sql}
  `);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

describe('#1217 B. csat_feedbacks の索引 (実行計画)', () => {
  it('(1) 集計 API と同じ形 (created_at の期間 + 新しい順) は created_at の索引を使う', async () => {
    const plan = await explain(
      `SELECT id, score, comment, ticket_id, created_at
         FROM public.csat_feedbacks
        WHERE created_at >= '2026-01-01T00:00:00Z' AND created_at <= '2026-12-31T23:59:59Z'
        ORDER BY created_at DESC`,
      PLAN_USER_ID,
    );
    expect(plan).toContain(IDX_CREATED_AT);
    expect(plan).not.toContain('Seq Scan on csat_feedbacks');
  });

  it('(1) 直近 N 件 (ORDER BY created_at DESC LIMIT N) も created_at の索引を使う', async () => {
    const plan = await explain(
      `SELECT id, score, comment, ticket_id, created_at
         FROM public.csat_feedbacks
        ORDER BY created_at DESC LIMIT 10`,
      PLAN_USER_ID,
    );
    expect(plan).toContain(IDX_CREATED_AT);
    expect(plan).not.toContain('Seq Scan on csat_feedbacks');
  });

  it('(2) RLS の下で本人の行を user_id で引く問い合わせは user_id の索引を使う', async () => {
    const plan = await explain(
      `SELECT id, score, comment, created_at FROM public.csat_feedbacks WHERE user_id = '${PLAN_USER_ID}'`,
      PLAN_USER_ID,
    );
    expect(plan).toContain(IDX_USER_ID);
    expect(plan).not.toContain('Seq Scan on csat_feedbacks');
  });

  it('(3) 外部キー csat_feedbacks_user_id_fkey の確認 (auth.users の行を消すとき内部で流れる問い合わせ) は user_id の索引を使う', async () => {
    // ri_triggers.c が NO ACTION の外部キーの確認に使う問い合わせと同じ形
    const plan = await explain(
      `SELECT 1 FROM ONLY public.csat_feedbacks x WHERE x.user_id = '${PLAN_USER_ID}' FOR KEY SHARE OF x`,
    );
    expect(plan).toContain(IDX_USER_ID);
    expect(plan).not.toContain('Seq Scan on csat_feedbacks');
  });
});

// ---------------------------------------------------------------
// C. 結果が変わらないこと (RLS の見え方 + 集計 API と同じ形の問い合わせ)
// ---------------------------------------------------------------
interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const MARK = `csat-idx-${TS}`; // comment の接頭辞。後片付けと検索で「このテストが入れた行だけ」を特定する印
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];
const createdFeedbackIds: string[] = [];

async function createUser(label: string, roles: string[] = ['user']): Promise<TestUser> {
  const email = `rls-csat-idx-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `csat-idx-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function insertFeedback(userId: string, score: number, createdAt: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('csat_feedbacks')
    .insert({ user_id: userId, score, comment: `${MARK} score=${score}`, created_at: createdAt })
    .select('id')
    .single();
  if (error || !data) throw new Error(`csat_feedbacks insert: ${error?.message}`);
  createdFeedbackIds.push(data.id as string);
  return data.id as string;
}

// 本物のデータと重ならないよう、2020 年の日付を使う
const T1 = '2020-03-01T00:00:00Z';
const T2 = '2020-03-02T00:00:00Z';
const T3 = '2020-03-03T00:00:00Z';

let staff: TestUser; // サポート担当 (roles = ['support'])
let userA: TestUser;
let userB: TestUser;
let rowA1 = ''; // userA の古い行
let rowA2 = ''; // userA の新しい行
let rowB1 = ''; // userB の行 (最も新しい)

describe('#1217 C. csat_feedbacks の見え方と集計クエリの結果 (索引を足しても変わらない)', () => {
  beforeAll(async () => {
    [staff, userA, userB] = await Promise.all([
      createUser('staff', ['support']),
      createUser('a'),
      createUser('b'),
    ]);
    rowA1 = await insertFeedback(userA.id, 3, T1);
    rowA2 = await insertFeedback(userA.id, 5, T2);
    rowB1 = await insertFeedback(userB.id, 1, T3);
  }, 60_000);

  afterAll(async () => {
    // csat_feedbacks.user_id の外部キー (ON DELETE なし) があるため、行を先に消してからユーザーを消す
    if (createdFeedbackIds.length > 0) {
      await srAdmin.from('csat_feedbacks').delete().in('id', createdFeedbackIds);
    }
    for (const id of createdUserIds) {
      await srAdmin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  /** このテストが入れた行の id だけを返す (他のデータが混ざっても影響されない) */
  async function visibleIds(c: SupabaseClient, filterUserId?: string): Promise<string[]> {
    let q = c.from('csat_feedbacks').select('id').like('comment', `${MARK}%`);
    if (filterUserId) q = q.eq('user_id', filterUserId);
    const { data, error } = await q;
    expect(error).toBeNull();
    return (data ?? []).map((r) => r.id as string).sort();
  }

  it('本人は自分の行だけ見える (user_id で絞っても、絞らなくても)', async () => {
    expect(await visibleIds(asUser(userA.jwt), userA.id)).toEqual([rowA1, rowA2].sort());
    expect(await visibleIds(asUser(userA.jwt))).toEqual([rowA1, rowA2].sort());
    expect(await visibleIds(asUser(userB.jwt), userB.id)).toEqual([rowB1]);
    expect(await visibleIds(asUser(userB.jwt))).toEqual([rowB1]);
  });

  it('他人の user_id を指定しても、他人の行は見えない', async () => {
    expect(await visibleIds(asUser(userA.jwt), userB.id)).toEqual([]);
    expect(await visibleIds(asUser(userB.jwt), userA.id)).toEqual([]);
  });

  it('サポート担当は全員分の行が見える', async () => {
    expect(await visibleIds(asUser(staff.jwt))).toEqual([rowA1, rowA2, rowB1].sort());
  });

  it('匿名 (anon) は 1 件も見えない', async () => {
    expect(await visibleIds(anon())).toEqual([]);
  });

  it('集計 API と同じ形 (created_at の期間 + 新しい順) の結果が、期間の内側だけを新しい順に返す', async () => {
    const select = (c: SupabaseClient, from: string, to: string) =>
      c
        .from('csat_feedbacks')
        .select('id, score, comment, ticket_id, created_at')
        .like('comment', `${MARK}%`)
        .gte('created_at', from)
        .lte('created_at', to)
        .order('created_at', { ascending: false });

    // 3 行とも入る期間: 新しい順 (B1 → A2 → A1)
    const all = await select(asUser(staff.jwt), '2020-03-01T00:00:00Z', '2020-03-31T00:00:00Z');
    expect(all.error).toBeNull();
    expect((all.data ?? []).map((r) => r.id)).toEqual([rowB1, rowA2, rowA1]);
    expect((all.data ?? []).map((r) => r.score)).toEqual([1, 5, 3]);

    // 期間の端 (含む) と外側 (含まない)
    const middle = await select(asUser(staff.jwt), T2, T2);
    expect((middle.data ?? []).map((r) => r.id)).toEqual([rowA2]);
    const outside = await select(asUser(staff.jwt), '2021-01-01T00:00:00Z', '2021-12-31T00:00:00Z');
    expect(outside.data ?? []).toEqual([]);

    // 一般ユーザーが同じ形で引いても、見えるのは自分の行だけ (新しい順は保たれる)
    const mine = await select(asUser(userA.jwt), '2020-03-01T00:00:00Z', '2020-03-31T00:00:00Z');
    expect((mine.data ?? []).map((r) => r.id)).toEqual([rowA2, rowA1]);
  });
});
