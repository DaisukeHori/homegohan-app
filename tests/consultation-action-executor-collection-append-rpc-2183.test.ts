/**
 * #2183 Z3: AI 相談のアクション add_recipe_to_collection (src/lib/ai/consultation-action-executor.ts) は、
 * レシピを DB の関数 append_recipe_to_collection (1 文の条件つき UPDATE) で足す。
 *
 * 修正前は recipe_ids を読み直してから `.update({ recipe_ids: [...読んだ値, recipeId] })` で書いていた。
 * 読んだ後・書く前に別の実行が同じコレクションへレシピを足すと、後から書いた方がそのレシピを上書きで消した。
 * 修正後は読み直しも update もせず、関数に「まだ入っていなければ末尾に足す」を不可分に任せる。
 * 関数が失敗した・コレクションが見つからない・想定外の値 (STRICT の NULL) を返したときは、ほかの失敗の分岐と同じく
 * 固定の文を result.error に入れ、DB の生のエラー文は構造化ログにだけ残す。
 *
 * Supabase のクライアントは tests/helpers/fake-recipe-collections-db.ts の作り物 (rpc は関数と同じ意味) に差し替える。
 * 本物の DB での振る舞い (同時に 2 本足しても両方残る・本人の行だけ・権限) は
 * tests/integration/rls/recipe-collections-append-recipe-rpc.test.ts が確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECIPE_COLLECTIONS_APPEND_RECIPE_RPC } from '@/lib/recipes/collection-append';

const USER_ID = 'user-2183';
const RECIPE_ID = 'recipe-2183-new';
/** 読んだ後・書く前に、別の実行が先に足すレシピ */
const RACER_RECIPE_ID = 'recipe-2183-racer';
const EXISTING_RECIPE_IDS = ['recipe-2183-a', 'recipe-2183-b'];
const COLLECTION_NAME = '作り置き';
const COLLECTION_ID = 'collection-2183';
const SEED_CREATED_AT = '2026-10-01T00:00:00.000Z';
const ACTION_ID = 'action-2183';
/** 関数の失敗を残す構造化ログの operation */
const APPEND_OPERATION = 'recipe_collections.append_recipe_rpc';
/** DB が返す生のエラー文の目印。result に出てはいけない (#1172) */
const RAW_DB_ERROR_TEXT = 'canceling statement due to statement timeout (sentinel 2183)';
/** statement_timeout の SQLSTATE (関数の一時的な失敗の例) */
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

import {
  AI_COLLECTION_APPEND_FAILED_MESSAGE,
  AI_COLLECTION_NOT_FOUND_MESSAGE,
  runConsultationAction,
  type ConsultationActionRow,
} from '../src/lib/ai/consultation-action-executor';
import { createFakeCollectionsDb, type CollectionRow } from './helpers/fake-recipe-collections-db';

