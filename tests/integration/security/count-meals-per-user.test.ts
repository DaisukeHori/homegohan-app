/**
 * #1491 利用者ごとの meals の件数を数える DB の関数 public.count_meals_per_user() の回帰テスト
 *
 * 背景:
 *   比較ランキングの集計 (Edge Function calculate-segment-stats) は、指標 total_meals のために、毎回 meals の全行を
 *   1000 行ずつ読み、関数の中で数えていた (集計は 1 時間ごとに 3〜6 本並行して動く)。
 *   migration 20261011060000_count_meals_per_user.sql で、DB の中で数えて利用者ごとに 1 行を返す関数を足した。
 *   全利用者の件数を返すので、service role だけが呼べる。
 *
 * 確かめること (ローカル Supabase の実 DB で):
 *   A. service role は呼べて、利用者ごとに (user_id, meal_count) を 1 行ずつ返す。件数は全期間 (期間で絞らない)。
 *      記録の無い利用者の行は無い。運営が隠した行は数えない (#1445。migration 20261011120000)
 *   B. user_id の順に並べ、range でページ送りできる (Edge Function の fetchAllRows が上限 1000 行を超えたときに使う)
 *   C. 未ログイン (anon)・ログインユーザー (authenticated) は呼べない (42501)。他人の記録の件数を読めない
 *   D. EXECUTE の権限: PUBLIC / anon / authenticated は無く、service_role だけにある (postgres-meta で読み取りだけ確かめる)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。本番には接続しない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/count-meals-per-user.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const RPC = 'count_meals_per_user';
const FUNCTION_SIGNATURE = 'public.count_meals_per_user()';
/** PostgreSQL の「権限が無い」(insufficient_privilege) */
const PERMISSION_DENIED = '42501';

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
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];

interface TestUser {
  id: string;
  jwt: string;
}

