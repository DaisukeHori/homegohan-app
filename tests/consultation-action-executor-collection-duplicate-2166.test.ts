/**
 * #2166 X4: AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) は、
 * 同じ名前のコレクションが 2 件以上あっても、新しいコレクションを作らず、いつも同じ古い方 (作った日時の古い順・同じ日時は id の順の先頭) へ足す。
 *
 * recipe_collections に (user_id, name) の一意の制約は無い (主キーと user_id の索引だけ)。
 * 修正前は名前で引く問い合わせを .single() で読んでいた。PostgREST の .single() は 2 行以上で失敗 (data は null) するので、
 * 同じ名前が 2 件になると、以後この操作のたびに同じ名前のコレクションをもう 1 件作り、レシピがばらばらのコレクションに入っていた。
 * 修正後は LIST_ORDERS.aiConsultationCollectionByName で並べて limit(1) + maybeSingle で読み、読み取りのエラーと 0 行を分ける
 * (エラーなら作らずに失敗を返す)。
 *
 * Supabase のクライアントは、eq / order / limit / single / maybeSingle を実物の PostgREST と同じ意味で扱う作り物に差し替える
 * (.single() は 1 行ちょうどでなければエラー、.maybeSingle() は 2 行以上でエラー・0 行は null)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_ORDERS, type ListOrderKey } from '@/lib/api/list-order';

const USER_ID = 'user-2166';
const OTHER_USER_ID = 'user-other-2166';
const RECIPE_ID = 'recipe-2166';
const COLLECTION_NAME = '作り置き';
/** AI がコレクションの名前を渡さなかったときの足し先の名前 (executor の DEFAULT_RECIPE_COLLECTION_NAME と同じ文) */
const DEFAULT_COLLECTION_NAME = 'お気に入り';
const LOOKUP_FAILED_MESSAGE = 'コレクションの取得に失敗しました';
const CREATE_FAILED_MESSAGE = 'コレクションの作成に失敗しました';
/** DB が返す生のエラー文の目印。result に出てはいけない (#1172) */
const RAW_DB_ERROR_TEXT = 'relation "recipe_collections_sentinel_2166" does not exist';

const logError = vi.hoisted(() => vi.fn());

// 献立生成のエンジン切り替え (#1148) はこのアクションに関係しないので OFF 固定
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

vi.mock('@/lib/db-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db-logger')>()),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import { runConsultationAction, type ConsultationActionRow } from '../src/lib/ai/consultation-action-executor';

interface CollectionRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  recipe_ids: string[];
}

interface PgError {
  message: string;
  code: string;
}

type Op = 'select' | 'insert' | 'update';

/** recipe_collections だけを持つ Supabase の作り物 */
function createFakeCollectionsDb(seed: CollectionRow[]) {
  const rows: CollectionRow[] = seed.map((row) => ({ ...row, recipe_ids: [...row.recipe_ids] }));
  /** 名前で引く select (user_id と name で絞る読み取り) の order / limit の記録 */
  const nameLookups: Array<{ orders: ListOrderKey[]; limit: number | null }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const failures: Partial<Record<Op, PgError>> = {};
  let nextId = 1;

  const compare = (a: CollectionRow, b: CollectionRow, orders: ListOrderKey[]): number => {
    for (const { column, options } of orders) {
      const left = String(a[column as keyof CollectionRow]);
      const right = String(b[column as keyof CollectionRow]);
      if (left !== right) return (left < right ? -1 : 1) * (options.ascending ? 1 : -1);
    }
    return 0;
  };

  const makeQuery = (table: string) => {
    expect(table).toBe('recipe_collections');
    let op: Op = 'select';
    let payload: Record<string, unknown> = {};
    const filters: Array<[string, unknown]> = [];
    const orders: ListOrderKey[] = [];
    let limit: number | null = null;

    const matched = () =>
      rows.filter((row) => filters.every(([column, value]) => row[column as keyof CollectionRow] === value));

    const selectRows = (): CollectionRow[] => {
      const filterColumns = filters.map(([column]) => column);
      if (filterColumns.includes('user_id') && filterColumns.includes('name')) nameLookups.push({ orders: [...orders], limit });
      const sorted = [...matched()].sort((a, b) => compare(a, b, orders));
      return limit === null ? sorted : sorted.slice(0, limit);
    };

    /** insert / update を実行し、select の対象の行を返す */
    const run = (): { data: CollectionRow[] | null; error: PgError | null } => {
      const failure = failures[op];
      if (failure) return { data: null, error: failure };
      if (op === 'insert') {
        inserts.push(payload);
        const row: CollectionRow = {
          id: `collection-new-${nextId++}`,
          user_id: String(payload.user_id),
          name: String(payload.name),
          created_at: '2026-11-01T09:00:00.000Z',
          recipe_ids: [],
        };
        rows.push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        const targets = matched();
        for (const row of targets) Object.assign(row, payload);
        return { data: targets, error: null };
      }
      return { data: selectRows(), error: null };
    };

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: (column: string, options: ListOrderKey['options']) => {
        orders.push({ column, options });
        return builder;
      },
      limit: (count: number) => {
        limit = count;
        return builder;
      },
      insert: (values: Record<string, unknown>) => {
        op = 'insert';
        payload = values;
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        op = 'update';
        payload = values;
        return builder;
      },
      /** PostgREST の .single(): 1 行ちょうどでなければエラー (PGRST116) */
      single: async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        if (data === null || data.length !== 1) {
          return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        }
        return { data: data[0], error: null };
      },
      /** PostgREST の .maybeSingle(): 0 行は null、2 行以上はエラー */
      maybeSingle: async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        if (data !== null && data.length > 1) {
          return { data: null, error: { message: 'JSON object requested, multiple rows returned', code: 'PGRST116' } };
        }
        return { data: data?.[0] ?? null, error: null };
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        const { error } = run();
        return Promise.resolve({ data: null, error }).then(resolve, reject);
      },
    };
    return builder;
  };

  return {
    rows,
    nameLookups,
    inserts,
    failOn(op: Op, error: PgError) {
      failures[op] = error;
    },
    supabase: { from: (table: string) => makeQuery(table) },
  };
}

