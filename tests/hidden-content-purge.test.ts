// @vitest-environment node
/**
 * #1538 運営が隠したコンテンツの完全削除 (supabase/functions/_shared/hidden-content-purge.ts) の単体テスト
 *
 * DB と Storage は、このファイルの中の小さな偽物 (メモリ上の表・オブジェクト) に差し替える。
 * 偽物は、本体が使う絞り込み (hidden_at < 期限・id の一覧・並び・件数) を本物と同じ意味で解釈する。
 * 本物の DB・Storage での確かめは tests/integration/security/purge-hidden-content.test.ts。
 *
 * 確かめること:
 *   1. 期限 = 今の 90 日前。89 日・90 日ちょうど・隠していない行は消さず、91 日の行を消す (食事・レシピとも)
 *   2. 画像: 持ち主のフォルダの画像だけを消す。他人のフォルダ・持ち主の無い行・外部の URL・ほかの行が使う画像は消さない
 *      (同じ画像を指す複製は、どれかの行の持ち主のものなら 1 回だけ消す)
 *   3. 画像を消してから行を消す。Storage・確認の関数が失敗したら例外にして、行を消さない
 *   4. 件数ごとに繰り返して最後まで消す。時間の上限を過ぎたら途中で止めて completed: false
 * Edge Function purge-hidden-content のハンドラは tests/purge-hidden-content-edge.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  HIDDEN_CONTENT_PURGE_BATCH_SIZE,
  HIDDEN_CONTENT_PURGE_MAX_DURATION_MS,
  HIDDEN_CONTENT_RETENTION_DAYS,
  REFERENCED_NEEDLES_RPC,
  hiddenContentCutoff,
  objectNeedles,
  purgeExpiredHiddenContent,
  type HiddenContentPurgeAdmin,
} from '../supabase/functions/_shared/hidden-content-purge';
import * as sharedUrl from '../supabase/functions/_shared/storage-object-url';
import * as accountStorage from '../src/lib/account-deletion-storage';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-15T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HOST = 'https://example.supabase.co';
const publicUrl = (bucket: string, path: string) => `${HOST}/storage/v1/object/public/${bucket}/${path}`;

type Row = Record<string, unknown> & { id: string; hidden_at: string | null };
type Event = { kind: 'select' | 'delete' | 'rpc' | 'remove'; table?: string; detail?: unknown };

interface FakeOptions {
  meals?: Row[];
  recipes?: Row[];
  /** Storage にあるオブジェクト ('<bucket>/<path>') */
  objects?: string[];
  /** 確認の関数が「使われている」と答える部分文字列 */
  referenced?: string[];
  rpcError?: string;
  removeError?: string;
  /** 行の削除が、何も消さずに成功したことにする (同時に別の処理が消した状態) */
  deleteMatchesNothing?: boolean;
}

/** 本体が使う形だけを解釈する、メモリ上の DB と Storage */
function createFake(options: FakeOptions = {}) {
  const tables: Record<string, Row[]> = { meals: [...(options.meals ?? [])], recipes: [...(options.recipes ?? [])] };
  const objects = new Set(options.objects ?? []);
  const referenced = new Set(options.referenced ?? []);
  const events: Event[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function query(table: string) {
    let op: 'select' | 'delete' = 'select';
    let columns = '*';
    let returning = false;
    let ltCutoff: string | null = null;
    let ids: string[] | null = null;
    let limit = Number.POSITIVE_INFINITY;
    const orders: string[] = [];

    const builder = {
      select(cols: string) {
        if (op === 'delete') returning = true;
        else columns = cols;
        return builder;
      },
      delete() {
        op = 'delete';
        return builder;
      },
      lt(column: string, value: string) {
        expect(column).toBe('hidden_at');
        ltCutoff = value;
        return builder;
      },
      in(column: string, values: string[]) {
        expect(column).toBe('id');
        ids = values;
        return builder;
      },
      order(column: string) {
        orders.push(column);
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      then<T>(resolve: (value: { data: unknown; error: null }) => T) {
        const matches = (row: Row) =>
          (ltCutoff === null || (row.hidden_at !== null && new Date(row.hidden_at).getTime() < new Date(ltCutoff).getTime())) &&
          (ids === null || ids.includes(row.id));
        if (op === 'select') {
          expect(orders).toEqual(['hidden_at', 'id']);
          const picked = tables[table]
            .filter(matches)
            .sort((a, b) => String(a.hidden_at).localeCompare(String(b.hidden_at)) || a.id.localeCompare(b.id))
            .slice(0, limit)
            .map((row) => Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()] ?? null])));
          events.push({ kind: 'select', table, detail: picked.map((row) => row.id) });
          return Promise.resolve({ data: picked, error: null }).then(resolve);
        }
        expect(returning).toBe(true);
        const removed = options.deleteMatchesNothing ? [] : tables[table].filter(matches);
        tables[table] = tables[table].filter((row) => !removed.includes(row));
        events.push({ kind: 'delete', table, detail: removed.map((row) => row.id) });
        return Promise.resolve({ data: removed.map((row) => ({ id: row.id })), error: null }).then(resolve);
      },
    };
    return builder;
  }

  const admin = {
    from: (table: string) => query(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      events.push({ kind: 'rpc' });
      if (options.rpcError) return Promise.resolve({ data: null, error: { message: options.rpcError } });
      const needles = args.p_needles as string[];
      return Promise.resolve({ data: needles.filter((n) => referenced.has(n)), error: null });
    },
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => {
          events.push({ kind: 'remove', detail: paths.map((p) => `${bucket}/${p}`) });
          if (options.removeError) return Promise.resolve({ data: null, error: { message: options.removeError } });
          const gone = paths.filter((p) => objects.delete(`${bucket}/${p}`));
          return Promise.resolve({ data: gone.map((name) => ({ name })), error: null });
        },
      }),
    },
  } as unknown as HiddenContentPurgeAdmin;

  return { admin, tables, objects, events, rpcCalls };
}

