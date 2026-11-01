/**
 * #2178 Y3-b: recipe_collections の一意の索引 (user_id, name) (*_recipe_collections_user_name_unique.sql) の実 DB での振る舞いと、
 * AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) が同じ名前のコレクションを作らないこと。
 *
 * 確かめること (I-n はこのファイルの it の番号):
 *   - I-1: カタログ: recipe_collections に一意の索引 recipe_collections_user_id_name_key (user_id, name) があり、部分索引ではない
 *   - I-2: 本人のクライアントで同じ名前の 2 件目を insert すると一意の違反 (23505)。違う名前・ほかの利用者の同じ名前は作れる
 *   - I-3: executor の作り方 (onConflict = 索引の列の upsert) は、同じ名前の行が既にあれば、その行を返して行を増やさない
 *          (PostgREST の on_conflict が索引から推論できる = 42P10 にならない。recipe_ids には触れない)
 *   - I-4: executor を同じ名前で 2 回続けて実行しても、コレクションは 1 件で、レシピは 1 回だけ入る
 *   - I-5: executor を同じ新しい名前で同時に 2 本実行しても、どちらも成功し、コレクションは 1 件
 *          (読んでから作るまでに相手が作っても、一意の違反で失敗せずにその行を使う。どの順に重なってもこの結果になる)
 *   - I-6: 戻し口を 1 つのトランザクションで流して巻き戻す (DB には残らない): 索引が消える。巻き戻ったあとは索引が残っている
 *
 * 修正前 (migration を流す前) は I-1・I-2・I-3 が赤になる (索引が無い・2 件目が作れる・on_conflict が 42P10)。
 * 索引だけを入れて executor を直す前 (insert のまま) は、I-5 が重なり方によって赤になる (片方が 23505 で失敗する)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ。executor は関数として呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/recipe-collections-user-name-unique.test.ts
 * カタログと戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';
import {
  RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX,
} from '@/lib/recipes/collections';
import {
  RECIPE_COLLECTIONS_TABLE,
  RECIPE_COLLECTIONS_USER_NAME_UNIQUE_MIGRATION_NAME,
  UNIQUE_VIOLATION_SQLSTATE,
} from '../../helpers/recipe-collections-user-name-unique';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

// 献立生成のエンジン切り替え (#1148) はこのアクションに関係しないので OFF 固定 (feature_flags を読みに行かない)
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

import { runConsultationAction, type ConsultationActionRow } from '@/lib/ai/consultation-action-executor';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
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

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'RECIPE_COLLECTIONS_USER_NAME_UNIQUE_ROLLBACK_RESULT:';
/** 索引の数を数える SQL (戻し口の前後で 1 → 0) */
const INDEX_COUNT_SQL = `(SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${RECIPE_COLLECTIONS_TABLE}' AND indexname = '${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX}')`;

function findMarkedText(body: unknown): string | null {
  if (typeof body === 'string') return body.includes(ROLLBACK_RESULT_MARKER) ? body : null;
  if (body && typeof body === 'object') {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const found = findMarkedText(value);
      if (found) return found;
    }
  }
  return null;
}

/** 戻し口を流し、その直後の索引の数を例外の文に載せて、トランザクションごと巻き戻す */
async function indexCountAfterRolledBack(sql: string): Promise<number> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${INDEX_COUNT_SQL}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return Number(rest.slice(0, rest.indexOf(';')));
}

async function currentIndexCount(): Promise<number> {
  const [row] = await pgQuery<{ count: string | number }>(`SELECT ${INDEX_COUNT_SQL} AS count;`);
  return Number(row.count);
}

// ---------------------------------------------------------------
// テストユーザー
// ---------------------------------------------------------------
interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
/** この実行で使うコレクションの名前 (他の実行の行と混ざらないように実行の印を付ける) */
const NAME = (key: string) => `y3 collection ${key} ${TS}`;
const LONG = 120_000;

async function createUser(label: string): Promise<TestUser> {
  const email = `y3-2178-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, `createUser ${label}: user_profiles の upsert`, (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `y3-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** 利用者のこの名前のコレクションを service_role で読む (作った日時の順) */
async function collectionsNamed(userId: string, name: string): Promise<Array<{ id: string; recipe_ids: string[] | null }>> {
  const { data, error } = await srAdmin
    .from(RECIPE_COLLECTIONS_TABLE)
    .select('id, recipe_ids')
    .eq('user_id', userId)
    .eq('name', name)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`select recipe_collections: ${error.message}`);
  return (data ?? []) as Array<{ id: string; recipe_ids: string[] | null }>;
}

function addToCollectionAction(userId: string, recipeId: string, collectionName: string): ConsultationActionRow {
  return {
    id: randomUUID(),
    action_type: 'add_recipe_to_collection',
    action_params: { recipeId, collectionName },
    ai_consultation_sessions: { user_id: userId },
  };
}

