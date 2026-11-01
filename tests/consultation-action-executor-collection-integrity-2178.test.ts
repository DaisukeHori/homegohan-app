/**
 * #2178 Y3: AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) の
 * recipe_ids の読み直しの失敗 (Y3-a) と、同じ名前のコレクションを作るときの ON CONFLICT (Y3-b)。
 *
 * Y3-a: 足す前に recipe_ids を読み直す。修正前はこの読み直しの error を受け取らず、`currentCollection?.recipe_ids || []` で
 *   読み直しの失敗を「空のコレクション」と同じに扱っていた。そのまま `.update({ recipe_ids: [...[], recipeId] })` を書くので、
 *   それまで入っていたレシピがコレクションから消えた。修正後は、読み直しがエラー・行が返らないときは update を呼ばず、
 *   `success = false`・`result = { collectionId, added: false }` を返し、構造化ログに残す。
 * Y3-b: recipe_collections に一意の索引 (user_id, name) を足した。名前で引いて 0 行だったあとに、別の実行が同じ名前の行を
 *   先に作ると、修正前の insert は一意の違反 (23505) で「コレクションの作成に失敗しました」を返していた。
 *   修正後は upsert (onConflict = 索引の列) で作り、既にある行を使う (行は増えない)。
 *
 * Supabase のクライアントは tests/helpers/fake-recipe-collections-db.ts の作り物 (一意の索引 (user_id, name) を持つ) に差し替える。
 * 本物の DB での振る舞い (一意の違反・executor が重複を作らない) は
 * tests/integration/rls/recipe-collections-user-name-unique.test.ts が確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET } from '@/lib/recipes/collections';

const USER_ID = 'user-2178';
const RECIPE_ID = 'recipe-2178-new';
const EXISTING_RECIPE_IDS = ['recipe-2178-a', 'recipe-2178-b'];
const COLLECTION_NAME = '作り置き';
const COLLECTION_ID = 'collection-2178';
const SEED_CREATED_AT = '2026-10-01T00:00:00.000Z';
const ACTION_ID = 'action-2178';
/** 読み直しの失敗を残す構造化ログの operation */
const REREAD_OPERATION = 'recipe_collections.reread';
/** DB が返す生のエラー文の目印。result に出てはいけない (#1172) */
const RAW_DB_ERROR_TEXT = 'canceling statement due to statement timeout (sentinel 2178)';
/** statement_timeout の SQLSTATE (読み直しの一時的な失敗の例) */
const QUERY_CANCELED_SQLSTATE = '57014';

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

function addToCollectionAction(): ConsultationActionRow {
  return {
    id: ACTION_ID,
    action_type: 'add_recipe_to_collection',
    action_params: { recipeId: RECIPE_ID, collectionName: COLLECTION_NAME },
    ai_consultation_sessions: { user_id: USER_ID },
  };
}

function existingCollection(overrides: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: COLLECTION_ID,
    user_id: USER_ID,
    name: COLLECTION_NAME,
    created_at: SEED_CREATED_AT,
    recipe_ids: [...EXISTING_RECIPE_IDS],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2178 Y3-a add_recipe_to_collection: recipe_ids の読み直しが失敗したら上書きしない', () => {
  it('読み直しがエラーなら update を呼ばず、既存のレシピを残して added: false を返し、生のエラー文は result に入れずログに残す', async () => {
    const db = createFakeCollectionsDb([existingCollection()]);
    db.failOn('reread', { message: RAW_DB_ERROR_TEXT, code: QUERY_CANCELED_SQLSTATE });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(db.rereadCount).toBe(1);
    expect(db.updates).toEqual([]);
    expect(db.rows[0].recipe_ids).toEqual(EXISTING_RECIPE_IDS);
    expect(success).toBe(false);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: false });
    expect(JSON.stringify(result)).not.toContain(RAW_DB_ERROR_TEXT);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, loggedError, meta] = logError.mock.calls[0];
    expect((loggedError as Error).message).toBe(RAW_DB_ERROR_TEXT);
    expect(meta).toMatchObject({ action_id: ACTION_ID, operation: REREAD_OPERATION, error_code: QUERY_CANCELED_SQLSTATE });
  });

  it('読み直しがエラーも行も返さない ({ data: null, error: null }) ときも update を呼ばず、added: false を返してログに残す', async () => {
    const db = createFakeCollectionsDb([existingCollection()]);
    db.rereadWithoutRow();

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(db.rereadCount).toBe(1);
    expect(db.updates).toEqual([]);
    expect(db.rows[0].recipe_ids).toEqual(EXISTING_RECIPE_IDS);
    expect(success).toBe(false);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: false });
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , meta] = logError.mock.calls[0];
    expect(meta).toMatchObject({ action_id: ACTION_ID, operation: REREAD_OPERATION });
  });

  it('名前で引いたあと読み直しの前に行が消えた (.single() が 0 行で PGRST116) ら、update を呼ばずに added: false を返す', async () => {
    const db = createFakeCollectionsDb([existingCollection()], {
      beforeReread: (rows) => {
        rows.splice(0, rows.length);
      },
    });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(db.updates).toEqual([]);
    expect(db.rows).toEqual([]);
    expect(success).toBe(false);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: false });
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('読み直しが成功したら、既存のレシピの後ろに足す (既存は消えない)', async () => {
    const db = createFakeCollectionsDb([existingCollection()]);

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.updates).toEqual([{ filters: [['id', COLLECTION_ID]], values: { recipe_ids: [...EXISTING_RECIPE_IDS, RECIPE_ID] } }]);
    expect(db.rows[0].recipe_ids).toEqual([...EXISTING_RECIPE_IDS, RECIPE_ID]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('読み直した recipe_ids が NULL (列は NULL を許す) なら、空として扱って足す', async () => {
    const db = createFakeCollectionsDb([existingCollection({ recipe_ids: null })]);

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.rows[0].recipe_ids).toEqual([RECIPE_ID]);
  });

  it('レシピが既に入っていれば update を呼ばずに成功を返す', async () => {
    const db = createFakeCollectionsDb([existingCollection({ recipe_ids: [...EXISTING_RECIPE_IDS, RECIPE_ID] })]);

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.updates).toEqual([]);
  });
});

describe('#2178 Y3-b add_recipe_to_collection: 作るときは一意の索引 (user_id, name) の ON CONFLICT で既存の行を使う', () => {
  it('名前で引いて 0 行のとき、insert ではなく onConflict = 索引の列の upsert で作る', async () => {
    const db = createFakeCollectionsDb([]);

    const { success } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(db.inserts).toEqual([]);
    expect(db.upserts).toEqual([
      { values: { user_id: USER_ID, name: COLLECTION_NAME }, options: { onConflict: RECIPE_COLLECTIONS_USER_NAME_CONFLICT_TARGET } },
    ]);
    expect(db.rows).toHaveLength(1);
  });

  it('名前で引いたあとに別の実行が同じ名前の行を先に作っても、その行に足して成功する (行は増えず、既存のレシピも残る)', async () => {
    const racer = existingCollection();
    const db = createFakeCollectionsDb([], {
      afterNameLookup: (rows) => {
        if (!rows.some((row) => row.id === racer.id)) rows.push({ ...racer, recipe_ids: [...EXISTING_RECIPE_IDS] });
      },
    });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].recipe_ids).toEqual([...EXISTING_RECIPE_IDS, RECIPE_ID]);
    expect(logError).not.toHaveBeenCalled();
  });
});
