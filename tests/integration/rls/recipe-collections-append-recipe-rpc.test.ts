/**
 * #2183 Z3: レシピのコレクションにレシピを 1 つ足す関数 append_recipe_to_collection (*_recipe_collections_append_recipe_rpc.sql) の
 * 実 DB での振る舞いと、AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) が
 * 同じコレクションへ同時に 2 つのレシピを足しても両方残すこと。
 *
 * 確かめること (I-n はこのファイルの it の番号):
 *   - I-1: カタログ: SECURITY INVOKER・STRICT・RETURNS text・search_path は空。EXECUTE は authenticated だけ
 *          (PUBLIC・anon・service_role には無い)
 *   - I-2: 本人が足すと added で末尾に入る。同じレシピをもう一度足すと already_present で二重に入らない。
 *          recipe_ids が NULL の行にも足せる
 *   - I-3: 他人の行は、非公開でも公開 (is_public) でも not_found で、行は変わらない (RLS で本人の行だけ)。無い id も not_found
 *   - I-4: anon は呼べない (42501、HTTP 401 / 403)
 *   - I-5: 先に足した接続がコミット前のまま行を持っている間に、別のレシピを足す呼び出しは行のロックを待ち、
 *          相手のコミットの後の recipe_ids に足す (両方残る)。同じレシピなら already_present で二重に入らない
 *          (lock-holder で、待ちに並んだのを pg_stat_activity で確かめてから放す。決まった順で再現する)
 *   - I-6: 同じコレクションへ、違うレシピを同時に何本も足しても、全部が 1 回ずつ残る。同じレシピを同時に何本も足すと、
 *          added は 1 本だけで残りは already_present、レシピは 1 回だけ入る
 *   - I-7: executor を同じコレクションへ違うレシピで同時に 2 本実行しても、どちらも成功し、両方のレシピが残る
 *   - I-8: 戻し口を 1 つのトランザクションで流して巻き戻す (DB には残らない): 関数が消える。巻き戻ったあとは関数が残っている
 *
 * 修正前 (migration を流す前) は全部が赤になる (関数が無い。executor は読み直してから書く形で、I-7 は重なり方によって片方のレシピが消える)。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ。executor は関数として呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/recipe-collections-append-recipe-rpc.test.ts
 * カタログ・コミット前の接続・戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ws from 'ws';
import {
  RECIPE_COLLECTION_APPEND_OUTCOME,
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC,
} from '@/lib/recipes/collection-append';
import {
  APPEND_RECIPE_RPC_SIGNATURE,
  RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_MIGRATION_NAME,
} from '../../helpers/recipe-collections-append-recipe-rpc';
import { RECIPE_COLLECTIONS_TABLE } from '../../helpers/recipe-collections-user-name-unique';
import { actAsAuthenticatedSql, createLockHolderKit } from '../helpers/lock-holder';
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

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'z3-append-recipe' });

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'RECIPE_COLLECTIONS_APPEND_RECIPE_RPC_ROLLBACK_RESULT:';
/** 関数の数を数える SQL (戻し口の前後で 1 → 0) */
const FUNCTION_COUNT_SQL = `(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}')`;
/** PostgreSQL の権限の不足の SQLSTATE */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';
/** anon が権限の無い関数を呼んだときに PostgREST が返す HTTP の状態 */
const ANON_DENIED_HTTP_STATUSES = [401, 403];
/** I-6 で同時に足す本数 (PostgREST の接続の数より少なく、重なりが起きるだけの数) */
const CONCURRENT_APPENDS = 8;

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

/** 戻し口を流し、その直後の関数の数を例外の文に載せて、トランザクションごと巻き戻す */
async function functionCountAfterRolledBack(sql: string): Promise<number> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${FUNCTION_COUNT_SQL}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return Number(rest.slice(0, rest.indexOf(';')));
}