function addToCollectionAction(collectionName?: string): ConsultationActionRow {
  return {
    id: 'action-2166',
    action_type: 'add_recipe_to_collection',
    action_params: collectionName === undefined ? { recipeId: RECIPE_ID } : { recipeId: RECIPE_ID, collectionName },
    ai_consultation_sessions: { user_id: USER_ID },
  };
}

function collection(id: string, createdAt: string, overrides: Partial<CollectionRow> = {}): CollectionRow {
  return { id, user_id: USER_ID, name: COLLECTION_NAME, created_at: createdAt, recipe_ids: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2166 X4 runConsultationAction: add_recipe_to_collection は同じ名前のコレクションを増やさない', () => {
  it('同じ名前のコレクションが 2 件あると、新しく作らず、作った日時の古い方へ足す', async () => {
    // 新しい方を先に並べておく (表の並びのまま先頭を取ると新しい方になる)
    const db = createFakeCollectionsDb([
      collection('collection-newer', '2026-10-20T00:00:00.000Z'),
      collection('collection-older', '2026-10-01T00:00:00.000Z'),
    ]);

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: 'collection-older', added: true });
    expect(db.inserts).toEqual([]);
    expect(db.rows).toHaveLength(2);
    expect(db.rows.find((row) => row.id === 'collection-older')?.recipe_ids).toEqual([RECIPE_ID]);
    expect(db.rows.find((row) => row.id === 'collection-newer')?.recipe_ids).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('同じ名前のコレクションの作った日時が同じなら、id の順の先頭へ足す (何度実行しても同じ 1 件)', async () => {
    const sameCreatedAt = '2026-10-05T12:00:00.000Z';
    const db = createFakeCollectionsDb([collection('collection-b', sameCreatedAt), collection('collection-a', sameCreatedAt)]);

    const first = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));
    const second = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(first.result).toEqual({ collectionId: 'collection-a', added: true });
    expect(second.success).toBe(true);
    expect(second.result).toEqual({ collectionId: 'collection-a', added: true });
    expect(db.inserts).toEqual([]);
    expect(db.rows.find((row) => row.id === 'collection-a')?.recipe_ids).toEqual([RECIPE_ID]);
    expect(db.rows.find((row) => row.id === 'collection-b')?.recipe_ids).toEqual([]);
  });

  it('名前で引く問い合わせは LIST_ORDERS.aiConsultationCollectionByName の鍵の順で並べ、1 行に切って読む', async () => {
    const db = createFakeCollectionsDb([collection('collection-only', '2026-10-01T00:00:00.000Z')]);

    await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(db.nameLookups).toEqual([{ orders: [...LIST_ORDERS.aiConsultationCollectionByName.keys], limit: 1 }]);
  });

  it('ほかの利用者の同じ名前のコレクションには足さない', async () => {
    const db = createFakeCollectionsDb([
      collection('collection-other-user', '2026-09-01T00:00:00.000Z', { user_id: OTHER_USER_ID }),
      collection('collection-mine', '2026-10-01T00:00:00.000Z'),
    ]);

    const { result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(result).toEqual({ collectionId: 'collection-mine', added: true });
    expect(db.rows.find((row) => row.id === 'collection-other-user')?.recipe_ids).toEqual([]);
  });

  it('同じ名前のコレクションが無ければ 1 件だけ作って足す (名前を渡さなければ「お気に入り」)', async () => {
    const db = createFakeCollectionsDb([]);

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(db.inserts).toEqual([{ user_id: USER_ID, name: DEFAULT_COLLECTION_NAME }]);
    expect(db.rows).toHaveLength(1);
    expect(result).toEqual({ collectionId: db.rows[0].id, added: true });
    expect(db.rows[0].recipe_ids).toEqual([RECIPE_ID]);
  });

  it('名前で引く読み取りがエラーなら、コレクションを作らずに失敗を返し、生のエラー文は result に入れずログに残す', async () => {
    const db = createFakeCollectionsDb([collection('collection-older', '2026-10-01T00:00:00.000Z')]);
    db.failOn('select', { message: RAW_DB_ERROR_TEXT, code: '42P01' });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(success).toBe(false);
    expect(result).toEqual({ error: LOOKUP_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(RAW_DB_ERROR_TEXT);
    expect(db.inserts).toEqual([]);
    expect(db.rows).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, loggedError, meta] = logError.mock.calls[0];
    expect((loggedError as Error).message).toBe(RAW_DB_ERROR_TEXT);
    expect(meta).toMatchObject({ action_id: 'action-2166', operation: 'recipe_collections.select' });
  });

  it('コレクションを作れなければ失敗を返し、生のエラー文は result に入れずログに残す', async () => {
    const db = createFakeCollectionsDb([]);
    db.failOn('insert', { message: RAW_DB_ERROR_TEXT, code: '42501' });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(success).toBe(false);
    expect(result).toEqual({ error: CREATE_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(RAW_DB_ERROR_TEXT);
    expect(db.rows).toHaveLength(0);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , meta] = logError.mock.calls[0];
    expect(meta).toMatchObject({ action_id: 'action-2166', operation: 'recipe_collections.insert' });
  });
});
