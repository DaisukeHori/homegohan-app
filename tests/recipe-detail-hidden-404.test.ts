// @vitest-environment node
/**
 * #1445 (細かい所見): 運営が隠したレシピ (#1101) の詳細 (GET /api/recipes/[id]) を本人以外が開くと、404 ではなく 500 になっていた。
 *
 * 隠したレシピは RLS ("Users can view public recipes" の hidden_at IS NULL OR 本人) で本人以外には 0 行になる。
 * route が .single() で読んでいたので、0 行は PostgREST のエラー (PGRST116) になり、internalError (500) で返していた。
 * 存在しないレシピ・本人以外から見た非公開のレシピも同じ (どれも RLS で 0 行)。
 * 修正後は .maybeSingle() で読み、0 行は 404 { error: 'Not found' } (#1917 から日本語の「対象が見つかりません」) にする。DB の本当のエラーは今までどおり 500。
 *
 * Supabase には接続しない (createClient をモック)。モックの .single() は本物の PostgREST と同じく、
 * 0 行のときに PGRST116 のエラーを返す (修正前の route をこのモックで動かすと 500 になる)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

/** PostgREST が .single() で 0 行 (または 2 行以上) のときに返すエラー */
const PGRST116 = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
  details: 'The result contains 0 rows',
  hint: null,
};

const h = vi.hoisted(() => ({
  user: { id: 'viewer-1' } as { id: string } | null,
  /** recipes を読んだときの行 (RLS を通ったあとの結果)。null = 見えない (0 行) */
  row: null as Record<string, unknown> | null,
  /** 設定すると、読み取りが DB のエラーになる */
  dbError: null as { code: string; message: string } | null,
  logError: vi.fn(),
}));

function recipesQuery() {
  const result = () => {
    if (h.dbError) return { data: null, error: h.dbError };
    return { data: h.row, error: null };
  };
  const builder = {
    select: () => builder,
    // 埋め込んだコメントの並び (#2166 X6)
    order: () => builder,
    eq: () => builder,
    // 本物と同じく、0 行は .single() ではエラー、.maybeSingle() では data: null
    single: async () => {
      const r = result();
      if (!r.error && r.data === null) return { data: null, error: PGRST116 };
      return r;
    },
    maybeSingle: async () => result(),
  };
  return builder;
}

/** 自分のいいね (recipe_likes) を引くクエリ (#1917。埋め込まずに別のクエリで引く)。0 行 (作者の表示名は rpc。名前は 0 件 = 既定の呼称) */
function emptyLookupQuery() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => resolve({ data: [], error: null }),
  };
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      if (table === 'recipes') return recipesQuery();
      if (table === 'recipe_likes') return emptyLookupQuery();
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: h.logError,
      withUser: () => logger,
    };
    return logger;
  },
  generateRequestId: () => 'req_test',
}));

import { GET } from '@/app/api/recipes/[id]/route';

/** パスの id (UUID の形でない id は DB に渡さず 404 にするので、UUID の形にする。#1917) */
const RECIPE_ID = '30000000-0000-4000-8000-000000000001';
const HIDDEN_RECIPE_ID = '30000000-0000-4000-8000-000000000002';

function call(id: string) {
  return GET(new Request(`http://localhost/api/recipes/${id}`), { params: { id } });
}

function recipeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recipe-1',
    user_id: 'owner-1',
    name: 'テストのレシピ',
    is_public: true,
    recipe_comments: [],
    ...overrides,
  };
}

beforeEach(() => {
  h.user = { id: 'viewer-1' };
  h.row = null;
  h.dbError = null;
  h.logError.mockReset();
});

describe('GET /api/recipes/[id]: 見えないレシピは 404 (#1445)', () => {
  it('運営が隠したレシピを本人以外が開く (RLS で 0 行) と 404。500 にしない・エラーのログも残さない', async () => {
    h.row = null;

    const res = await call(HIDDEN_RECIPE_ID);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '対象が見つかりません' });
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('未ログインで、見えないレシピを開いても 404', async () => {
    h.user = null;
    h.row = null;

    const res = await call(HIDDEN_RECIPE_ID);

    expect(res.status).toBe(404);
  });

  it('見えるレシピは今までどおり 200 で返す (隠した本人には、自分のレシピとして見える)', async () => {
    h.user = { id: 'owner-1' };
    h.row = recipeRow({ hidden_at: '2026-10-09T00:00:00Z' });

    const res = await call(RECIPE_ID);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { recipe: { id: string; isOwner: boolean } };
    expect(json.recipe).toMatchObject({ id: 'recipe-1', isOwner: true });
  });

  it('DB の本当のエラーは今までどおり汎用の 500 (生のエラー文は本文に出さない)', async () => {
    h.dbError = { code: '57014', message: 'canceling statement due to statement timeout (secret_xyz)' };

    const res = await call(RECIPE_ID);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret_xyz');
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
  });
});
