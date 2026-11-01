/**
 * cross/25 (#2166 X1): recipe_comments の SELECT のポリシーを「そのコメントのレシピを読める人」と「書いた本人」に絞る migration
 * (*_recipe_comments_select_scope.sql) の実 DB での振る舞い。設計: docs/design/cross/25-recipe-comments-select-scope.md §7.5
 *
 * 修正前 (migration を流す前) は I-2・I-3・I-4・I-6・I-8・I-9・I-11 が赤になる (他人に全行が見える・ポリシーの名前が違う)。I-6 が途中で落ちると I-10 も連鎖で赤になる。
 *
 * 登場する人 (設計書 §0.3): A = レシピの作者、C = コメントを書いた人、V = ほかのログインした利用者、anon = 未ログイン、SR = service_role。
 * レシピ (system* の 3 つは作者なし。ほかは A のもの): publicVisible・privateRecipe・publicHidden・privateHidden・systemVisible・systemPrivate・systemHidden。
 *   systemPrivate は作者なし・非公開・隠していない (設計書 §9.1 の P-7a)。recipes の RLS が全員に返すので、コメントも他人に見える (設計書 §6.8)。
 * コメント: C が 7 つのレシピすべてに 1 件ずつ。V が publicVisible と privateRecipe に 1 件ずつ。
 *
 * 確かめること (I-n はこのファイルの it の番号。括弧の S-n は設計書 §0.3 のシナリオ):
 *   - I-1 (S-7): anon は 0 行 (エラーにならない)
 *   - I-2 (S-1・S-2・S-5・S-14・S-17): V は、誰にでも読めるレシピ (作者のいる公開で隠されていないもの・作者のいない隠されていないもの) のコメントと、自分のコメントだけを読める
 *   - I-3 (S-3): C は自分のコメントを全部 (非公開・隠したレシピへのものを含む) と、公開のレシピへの V のコメントを読める
 *   - I-4 (S-4・S-5): A は自分のレシピ (非公開・隠したものを含む) へのコメントを全部読める。作者のいない隠したレシピのコメントは読めない
 *   - I-5: SR は全行を読める
 *   - I-6 (S-2・S-6): A が非公開に戻す・公開に戻す、運営が隠す・戻すで、V の見え方が追随する。行は消えない
 *   - I-7 (S-11・S-13): C は見えないレシピへの自分のコメントを消せる・直せる。V は C のコメントを消せない・直せない (0 行)
 *   - I-8 (S-12): C は見えないレシピへ INSERT ... RETURNING (insert().select()) できる (本人の行の句が RETURNING を通す)
 *   - I-9: カタログ: recipe_comments のポリシーは 4 本で、SELECT は新しい名前・TO authenticated・USING が正典の形。recipes のポリシーは変わっていない
 *   - I-10 (S-9・S-17): PostgREST の埋め込み (recipes → recipe_comments) は、見えるレシピとそのコメントだけを返す
 *   - I-11 (S-16): 戻し口を 1 つのトランザクションで流して巻き戻す (DB には残らない): 旧ポリシー (USING true) に戻る。巻き戻ったあとの DB は本冊が当たったまま
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/recipe-comments-select-scope.test.ts
 * カタログと戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 作った行とユーザーは afterAll で消す。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import {
  INSUFFICIENT_PRIVILEGE_SQLSTATE,
  RECIPE_COMMENTS_LEGACY_SELECT_POLICY,
  RECIPE_COMMENTS_OTHER_POLICIES,
  RECIPE_COMMENTS_SELECT_POLICY,
  RECIPE_COMMENTS_SELECT_QUAL,
  RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME,
  RECIPE_COMMENTS_TABLE,
  RECIPES_PUBLIC_SELECT_POLICY,
  RECIPES_PUBLIC_SELECT_USING,
  foldSql,
} from '../../helpers/recipe-comments-select-scope';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${RECIPE_COMMENTS_SELECT_SCOPE_MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'RECIPE_COMMENTS_SELECT_SCOPE_ROLLBACK_RESULT:';

type PolicyRow = { policyname: string; roles: string; cmd: string; qual: string | null; with_check: string | null };
/** recipe_comments のポリシーを json の 1 行で読む SQL (結果の json は PolicyRow の配列) */
const POLICIES_JSON = `(SELECT coalesce(json_agg(json_build_object('policyname', policyname, 'roles', roles::text, 'cmd', cmd, 'qual', qual, 'with_check', with_check) ORDER BY policyname), '[]'::json)
   FROM pg_policies WHERE schemaname = 'public' AND tablename = '${RECIPE_COMMENTS_TABLE}')`;

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

