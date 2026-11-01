// @vitest-environment node
/**
 * #2166 X6: レシピの詳細 (GET /api/recipes/[id]) がレシピに埋め込んで返すコメント (recipe_comments) の並び。
 *
 * 埋め込みに並びの指定が無いと、コメントの順は DB 任せで、問い合わせのたびに変わりうる。コメントの一覧
 * (GET /api/recipes/[id]/comments・LIST_ORDERS.recipeComments) と同じ鍵 (書いた日時の新しい順 → id の順) で並べる。
 *
 * ここでは本物の supabase-js のクライアントを、PostgREST に送る URL を記録する偽の fetch につないで route を呼び、
 * レシピを読む問い合わせが
 *   - 埋め込んだコメントの並び recipe_comments.order に、LIST_ORDERS.recipeComments の鍵を順に書く
 *   - 親の行 (レシピ) の並び order は付けない
 * ことを確かめる (supabase-js が referencedTable を PostgREST の <表>.order に組み立てるところまで通す)。
 * 実物の PostgREST がこの並びを受け付けることは tests/integration/rls/list-order-tiebreak.test.ts が確かめる。
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/recipes/[id]/route';
import { LIST_ORDERS } from '@/lib/api/list-order';
import { RECIPE_AUTHOR_DISPLAY_NAMES_RPC } from '@/lib/recipes/viewer-lookups';

const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const COMMENTER_ID = '33333333-3333-4333-8333-333333333333';
const SUPABASE_URL = 'http://supabase.test';
const ANON_KEY = 'anon-key-for-test';

/** PostgREST の HTTP の成功 */
const HTTP_OK = 200;

/** DB が返す (= 並びの指定どおりに並んだ) コメント。新しい順で、同じ日時の 2 件は id の順 */
const COMMENT_ROWS = [
  { id: 'c-3', content: '新しい', rating: 5, created_at: '2026-10-03T00:00:00Z', user_id: COMMENTER_ID },
  { id: 'c-1', content: '同じ日時の先', rating: 4, created_at: '2026-10-01T00:00:00Z', user_id: COMMENTER_ID },
  { id: 'c-2', content: '同じ日時の後', rating: 3, created_at: '2026-10-01T00:00:00Z', user_id: COMMENTER_ID },
];

const RECIPE_ROW = {
  id: RECIPE_ID,
  user_id: OWNER_ID,
  name: 'カレー',
  description: null,
  calories_kcal: null,
  cooking_time_minutes: null,
  servings: null,
  image_url: null,
  ingredients: [],
  steps: [],
  is_public: true,
  category: null,
  cuisine_type: null,
  difficulty: null,
  tags: [],
  nutrition: null,
  tips: null,
  video_url: null,
  source_url: null,
  view_count: 0,
  like_count: 0,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  recipe_comments: COMMENT_ROWS,
};

const h = vi.hoisted(() => ({ requests: [] as URL[] }));

/** PostgREST への要求の URL を記録し、レシピの表にはレシピ 1 行、作者の表示名の関数には 0 件を返す */
async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  h.requests.push(url);
  const body = url.pathname === '/rest/v1/recipes' ? [RECIPE_ROW] : [];
  return new Response(JSON.stringify(body), { status: HTTP_OK, headers: { 'Content-Type': 'application/json' } });
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const real = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: fakeFetch },
    });
    return {
      // 未ログイン (閲覧数の rpc と自分のいいねの読み込みを通らない)
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      from: real.from.bind(real),
      rpc: real.rpc.bind(real),
    };
  },
}));

vi.mock('@/lib/db-logger', () => ({ logError: vi.fn() }));

/** LIST_ORDERS の鍵を PostgREST の並びの書き方にしたもの (テストの側で独立に組み立てる) */
function postgrestOrderOf(keys: readonly { column: string; options: { ascending: boolean; nullsFirst: boolean } }[]): string {
  return keys
    .map(({ column, options }) => `${column}.${options.ascending ? 'asc' : 'desc'}.${options.nullsFirst ? 'nullsfirst' : 'nullslast'}`)
    .join(',');
}

describe('#2166 X6 レシピの詳細のコメントの並び', () => {
  beforeEach(() => {
    h.requests.length = 0;
  });

  it('埋め込んだコメントを、コメントの一覧と同じ鍵 (書いた日時の新しい順 → id の順) で並べて読み、レシピの行には並びを付けない', async () => {
    const res = await GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`), {
      params: Promise.resolve({ id: RECIPE_ID }),
    });
    expect(res.status).toBe(HTTP_OK);

    const recipeRequests = h.requests.filter((url) => url.pathname === '/rest/v1/recipes');
    expect(recipeRequests).toHaveLength(1);
    const [recipeRequest] = recipeRequests;
    expect(recipeRequest.searchParams.get('recipe_comments.order')).toBe('created_at.desc.nullsfirst,id.asc.nullslast');
    expect(recipeRequest.searchParams.get('recipe_comments.order')).toBe(postgrestOrderOf(LIST_ORDERS.recipeComments.keys));
    expect(recipeRequest.searchParams.has('order')).toBe(false);
    expect(recipeRequest.searchParams.get('id')).toBe(`eq.${RECIPE_ID}`);

    // 作者の表示名は関数で引く (並びを足しても、ほかの問い合わせは変わらない)
    expect(h.requests.some((url) => url.pathname === `/rest/v1/rpc/${RECIPE_AUTHOR_DISPLAY_NAMES_RPC}`)).toBe(true);

    // 応答のコメントは DB が返した順のまま (route で並べ替えない)
    const json = (await res.json()) as { recipe: { comments: Array<{ id: string }> } };
    expect(json.recipe.comments.map((comment) => comment.id)).toEqual(COMMENT_ROWS.map((row) => row.id));
  });
});
