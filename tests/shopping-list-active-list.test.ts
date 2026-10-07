/**
 * #1214: アクティブな買い物リストの get-or-create (getOrCreateActiveShoppingList) の単体テスト。
 *
 * 修正前の処理は「SELECT → 無ければ INSERT」で、同時に 2 件の追加が来ると後から INSERT した側が
 * 部分ユニーク索引 idx_shopping_lists_active_unique の 23505 で失敗していた。
 * さらに INSERT のペイロード自体が実テーブルと合っていなかった
 * (name 列は無い。start_date / end_date は NOT NULL で既定値が無い)。
 *
 * フェイクは本番スキーマの列定義と部分ユニーク索引を再現する (tests/helpers/fake-shopping-lists-db.ts)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateActiveShoppingList } from '../src/lib/shopping-list/active-list';
import { createFakeSupabase } from './helpers/fake-supabase';
import { createFakeShoppingListsDb, pgError } from './helpers/fake-shopping-lists-db';

const USER_ID = 'user-1';

afterEach(() => {
  vi.useRealTimers();
});

function activeLists(db: ReturnType<typeof createFakeShoppingListsDb>, userId = USER_ID) {
  return db.lists.filter((l) => l.user_id === userId && l.status === 'active');
}

describe('getOrCreateActiveShoppingList: 既存リスト', () => {
  it('アクティブなリストがあればそれを返し、INSERT しない', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const existing = db.seedActiveList(USER_ID);

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(result).toEqual({ id: existing.id });
    expect(db.calls.map((c) => c.op)).toEqual(['select']);
    expect(db.lists).toHaveLength(1);
  });

  it('他のユーザーのアクティブなリストは使わず、自分のリストを新しく作る', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const others = db.seedActiveList('someone-else');

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(result.id).not.toBe(others.id);
    expect(activeLists(db)).toHaveLength(1);
    expect(activeLists(db, 'someone-else')).toHaveLength(1);
  });

  it('アーカイブ済みのリストしか無ければ、新しいアクティブなリストを作る', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const archived = db.seedActiveList(USER_ID, { status: 'archived' });

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(result.id).not.toBe(archived.id);
    expect(activeLists(db)).toHaveLength(1);
  });
});

describe('getOrCreateActiveShoppingList: 新規作成', () => {
  it('title / start_date / end_date を付けて INSERT する (name 列は送らない)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z')); // JST 2026-10-07 12:00
    const db = createFakeShoppingListsDb(USER_ID);

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    const insert = db.calls.find((c) => c.op === 'insert');
    expect(insert?.payload).toEqual({
      user_id: USER_ID,
      status: 'active',
      title: '買い物リスト',
      start_date: '2026-10-07',
      end_date: '2026-10-13',
    });
    expect(insert?.payload).not.toHaveProperty('name');
    expect(db.lists).toHaveLength(1);
    expect(result).toEqual({ id: db.lists[0].id });
  });

  it('日付は JST 基準 (UTC では前日の早朝でも JST の今日から 7 日間)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // UTC 2026-10-07 16:30 = JST 2026-10-08 01:30。toISOString().slice(0, 10) だと '2026-10-07' にずれる
    vi.setSystemTime(new Date('2026-10-07T16:30:00Z'));
    const db = createFakeShoppingListsDb(USER_ID);

    await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(db.lists[0]).toMatchObject({ start_date: '2026-10-08', end_date: '2026-10-14' });
  });

  it('月・年をまたぐ場合も JST の暦どおりに 7 日間 (今日を含めて +6 日)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-28T15:30:00Z')); // JST 2026-12-29 00:30
    const db = createFakeShoppingListsDb(USER_ID);

    await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(db.lists[0]).toMatchObject({ start_date: '2026-12-29', end_date: '2027-01-04' });
  });
});

describe('getOrCreateActiveShoppingList: 同時実行 (TOCTOU)', () => {
  it('SELECT の後 INSERT の前に別リクエストがリストを作っても (23505)、既存のリストを返して成功する', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    let winner: { id: string } | null = null;
    // 自分の SELECT は「無い」と返り、INSERT が適用される直前に別リクエストが先にコミットする
    db.beforeNextListInsert(() => {
      winner = db.seedActiveList(USER_ID);
    });

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(winner).not.toBeNull();
    expect(result).toEqual({ id: winner!.id });
    // SELECT → INSERT (23505 で負ける) → 再 SELECT
    expect(db.calls.map((c) => c.op)).toEqual(['select', 'insert', 'select']);
    expect(activeLists(db)).toHaveLength(1);
  });

  it('同時に呼んだ 2 本は、どちらも成功して同じリストを返す (アクティブなリストは 1 つのまま)', async () => {
    const db = createFakeShoppingListsDb(USER_ID);

    const [a, b] = await Promise.all([
      getOrCreateActiveShoppingList(db.supabase as never, USER_ID),
      getOrCreateActiveShoppingList(db.supabase as never, USER_ID),
    ]);

    expect(a.id).toBe(b.id);
    expect(activeLists(db)).toHaveLength(1);
    // 両方が「リスト無し」と判定して INSERT し、片方が 23505 で負けたことの確認 (競合を実際に踏んでいる)
    expect(db.calls.filter((c) => c.op === 'insert')).toHaveLength(2);
  });

  it('同時に 8 本呼んでも、全て同じリストを返す', async () => {
    const db = createFakeShoppingListsDb(USER_ID);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateActiveShoppingList(db.supabase as never, USER_ID)),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(activeLists(db)).toHaveLength(1);
  });
});

describe('getOrCreateActiveShoppingList: 想定外のエラー', () => {
  it('23505 以外の INSERT エラーは再試行せずに投げる', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const rls = pgError('42501', 'new row violates row-level security policy for table "shopping_lists"');
    db.failNext('shopping_lists', 'insert', rls);

    await expect(getOrCreateActiveShoppingList(db.supabase as never, USER_ID)).rejects.toBe(rls);

    expect(db.calls.filter((c) => c.op === 'insert')).toHaveLength(1);
    expect(db.lists).toHaveLength(0);
  });

  it('SELECT がエラーなら、INSERT を試みずに投げる', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const down = pgError('08006', 'connection failure');
    db.failNext('shopping_lists', 'select', down);

    await expect(getOrCreateActiveShoppingList(db.supabase as never, USER_ID)).rejects.toBe(down);

    expect(db.calls.map((c) => c.op)).toEqual(['select']);
  });

  it('23505 の後に再 SELECT しても見つからない状態が続くなら、上限回数で諦めて投げる (無限ループしない)', async () => {
    const conflict = pgError('23505', 'duplicate key value violates unique constraint "idx_shopping_lists_active_unique"');
    const none = { data: null, error: null };
    const lost = { data: null, error: conflict };
    // SELECT(なし) → INSERT(23505) を繰り返し続ける。最後の要素は使い回される
    const supabase = createFakeSupabase({ shopping_lists: [none, lost, none, lost, none, lost] });

    await expect(getOrCreateActiveShoppingList(supabase as never, USER_ID)).rejects.toBe(conflict);

    expect(supabase.from).toHaveBeenCalledTimes(6); // 3 回の試行 x (SELECT + INSERT)
  });

  it('INSERT がエラーなしで行を返さなかった場合は、成功扱いにせず投げる', async () => {
    const none = { data: null, error: null };
    const supabase = createFakeSupabase({ shopping_lists: [none, none] });

    await expect(getOrCreateActiveShoppingList(supabase as never, USER_ID)).rejects.toThrow();
  });
});
