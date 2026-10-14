/**
 * #1214 / #1312: アクティブな買い物リストの get-or-create (getOrCreateActiveShoppingList) の単体テスト。
 *
 * #1214 の修正前は「SELECT -> 無ければ INSERT」で、同時に 2 件の追加が来ると後から INSERT した側が
 * 部分ユニーク索引 idx_shopping_lists_active_unique の 23505 で失敗していた。
 * さらに INSERT のペイロード自体が実テーブルと合っていなかった
 * (name 列は無い。start_date / end_date は NOT NULL で既定値が無い)。
 * #1214 の修正で TS 側に 23505 の再取得を入れたが、買い物リストの再生成の「アーカイブ -> INSERT」とは
 * 直列化されておらず、再生成の INSERT が 23505 で失敗していた (#1312)。
 *
 * #1312 の修正後は、DB 関数 get_or_create_active_shopping_list に任せる。
 * 関数の中のロックと数え直し (同時実行への耐性) は、ローカル Supabase を使う結合テスト
 * (tests/integration/security/shopping-list-active-lock.test.ts) で確認する。
 * ここでは TS 側が次を守っていることを確かめる。
 *   - 関数を、本物と同じ引数名・値 (title・JST の 7 日間) で呼ぶ。テーブルには直接触れない
 *   - 返った id をそのまま返す。エラーはそのまま投げる (再試行しない。呼び出し側がログに残して固定文言を返す)
 *
 * フェイクは本番スキーマの列定義と部分ユニーク索引、DB 関数の振る舞いを再現する (tests/helpers/fake-shopping-lists-db.ts)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateActiveShoppingList } from '../src/lib/shopping-list/active-list';
import { createFakeShoppingListsDb, pgError } from './helpers/fake-shopping-lists-db';

const USER_ID = 'user-1';

afterEach(() => {
  vi.useRealTimers();
});

function activeLists(db: ReturnType<typeof createFakeShoppingListsDb>, userId = USER_ID) {
  return db.lists.filter((l) => l.user_id === userId && l.status === 'active');
}

describe('getOrCreateActiveShoppingList: DB 関数の呼び出し', () => {
  it('get_or_create_active_shopping_list を 1 回だけ呼び、テーブルには直接触れない (SELECT -> INSERT に戻さない)', async () => {
    const db = createFakeShoppingListsDb(USER_ID);

    await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(db.supabase.rpc).toHaveBeenCalledTimes(1);
    expect(db.supabase.rpc.mock.calls[0][0]).toBe('get_or_create_active_shopping_list');
    expect(db.supabase.from).not.toHaveBeenCalled();
    expect(db.calls.map((c) => c.op)).toEqual(['rpc']);
  });

  it('引数は p_user_id / p_title / p_start_date / p_end_date (name 列は無い)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z')); // JST 2026-10-07 12:00
    const db = createFakeShoppingListsDb(USER_ID);

    await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(db.supabase.rpc).toHaveBeenCalledWith('get_or_create_active_shopping_list', {
      p_user_id: USER_ID,
      p_title: '買い物リスト',
      p_start_date: '2026-10-07',
      p_end_date: '2026-10-13',
    });
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

describe('getOrCreateActiveShoppingList: 戻り値', () => {
  it('アクティブなリストが無ければ作られたリストの id を返す (title / start_date / end_date 付き)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z'));
    const db = createFakeShoppingListsDb(USER_ID);

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(db.lists).toHaveLength(1);
    expect(db.lists[0]).toMatchObject({
      user_id: USER_ID,
      status: 'active',
      title: '買い物リスト',
      start_date: '2026-10-07',
      end_date: '2026-10-13',
    });
    expect(result).toEqual({ id: db.lists[0].id });
  });

  it('アクティブなリストがあればその id を返し、新しいリストは作られない', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const existing = db.seedActiveList(USER_ID);

    const result = await getOrCreateActiveShoppingList(db.supabase as never, USER_ID);

    expect(result).toEqual({ id: existing.id });
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

  it('同時に 8 本呼んでも、全て同じリストを返す (アクティブなリストは 1 つ)', async () => {
    const db = createFakeShoppingListsDb(USER_ID);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateActiveShoppingList(db.supabase as never, USER_ID)),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(activeLists(db)).toHaveLength(1);
  });
});

describe('getOrCreateActiveShoppingList: エラー', () => {
  it('DB 関数のエラーは、再試行せずにそのまま投げる (呼び出し側がログに残して固定文言を返す)', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const down = pgError('08006', 'connection failure');
    db.failNext('shopping_lists', 'select', down);

    await expect(getOrCreateActiveShoppingList(db.supabase as never, USER_ID)).rejects.toBe(down);

    expect(db.supabase.rpc).toHaveBeenCalledTimes(1);
    expect(db.lists).toHaveLength(0);
  });

  it('関数の中の INSERT が失敗した場合も、そのまま投げる', async () => {
    const db = createFakeShoppingListsDb(USER_ID);
    const fk = pgError('23503', 'insert or update on table "shopping_lists" violates foreign key constraint');
    db.failNext('shopping_lists', 'insert', fk);

    await expect(getOrCreateActiveShoppingList(db.supabase as never, USER_ID)).rejects.toBe(fk);

    expect(db.supabase.rpc).toHaveBeenCalledTimes(1);
    expect(db.lists).toHaveLength(0);
  });

  it('本人以外の userId は DB 関数が 42501 (FORBIDDEN) で拒否し、何も作られない', async () => {
    const db = createFakeShoppingListsDb(USER_ID);

    await expect(getOrCreateActiveShoppingList(db.supabase as never, 'someone-else')).rejects.toMatchObject({
      code: '42501',
      message: 'FORBIDDEN',
    });

    expect(db.lists).toHaveLength(0);
  });

  it('関数が無い (migration 未適用) 場合は PGRST202 をそのまま投げる', async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: null,
        error: pgError('PGRST202', 'Could not find the function public.get_or_create_active_shopping_list'),
      })),
    };

    await expect(getOrCreateActiveShoppingList(supabase as never, USER_ID)).rejects.toMatchObject({
      code: 'PGRST202',
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null', null],
    ['空文字', ''],
    ['文字列でない値', { id: 'list-1' }],
  ])('エラーなしで id が返らなかった場合 (%s) は、成功扱いにせず投げる', async (_label, data) => {
    const supabase = { rpc: vi.fn(async () => ({ data, error: null })) };

    await expect(getOrCreateActiveShoppingList(supabase as never, USER_ID)).rejects.toThrow(
      'get_or_create_active_shopping_list returned no id',
    );
  });
});