let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  [owner, other] = await Promise.all([createUser('owner'), createUser('other')]);
}, LONG);

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.from(RECIPE_COLLECTIONS_TABLE).delete().eq('user_id', id);
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, LONG);

describe('#2178 Y3-b recipe_collections の一意の索引 (user_id, name)', () => {
  it('I-1: カタログ: 一意の索引 (user_id, name) があり、部分索引ではない', async () => {
    const rows = await pgQuery<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${RECIPE_COLLECTIONS_TABLE}' AND indexname = '${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX}';`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toBe(
      `CREATE UNIQUE INDEX ${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_INDEX} ON public.${RECIPE_COLLECTIONS_TABLE} USING btree (${RECIPE_COLLECTIONS_USER_NAME_UNIQUE_COLUMNS.join(', ')})`,
    );
  });

  it('I-2: 本人が同じ名前の 2 件目を insert すると一意の違反。違う名前・ほかの利用者の同じ名前は作れる', async () => {
    const db = asUser(owner.jwt);
    const first = await db.from(RECIPE_COLLECTIONS_TABLE).insert({ user_id: owner.id, name: NAME('dup') }).select('id').single();
    expect(first.error).toBeNull();
    const second = await db.from(RECIPE_COLLECTIONS_TABLE).insert({ user_id: owner.id, name: NAME('dup') }).select('id').single();
    expect(second.error?.code).toBe(UNIQUE_VIOLATION_SQLSTATE);
    const otherName = await db.from(RECIPE_COLLECTIONS_TABLE).insert({ user_id: owner.id, name: NAME('dup-2') }).select('id').single();
    expect(otherName.error).toBeNull();
    const otherUser = await asUser(other.jwt).from(RECIPE_COLLECTIONS_TABLE).insert({ user_id: other.id, name: NAME('dup') }).select('id').single();
    expect(otherUser.error).toBeNull();
    expect(await collectionsNamed(owner.id, NAME('dup'))).toHaveLength(1);
    expect(await collectionsNamed(other.id, NAME('dup'))).toHaveLength(1);
  }, LONG);

  it('I-3: executor の作り方 (onConflict = 索引の列の upsert) は、既にある同じ名前の行を返し、行も recipe_ids も変えない', async () => {
    const db = asUser(owner.jwt);
    const recipeId = randomUUID();
    const seeded = await db
      .from(RECIPE_COLLECTIONS_TABLE)
      .insert({ user_id: owner.id, name: NAME('upsert'), recipe_ids: [recipeId] })
      .select('id')
      .single();
    expect(seeded.error).toBeNull();
    const upserted = await db
      .from(RECIPE_COLLECTIONS_TABLE)
      .upsert({ user_id: owner.id, name: NAME('upsert') }, { onConflict: RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET })
      .select('id')
      .single();
    expect(upserted.error).toBeNull();
    expect(upserted.data?.id).toBe(seeded.data?.id);
    expect(await collectionsNamed(owner.id, NAME('upsert'))).toEqual([{ id: seeded.data?.id, recipe_ids: [recipeId] }]);
  }, LONG);

  it('I-4: executor を同じ名前で 2 回続けて実行しても、コレクションは 1 件で、レシピは 1 回だけ入る', async () => {
    const db = asUser(owner.jwt);
    const recipeId = randomUUID();
    const first = await runConsultationAction(db, { id: owner.id }, addToCollectionAction(owner.id, recipeId, NAME('serial')));
    const second = await runConsultationAction(db, { id: owner.id }, addToCollectionAction(owner.id, recipeId, NAME('serial')));
    const rows = await collectionsNamed(owner.id, NAME('serial'));
    expect(rows).toHaveLength(1);
    expect(first).toMatchObject({ success: true, result: { collectionId: rows[0].id, added: true } });
    expect(second).toMatchObject({ success: true, result: { collectionId: rows[0].id, added: true } });
    expect(rows[0].recipe_ids).toEqual([recipeId]);
  }, LONG);

  it('I-5: executor を同じ新しい名前で同時に 2 本実行しても、どちらも成功し、コレクションは 1 件', async () => {
    const recipeId = randomUUID();
    const results = await Promise.all(
      [asUser(owner.jwt), asUser(owner.jwt)].map((db) =>
        runConsultationAction(db, { id: owner.id }, addToCollectionAction(owner.id, recipeId, NAME('concurrent'))),
      ),
    );
    const rows = await collectionsNamed(owner.id, NAME('concurrent'));
    expect(rows).toHaveLength(1);
    for (const outcome of results) {
      expect(outcome).toMatchObject({ success: true, result: { collectionId: rows[0].id, added: true } });
    }
    expect(rows[0].recipe_ids).toEqual([recipeId]);
  }, LONG);

  it('I-6: 戻し口を 1 つのトランザクションで流して巻き戻す。索引が消え、巻き戻ったあとは索引が残っている', async () => {
    expect(await indexCountAfterRolledBack(readRollback())).toBe(0);
    expect(await currentIndexCount()).toBe(1);
  }, LONG);
});