/** 戻し口を流し、その直後の recipe_comments のポリシーを例外の文に載せて、トランザクションごと巻き戻す */
async function policiesAfterRolledBack(sql: string): Promise<PolicyRow[]> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%', ${POLICIES_JSON}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const json = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return JSON.parse(json.slice(0, json.lastIndexOf(']') + 1)) as PolicyRow[];
}

async function currentPolicies(): Promise<PolicyRow[]> {
  const [row] = await pgQuery<{ policies: string }>(`SELECT ${POLICIES_JSON}::text AS policies;`);
  return JSON.parse(row.policies) as PolicyRow[];
}

// ---------------------------------------------------------------
// テストユーザー・レシピ・コメント
// ---------------------------------------------------------------
interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdRecipeIds: string[] = [];
const RECIPE_NAME = (key: string) => `cross25 recipe ${key} ${TS}`;
const COMMENT = (who: string, key: string) => `cross25 comment ${who} ${key} ${TS}`;
/** 評価 (recipe_comments の検査は 1〜5) */
const RATING = 4;
const LONG = 120_000;

async function createUser(label: string): Promise<TestUser> {
  const email = `cross25-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, `createUser ${label}: user_profiles の upsert`, (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: `cross25-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function insertRecipe(userId: string | null, key: string, isPublic: boolean, hidden: boolean): Promise<string> {
  const { data, error } = await srAdmin
    .from('recipes')
    .insert({ user_id: userId, name: RECIPE_NAME(key), is_public: isPublic })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert recipe ${key}: ${error?.message}`);
  const id = data.id as string;
  createdRecipeIds.push(id);
  if (hidden) await setRecipe(id, { hidden_at: new Date().toISOString(), hidden_reason: 'moderation:delete_only' });
  return id;
}

/** レシピの公開・隠しの状態を運営 (service_role) の権限で書く (hidden_* は特権列。本人は書けない) */
async function setRecipe(id: string, patch: { is_public?: boolean; hidden_at?: string | null; hidden_reason?: string | null }) {
  const { error } = await srAdmin.from('recipes').update(patch).eq('id', id);
  if (error) throw new Error(`update recipe ${id}: ${error.message}`);
}

async function insertComment(userId: string, recipeId: string, content: string): Promise<string> {
  const { data, error } = await srAdmin
    .from(RECIPE_COMMENTS_TABLE)
    .insert({ recipe_id: recipeId, user_id: userId, content, rating: RATING })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert comment ${content}: ${error?.message}`);
  return data.id as string;
}

/** この実行のコメントだけを読み、本文の並び (JS の既定の sort = 符号位置の順。期待値の .sort() と同じ) で返す (db は読む人のクライアント) */
async function contentsAs(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from(RECIPE_COMMENTS_TABLE).select('content').like('content', `cross25 comment % ${TS}`);
  if (error) throw new Error(`select recipe_comments: ${error.message}`);
  return (data ?? []).map((r) => r.content as string).sort();
}

