/**
 * #2178 Y3-b: AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) が
 * 同じ名前のコレクションを作るときの ON CONFLICT。
 *
 * Y3-b: recipe_collections に一意の索引 (user_id, name) を足した。名前で引いて 0 行だったあとに、別の実行が同じ名前の行を
 *   先に作ると、修正前の insert は一意の違反 (23505) で「コレクションの作成に失敗しました」を返していた。
 *   修正後は upsert (onConflict = 索引の列) で作り、既にある行を使う (行は増えない)。
 * Y3-a (recipe_ids の読み直しの失敗で上書きしない) の検査は、#2183 Z3 で読み直しそのものを無くし、1 文の条件つき UPDATE の
 *   DB の関数 append_recipe_to_collection を呼ぶ形にしたため、tests/consultation-action-executor-collection-append-rpc-2183.test.ts
 *   (関数の失敗で何も書かない・既存のレシピが残る・NULL の recipe_ids に足す・既に入っていれば書かない) に移した。
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