async function createUser(label: string): Promise<TestUser> {
  const email = `it1491-${label}-${TS}@homegohan.test`;
  const { data, error } = await sr.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await sr
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `it1491-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

interface CountRow {
  user_id: string;
  meal_count: number | string;
}

let many: TestUser; // 3 件 (1 年以上前の記録を含む)
let one: TestUser; // 1 件
let none: TestUser; // 0 件

beforeAll(async () => {
  many = await createUser('many');
  one = await createUser('one');
  none = await createUser('none');
  const { error } = await sr.from('meals').insert([
    { user_id: many.id, eaten_at: '2025-01-15T03:00:00Z', meal_type: 'lunch' },
    { user_id: many.id, eaten_at: '2026-10-01T03:00:00Z', meal_type: 'lunch' },
    { user_id: many.id, eaten_at: '2026-10-08T10:00:00Z', meal_type: 'dinner' },
    { user_id: one.id, eaten_at: '2026-10-08T23:00:00Z', meal_type: 'breakfast' },
  ]);
  if (error) throw new Error(`meals: ${error.message}`);
}, 120_000);

afterAll(async () => {
  // ユーザーを消すと meals も CASCADE で消える
  for (const id of createdUserIds) await sr.auth.admin.deleteUser(id);
}, 120_000);

/** service role で全件 (ページ送りなし) を取り、このテストの利用者の件数だけを返す */
async function countsOfTestUsers(): Promise<Map<string, number>> {
  const { data, error } = await sr.rpc(RPC).in('user_id', createdUserIds);
  expect(error).toBeNull();
  return new Map(((data ?? []) as CountRow[]).map((r) => [r.user_id, Number(r.meal_count)]));
}

describe('count_meals_per_user: 利用者ごとの meals の件数 (#1491)', () => {
  it('A: service role は呼べて、利用者ごとに全期間の件数を 1 行ずつ返す。記録の無い利用者の行は無い', async () => {
    const counts = await countsOfTestUsers();
    expect(counts.get(many.id)).toBe(3);
    expect(counts.get(one.id)).toBe(1);
    expect(counts.has(none.id)).toBe(false);
    expect(counts.size).toBe(2);
  });

  it('A2: 記録を足すと、次の呼び出しの件数に入る (集計の結果を保存しているのではなく、呼ぶたびに数える)', async () => {
    const { error } = await sr.from('meals').insert({ user_id: none.id, eaten_at: '2026-10-09T03:00:00Z', meal_type: 'lunch' });
    expect(error).toBeNull();
    const counts = await countsOfTestUsers();
    expect(counts.get(none.id)).toBe(1);
    const { error: deleteError } = await sr.from('meals').delete().eq('user_id', none.id);
    expect(deleteError).toBeNull();
  });

  it('A3: 運営が隠した食事 (hidden_at が入った行。#1101) は数えない。隠した記録しかない利用者の行は無い (#1445。migration 20261011120000)', async () => {
    const hiddenAt = '2026-10-10T00:00:00Z';
    const { data: inserted, error } = await sr
      .from('meals')
      .insert([
        { user_id: one.id, eaten_at: '2026-10-09T03:00:00Z', meal_type: 'lunch' },
        { user_id: none.id, eaten_at: '2026-10-09T03:00:00Z', meal_type: 'lunch' },
      ])
      .select('id');
    expect(error).toBeNull();
    const insertedIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id);
    expect(insertedIds).toHaveLength(2);
    // 運営と同じく service role で隠す (hidden_* を書けるのは service role だけ。guard_hidden_content_columns)
    const { error: hideError } = await sr
      .from('meals')
      .update({ hidden_at: hiddenAt, hidden_reason: 'moderation:delete_only' })
      .in('id', insertedIds);
    expect(hideError).toBeNull();

    try {
      const counts = await countsOfTestUsers();
      expect(counts.get(many.id)).toBe(3);
      // one: 見える 1 件 + 隠した 1 件 → 1
      expect(counts.get(one.id)).toBe(1);
      // none: 隠した記録だけ → 行が無い (記録の無い利用者と同じ)
      expect(counts.has(none.id)).toBe(false);
    } finally {
      const { error: deleteError } = await sr.from('meals').delete().in('id', insertedIds);
      expect(deleteError).toBeNull();
    }
  });

  it('B: user_id の順に並べて range でページ送りでき、ページをつなぐと全件と同じになる (fetchAllRows が使う形)', async () => {
    const { data: all, error } = await sr.rpc(RPC).order('user_id');
    expect(error).toBeNull();
    const allRows = (all ?? []) as CountRow[];
    expect(allRows.length).toBeGreaterThanOrEqual(2);
    // user_id は 1 人 1 行
    expect(new Set(allRows.map((r) => r.user_id)).size).toBe(allRows.length);

    const pageSize = 1;
    const paged: CountRow[] = [];
    for (let from = 0; from < allRows.length + pageSize; from += pageSize) {
      const { data, error: pageError } = await sr.rpc(RPC).order('user_id').range(from, from + pageSize - 1);
      expect(pageError).toBeNull();
      const rows = (data ?? []) as CountRow[];
      if (rows.length === 0) break;
      paged.push(...rows);
    }
    expect(paged.map((r) => [r.user_id, Number(r.meal_count)])).toEqual(allRows.map((r) => [r.user_id, Number(r.meal_count)]));
  });

  it('C1: 未ログイン (anon) は呼べない (42501)', async () => {
    const { data, error } = await client(anonKey).rpc(RPC);
    expect(error?.code, error?.message).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it('C2: ログインユーザー (authenticated) も呼べない (42501)。自分の件数だけでも、他人の件数でも読めない', async () => {
    const { data, error } = await client(anonKey, one.jwt).rpc(RPC);
    expect(error?.code, error?.message).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it('D: EXECUTE は service_role だけ (PUBLIC / anon / authenticated には無い)。SECURITY INVOKER で search_path を固定している', async () => {
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