async function currentFunctionCount(): Promise<number> {
  const [row] = await pgQuery<{ count: string | number }>(`SELECT ${FUNCTION_COUNT_SQL} AS count;`);
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
const NAME = (key: string) => `z3 collection ${key} ${TS}`;
const LONG = 120_000;

async function createUser(label: string): Promise<TestUser> {
  const email = `z3-2183-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, `createUser ${label}: user_profiles の upsert`, (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `z3-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** service_role でコレクションを 1 件作る */
async function seedCollection(
  userId: string,
  key: string,
  values: { recipe_ids?: string[] | null; is_public?: boolean } = {},
): Promise<string> {
  const { data, error } = await srAdmin
    .from(RECIPE_COLLECTIONS_TABLE)
    .insert({ user_id: userId, name: NAME(key), ...values })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed recipe_collections ${key}: ${error?.message}`);
  return (data as { id: string }).id;
}

/** service_role で recipe_ids を読む */
async function recipeIdsOf(collectionId: string): Promise<string[] | null> {
  const { data, error } = await srAdmin.from(RECIPE_COLLECTIONS_TABLE).select('recipe_ids').eq('id', collectionId).single();
  if (error || !data) throw new Error(`select recipe_collections: ${error?.message}`);
  return (data as { recipe_ids: string[] | null }).recipe_ids;
}

/**
 * 本人の JWT で関数を呼ぶ。PostgREST のビルダーは then だけを持つ (catch が無い) ので、async で本物の Promise にして返す
 * (lock-holder の runBehindHolder が呼び出しの結果に catch を付ける)
 */
async function appendAs(jwt: string, collectionId: string, recipeId: string) {
  return await asUser(jwt).rpc(RECIPE_COLLECTIONS_APPEND_RECIPE_RPC, { p_collection_id: collectionId, p_recipe_id: recipeId });
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

afterEach(() => holders.releaseOpenHolders());

afterAll(async () => {
  await holders.settle();
  for (const id of createdUserIds) {
    await srAdmin.from(RECIPE_COLLECTIONS_TABLE).delete().eq('user_id', id);
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, LONG);

describe('#2183 Z3 append_recipe_to_collection (1 文の条件つき UPDATE)', () => {
  it('I-1: カタログ: SECURITY INVOKER・STRICT・RETURNS text・search_path は空。EXECUTE は authenticated だけ', async () => {
    const rows = await pgQuery<{
      sig: string;
      secdef: boolean;
      strict: boolean;
      rettype: string;
      config: string[] | null;
      public_exec: boolean;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
    }>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             p.prosecdef AS secdef,
             p.proisstrict AS strict,
             p.prorettype::regtype::text AS rettype,
             p.proconfig AS config,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}'
    `);
    expect(rows).toEqual([
      {
        sig: APPEND_RECIPE_RPC_SIGNATURE,
        secdef: false,
        strict: true,
        rettype: 'text',
        config: ['search_path=""'],
        public_exec: false,
        anon_exec: false,
        auth_exec: true,
        sr_exec: false,
      },
    ]);
  });

  it('I-2: 本人が足すと added で末尾に入り、同じレシピは already_present で二重に入らない。NULL の recipe_ids にも足せる', async () => {
    const existing = randomUUID();
    const recipeId = randomUUID();
    const collectionId = await seedCollection(owner.id, 'own', { recipe_ids: [existing] });

    const first = await appendAs(owner.jwt, collectionId, recipeId);
    expect(first.error).toBeNull();
    expect(first.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.added);
    expect(await recipeIdsOf(collectionId)).toEqual([existing, recipeId]);

    const second = await appendAs(owner.jwt, collectionId, recipeId);
    expect(second.error).toBeNull();
    expect(second.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.alreadyPresent);
    expect(await recipeIdsOf(collectionId)).toEqual([existing, recipeId]);

    const nullCollectionId = await seedCollection(owner.id, 'own-null', { recipe_ids: null });
    const intoNull = await appendAs(owner.jwt, nullCollectionId, recipeId);
    expect(intoNull.error).toBeNull();
    expect(intoNull.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.added);
    expect(await recipeIdsOf(nullCollectionId)).toEqual([recipeId]);
  }, LONG);

  it('I-3: 他人の行は非公開でも公開でも not_found で変わらない。無い id も not_found', async () => {
    const existing = randomUUID();
    const recipeId = randomUUID();
    const privateId = await seedCollection(other.id, 'other-private', { recipe_ids: [existing] });
    const publicId = await seedCollection(other.id, 'other-public', { recipe_ids: [existing], is_public: true });

    for (const [collectionId, probe] of [
      [privateId, recipeId],
      [publicId, recipeId],
      // 公開の行に既に入っているレシピでも、本人の行ではないので already_present にしない
      [publicId, existing],
    ] as const) {
      const res = await appendAs(owner.jwt, collectionId, probe);
      expect(res.error).toBeNull();
      expect(res.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.notFound);
      expect(await recipeIdsOf(collectionId)).toEqual([existing]);
    }

    const missing = await appendAs(owner.jwt, randomUUID(), recipeId);
    expect(missing.error).toBeNull();
    expect(missing.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.notFound);
  }, LONG);

  it('I-4: anon は呼べない (42501、HTTP 401 / 403)', async () => {
    const collectionId = await seedCollection(owner.id, 'anon-target', { recipe_ids: [] });
    const { data, error, status } = await anon().rpc(RECIPE_COLLECTIONS_APPEND_RECIPE_RPC, {
      p_collection_id: collectionId,
      p_recipe_id: randomUUID(),
    });
    expect(error?.code, error?.message).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(ANON_DENIED_HTTP_STATUSES).toContain(status);
    expect(data).toBeNull();
    expect(await recipeIdsOf(collectionId)).toEqual([]);
  }, LONG);

  it('I-5: 先に足した接続がコミット前のまま行を持つ間に足すと、行のロックを待ってから相手の後に足す (両方残る・同じレシピは 1 回)', async () => {
    const firstRecipe = randomUUID();
    const secondRecipe = randomUUID();
    const collectionId = await seedCollection(owner.id, 'held', { recipe_ids: [] });

    const holdingAppend = (recipeId: string) =>
      holders.startHolder(
        '先にレシピを足してコミット前のまま開いておく接続',
        `${actAsAuthenticatedSql(owner.id)}
         SELECT public.${RECIPE_COLLECTIONS_APPEND_RECIPE_RPC}('${collectionId}'::uuid, '${recipeId}'::uuid);`,
      );

    // 違うレシピ: 待った方は、相手のコミットの後の recipe_ids に対して条件を確かめ直して足す
    const [held, waited] = await holders.runBehindHolder(holdingAppend(firstRecipe), {
      fn: RECIPE_COLLECTIONS_APPEND_RECIPE_RPC,
      call: () => appendAs(owner.jwt, collectionId, secondRecipe),
    });
    expect(held.ok, held.message ?? '').toBe(true);
    expect(waited.error).toBeNull();
    expect(waited.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.added);
    expect(await recipeIdsOf(collectionId)).toEqual([firstRecipe, secondRecipe]);

    // 同じレシピ: 待った方は、相手が足した後の値で「既に入っている」になり、二重に入らない
    const sameRecipe = randomUUID();
    const [heldSame, waitedSame] = await holders.runBehindHolder(holdingAppend(sameRecipe), {
      fn: RECIPE_COLLECTIONS_APPEND_RECIPE_RPC,
      call: () => appendAs(owner.jwt, collectionId, sameRecipe),
    });
    expect(heldSame.ok, heldSame.message ?? '').toBe(true);
    expect(waitedSame.error).toBeNull();
    expect(waitedSame.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.alreadyPresent);
    expect(await recipeIdsOf(collectionId)).toEqual([firstRecipe, secondRecipe, sameRecipe]);
  }, LONG);

  it('I-6: 違うレシピを同時に何本も足すと全部が 1 回ずつ残り、同じレシピを同時に何本も足すと added は 1 本だけ', async () => {
    const collectionId = await seedCollection(owner.id, 'concurrent', { recipe_ids: [] });
    const recipeIds = Array.from({ length: CONCURRENT_APPENDS }, () => randomUUID());
    const distinct = await Promise.all(recipeIds.map((recipeId) => appendAs(owner.jwt, collectionId, recipeId)));
    for (const res of distinct) {
      expect(res.error).toBeNull();
      expect(res.data).toBe(RECIPE_COLLECTION_APPEND_OUTCOME.added);
    }
    const afterDistinct = await recipeIdsOf(collectionId);
    expect([...(afterDistinct ?? [])].sort()).toEqual([...recipeIds].sort());

    const sameRecipe = randomUUID();
    const same = await Promise.all(
      Array.from({ length: CONCURRENT_APPENDS }, () => appendAs(owner.jwt, collectionId, sameRecipe)),
    );
    for (const res of same) expect(res.error).toBeNull();
    const outcomes = same.map((res) => res.data);
    expect(outcomes.filter((o) => o === RECIPE_COLLECTION_APPEND_OUTCOME.added)).toHaveLength(1);
    expect(outcomes.filter((o) => o === RECIPE_COLLECTION_APPEND_OUTCOME.alreadyPresent)).toHaveLength(CONCURRENT_APPENDS - 1);
    const afterSame = (await recipeIdsOf(collectionId)) ?? [];
    expect(afterSame.filter((id) => id === sameRecipe)).toHaveLength(1);
    expect(afterSame).toHaveLength(CONCURRENT_APPENDS + 1);
  }, LONG);

  it('I-7: executor を同じコレクションへ違うレシピで同時に 2 本実行しても、どちらも成功して両方のレシピが残る', async () => {
    const existing = randomUUID();
    const collectionId = await seedCollection(owner.id, 'executor', { recipe_ids: [existing] });
    const recipeA = randomUUID();
    const recipeB = randomUUID();
    const results = await Promise.all(
      [recipeA, recipeB].map((recipeId) =>
        runConsultationAction(asUser(owner.jwt), { id: owner.id }, addToCollectionAction(owner.id, recipeId, NAME('executor'))),
      ),
    );
    for (const outcome of results) {
      expect(outcome).toMatchObject({ success: true, result: { collectionId, added: true } });
    }
    const ids = (await recipeIdsOf(collectionId)) ?? [];
    expect(ids[0]).toBe(existing);
    expect([...ids].sort()).toEqual([existing, recipeA, recipeB].sort());
  }, LONG);

  it('I-8: 戻し口を 1 つのトランザクションで流して巻き戻す。関数が消え、巻き戻ったあとは関数が残っている', async () => {
    expect(await functionCountAfterRolledBack(readRollback())).toBe(0);
    expect(await currentFunctionCount()).toBe(1);
  }, LONG);
});
