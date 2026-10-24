// @vitest-environment node
/**
 * #1649: レシピ・レシピのコメントの API が返す作者名 (authorName) に、仮置きの 'Guest' を人の名前として出さない。
 *
 * 作者の名前は user_profiles.nickname。名前が無いまま user_profiles を作る・更新するとき、アプリと RPC は仮置きの 'Guest' を入れる。
 * 以前の route は `nickname || '匿名'` で、'Guest' をそのまま作者名として返していた (Web のレシピの画面がそのまま出す)。
 * 修正後は normalizeProfileName (packages/shared) を通し、名前が無い (空・空白だけ・仮置きの 'Guest') ときは既定の '匿名' にする。
 * 'guest' (小文字) や実名は本人が付けた名前としてそのまま (前後の空白だけ除く) 返す。
 *
 * 対象 (src/lib/recipes/author-name.ts の recipeAuthorName を通る 5 箇所):
 *   - GET  /api/recipes                 の recipes[].authorName
 *   - GET  /api/recipes/[id]            の recipe.authorName と recipe.comments[].authorName
 *   - GET  /api/recipes/[id]/comments   の comments[].authorName
 *   - POST /api/recipes/[id]/comments   の comment.authorName
 *
 * 作者の名前は、レシピ・コメントに埋め込まずに user_profiles を別のクエリで引く (#1917。src/lib/recipes/viewer-lookups.ts)。
 * ここのモックの user_profiles は、引かれた id のどれにも h.nickname を返す。
 *
 * Supabase には接続しない (createClient をモック)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECIPE_AUTHOR_FALLBACK_NAME, recipeAuthorName } from '@/lib/recipes/author-name';

const RECIPE_ID = 'r0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

const h = vi.hoisted(() => ({
  /** user_profiles を引いたときの nickname (引かれた id のどれにもこの値を返す) */
  nickname: '' as string,
}));

/** select / eq / in / or / order / range / insert / maybeSingle / single を受ける最小のクエリビルダー */
function queryFor(table: string) {
  const recipeRow = {
    id: RECIPE_ID,
    user_id: 'author-1',
    name: 'カレー',
    is_public: true,
    recipe_comments: [{ id: 'c-1', content: 'おいしい', rating: 5, created_at: '2026-10-01T00:00:00Z', user_id: 'commenter-1' }],
  };
  const commentRow = { id: 'c-1', content: 'おいしい', rating: 5, created_at: '2026-10-01T00:00:00Z', user_id: 'commenter-1' };

  const builder: Record<string, unknown> = {};
  /** user_profiles の .in('id', ids) で引かれた id */
  let profileIds: string[] = [];
  for (const method of ['select', 'eq', 'or', 'lte', 'order', 'insert']) {
    builder[method] = () => builder;
  }
  builder.in = (column: string, values: string[]) => {
    if (column === 'id') profileIds = values;
    return builder;
  };
  if (table === 'recipes') {
    builder.range = async () => ({ data: [recipeRow], error: null, count: 1 });
    builder.maybeSingle = async () => ({ data: recipeRow, error: null });
  } else if (table === 'recipe_comments') {
    // GET は order のあと await する (thenable)。POST は insert → select → single
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: [commentRow], error: null });
    builder.single = async () => ({ data: commentRow, error: null });
  } else if (table === 'user_profiles') {
    builder.then = (resolve: (value: unknown) => void) =>
      resolve({ data: profileIds.map((id) => ({ id, nickname: h.nickname })), error: null });
  } else if (table === 'recipe_likes') {
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
  } else {
    throw new Error(`unexpected table: ${table}`);
  }
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'viewer-1' } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => queryFor(table),
  }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      withUser: () => logger,
    };
    return logger;
  },
  generateRequestId: () => 'req_test',
}));

const listRoute = await import('@/app/api/recipes/route');
const detailRoute = await import('@/app/api/recipes/[id]/route');
const commentsRoute = await import('@/app/api/recipes/[id]/comments/route');

const params = { params: Promise.resolve({ id: RECIPE_ID }) };

/** 5 つの面の authorName を集める (面の名前 → 値) */
async function authorNamesOfAllSurfaces(): Promise<Record<string, string>> {
  const list = await (await listRoute.GET(new Request('http://localhost/api/recipes'))).json();
  const detail = await (await detailRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`), params)).json();
  const comments = await (
    await commentsRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}/comments`), params)
  ).json();
  const posted = await (
    await commentsRoute.POST(
      new Request(`http://localhost/api/recipes/${RECIPE_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'おいしい' }),
      }),
      params,
    )
  ).json();
  return {
    'GET /api/recipes': list.recipes[0].authorName,
    'GET /api/recipes/[id] (レシピ)': detail.recipe.authorName,
    'GET /api/recipes/[id] (コメント)': detail.recipe.comments[0].authorName,
    'GET /api/recipes/[id]/comments': comments.comments[0].authorName,
    'POST /api/recipes/[id]/comments': posted.comment.authorName,
  };
}

beforeEach(() => {
  h.nickname = '';
});

describe('recipeAuthorName (#1649)', () => {
  it.each([
    ['Guest', RECIPE_AUTHOR_FALLBACK_NAME],
    [' Guest ', RECIPE_AUTHOR_FALLBACK_NAME],
    ['   ', RECIPE_AUTHOR_FALLBACK_NAME],
    ['', RECIPE_AUTHOR_FALLBACK_NAME],
    [null, RECIPE_AUTHOR_FALLBACK_NAME],
    [undefined, RECIPE_AUTHOR_FALLBACK_NAME],
    ['guest', 'guest'],
    [' 花子 ', '花子'],
  ])('%j → %j', (nickname, expected) => {
    expect(recipeAuthorName(nickname)).toBe(expected);
  });

  it('既定の呼称は「匿名」(以前の route の文言のまま)', () => {
    expect(RECIPE_AUTHOR_FALLBACK_NAME).toBe('匿名');
  });
});

describe('レシピ・コメントの API の authorName (#1649)', () => {
  it.each(['Guest', ' Guest ', '   '])('作者の nickname が %j なら、5 つの面すべてで「匿名」', async (nickname) => {
    h.nickname = nickname;

    const names = await authorNamesOfAllSurfaces();

    expect(Object.keys(names)).toHaveLength(5);
    for (const [surface, name] of Object.entries(names)) {
      expect({ surface, name }).toEqual({ surface, name: '匿名' });
    }
  });

  it.each([
    ['guest', 'guest'],
    [' 花子 ', '花子'],
  ])('作者の nickname が %j (本人が付けた名前) なら、5 つの面すべてでその名前', async (nickname, expected) => {
    h.nickname = nickname;

    const names = await authorNamesOfAllSurfaces();

    expect(Object.keys(names)).toHaveLength(5);
    for (const [surface, name] of Object.entries(names)) {
      expect({ surface, name }).toEqual({ surface, name: expected });
    }
  });
});