function addToCollectionAction(params: Record<string, unknown> = { recipeId: RECIPE_ID, collectionName: COLLECTION_NAME }): ConsultationActionRow {
  return {
    id: ACTION_ID,
    action_type: 'add_recipe_to_collection',
    action_params: params,
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

describe('#2183 Z3 add_recipe_to_collection: 1 文の条件つき UPDATE の DB の関数で足す', () => {
  it('関数 append_recipe_to_collection を 1 回だけ呼び、読み直しも直接の update もせず、既存のレシピの後ろに足す', async () => {
    const db = createFakeCollectionsDb([existingCollection()], { authUserId: USER_ID });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(db.rpcCalls).toEqual([
      { fn: RECIPE_COLLECTIONS_APPEND_RECIPE_RPC, args: { p_collection_id: COLLECTION_ID, p_recipe_id: RECIPE_ID } },
    ]);
    expect(db.rereadCount).toBe(0);
    expect(db.updates).toEqual([]);
    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.rows[0].recipe_ids).toEqual([...EXISTING_RECIPE_IDS, RECIPE_ID]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('読んだ後・書く前に別の実行が同じコレクションへレシピを足しても、そのレシピを消さずに両方が残る', async () => {
    let raced = false;
    const db = createFakeCollectionsDb([existingCollection()], {
      authUserId: USER_ID,
      beforeRecipeIdsWrite: (rows) => {
        if (raced) return;
        raced = true;
        const target = rows.find((row) => row.id === COLLECTION_ID);
        if (target) target.recipe_ids = [...(target.recipe_ids ?? []), RACER_RECIPE_ID];
      },
    });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(raced).toBe(true);
    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.rows[0].recipe_ids).toEqual([...EXISTING_RECIPE_IDS, RACER_RECIPE_ID, RECIPE_ID]);
  });

  it('レシピが既に入っていれば何も書かずに成功を返す (二重に入らない)', async () => {
    const db = createFakeCollectionsDb([existingCollection({ recipe_ids: [...EXISTING_RECIPE_IDS, RECIPE_ID] })], {
      authUserId: USER_ID,
    });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(db.rpcCalls).toHaveLength(1);
    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.rows[0].recipe_ids).toEqual([...EXISTING_RECIPE_IDS, RECIPE_ID]);
    expect(db.updates).toEqual([]);
  });

  it('recipe_ids が NULL (列は NULL を許す) なら、空として扱って足す', async () => {
    const db = createFakeCollectionsDb([existingCollection({ recipe_ids: null })], { authUserId: USER_ID });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: COLLECTION_ID, added: true });
    expect(db.rows[0].recipe_ids).toEqual([RECIPE_ID]);
  });

  it('コレクションが無ければ作ってから関数で足す (名前を渡さなければ「お気に入り」)', async () => {
    const db = createFakeCollectionsDb([], { authUserId: USER_ID });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction({ recipeId: RECIPE_ID }));

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].name).toBe('お気に入り');
    expect(success).toBe(true);
    expect(result).toEqual({ collectionId: db.rows[0].id, added: true });
    expect(db.rpcCalls).toEqual([
      { fn: RECIPE_COLLECTIONS_APPEND_RECIPE_RPC, args: { p_collection_id: db.rows[0].id, p_recipe_id: RECIPE_ID } },
    ]);
    expect(db.rows[0].recipe_ids).toEqual([RECIPE_ID]);
  });
});

describe('#2183 Z3 add_recipe_to_collection: 関数の失敗の分岐は固定の error 文を返し、何も書かない', () => {
  it('関数がエラーなら、既存のレシピを残して固定の文を返し、生のエラー文は result に入れずログに残す', async () => {
    const db = createFakeCollectionsDb([existingCollection()], { authUserId: USER_ID });
    db.failOn('rpc', { message: RAW_DB_ERROR_TEXT, code: QUERY_CANCELED_SQLSTATE });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(success).toBe(false);
    expect(result).toEqual({ error: AI_COLLECTION_APPEND_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(RAW_DB_ERROR_TEXT);
    expect(db.rows[0].recipe_ids).toEqual(EXISTING_RECIPE_IDS);
    expect(db.updates).toEqual([]);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, loggedError, meta] = logError.mock.calls[0];
    expect((loggedError as Error).message).toBe(RAW_DB_ERROR_TEXT);
    expect(meta).toMatchObject({ action_id: ACTION_ID, operation: APPEND_OPERATION, error_code: QUERY_CANCELED_SQLSTATE });
  });

  it('名前で引いた後・足す前にコレクションが消えた (関数が not_found) ら、見つからない文を返してログに残す', async () => {
    const db = createFakeCollectionsDb([existingCollection()], {
      authUserId: USER_ID,
      beforeRecipeIdsWrite: (rows) => {
        rows.splice(0, rows.length);
      },
    });

    const { success, result } = await runConsultationAction(db.supabase, { id: USER_ID }, addToCollectionAction());

    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rows).toEqual([]);
    expect(success).toBe(false);
    expect(result).toEqual({ error: AI_COLLECTION_NOT_FOUND_MESSAGE });
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , meta] = logError.mock.calls[0];
    expect(meta).toMatchObject({ action_id: ACTION_ID, operation: APPEND_OPERATION });
  });

  it('recipeId が無い (関数は STRICT で NULL を返す) ときは、足せたと扱わずに固定の文を返してログに残す', async () => {
    const db = createFakeCollectionsDb([existingCollection()], { authUserId: USER_ID });

    const { success, result } = await runConsultationAction(
      db.supabase,
      { id: USER_ID },
      addToCollectionAction({ collectionName: COLLECTION_NAME }),
    );

    expect(db.rpcCalls).toHaveLength(1);
    expect(success).toBe(false);
    expect(result).toEqual({ error: AI_COLLECTION_APPEND_FAILED_MESSAGE });
    expect(db.rows[0].recipe_ids).toEqual(EXISTING_RECIPE_IDS);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , meta] = logError.mock.calls[0];
    expect(meta).toMatchObject({ action_id: ACTION_ID, operation: APPEND_OPERATION });
  });
});
