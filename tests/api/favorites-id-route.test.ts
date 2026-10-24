/**
 * tests/api/favorites-id-route.test.ts
 *
 * DELETE /api/favorites/[id] (src/app/api/favorites/[id]/route.ts) の単体テスト (#2011)。
 * 設計書 docs/design/cross/22-dish-favorites.md §7.5.3・§12 の D-1〜D-5。
 * DB は tests/helpers/scripted-supabase.ts の偽物 (from を呼んだ順に結果を返し、呼び出しを記録する)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
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

import { DELETE } from '../../src/app/api/favorites/[id]/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAVORITE_ID = '22222222-2222-4222-8222-222222222222';

function useScripted(...results: ScriptedResult[]): ScriptedSupabase {
  const scripted = createScriptedSupabase(results);
  mocks.from.mockImplementation(scripted.db.from);
  return scripted;
}

async function callDelete(id: string) {
  const res = await DELETE(new Request(`http://localhost/api/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
  return { res, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
});

describe('DELETE /api/favorites/[id] (D-1〜D-5)', () => {
  it('D-1 未ログインは 401', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const { res, json } = await callDelete(FAVORITE_ID);

    expect(res.status).toBe(401);
    expect(json).toEqual({ error: API_UNAUTHENTICATED_MESSAGE });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('D-2 uuid の形でない id は DB に渡さず 404', async () => {
    for (const id of ['肉じゃが', 'not-a-uuid', '22222222-2222-4222-8222-22222222222', `${FAVORITE_ID}x`, '']) {
      const { res, json } = await callDelete(id);

      expect(res.status, id).toBe(404);
      expect(json, id).toEqual({ error: API_NOT_FOUND_MESSAGE });
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('D-3 本人の行を消して 200 { success: true }', async () => {
    const scripted = useScripted({ data: [{ id: FAVORITE_ID }] });

    const { res, json } = await callDelete(FAVORITE_ID);

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true });
    expect(scripted.queries).toHaveLength(1);
    expect(scripted.queries[0].table).toBe('dish_favorites');
    expect(scripted.queries[0].calls).toEqual([
      { method: 'delete', args: [] },
      { method: 'eq', args: ['id', FAVORITE_ID] },
      { method: 'eq', args: ['user_id', USER_ID] },
      { method: 'select', args: ['id'] },
    ]);
  });

  it('D-4 0 行 (他人・消した行) は 404', async () => {
    useScripted({ data: [] });

    const { res, json } = await callDelete(FAVORITE_ID);

    expect(res.status).toBe(404);
    expect(json).toEqual({ error: API_NOT_FOUND_MESSAGE });
  });

  it('D-5 DB の失敗は 500', async () => {
    useScripted({ error: { code: '42501', message: 'permission denied for table dish_favorites' } });

    const { res, json } = await callDelete(FAVORITE_ID);

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(JSON.stringify(json)).not.toContain('permission denied');
    expect(mocks.userError).toHaveBeenCalledTimes(1);
  });
});