/** ポリシーの (名前, 種類) を名前の符号位置の順に並べる (DB の照合順に頼らない。両辺を同じ順にして比べる) */
const byPolicyName = (rows: ReadonlyArray<readonly [string, string]>): Array<[string, string]> =>
  rows.map(([name, cmd]) => [name, cmd] as [string, string]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

let author: TestUser; // A
let commenter: TestUser; // C
let viewer: TestUser; // V
const recipes = { publicVisible: '', privateRecipe: '', publicHidden: '', privateHidden: '', systemVisible: '', systemPrivate: '', systemHidden: '' };
type RecipeKey = keyof typeof recipes;
const RECIPE_KEYS = Object.keys(recipes) as RecipeKey[];
const commentIds: Record<string, string> = {};

/** C が 7 つ全部に書いたコメントの本文 */
const C_ALL = () => RECIPE_KEYS.map((k) => COMMENT('C', k)).sort();
/** 誰にでも読めるレシピ (作者のいる公開で隠されていないもの・作者のいない隠されていないもの) のコメント (C と V の分) */
const READABLE_BY_ANYONE = () =>
  [COMMENT('C', 'publicVisible'), COMMENT('C', 'systemVisible'), COMMENT('C', 'systemPrivate'), COMMENT('V', 'publicVisible')].sort();

beforeAll(async () => {
  [author, commenter, viewer] = await Promise.all([createUser('author'), createUser('commenter'), createUser('viewer')]);
  recipes.publicVisible = await insertRecipe(author.id, 'publicVisible', true, false);
  recipes.privateRecipe = await insertRecipe(author.id, 'privateRecipe', false, false);
  recipes.publicHidden = await insertRecipe(author.id, 'publicHidden', true, true);
  recipes.privateHidden = await insertRecipe(author.id, 'privateHidden', false, true);
  recipes.systemVisible = await insertRecipe(null, 'systemVisible', true, false);
  recipes.systemPrivate = await insertRecipe(null, 'systemPrivate', false, false);
  recipes.systemHidden = await insertRecipe(null, 'systemHidden', true, true);
  for (const key of RECIPE_KEYS) commentIds[`C:${key}`] = await insertComment(commenter.id, recipes[key], COMMENT('C', key));
  commentIds['V:publicVisible'] = await insertComment(viewer.id, recipes.publicVisible, COMMENT('V', 'publicVisible'));
  commentIds['V:privateRecipe'] = await insertComment(viewer.id, recipes.privateRecipe, COMMENT('V', 'privateRecipe'));
}, LONG);

afterAll(async () => {
  // コメントはレシピの削除 (ON DELETE CASCADE) でも消えるが、先に明示的に消す。途中で落ちて id を控えそこねた行も本文で拾う
  await srAdmin.from(RECIPE_COMMENTS_TABLE).delete().like('content', `cross25 comment % ${TS}`);
  if (createdRecipeIds.length > 0) await srAdmin.from('recipes').delete().in('id', createdRecipeIds);
  await srAdmin.from('recipes').delete().like('name', `cross25 recipe % ${TS}`);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, LONG);

describe('I-1〜I-5: 読める行', () => {
  it('I-1 (S-7): anon は 0 行 (エラーにならない)', async () => {
    const { data, error } = await anon().from(RECIPE_COMMENTS_TABLE).select('id').like('content', `cross25 comment % ${TS}`);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('I-2 (S-1・S-2・S-5・S-14・S-17): V は誰にでも読めるレシピのコメント (作者のいない非公開のものを含む) と、自分のコメントだけを読める', async () => {
    expect(await contentsAs(asUser(viewer.jwt))).toEqual([...READABLE_BY_ANYONE(), COMMENT('V', 'privateRecipe')].sort());
  });

  it('I-3 (S-3): C は自分のコメントを全部 (非公開・隠したレシピへのものを含む) と、公開のレシピへの V のコメントを読める', async () => {
    expect(await contentsAs(asUser(commenter.jwt))).toEqual([...C_ALL(), COMMENT('V', 'publicVisible')].sort());
  });

  it('I-4 (S-4・S-5): A は自分のレシピへのコメントを全部読める。作者のいない隠したレシピのコメントは読めない', async () => {
    const own = ['publicVisible', 'privateRecipe', 'publicHidden', 'privateHidden'] as const;
    const expected = [
      ...own.map((k) => COMMENT('C', k)),
      COMMENT('C', 'systemVisible'),
      COMMENT('C', 'systemPrivate'),
      COMMENT('V', 'publicVisible'),
      COMMENT('V', 'privateRecipe'),
    ].sort();
    expect(await contentsAs(asUser(author.jwt))).toEqual(expected);
  });

  it('I-5: service_role は全行を読める', async () => {
    expect(await contentsAs(srAdmin)).toEqual([...C_ALL(), COMMENT('V', 'publicVisible'), COMMENT('V', 'privateRecipe')].sort());
  });
});

describe('I-6: レシピの状態の切り替えに追随する (行は消えない)', () => {
  it('I-6 (S-2・S-6): 非公開に戻す → 公開に戻す、隠す → 戻す で V の見え方が変わる', async () => {
    const seesC = async (key: RecipeKey) => (await contentsAs(asUser(viewer.jwt))).includes(COMMENT('C', key));
    expect(await seesC('publicVisible'), '切り替える前').toBe(true);
    await setRecipe(recipes.publicVisible, { is_public: false });
    expect(await seesC('publicVisible'), '本人が非公開に戻した').toBe(false);
    await setRecipe(recipes.publicVisible, { is_public: true });
    expect(await seesC('publicVisible'), '公開に戻した').toBe(true);
    await setRecipe(recipes.publicVisible, { hidden_at: new Date().toISOString(), hidden_reason: 'moderation:delete_only' });
    expect(await seesC('publicVisible'), '運営が隠した').toBe(false);
    await setRecipe(recipes.publicVisible, { hidden_at: null, hidden_reason: null });
    expect(await seesC('publicVisible'), '隠すのを戻した').toBe(true);
    // 行は消えていない (見え方だけが変わる)
    const { count } = await srAdmin.from(RECIPE_COMMENTS_TABLE).select('id', { count: 'exact', head: true }).eq('recipe_id', recipes.publicVisible);
    expect(count).toBe(2);
  }, LONG);
});

describe('I-7〜I-8: 本人の行 (書き出し・削除・訂正・RETURNING)', () => {
  it('I-7 (S-11・S-13): C は見えないレシピへの自分のコメントを直せる・消せる。V は C のコメントを直せない・消せない (0 行)', async () => {
    const own = commentIds['C:privateHidden'];
    const updated = await asUser(commenter.jwt).from(RECIPE_COMMENTS_TABLE).update({ content: COMMENT('C', 'privateHidden-edited') }).eq('id', own).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ id: own }]);
    const deleted = await asUser(commenter.jwt).from(RECIPE_COMMENTS_TABLE).delete().eq('id', own).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id: own }]);

    const target = commentIds['C:publicVisible'];
    const vUpdate = await asUser(viewer.jwt).from(RECIPE_COMMENTS_TABLE).update({ content: 'x' }).eq('id', target).select('id');
    expect(vUpdate.error).toBeNull();
    expect(vUpdate.data).toEqual([]);
    const vDelete = await asUser(viewer.jwt).from(RECIPE_COMMENTS_TABLE).delete().eq('id', target).select('id');
    expect(vDelete.error).toBeNull();
    expect(vDelete.data).toEqual([]);
    const { data: kept } = await srAdmin.from(RECIPE_COMMENTS_TABLE).select('content').eq('id', target).single();
    expect(kept).toEqual({ content: COMMENT('C', 'publicVisible') });
  });

  it('I-8 (S-12): C は見えないレシピへ insert().select() (RETURNING) できる。他人の user_id では 42501 (INSERT のポリシーは変えない)', async () => {
    const content = COMMENT('C', 'privateHidden-posted');
    const { data, error } = await asUser(commenter.jwt)
      .from(RECIPE_COMMENTS_TABLE)
      .insert({ recipe_id: recipes.privateHidden, user_id: commenter.id, content, rating: RATING })
      .select('id, content')
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ content });
    // V には見えない・A には見える
    expect(await contentsAs(asUser(viewer.jwt))).not.toContain(content);
    expect(await contentsAs(asUser(author.jwt))).toContain(content);
    // 他人の user_id を名乗る INSERT は今までどおり WITH CHECK で 42501 (行はできない)
    const forged = await asUser(commenter.jwt)
      .from(RECIPE_COMMENTS_TABLE)
      .insert({ recipe_id: recipes.publicVisible, user_id: viewer.id, content: COMMENT('C', 'forged'), rating: RATING })
      .select('id');
    expect(forged.error?.code).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(await contentsAs(srAdmin)).not.toContain(COMMENT('C', 'forged'));
  });
});