const meal = (id: string, hiddenAt: string | null, photo: string | null, userId: string | null = OWNER): Row => ({
  id,
  user_id: userId,
  hidden_at: hiddenAt,
  photo_url: photo,
});
const recipe = (id: string, hiddenAt: string | null, image: string | null, userId: string | null = OWNER): Row => ({
  id,
  user_id: userId,
  hidden_at: hiddenAt,
  image_url: image,
});

describe('期限 (90 日)', () => {
  it('保管期間は 90 日。期限は今の時刻のちょうど 90 日前', () => {
    expect(HIDDEN_CONTENT_RETENTION_DAYS).toBe(90);
    expect(hiddenContentCutoff(NOW).toISOString()).toBe(daysAgo(90));
  });

  it('89 日・90 日ちょうど・隠していない行は消さず、91 日の行だけを消す (食事・レシピとも)', async () => {
    const fake = createFake({
      meals: [meal('m89', daysAgo(89), null), meal('m90', daysAgo(90), null), meal('m91', daysAgo(91), null), meal('mvis', null, null)],
      recipes: [recipe('r89', daysAgo(89), null), recipe('r91', daysAgo(91), null), recipe('rvis', null, null)],
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });

    expect(fake.tables.meals.map((r) => r.id).sort()).toEqual(['m89', 'm90', 'mvis']);
    expect(fake.tables.recipes.map((r) => r.id).sort()).toEqual(['r89', 'rvis']);
    expect(result).toEqual({
      cutoff: daysAgo(90),
      deleted_rows: { meals: 1, recipes: 1 },
      removed_objects: 0,
      skipped_unowned_objects: 0,
      skipped_referenced_objects: 0,
      completed: true,
    });
  });

  it('対象が無ければ何も消さず、確認の関数も Storage も呼ばない', async () => {
    const fake = createFake({ meals: [meal('m1', daysAgo(10), publicUrl('fridge-images', `${OWNER}/a.jpg`))] });
    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });
    expect(result.deleted_rows).toEqual({ meals: 0, recipes: 0 });
    expect(fake.events.filter((e) => e.kind !== 'select')).toEqual([]);
  });

  it('不正な引数 (件数・時刻) は例外にする', async () => {
    const fake = createFake();
    await expect(purgeExpiredHiddenContent(fake.admin, { now: NOW, batchSize: 0 })).rejects.toThrow('batchSize');
    await expect(purgeExpiredHiddenContent(fake.admin, { now: new Date('invalid') })).rejects.toThrow('now');
  });
});

