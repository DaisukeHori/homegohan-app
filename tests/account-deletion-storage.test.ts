/**
 * 退会時の Storage 掃除 (src/lib/account-deletion-storage.ts, #1175) の単体テスト
 *
 * Storage と DB はメモリ上の偽物。実物での確認は tests/integration/security/account-deletion.test.ts。
 *
 * 確認すること:
 *   - URL の読み取り: public / sign / authenticated / render の URL からバケットとパスを取り出す。3 バケット以外・壊れた URL は null
 *   - 持ち主の判定: 他人のフォルダは常に触らない。本人の user_id を含むパス、本人の献立の id の generated/ だけが本人のもの
 *   - 掃除: 本人のフォルダ (サブフォルダも)・旧パス・URL が指す本人のファイルを消す。500 件を超える大きさでも最後まで消す
 *   - 他人のファイル・持ち主が分からないファイルは、自分の行の URL で指されていても消さない
 *   - バケットが無ければ何もしない。他の失敗・進まない・時間切れは例外にする (退会を止めてやり直せるようにする)
 *   - URL を集める読み出しの失敗は警告にとどめ、主な掃除は続ける
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AccountStorageTimeoutError,
  ACCOUNT_STORAGE_BUCKETS,
  STORAGE_LIST_PAGE_SIZE,
  isOwnedObjectPath,
  parseStorageObjectUrl,
  removeAccountStorage,
  type AccountStorageAdmin,
} from '../src/lib/account-deletion-storage';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PLANNED = '33333333-3333-4333-8333-333333333333';
const PLANNED_FOREIGN = '44444444-4444-4444-8444-444444444444';
const BASE = 'http://127.0.0.1:54321/storage/v1/object';

// ─────────────────────────────────────────────────────────────────────────────
// 偽の Storage と DB
// ─────────────────────────────────────────────────────────────────────────────
interface FakeOptions {
  /** 指定したバケットは「Bucket not found」を返す */
  missingBuckets?: string[];
  /** list / remove をこの回数目から失敗させる (1 始まり) */
  failListAt?: number;
  failRemoveAt?: number;
  /** true なら remove は何も消さずに空の結果を返す (進まない状態) */
  removeDoesNothing?: boolean;
  /** テーブル名 → 行。from(table).select().eq()... は全行を返し、range で切る */
  tables?: Record<string, Array<Record<string, unknown>>>;
  /** このテーブルの読み出しは失敗する */
  failingTables?: string[];
}

function makeAdmin(initial: Record<string, string[]>, options: FakeOptions = {}) {
  const buckets = new Map<string, Set<string>>();
  for (const bucket of ACCOUNT_STORAGE_BUCKETS) buckets.set(bucket, new Set(initial[bucket] ?? []));
  const calls = { list: 0, remove: 0, removedPaths: [] as string[], tablesRead: [] as string[] };

  const storage = {
    from: (bucket: string) => ({
      list: async (prefix: string, opts: { limit?: number; offset?: number } = {}) => {
        calls.list += 1;
        if (options.missingBuckets?.includes(bucket)) {
          return { data: null, error: { message: 'Bucket not found', status: 404 } };
        }
        if (options.failListAt === calls.list) return { data: null, error: { message: 'list exploded' } };
        const set = buckets.get(bucket) ?? new Set<string>();
        const folderPrefix = prefix ? `${prefix}/` : '';
        const entries = new Map<string, { name: string; id: string | null }>();
        for (const path of [...set].sort()) {
          if (!path.startsWith(folderPrefix)) continue;
          const rest = path.slice(folderPrefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) entries.set(rest, { name: rest, id: `id-${path}` });
          else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
        }
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? 100;
        return { data: [...entries.values()].slice(offset, offset + limit), error: null };
      },
      remove: async (paths: string[]) => {
        calls.remove += 1;
        if (options.failRemoveAt === calls.remove) return { data: null, error: { message: 'remove exploded' } };
        if (options.removeDoesNothing) return { data: [], error: null };
        const set = buckets.get(bucket);
        if (!set) return { data: null, error: { message: 'Bucket not found', status: 404 } };
        const removed: Array<{ name: string }> = [];
        for (const path of paths) {
          if (set.delete(path)) {
            removed.push({ name: path });
            calls.removedPaths.push(`${bucket}/${path}`);
          }
        }
        return { data: removed, error: null };
      },
    }),
  };

  const makeBuilder = (table: string) => {
    let from = 0;
    let to = Number.MAX_SAFE_INTEGER;
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'not', 'order']) builder[method] = () => builder;
    builder.range = (f: number, t: number) => {
      from = f;
      to = t;
      return builder;
    };
    builder.then = (resolve: (value: unknown) => unknown) => {
      calls.tablesRead.push(table);
      if (options.failingTables?.includes(table)) return resolve({ data: null, error: { message: `${table} is broken` } });
      const rows = options.tables?.[table] ?? [];
      return resolve({ data: rows.slice(from, to + 1), error: null });
    };
    return builder;
  };

  const admin = { storage, from: (table: string) => makeBuilder(table) } as unknown as AccountStorageAdmin;
  return { admin, buckets, calls };
}