describe('I-9: カタログ', () => {
  it('recipe_comments のポリシーは 4 本。SELECT は新しい名前・TO authenticated・USING が正典の形・WITH CHECK 無し', async () => {
    const rows = await currentPolicies();
    expect(byPolicyName(rows.map((r) => [r.policyname, r.cmd] as const))).toEqual(
      byPolicyName([...RECIPE_COMMENTS_OTHER_POLICIES, [RECIPE_COMMENTS_SELECT_POLICY, 'SELECT'] as const]),
    );
    const select = rows.find((r) => r.policyname === RECIPE_COMMENTS_SELECT_POLICY)!;
    expect(select.roles).toBe('{authenticated}');
    expect(foldSql(select.qual ?? '')).toBe(foldSql(RECIPE_COMMENTS_SELECT_QUAL));
    expect(select.with_check).toBeNull();
    expect(rows.some((r) => r.policyname === RECIPE_COMMENTS_LEGACY_SELECT_POLICY)).toBe(false);
  });

  it('recipes の SELECT のポリシーは変わっていない (本書の判定の土台)', async () => {
    const [row] = await pgQuery<{ roles: string; qual: string }>(
      `SELECT roles::text AS roles, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recipes' AND policyname = '${RECIPES_PUBLIC_SELECT_POLICY}';`,
    );
    expect(row.roles).toBe('{public}');
    // pg_policies は括弧を足して整形する。括弧と空白を除いた語の並びで比べる
    const words = (s: string) => s.replace(/[()\s]/g, '');
    expect(words(row.qual)).toBe(words(RECIPES_PUBLIC_SELECT_USING));
  });
});

