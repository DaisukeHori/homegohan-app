/**
 * #1214 買い物リストの get-or-create (POST /api/shopping-list/add-recipe) の回帰テスト
 *
 * 修正前の問題 (どちらも本番スキーマ = ローカル Supabase のベースラインで確認できる):
 *   1. 競合: 「アクティブなリストを SELECT → 無ければ INSERT」の check-then-act だったため、
 *      同時に 2 件の追加が来ると、後から INSERT した側が部分ユニーク索引
 *      idx_shopping_lists_active_unique (user_id) WHERE status = 'active' の 23505 で失敗し、
 *      生の Postgres エラーが 500 で返って食材が失われた。
 *   2. 初回ユーザー: INSERT が存在しない name 列を送り (列は title)、NOT NULL の start_date / end_date も
 *      送っていなかったため、アクティブなリストが無いユーザーは競合に関係なく常に 500 だった。
 *      モックでは列の不一致を検出できないので、このテストで本物の PostgREST に対して確かめる。
 *
 * 構成:
 *   - D: 共通ヘルパー getOrCreateActiveShoppingList を、本物の PostgREST + 部分ユニーク索引に対して実行する。
 *        fetch をラップして「全員の SELECT が終わるまで最初の INSERT を送らない」ようにし、
 *        TOCTOU を決定的に再現する (全員が「リスト無し」と判定 → 全員 INSERT → 1 人だけ成功、他は 409 = 23505)。
 *   - A / B / C: API ルートを Bearer JWT で HTTP 経由で叩く (Next dev server が必要)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/shopping-list-add-recipe.test.ts
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { getOrCreateActiveShoppingList } from '../../../src/lib/shopping-list/active-list';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string, fetchImpl?: typeof fetch): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `Pw-${randomUUID()}`;
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-slist-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `slist-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function listsOf(userId: string) {
  const { data, error } = await srAdmin
    .from('shopping_lists')
    .select('id, status, title, start_date, end_date')
    .eq('user_id', userId);
  if (error) throw new Error(`listsOf: ${error.message}`);
  return data ?? [];
}

async function itemsOf(listId: string) {
  const { data, error } = await srAdmin
    .from('shopping_list_items')
    .select('item_name, quantity, category, source, shopping_list_id')
    .eq('shopping_list_id', listId);
  if (error) throw new Error(`itemsOf: ${error.message}`);
  return data ?? [];
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

afterAll(async () => {
  // 食材は shopping_lists の ON DELETE CASCADE で一緒に消える
  for (const id of createdUserIds) {
    await srAdmin.from('shopping_lists').delete().eq('user_id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
});

/**
 * 全員の shopping_lists への SELECT が終わるまで、最初の INSERT (POST) を送らせない fetch を作る。
 * これで「全員が『アクティブなリストは無い』と判定してから INSERT する」状況を決定的に作れる。
 */
function createRaceFetch(parties: number) {
  let selects = 0;
  let open!: () => void;
  const selectsDone = new Promise<void>((resolve) => {
    open = resolve;
  });
  const stats = { inserts: 0, conflicts: 0 };

  const raceFetch: typeof fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const isListsTable = target.includes('/rest/v1/shopping_lists');

    if (isListsTable && method === 'POST') await selectsDone;
    try {
      const res = await fetch(input, init);
      if (isListsTable && method === 'POST') {
        stats.inserts += 1;
        // PostgREST は unique_violation (23505) を 409 Conflict で返す
        if (res.status === 409) stats.conflicts += 1;
      }
      return res;
    } finally {
      if (isListsTable && method === 'GET') {
        selects += 1;
        if (selects >= parties) open();
      }
    }
  };
  return { raceFetch, stats };
}

describe('D: getOrCreateActiveShoppingList を本物の PostgREST と部分ユニーク索引に対して実行する (#1214)', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser('helper');
  });

  it('D-1: 全員が「リスト無し」と判定して同時に INSERT しても (1 人だけ成功し、他は 23505)、全員が同じリストを得る', async () => {
    const parties = 4;
    const { raceFetch, stats } = createRaceFetch(parties);

    const results = await Promise.all(
      Array.from({ length: parties }, () =>
        getOrCreateActiveShoppingList(client(anonKey, user.jwt, raceFetch), user.id),
      ),
    );

    // 全員が成功し、同じリストを指す
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    // INSERT は全員が送り、1 人だけ成功、残りは本物の 23505 (HTTP 409) で負けて再取得した
    expect(stats.inserts).toBe(parties);
    expect(stats.conflicts).toBe(parties - 1);

    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: results[0].id, status: 'active', title: '買い物リスト' });
    expect(daysBetween(lists[0].start_date, lists[0].end_date)).toBe(6);
  });

  it('D-2: すでにアクティブなリストがあれば、同じものを返し INSERT しない', async () => {
    const { raceFetch, stats } = createRaceFetch(0);
    const before = await listsOf(user.id);

    const result = await getOrCreateActiveShoppingList(client(anonKey, user.jwt, raceFetch), user.id);

    expect(result.id).toBe(before[0].id);
    expect(stats.inserts).toBe(0);
    expect(await listsOf(user.id)).toHaveLength(1);
  });
});