const left = (buckets: Map<string, Set<string>>, bucket: string) => [...(buckets.get(bucket) ?? [])].sort();

// ─────────────────────────────────────────────────────────────────────────────
// parseStorageObjectUrl / isOwnedObjectPath
// ─────────────────────────────────────────────────────────────────────────────
describe('parseStorageObjectUrl', () => {
  it('public / sign / authenticated / render の URL からバケットとパスを取り出す', () => {
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/${USER}/fridge/a.png`)).toEqual({
      bucket: 'fridge-images',
      path: `${USER}/fridge/a.png`,
    });
    expect(parseStorageObjectUrl(`${BASE}/sign/health-checkups/${USER}/x.png?token=abc.def.ghi`)).toEqual({
      bucket: 'health-checkups',
      path: `${USER}/x.png`,
    });
    expect(parseStorageObjectUrl(`${BASE}/authenticated/meal_photos/${USER}/y.jpg`)).toEqual({
      bucket: 'meal_photos',
      path: `${USER}/y.jpg`,
    });
    expect(parseStorageObjectUrl('http://127.0.0.1:54321/storage/v1/render/image/public/fridge-images/meals/u/z.png?width=200')).toEqual({
      bucket: 'fridge-images',
      path: 'meals/u/z.png',
    });
  });

  it('パーセントエンコードされたパスを元に戻す', () => {
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/${USER}/%E5%86%B7%E8%94%B5%E5%BA%AB%20a.png`)).toEqual({
      bucket: 'fridge-images',
      path: `${USER}/冷蔵庫 a.png`,
    });
  });

  it('3 バケット以外・Storage の URL でないもの・壊れた値は null', () => {
    expect(parseStorageObjectUrl(`${BASE}/public/avatars/${USER}/a.png`)).toBeNull();
    expect(parseStorageObjectUrl('https://example.com/images/a.png')).toBeNull();
    expect(parseStorageObjectUrl('not a url')).toBeNull();
    expect(parseStorageObjectUrl('')).toBeNull();
    expect(parseStorageObjectUrl(null)).toBeNull();
    expect(parseStorageObjectUrl(undefined)).toBeNull();
    expect(parseStorageObjectUrl(123)).toBeNull();
    // パスが空 (バケット直下のフォルダ指定)
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/`)).toBeNull();
    // 壊れたパーセントエンコード
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/%E0%A4%A.png`)).toBeNull();
  });

  it('パスの組み立てが怪しい URL (%2F で隠した区切り・%5C・空の区間・制御文字・末尾のスラッシュ) は null', () => {
    // 区切りの / を %2F で隠して、「本人のパス」に見せかけた別のオブジェクトを指す
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}/..%2F${OTHER}%2Fx.png`)).toBeNull();
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old%2F${USER}%2Fx.png`)).toBeNull();
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}/..%5C${OTHER}/x.png`)).toBeNull();
    // 空の区間 (//)・制御文字・末尾のスラッシュ (フォルダ指定)
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}//x.png`)).toBeNull();
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}/x.png%00`)).toBeNull();
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}/x%0A.png`)).toBeNull();
    expect(parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}/`)).toBeNull();
  });

  it('リテラルの `..` は URL の解釈で解決されるので、本人のパスを経由しても他人のパスとして扱われる', () => {
    const parsed = parseStorageObjectUrl(`${BASE}/public/fridge-images/old/${USER}/../${OTHER}/x.png`);
    expect(parsed).toEqual({ bucket: 'fridge-images', path: `old/${OTHER}/x.png` });
    // 解決後のパスには本人の id が無いので、本人のものとは扱われない
    expect(isOwnedObjectPath(parsed!.path, USER, new Set())).toBe(false);
  });
});

describe('isOwnedObjectPath', () => {
  const planned = new Set([PLANNED]);

  it('パスの中に本人の user_id がある旧パスは本人のもの', () => {
    expect(isOwnedObjectPath(`meals/${USER}/a.jpg`, USER, planned)).toBe(true);
    expect(isOwnedObjectPath(`generated/${USER}/a.png`, USER, planned)).toBe(true);
    expect(isOwnedObjectPath(`old/${USER}/a.png`, USER, planned)).toBe(true);
    expect(isOwnedObjectPath(`${USER}/fridge/a.png`, USER, planned)).toBe(true);
  });

  it('他の利用者のフォルダ (先頭が別の uuid) は、どんな場合も本人のものではない', () => {
    expect(isOwnedObjectPath(`${OTHER}/a.png`, USER, planned)).toBe(false);
    // 本人の id や献立の id を後ろに混ぜても、先頭が別の uuid なら触らない
    expect(isOwnedObjectPath(`${OTHER}/${USER}/a.png`, USER, planned)).toBe(false);
    expect(isOwnedObjectPath(`${OTHER}/generated/${PLANNED}/a.png`, USER, planned)).toBe(false);
  });

  it('generated/<本人の献立の id>/… は本人のもの。知らない献立の id や形の違うものは違う', () => {
    expect(isOwnedObjectPath(`generated/${PLANNED}/job-1.png`, USER, planned)).toBe(true);
    expect(isOwnedObjectPath(`generated/${PLANNED_FOREIGN}/job-1.png`, USER, planned)).toBe(false);
    expect(isOwnedObjectPath(`other/${PLANNED}/job-1.png`, USER, planned)).toBe(false);
    expect(isOwnedObjectPath(`generated/${PLANNED}`, USER, planned)).toBe(false);
    expect(isOwnedObjectPath(`generated/${PLANNED}/job-1.png`, USER, new Set())).toBe(false);
  });

  it('持ち主がパスから分からないもの (バケット直下のタイムスタンプ名・別の人の旧パス) は違う', () => {
    expect(isOwnedObjectPath('1700000000000.jpg', USER, planned)).toBe(false);
    expect(isOwnedObjectPath(`meals/${OTHER}/a.jpg`, USER, planned)).toBe(false);
    expect(isOwnedObjectPath('', USER, planned)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// removeAccountStorage
// ─────────────────────────────────────────────────────────────────────────────
describe('removeAccountStorage: 本人のフォルダと旧パス', () => {
  it('3 バケットの <user_id>/ 以下 (サブフォルダも) と旧パスを消し、他人のファイルは残す', async () => {
    const { admin, buckets } = makeAdmin({
      'fridge-images': [
        `${USER}/fridge/a.png`,
        `${USER}/generated/deep/b.png`,
        `meals/${USER}/legacy.jpg`,
        `generated/${USER}/legacy.png`,
        `uploads/${USER}/legacy.png`,
        `${OTHER}/fridge/keep.png`,
        `meals/${OTHER}/keep.jpg`,
        'root-level.jpg',
      ],
      meal_photos: [`${USER}/p.png`, `${OTHER}/keep.png`],
      'health-checkups': [`${USER}/c.png`, `${OTHER}/keep.png`],
    });

    const result = await removeAccountStorage(admin, USER);

    expect(left(buckets, 'fridge-images')).toEqual([`${OTHER}/fridge/keep.png`, `meals/${OTHER}/keep.jpg`, 'root-level.jpg'].sort());
    expect(left(buckets, 'meal_photos')).toEqual([`${OTHER}/keep.png`]);
    expect(left(buckets, 'health-checkups')).toEqual([`${OTHER}/keep.png`]);
    expect(result.removed_by_bucket).toEqual({ meal_photos: 1, 'fridge-images': 5, 'health-checkups': 1 });
    expect(result.removed_total).toBe(7);
    expect(result.removed_by_reference).toBe(0);
  });

  it(`${STORAGE_LIST_PAGE_SIZE} 件を超える大きさでも最後まで消す`, async () => {
    const many = Array.from({ length: STORAGE_LIST_PAGE_SIZE * 2 + 37 }, (_, i) => `${USER}/bulk/f-${String(i).padStart(5, '0')}.png`);
    const { admin, buckets, calls } = makeAdmin({ 'fridge-images': [...many, `${OTHER}/keep.png`] });

    const result = await removeAccountStorage(admin, USER);

    expect(left(buckets, 'fridge-images')).toEqual([`${OTHER}/keep.png`]);
    expect(result.removed_by_bucket['fridge-images']).toBe(many.length);
    expect(calls.remove).toBeGreaterThanOrEqual(3);
  });

  it('消すものが無い利用者でもエラーにならない', async () => {
    const { admin, calls } = makeAdmin({ 'fridge-images': [`${OTHER}/keep.png`] });
    const result = await removeAccountStorage(admin, USER);
    expect(result.removed_total).toBe(0);
    expect(calls.remove).toBe(0);
  });

  it('バケットが無い (Bucket not found) ときは何もせず成功する', async () => {
    const { admin } = makeAdmin({}, { missingBuckets: ['meal_photos'] });
    await expect(removeAccountStorage(admin, USER)).resolves.toMatchObject({ removed_total: 0 });
  });

  it('userId が uuid でなければ、何も触らず例外にする (バケット直下の掃除を防ぐ)', async () => {
    const { admin, calls } = makeAdmin({ 'fridge-images': ['root.png'] });
    await expect(removeAccountStorage(admin, '')).rejects.toThrow(/uuid/);
    await expect(removeAccountStorage(admin, 'not-a-uuid')).rejects.toThrow(/uuid/);
    expect(calls.list).toBe(0);
    expect(calls.remove).toBe(0);
  });
});

describe('removeAccountStorage: 失敗は例外にする (退会を止めてやり直せるようにする)', () => {
  it('list の失敗 (Bucket not found 以外) は例外。メッセージにパスを含めない', async () => {
    const { admin } = makeAdmin({ 'fridge-images': [`${USER}/secret-name.png`] }, { failListAt: 1 });
    const error = await removeAccountStorage(admin, USER).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/storage list failed/);
    expect(error?.message).not.toContain('secret-name');
    expect(error?.message).not.toContain(USER);
  });

  it('remove の失敗は例外', async () => {
    const { admin } = makeAdmin({ 'fridge-images': [`${USER}/a.png`] }, { failRemoveAt: 1 });
    await expect(removeAccountStorage(admin, USER)).rejects.toThrow(/storage remove failed/);
  });

  it('一覧に出ているのに消えない状態が続いたら例外 (無限ループにしない)', async () => {
    const { admin, calls } = makeAdmin({ 'fridge-images': [`${USER}/a.png`] }, { removeDoesNothing: true });
    await expect(removeAccountStorage(admin, USER)).rejects.toThrow(/no progress/);
    expect(calls.list).toBeLessThan(10);
  });

  it('時間の上限を超えたら AccountStorageTimeoutError (やり直せる)', async () => {
    const { admin } = makeAdmin({ 'fridge-images': [`${USER}/a.png`] });
    let t = 0;
    const now = () => {
      t += 1000;
      return t;
    };
    await expect(removeAccountStorage(admin, USER, { maxDurationMs: 1500, now })).rejects.toBeInstanceOf(AccountStorageTimeoutError);
  });
});

describe('removeAccountStorage: DB に保存された URL が指すファイル', () => {
  const url = (bucket: string, path: string) => `${BASE}/public/${bucket}/${path}`;

  it('本人の献立の generated/<id>/ と、パスに本人の id がある旧ファイルを消す', async () => {
    const generated = `generated/${PLANNED}/job-1.png`;
    const old = `old/${USER}/checkup.png`;
    const { admin, buckets } = makeAdmin(
      { 'fridge-images': [generated], 'health-checkups': [old] },
      {
        tables: {
          planned_meals: [{ id: PLANNED, image_url: url('fridge-images', generated) }],
          health_checkups: [{ id: 'c1', image_url: url('health-checkups', old) }],
        },
      },
    );

    const result = await removeAccountStorage(admin, USER);

    expect(left(buckets, 'fridge-images')).toEqual([]);
    expect(left(buckets, 'health-checkups')).toEqual([]);
    expect(result.removed_by_reference).toBe(2);
    expect(result.skipped_unowned).toBe(0);
  });

  it('自分の行の URL が指していても、他人のファイル・持ち主が分からないファイルは消さない', async () => {
    const othersCurrent = `${OTHER}/keep.png`;
    const othersLegacy = `meals/${OTHER}/keep.jpg`;
    const unownedGenerated = `generated/${PLANNED_FOREIGN}/x.png`;
    const rootLevel = '1700000000000.jpg';
    const { admin, buckets } = makeAdmin(
      { 'fridge-images': [othersCurrent, othersLegacy, unownedGenerated, rootLevel] },
      {
        tables: {
          meals: [
            { id: 'm1', photo_url: url('fridge-images', othersCurrent) },
            { id: 'm2', photo_url: url('fridge-images', othersLegacy) },
            { id: 'm3', photo_url: url('fridge-images', unownedGenerated) },
          ],
          weekly_menu_requests: [{ id: 'w1', inventory_image_url: url('fridge-images', rootLevel) }],
          // 献立の id として自分の id を主張しても、planned_meals は「本人の献立」だけを返す前提 (PLANNED_FOREIGN は含まれない)
          planned_meals: [{ id: PLANNED, image_url: null }],
        },
      },
    );

    const result = await removeAccountStorage(admin, USER);

    expect(left(buckets, 'fridge-images')).toEqual([othersCurrent, othersLegacy, unownedGenerated, rootLevel].sort());
    expect(result.removed_by_reference).toBe(0);
    expect(result.skipped_unowned).toBe(4);
  });

  it('3 バケット以外・Storage でない URL・本人のフォルダ (すでに消したもの) は数えず、何も呼ばない', async () => {
    const { admin, calls } = makeAdmin(
      {},
      {
        tables: {
          meals: [
            { id: 'm1', photo_url: 'https://example.com/a.png' },
            { id: 'm2', photo_url: `${BASE}/public/avatars/${USER}/a.png` },
            { id: 'm3', photo_url: url('fridge-images', `${USER}/already-swept.png`) },
            { id: 'm4', photo_url: url('fridge-images', `meals/${USER}/already-swept.png`) },
          ],
        },
      },
    );
    const result = await removeAccountStorage(admin, USER);
    expect(result.skipped_unowned).toBe(0);
    expect(result.removed_by_reference).toBe(0);
    expect(calls.remove).toBe(0);
  });

  it('同じファイルを複数の行が指していても 1 回だけ消す', async () => {
    const path = `old/${USER}/same.png`;
    const { admin, calls } = makeAdmin(
      { 'fridge-images': [path] },
      {
        tables: {
          meals: [
            { id: 'm1', photo_url: url('fridge-images', path) },
            { id: 'm2', photo_url: url('fridge-images', path) },
          ],
        },
      },
    );
    await removeAccountStorage(admin, USER);
    expect(calls.removedPaths).toEqual([`fridge-images/${path}`]);
  });

  it('URL を集める読み出しが失敗しても、警告にとどめて主な掃除は続ける。献立が読めなければ generated/ は消さない', async () => {
    const generated = `generated/${PLANNED}/job-1.png`;
    const { admin, buckets } = makeAdmin(
      { 'fridge-images': [`${USER}/a.png`, generated] },
      {
        failingTables: ['planned_meals', 'blood_test_results'],
        tables: { meal_image_jobs: [{ id: 'j1', result_image_url: url('fridge-images', generated) }] },
      },
    );
    const warn = vi.fn();

    const result = await removeAccountStorage(admin, USER, { log: { warn } });

    expect(left(buckets, 'fridge-images')).toEqual([generated]); // 本人のフォルダは消え、持ち主を確認できない generated/ は残る
    expect(result.reference_read_errors).toBe(2);
    expect(result.skipped_unowned).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    // 警告に URL やメールアドレスは載せない
    expect(JSON.stringify(warn.mock.calls)).not.toContain('storage/v1');
  });

  it('1000 行を超える読み出しも最後まで読む', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `m${i}`, photo_url: null as string | null }));
    rows[2499].photo_url = url('fridge-images', `old/${USER}/last.png`);
    const { admin, buckets } = makeAdmin({ 'fridge-images': [`old/${USER}/last.png`] }, { tables: { meals: rows } });
    await removeAccountStorage(admin, USER);
    expect(left(buckets, 'fridge-images')).toEqual([]);
  });
});