describe('I-10: PostgREST の埋め込み', () => {
  it('I-10 (S-9・S-17): V の recipes → recipe_comments の埋め込みは、見えるレシピとそのコメントだけ', async () => {
    const { data, error } = await asUser(viewer.jwt)
      .from('recipes')
      .select('id, recipe_comments(content)')
      .like('name', `cross25 recipe % ${TS}`);
    expect(error).toBeNull();
    const byId = new Map((data ?? []).map((r) => [r.id as string, ((r.recipe_comments ?? []) as Array<{ content: string }>).map((c) => c.content).sort()]));
    expect([...byId.keys()].sort()).toEqual([recipes.publicVisible, recipes.systemVisible, recipes.systemPrivate].sort());
    expect(byId.get(recipes.publicVisible)).toEqual([COMMENT('C', 'publicVisible'), COMMENT('V', 'publicVisible')].sort());
    expect(byId.get(recipes.systemVisible)).toEqual([COMMENT('C', 'systemVisible')]);
    expect(byId.get(recipes.systemPrivate)).toEqual([COMMENT('C', 'systemPrivate')]);
  });
});

describe('I-11: 戻し口', () => {
  it('I-11 (S-16): 戻し口を 1 つのトランザクションで流して巻き戻す。旧ポリシー (USING true) に戻り、巻き戻ったあとは本冊が当たったまま', async () => {
    const after = await policiesAfterRolledBack(readRollback());
    expect(byPolicyName(after.map((r) => [r.policyname, r.cmd] as const))).toEqual(
      byPolicyName([...RECIPE_COMMENTS_OTHER_POLICIES, [RECIPE_COMMENTS_LEGACY_SELECT_POLICY, 'SELECT'] as const]),
    );
    const legacy = after.find((r) => r.policyname === RECIPE_COMMENTS_LEGACY_SELECT_POLICY)!;
    expect(legacy.roles).toBe('{authenticated}');
    expect(legacy.qual).toBe('true');
    // 巻き戻ったあと
    const now = await currentPolicies();
    expect(now.some((r) => r.policyname === RECIPE_COMMENTS_SELECT_POLICY)).toBe(true);
    expect(now.some((r) => r.policyname === RECIPE_COMMENTS_LEGACY_SELECT_POLICY)).toBe(false);
  }, LONG);
});
