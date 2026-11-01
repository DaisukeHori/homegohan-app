/**
 * #2166 X4: AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) は、
 * 同じ名前のコレクションが 2 件以上あっても、新しいコレクションを作らず、いつも同じ古い方 (作った日時の古い順・同じ日時は id の順の先頭) へ足す。
 *
 * X4 の時点の recipe_collections には (user_id, name) の一意の制約が無かった (主キーと user_id の索引だけ)。#2178 Y3-b で一意の索引を足し、
 * いまは同じ名前の 2 件目を作れない。ここで 2 件を seed するテストは、索引の前に作られた行が残っていても古い方へ足すことを確かめる。
 * 修正前は名前で引く問い合わせを .single() で読んでいた。PostgREST の .single() は 2 行以上で失敗 (data は null) するので、
 * 同じ名前が 2 件になると、以後この操作のたびに同じ名前のコレクションをもう 1 件作り、レシピがばらばらのコレクションに入っていた。
 * 修正後は LIST_ORDERS.aiConsultationCollectionByName で並べて limit(1) + maybeSingle で読み、読み取りのエラーと 0 行を分ける
 * (エラーなら作らずに失敗を返す)。
 *
 * Supabase のクライアントは、eq / order / limit / single / maybeSingle / upsert を実物の PostgREST と同じ意味で扱う作り物
 * (tests/helpers/fake-recipe-collections-db.ts) に差し替える
 * (.single() は 1 行ちょうどでなければエラー、.maybeSingle() は 2 行以上でエラー・0 行は null)。
 * コレクションを作るときは、Y3-b から insert ではなく upsert (onConflict = 一意の索引の列) を使う。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_ORDERS } from '@/lib/api/list-order';
import { RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET } from '@/lib/recipes/collections';

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
import { createFakeCollectionsDb, type CollectionRow } from './helpers/fake-recipe-collections-db';

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
    expect(db.upserts).toEqual([]);
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
    expect(db.upserts).toEqual([]);
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
    expect(db.inserts).toEqual([]);
    expect(db.upserts).toEqual([
      { values: { user_id: USER_ID, name: DEFAULT_COLLECTION_NAME }, options: { onConflict: RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET } },
    ]);
    expect(db.rows).toHaveLength(1);
    expect(result).toEqual({ collectionId: db.rows[0].id, added: true });
    expect(db.rows[0].recipe_ids).toEqual([RECIPE_ID]);
  });

  it('名前で引く読み取りがエラーなら、コレクションを作らずに失敗を返し、生のエラー文は result に入れずログに残す', async () => {
    const db = createFakeCollectionsDb([collection('collection-older', '2026-10-01T00:00:00.000Z')]);
    db.failOn('lookup', { message: RAW_DB_ERROR_TEXT, code: '42P01' });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(success).toBe(false);
    expect(result).toEqual({ error: LOOKUP_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(RAW_DB_ERROR_TEXT);
    expect(db.inserts).toEqual([]);
    expect(db.upserts).toEqual([]);
    expect(db.rows).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, loggedError, meta] = logError.mock.calls[0];
    expect((loggedError as Error).message).toBe(RAW_DB_ERROR_TEXT);
    expect(meta).toMatchObject({ action_id: 'action-2166', operation: 'recipe_collections.select' });
  });

  it('コレクションを作れなければ失敗を返し、生のエラー文は result に入れずログに残す', async () => {
    const db = createFakeCollectionsDb([]);
    db.failOn('upsert', { message: RAW_DB_ERROR_TEXT, code: '42501' });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction(COLLECTION_NAME));

    expect(success).toBe(false);
    expect(result).toEqual({ error: CREATE_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(RAW_DB_ERROR_TEXT);
    expect(db.rows).toHaveLength(0);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , meta] = logError.mock.calls[0];
    expect(meta).toMatchObject({ action_id: 'action-2166', operation: 'recipe_collections.upsert' });
  });
});