describe('A: アクティブな買い物リストが無いユーザーで add-recipe (初回)', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser('first');
  });

  it('A-1: 200 を返し、title / start_date / end_date を持つアクティブなリストが 1 つでき、食材が保存される', async () => {
    expect(await listsOf(user.id)).toHaveLength(0);

    const res = await apiCall<{ items: Array<{ itemName: string; quantity: string | null; category: string }> }>(
      'POST',
      '/api/shopping-list/add-recipe',
      user.jwt,
      { ingredients: [{ name: '鶏むね肉', amount: '200g' }, { name: '玉ねぎ', amount: '1個' }, { name: '塩' }] },
    );

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.itemName)).toEqual(['鶏むね肉', '玉ねぎ', '塩']);

    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ status: 'active', title: '買い物リスト' });
    expect(daysBetween(lists[0].start_date, lists[0].end_date)).toBe(6);

    const items = await itemsOf(lists[0].id);
    expect(items).toHaveLength(3);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_name: '鶏むね肉', quantity: '200g', category: '肉', source: 'manual' }),
        expect.objectContaining({ item_name: '玉ねぎ', quantity: '1個', category: '野菜' }),
        expect.objectContaining({ item_name: '塩', quantity: null, category: '調味料' }),
      ]),
    );
  });

  it('A-2: 続けて追加すると、新しいリストは作らず同じリストに積み重なる', async () => {
    const res = await apiCall('POST', '/api/shopping-list/add-recipe', user.jwt, {
      ingredients: [{ name: '牛乳', amount: '1本' }],
    });

    expect(res.status).toBe(200);
    const lists = await listsOf(user.id);
    expect(lists).toHaveLength(1);
    expect(await itemsOf(lists[0].id)).toHaveLength(4);
  });
});

describe('B: 同時に追加 (#1214)', () => {
  it('B-1: 初回ユーザーが 4 つのレシピをほぼ同時に追加しても、全て 200 で、リストは 1 つ、食材は全て保存される', async () => {
    const user = await createUser('race');
    const recipes = [
      [{ name: '鶏むね肉', amount: '200g' }, { name: '玉ねぎ', amount: '1個' }],
      [{ name: '豚バラ肉', amount: '300g' }, { name: 'キャベツ', amount: '半玉' }],
      [{ name: '鮭', amount: '2切れ' }, { name: '大根', amount: '1/2本' }],
      [{ name: '豆腐', amount: '1丁' }, { name: 'ねぎ', amount: '1本' }],
    ];

    const responses = await Promise.all(
      recipes.map((ingredients) => apiCall('POST', '/api/shopping-list/add-recipe', user.jwt, { ingredients })),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);

    const lists = await listsOf(user.id);
    expect(lists.filter((l) => l.status === 'active')).toHaveLength(1);
    const items = await itemsOf(lists[0].id);
    expect(items.map((i) => i.item_name).sort()).toEqual(recipes.flat().map((i) => i.name).sort());
  });
});

describe('C: 入力の検証と認証', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser('validation');
  });

  it('C-1: ingredients が配列でない / name が文字列でない は 400 で、リストも食材も作らない', async () => {
    const notArray = await apiCall<{ error: string }>('POST', '/api/shopping-list/add-recipe', user.jwt, {
      ingredients: 'キャベツ',
    });
    const badName = await apiCall<{ error: string }>('POST', '/api/shopping-list/add-recipe', user.jwt, {
      ingredients: [{ name: 'キャベツ' }, { name: 5 }],
    });

    expect(notArray.status).toBe(400);
    expect(notArray.body.error).toBe('ingredients must be an array');
    expect(badName.status).toBe(400);
    expect(badName.body.error).toBe('each ingredient must have a string name');
    expect(await listsOf(user.id)).toHaveLength(0);
  });

  it('C-2: 追加する食材が無ければ (空配列・空の name だけ) 200 で、空のリストも作らない', async () => {
    const empty = await apiCall<{ items: unknown[] }>('POST', '/api/shopping-list/add-recipe', user.jwt, {
      ingredients: [],
    });
    const blankOnly = await apiCall<{ items: unknown[] }>('POST', '/api/shopping-list/add-recipe', user.jwt, {
      ingredients: [{ name: '  ' }],
    });

    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);
    expect(blankOnly.status).toBe(200);
    expect(blankOnly.body.items).toEqual([]);
    expect(await listsOf(user.id)).toHaveLength(0);
  });

  it('C-3: 空の name が混ざっていても、他の食材は追加される', async () => {
    // C-1 / C-2 は「リストが作られないこと」を確かめるので、別のユーザーで行う
    const other = await createUser('blank-mixed');

    const res = await apiCall<{ items: Array<{ itemName: string }> }>(
      'POST',
      '/api/shopping-list/add-recipe',
      other.jwt,
      { ingredients: [{ name: 'キャベツ' }, { name: '' }, { name: '卵', amount: '2個' }] },
    );

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.itemName)).toEqual(['キャベツ', '卵']);
    const lists = await listsOf(other.id);
    expect(lists).toHaveLength(1);
    expect(await itemsOf(lists[0].id)).toHaveLength(2);
  });

  it('C-4: 未認証は 401', async () => {
    const res = await apiCallNoAuth('POST', '/api/shopping-list/add-recipe', {
      ingredients: [{ name: 'キャベツ' }],
    });

    expect(res.status).toBe(401);
  });
});