describe('画像', () => {
  it('持ち主のフォルダの画像だけを消す。他人のフォルダ・持ち主の無い行・外部の URL・バケット以外は消さない', async () => {
    const own = `${OWNER}/own.jpg`;
    const others = `${OTHER}/others.jpg`;
    const ownRecipe = `${OWNER}/recipe.jpg`;
    const orphan = `${OTHER}/orphan.jpg`;
    const fake = createFake({
      meals: [
        meal('own', daysAgo(91), publicUrl('fridge-images', own)),
        meal('others', daysAgo(91), publicUrl('fridge-images', others)),
        meal('external', daysAgo(91), 'https://cdn.example.com/x.jpg'),
        meal('nobucket', daysAgo(91), publicUrl('avatars', `${OWNER}/x.jpg`)),
      ],
      recipes: [
        recipe('ownr', daysAgo(91), publicUrl('meal_photos', ownRecipe)),
        recipe('orphanr', daysAgo(91), publicUrl('fridge-images', orphan), null),
      ],
      objects: [`fridge-images/${own}`, `fridge-images/${others}`, `meal_photos/${ownRecipe}`, `fridge-images/${orphan}`],
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });

    expect([...fake.objects].sort()).toEqual([`fridge-images/${orphan}`, `fridge-images/${others}`].sort());
    expect(result.removed_objects).toBe(2);
    expect(result.skipped_unowned_objects).toBe(2);
    expect(result.deleted_rows).toEqual({ meals: 4, recipes: 2 });
  });

  it('ほかの行が使っている画像 (確認の関数が答えたもの) は消さないが、行は消す', async () => {
    const shared = `${OWNER}/shared.jpg`;
    const fake = createFake({
      meals: [meal('m', daysAgo(91), publicUrl('fridge-images', shared))],
      objects: [`fridge-images/${shared}`],
      referenced: [`/fridge-images/${shared}`],
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });

    expect(fake.objects.has(`fridge-images/${shared}`)).toBe(true);
    expect(result.skipped_referenced_objects).toBe(1);
    expect(result.removed_objects).toBe(0);
    expect(fake.tables.meals).toEqual([]);
    expect(fake.events.some((e) => e.kind === 'remove')).toBe(false);
  });

  it('確認の関数には、期限と、オブジェクトを指す部分 (符号化した形・しない形) を渡す', async () => {
    const path = `${OWNER}/日本語 写真.jpg`;
    const encodedPath = `${OWNER}/${encodeURIComponent('日本語 写真.jpg')}`;
    const fake = createFake({
      meals: [meal('m', daysAgo(91), publicUrl('fridge-images', encodedPath))],
      objects: [`fridge-images/${path}`],
      referenced: [`/fridge-images/${encodedPath}`],
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });

    expect(fake.rpcCalls).toEqual([
      { name: REFERENCED_NEEDLES_RPC, args: { p_needles: [`/fridge-images/${path}`, `/fridge-images/${encodedPath}`], p_cutoff: daysAgo(90) } },
    ]);
    // 符号化した形がほかの行に残っているので消さない
    expect(result.skipped_referenced_objects).toBe(1);
    expect(fake.objects.has(`fridge-images/${path}`)).toBe(true);
  });

  it('同じ画像を指す複製 (家族への貼り付け) は、どれかの行の持ち主のものなら 1 回だけ消す', async () => {
    const photo = `${OWNER}/paste.jpg`;
    const url = publicUrl('fridge-images', photo);
    const fake = createFake({
      meals: [meal('copy', daysAgo(91), url, OTHER), meal('source', daysAgo(91), url, OWNER)],
      objects: [`fridge-images/${photo}`],
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });

    expect(fake.objects.size).toBe(0);
    expect(result.removed_objects).toBe(1);
    expect(result.skipped_unowned_objects).toBe(0);
    expect(fake.events.filter((e) => e.kind === 'remove')).toEqual([{ kind: 'remove', detail: [`fridge-images/${photo}`] }]);
  });

  it('画像を消してから行を消す (行を先に消すと画像の URL が分からなくなる)', async () => {
    const photo = `${OWNER}/order.jpg`;
    const fake = createFake({
      meals: [meal('m', daysAgo(91), publicUrl('fridge-images', photo))],
      objects: [`fridge-images/${photo}`],
    });

    await purgeExpiredHiddenContent(fake.admin, { now: NOW });

    const kinds = fake.events.filter((e) => e.table !== 'recipes').map((e) => e.kind);
    expect(kinds).toEqual(['select', 'rpc', 'remove', 'delete']);
  });

  it('Storage の削除に失敗したら例外にして、行を消さない (次の回にやり直す)。例外の文にパスを入れない', async () => {
    const photo = `${OWNER}/fail.jpg`;
    const fake = createFake({
      meals: [meal('m', daysAgo(91), publicUrl('fridge-images', photo))],
      objects: [`fridge-images/${photo}`],
      removeError: 'storage unavailable',
    });

    const error = await purgeExpiredHiddenContent(fake.admin, { now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('storage remove failed (bucket=fridge-images)');
    expect((error as Error).message).not.toContain(photo);
    expect(fake.tables.meals.map((r) => r.id)).toEqual(['m']);
  });

  it('バケットが無い (Bucket not found) ときは消すものが無いのと同じ。行は消す', async () => {
    const fake = createFake({
      meals: [meal('m', daysAgo(91), publicUrl('health-checkups', `${OWNER}/x.jpg`))],
      removeError: 'Bucket not found',
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW });
    expect(result.deleted_rows.meals).toBe(1);
    expect(result.removed_objects).toBe(0);
  });

  it('確認の関数が失敗したら例外にして、画像も行も消さない', async () => {
    const photo = `${OWNER}/rpc.jpg`;
    const fake = createFake({
      meals: [meal('m', daysAgo(91), publicUrl('fridge-images', photo))],
      objects: [`fridge-images/${photo}`],
      rpcError: 'function does not exist',
    });

    await expect(purgeExpiredHiddenContent(fake.admin, { now: NOW })).rejects.toThrow(REFERENCED_NEEDLES_RPC);
    expect(fake.objects.size).toBe(1);
    expect(fake.tables.meals).toHaveLength(1);
  });
});

describe('件数と時間', () => {
  it('件数ごとに繰り返して、期限を過ぎた行を最後まで消す', async () => {
    const meals = Array.from({ length: 5 }, (_, i) => meal(`m${i}`, daysAgo(91 + i), null));
    const fake = createFake({ meals: [...meals, meal('keep', daysAgo(1), null)] });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW, batchSize: 2 });

    expect(result.deleted_rows.meals).toBe(5);
    expect(fake.tables.meals.map((r) => r.id)).toEqual(['keep']);
    // 2 + 2 + 1 で 3 回読む (最後は件数に満たないので、もう一度は読まない)
    expect(fake.events.filter((e) => e.kind === 'select' && e.table === 'meals')).toHaveLength(3);
  });

  it('既定の件数は URL の長さに収まる 100 行・時間の上限は Edge Function の 400 秒より短い', () => {
    expect(HIDDEN_CONTENT_PURGE_BATCH_SIZE).toBe(100);
    expect(HIDDEN_CONTENT_PURGE_MAX_DURATION_MS).toBeLessThan(400_000);
  });

  it('行が 1 行も消えなかったら (同時に別の処理が消した)、同じ行を読み続けずに止める', async () => {
    const fake = createFake({
      meals: [meal('a', daysAgo(91), null), meal('b', daysAgo(92), null)],
      deleteMatchesNothing: true,
    });

    const result = await purgeExpiredHiddenContent(fake.admin, { now: NOW, batchSize: 2 });
    expect(result.deleted_rows.meals).toBe(0);
    expect(result.completed).toBe(true);
    expect(fake.events.filter((e) => e.kind === 'select' && e.table === 'meals')).toHaveLength(1);
  });

  it('時間の上限を過ぎたら、その時点で止めて completed: false を返す (失敗にしない)', async () => {
    const fake = createFake({ meals: [meal('a', daysAgo(91), null), meal('b', daysAgo(92), null)] });
    // 時計は呼ぶたびに 6 ms 進む。始め (0) から上限は 10。1 回目の確認 (6) は上限の中、2 回目 (12) で上限を過ぎる
    let t = 0;
    const result = await purgeExpiredHiddenContent(fake.admin, {
      now: NOW,
      batchSize: 1,
      maxDurationMs: 10,
      clock: () => {
        const value = t;
        t += 6;
        return value;
      },
    });

    expect(result.completed).toBe(false);
    expect(result.deleted_rows.meals).toBe(1);
    expect(fake.tables.meals).toHaveLength(1);
  });
});

describe('Storage の URL の解釈 (退会の掃除と共用)', () => {
  it('退会の掃除 (src/lib/account-deletion-storage.ts) は、同じ関数をそのまま使う', () => {
    expect(accountStorage.parseStorageObjectUrl).toBe(sharedUrl.parseStorageObjectUrl);
    expect(accountStorage.isOwnedObjectPath).toBe(sharedUrl.isOwnedObjectPath);
    expect(accountStorage.ACCOUNT_STORAGE_BUCKETS).toEqual(['meal_photos', 'fridge-images', 'health-checkups']);
  });

  it('objectNeedles: 符号化の要らないパスは 1 つ、要るパスは 2 つの形を返す', () => {
    expect(objectNeedles('fridge-images', `${OWNER}/a.jpg`)).toEqual([`/fridge-images/${OWNER}/a.jpg`]);
    expect(objectNeedles('fridge-images', `${OWNER}/a b.jpg`)).toEqual([
      `/fridge-images/${OWNER}/a b.jpg`,
      `/fridge-images/${OWNER}/a%20b.jpg`,
    ]);
  });
});
