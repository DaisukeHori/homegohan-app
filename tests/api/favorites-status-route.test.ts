/**
 * tests/api/favorites-status-route.test.ts
 *
 * GET /api/favorites/status?name=<料理名> (src/app/api/favorites/status/route.ts) の単体テスト (#2011)。
 * 設計書 docs/design/cross/22-dish-favorites.md §7.5.2・§12 の T-1〜T-5。
 * DB は tests/helpers/scripted-supabase.ts の偽物 (from を呼んだ順に結果を返し、呼び出しを記録する)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import {
  DISH_FAVORITE_NAME_INVALID_MESSAGE,
  DISH_FAVORITE_NAME_MAX_CHARS,
  DISH_FAVORITE_VALIDATION_CODE,
  DishSnapshotSchema,
  type DishFavoriteRow,
} from '@/modules/dish-favorites/core';
import { createScriptedSupabase, type ScriptedResult, type ScriptedSupabase } from '../helpers/scripted-supabase';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  userError: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));

// 構造化ログ: 本物は app_logs テーブルへ書きに行くので、テストでは差し替える
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withUser: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: mocks.userError }),
  }),
  generateRequestId: () => 'req_test',
}));

import { GET } from '../../src/app/api/favorites/status/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAVORITE_ID = '22222222-2222-4222-8222-222222222222';

function rowOf(): DishFavoriteRow {
  return {
    id: FAVORITE_ID,
    user_id: USER_ID,
    dish_name: '肉じゃが',
    dish_name_key: '肉じゃが',
    dish: DishSnapshotSchema.parse({ name: '肉じゃが' }),
    source_planned_meal_id: null,
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:00:00.000Z',
  };
}

function scriptFrom(...results: ScriptedResult[]): ScriptedSupabase {
  const scripted = createScriptedSupabase(results);
  mocks.from.mockImplementation(scripted.db.from);
  return scripted;
}

/** name を付けて GET する (null なら name を付けない) */
async function callGet(name: string | null) {
  const search = name === null ? '' : `?${new URLSearchParams({ name }).toString()}`;
  const res = await GET(new Request(`http://localhost/api/favorites/status${search}`));
  return { res, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
});

describe('GET /api/favorites/status (T-1〜T-5)', () => {
  it('T-1 未ログインは 401', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const { res, json } = await callGet('肉じゃが');

    expect(res.status).toBe(401);
    expect(json).toEqual({ error: API_UNAUTHENTICATED_MESSAGE });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('T-2 name が無い・空白だけ・101 文字・NULL 文字を含む・鍵が 101 文字以上は 400 VALIDATION_ERROR で DB に問い合わせない', async () => {
    // 「㌀」(U+3300) は NFKC で「アパート」の 4 文字になる。30 文字の表示名の鍵は 120 文字
    const KEY_EXPANDING_CHAR = '㌀';
    const KEY_EXPANDING_COUNT = 30;
    const invalidNames: Array<[string, string | null]> = [
      ['name が無い', null],
      ['空', ''],
      ['空白だけ', ' 　 '],
      ['101 文字', 'あ'.repeat(DISH_FAVORITE_NAME_MAX_CHARS + 1)],
      ['NULL 文字を含む', '肉\u0000じゃが'],
      ['鍵が 101 文字以上', KEY_EXPANDING_CHAR.repeat(KEY_EXPANDING_COUNT)],
    ];

    for (const [label, name] of invalidNames) {
      const { res, json } = await callGet(name);

      expect(res.status, label).toBe(400);
      expect(json, label).toEqual({ error: DISH_FAVORITE_NAME_INVALID_MESSAGE, code: DISH_FAVORITE_VALIDATION_CODE });
    }
    expect(mocks.from).not.toHaveBeenCalled();

    // 100 文字ちょうどは通す (境界)
    scriptFrom({ data: null });
    expect((await callGet('あ'.repeat(DISH_FAVORITE_NAME_MAX_CHARS))).res.status).toBe(200);
  });

  it('T-3 保存済みなら { favorited: true, id }', async () => {
    const scripted = scriptFrom({ data: rowOf() });

    const { res, json } = await callGet(' ＮＩＫＵ　じゃが ');

    expect(res.status).toBe(200);
    expect(json).toEqual({ favorited: true, id: FAVORITE_ID });
    // 同じ料理の判定は名前の鍵 (表示名 → NFKC → 小文字)
    expect(scripted.queries[0].table).toBe('dish_favorites');
    expect(scripted.queries[0].calls).toContainEqual({ method: 'eq', args: ['user_id', USER_ID] });
    expect(scripted.queries[0].calls).toContainEqual({ method: 'eq', args: ['dish_name_key', 'niku じゃが'] });
    expect(scripted.queries[0].calls.at(-1)).toEqual({ method: 'maybeSingle', args: [] });
  });

  it('T-4 未保存なら { favorited: false, id: null }', async () => {
    scriptFrom({ data: null });

    const { res, json } = await callGet('カレー');

    expect(res.status).toBe(200);
    expect(json).toEqual({ favorited: false, id: null });
  });

  it('T-5 DB の失敗は 500', async () => {
    scriptFrom({ error: { code: '57014', message: 'canceling statement due to statement timeout' } });

    const { res, json } = await callGet('肉じゃが');

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(mocks.userError).toHaveBeenCalledTimes(1);

    // 行の形が正典と違うときも 500 (「未保存」にしない)
    mocks.userError.mockClear();
    scriptFrom({ data: { ...rowOf(), id: 'not-a-uuid' } });
    const broken = await callGet('肉じゃが');
    expect(broken.res.status).toBe(500);
    expect(mocks.userError).toHaveBeenCalledTimes(1);
  });
});
