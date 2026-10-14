/**
 * tests/api/shopping-list-add-recipe-route.test.ts
 *
 * Issue #1214: POST /api/shopping-list/add-recipe の「アクティブな買い物リストの get-or-create」が
 * SELECT → INSERT の check-then-act で、同時に 2 件の追加が来ると後着が部分ユニーク索引の 23505 で
 * 失敗し、生の Postgres エラーが 500 で返って追加内容が失われていた問題の回帰テスト。
 *
 * あわせて、アクティブなリストが無いユーザーは競合に関係なく常に失敗していた
 * (INSERT が存在しない name 列を送り、NOT NULL の start_date / end_date を送っていなかった) ため、
 * その経路もここで確かめる。
 *
 * Issue #1312: リストの get-or-create は DB 関数 get_or_create_active_shopping_list に任せる。
 * 再生成 (アーカイブ -> INSERT) と同じユーザーごとのロックを取るので、同時に来ても互いを失敗させない
 * (ロックの確認は tests/integration/security/shopping-list-active-lock.test.ts)。
 * ここでは route が DB 関数を呼ぶこと (テーブルへ直接 INSERT しないこと) と、レスポンスの形を確かめる。
 *
 * フェイクは本番スキーマの列定義と部分ユニーク索引、DB 関数の振る舞いを再現する (tests/helpers/fake-shopping-lists-db.ts)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeShoppingListsDb, pgError, type FakeShoppingListsDb } from '../helpers/fake-shopping-lists-db';

const USER_ID = 'user-1';

const state = vi.hoisted(() => ({ supabase: null as unknown }));
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => state.supabase,
}));

// 構造化ログのモック (5xx は createLogger(...).withUser(user.id).error(...) で記録される)
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import { POST } from '../../src/app/api/shopping-list/add-recipe/route';

function post(body: unknown): Request {
  return new Request('https://homegohan-app.vercel.app/api/shopping-list/add-recipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const RECIPE = [
  { name: '鶏むね肉', amount: '200g' },
  { name: '玉ねぎ', amount: '1個' },
  { name: '塩' },
];

let db: FakeShoppingListsDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = createFakeShoppingListsDb(USER_ID);
  state.supabase = db.supabase;
});

describe('POST /api/shopping-list/add-recipe: 認証', () => {
  it('未認証なら 401 で、DB に触れない', async () => {
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await POST(post({ ingredients: RECIPE }));

    expect(res.status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });
});

describe('POST /api/shopping-list/add-recipe: アクティブなリストが無いユーザー (初回)', () => {
  it('リストを作って食材を追加し 200 を返す (title / start_date / end_date 付きで作る)', async () => {
    const res = await POST(post({ ingredients: RECIPE }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(3);

    expect(db.lists).toHaveLength(1);
    expect(db.lists[0]).toMatchObject({ user_id: USER_ID, status: 'active', title: '買い物リスト' });
    expect(db.lists[0].start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.lists[0].end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.lists[0].end_date > db.lists[0].start_date).toBe(true);

    // 食材は作成したリストに紐づく
    expect(db.items).toHaveLength(3);
    expect(db.items.every((item) => item.shopping_list_id === db.lists[0].id)).toBe(true);
  });

  it('食材の保存内容 (名前・分量・カテゴリ・出所) は従来どおり', async () => {
    const res = await POST(post({ ingredients: RECIPE }));
    const json = await res.json();

    expect(db.items).toEqual([
      expect.objectContaining({
        item_name: '鶏むね肉',
        normalized_name: '鶏むね肉',
        quantity: '200g',
        quantity_variants: [{ display: '200g', unit: '', value: null }],
        selected_variant_index: 0,
        source: 'manual',
        category: '肉',
        is_checked: false,
      }),
      expect.objectContaining({ item_name: '玉ねぎ', quantity: '1個', category: '野菜' }),
      // 分量が無い食材は quantity が null、quantity_variants が空
      expect.objectContaining({ item_name: '塩', quantity: null, quantity_variants: [], category: '調味料' }),
    ]);
    // レスポンスは camelCase に変換された保存済みの行
    expect(json.items.map((i: { itemName: string }) => i.itemName)).toEqual(['鶏むね肉', '玉ねぎ', '塩']);
    expect(json.items[0]).toMatchObject({ shoppingListId: db.lists[0].id, quantity: '200g', category: '肉' });
  });
});

describe('POST /api/shopping-list/add-recipe: アクティブなリストがあるユーザー', () => {
  it('新しいリストは作らず、既存のアクティブなリストへ追加する', async () => {
    const existing = db.seedActiveList(USER_ID);

    const res = await POST(post({ ingredients: RECIPE }));

    expect(res.status).toBe(200);
    expect(db.lists).toHaveLength(1);
    expect(db.items.every((item) => item.shopping_list_id === existing.id)).toBe(true);
    expect(db.calls.some((c) => c.table === 'shopping_lists' && c.op === 'insert')).toBe(false);
  });

  it('続けて 2 回追加すると、同じリストに食材が積み重なる', async () => {
    await POST(post({ ingredients: [{ name: '卵', amount: '2個' }] }));
    const res = await POST(post({ ingredients: [{ name: '牛乳', amount: '1本' }] }));

    expect(res.status).toBe(200);
    expect(db.lists).toHaveLength(1);
    expect(db.items.map((i) => i.item_name)).toEqual(['卵', '牛乳']);
  });
});

describe('POST /api/shopping-list/add-recipe: 同時実行 (#1214 / #1312)', () => {
  it('アクティブなリストの取得・作成は DB 関数 get_or_create_active_shopping_list を 1 回呼ぶだけで、shopping_lists へ直接 INSERT しない', async () => {
    const res = await POST(post({ ingredients: RECIPE }));

    expect(res.status).toBe(200);
    const rpcCalls = db.calls.filter((c) => c.op === 'rpc');
    expect(rpcCalls.map((c) => c.table)).toEqual(['rpc:get_or_create_active_shopping_list']);
    expect(rpcCalls[0].payload).toMatchObject({ p_user_id: USER_ID, p_title: '買い物リスト' });
    // 再生成のアーカイブ -> INSERT と直列化されるのは DB 関数の中だけ。route が SELECT -> INSERT に戻ると #1312 が再発する
    expect(db.calls.some((c) => c.table === 'shopping_lists')).toBe(false);
  });

  it('初回ユーザーが 2 つのレシピをほぼ同時に追加しても、両方 200 で、食材は全て同じリストに入る', async () => {
    const [a, b] = await Promise.all([
      POST(post({ ingredients: [{ name: '鶏むね肉', amount: '200g' }, { name: '玉ねぎ', amount: '1個' }] })),
      POST(post({ ingredients: [{ name: '豚バラ肉', amount: '300g' }, { name: 'キャベツ', amount: '半玉' }] })),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.lists).toHaveLength(1);
    expect(db.items.map((i) => i.item_name).sort()).toEqual(['キャベツ', '玉ねぎ', '豚バラ肉', '鶏むね肉'].sort());
    expect(db.items.every((item) => item.shopping_list_id === db.lists[0].id)).toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('POST /api/shopping-list/add-recipe: 想定外のエラー', () => {
  it('リストの作成が失敗したら、生のエラー文を返さず固定文言の 500 にして、ログに残す', async () => {
    const raw = pgError(
      '42501',
      'new row violates row-level security policy for table "shopping_lists"',
      'Failing row contains (secret-detail)',
    );
    db.failNext('shopping_lists', 'insert', raw);

    const res = await POST(post({ ingredients: RECIPE }));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '買い物リストへの追加に失敗しました' });
    // テーブル名・制約名・行の中身がクライアントに漏れない
    expect(text).not.toContain('shopping_lists');
    expect(text).not.toContain('row-level security');
    expect(text).not.toContain('secret-detail');
    // 原因 (本文・SQLSTATE) はサーバーログにだけ残す
    expect(logError).toHaveBeenCalledTimes(1);
    const [message, loggedError, meta] = logError.mock.calls[0];
    expect(message).toBe('Add recipe to shopping list failed');
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toBe(raw.message);
    expect(meta).toEqual({ pg_code: '42501' });
    expect(db.items).toHaveLength(0);
  });

  it('食材の保存が失敗したら、固定文言の 500 を返す', async () => {
    const raw = pgError('23514', 'new row for relation "shopping_list_items" violates check constraint "x"');
    db.failNext('shopping_list_items', 'insert', raw);

    const res = await POST(post({ ingredients: RECIPE }));
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '買い物リストへの追加に失敗しました' });
    expect(text).not.toContain('shopping_list_items');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][2]).toEqual({ pg_code: '23514' });
  });
});

describe('POST /api/shopping-list/add-recipe: 入力の検証', () => {
  it.each([
    ['ingredients が無い', {}],
    ['ingredients が配列でない', { ingredients: 'キャベツ' }],
    ['ingredients が null', { ingredients: null }],
    ['リクエスト本文が null', null],
  ])('%s → 400 (ingredients must be an array)', async (_label, body) => {
    const res = await POST(post(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('ingredients must be an array');
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ['name が無い', [{ amount: '1個' }]],
    ['name が null', [{ name: null, amount: '1個' }]],
    ['name が文字列でない', [{ name: 123 }]],
    ['要素がオブジェクトでない', ['キャベツ']],
    ['要素が null', [null]],
    ['1 件でも不正な要素があれば全体を拒否する', [{ name: 'キャベツ' }, { name: 5 }]],
  ])('%s → 400 で、リストも食材も作らない', async (_label, ingredients) => {
    const res = await POST(post({ ingredients }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('each ingredient must have a string name');
    expect(db.calls).toHaveLength(0);
    expect(db.lists).toHaveLength(0);
    expect(db.items).toHaveLength(0);
  });

  it('name が空白だけの要素は取り除き、他の食材は追加する (リクエスト全体は拒否しない)', async () => {
    const res = await POST(
      post({ ingredients: [{ name: 'キャベツ' }, { name: '' }, { name: '  　 ', amount: '1個' }, { name: '卵' }] }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.items.map((i: { itemName: string }) => i.itemName)).toEqual(['キャベツ', '卵']);
    expect(db.items.map((i) => i.item_name)).toEqual(['キャベツ', '卵']);
  });

  it('全ての要素の name が空白だけなら、DB に触れずに空の items を返す', async () => {
    const res = await POST(post({ ingredients: [{ name: '' }, { name: '   ' }] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(db.calls).toHaveLength(0);
    expect(db.lists).toHaveLength(0);
  });

  it('JSON として読めない本文は 500 ではなく 400', async () => {
    const res = await POST(post('{not json'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
    expect(db.calls).toHaveLength(0);
  });

  it('ingredients が空配列なら、DB に触れずに空の items を返す (空のリストを作らない)', async () => {
    const res = await POST(post({ ingredients: [] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(db.calls).toHaveLength(0);
    expect(db.lists).toHaveLength(0);
  });

  it('name の前後の空白は取り除いて保存し、分量が空白だけなら分量なしとして扱う', async () => {
    const res = await POST(post({ ingredients: [{ name: ' キャベツ ', amount: '   ' }, { name: '米', amount: 2 }] }));

    expect(res.status).toBe(200);
    expect(db.items).toEqual([
      expect.objectContaining({ item_name: 'キャベツ', normalized_name: 'キャベツ', quantity: null, quantity_variants: [] }),
      // 数値で渡された分量 (従来も保存できていた) は文字列にして保存する
      expect.objectContaining({
        item_name: '米',
        quantity: '2',
        quantity_variants: [{ display: '2', unit: '', value: null }],
      }),
    ]);
  });
});
