// @vitest-environment node
/**
 * #1917 レシピの API の作者の名前と自分のいいねを、埋め込まずに別のクエリで引く (src/lib/recipes/viewer-lookups.ts) の単体テスト
 *
 * 以前: 一覧・詳細・コメントの API が `user_profiles(nickname)`・`recipe_likes(user_id)` を埋め込んでいた。どちらも PostgREST が
 * 解決できない (外部キーが無い / 2 本ある) ので、一覧はログイン中いつも空の 200 (#1917 の途中で 500)、詳細とコメントはいつも 500 だった。
 * 本物の PostgREST での確認は tests/integration/security/recipes-api-logged-in.test.ts、埋め込みの見張りは
 * tests/postgrest-embed-relationship-scan.test.ts。ここでは、引き方 (どのテーブルをどう絞るか)・引けなかったときの 500・
 * 未ログインで問い合わせないこと・コメントの投稿が保存の前に引くことを確かめる。
 *
 * Supabase には接続しない (createClient をモック)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { loadRecipeViewerLookups } from '@/lib/recipes/viewer-lookups';
import { createClient } from '@/lib/supabase/server';

const VIEWER_ID = '20000000-0000-4000-8000-000000000001';
const AUTHOR_ID = '20000000-0000-4000-8000-000000000002';
const COMMENTER_ID = '20000000-0000-4000-8000-000000000003';
const RECIPE_ID = '20000000-0000-4000-8000-0000000000aa';
const OTHER_RECIPE_ID = '20000000-0000-4000-8000-0000000000bb';
/** DB の生のエラー文 (本文に出てはいけない) */
const RAW_DB_MESSAGE = 'lookup connection reset';
const DB_FAILURE = { code: '08006', message: RAW_DB_MESSAGE, details: null, hint: null };

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  /** テーブルごとの行 (一覧で読むと全部、maybeSingle / single で読むと先頭) */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** テーブルごとの DB の失敗 */
  errors: {} as Record<string, unknown>,
  /** 失敗ではないのに data が null で返る (どのテーブルも) */
  nullData: false,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  logError: vi.fn(),
}));

/** select / eq / in / or / lte / order / range / insert を記録して自分を返し、await・maybeSingle・single で結果を返すクエリ */
function query(table: string) {
  const result = (many: boolean) => {
    const error = h.errors[table] ?? null;
    if (error) return { data: null, error, count: null };
    if (h.nullData) return { data: null, error: null, count: null };
    const rows = h.rows[table] ?? [];
    return { data: many ? rows : rows[0] ?? null, error: null, count: rows.length };
  };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'or', 'lte', 'order', 'range', 'insert']) {
    builder[method] = (...args: unknown[]) => {
      h.calls.push({ table, method, args });
      return builder;
    };
  }
  builder.maybeSingle = async () => result(false);
  builder.single = async () => result(false);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result(true)).then(resolve, reject);
  return builder;
}

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => query(table),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeClient(),
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

const listRoute = await import('@/app/api/recipes/route');
const detailRoute = await import('@/app/api/recipes/[id]/route');
const commentsRoute = await import('@/app/api/recipes/[id]/comments/route');

const params = { params: Promise.resolve({ id: RECIPE_ID }) };

const callsOn = (table: string): Call[] => h.calls.filter((c) => c.table === table);
const argsOf = (table: string, method: string): unknown[][] => callsOn(table).filter((c) => c.method === method).map((c) => c.args);

beforeEach(() => {
  h.user = { id: VIEWER_ID };
  h.rows = {
    recipes: [
      {
        id: RECIPE_ID,
        user_id: AUTHOR_ID,
        name: 'カレー',
        is_public: true,
        recipe_comments: [{ id: 'c-1', content: 'おいしい', rating: 5, created_at: '2026-10-01T00:00:00Z', user_id: COMMENTER_ID }],
      },
    ],
    recipe_comments: [{ id: 'c-1', content: 'おいしい', rating: 5, created_at: '2026-10-01T00:00:00Z', user_id: COMMENTER_ID }],
    user_profiles: [
      { id: AUTHOR_ID, nickname: '作者' },
      { id: COMMENTER_ID, nickname: 'コメントした人' },
      { id: VIEWER_ID, nickname: '見ている人' },
    ],
    recipe_likes: [{ recipe_id: RECIPE_ID }],
  };
  h.errors = {};
  h.nullData = false;
  h.calls = [];
  h.logError.mockReset();
});

describe('loadRecipeViewerLookups (#1917)', () => {
  // createClient は上の vi.mock で fakeClient を返す (route が渡すのと同じクライアント)
  const db = () => createClient();

  it('作者の名前は user_profiles を id で、いいねは自分の recipe_likes をレシピの id で引く。NULL の作者と重複は除く', async () => {
    const result = await loadRecipeViewerLookups(await db(), VIEWER_ID, {
      authorIds: [AUTHOR_ID, null, AUTHOR_ID, COMMENTER_ID, undefined],
      recipeIds: [RECIPE_ID, OTHER_RECIPE_ID, RECIPE_ID],
    });

    expect(argsOf('user_profiles', 'select')).toEqual([['id, nickname']]);
    expect(argsOf('user_profiles', 'in')).toEqual([['id', [AUTHOR_ID, COMMENTER_ID]]]);
    expect(argsOf('recipe_likes', 'select')).toEqual([['recipe_id']]);
    expect(argsOf('recipe_likes', 'eq')).toEqual([['user_id', VIEWER_ID]]);
    expect(argsOf('recipe_likes', 'in')).toEqual([['recipe_id', [RECIPE_ID, OTHER_RECIPE_ID]]]);
    expect(result).toEqual({
      ok: true,
      nicknames: new Map<string, unknown>([
        [AUTHOR_ID, '作者'],
        [COMMENTER_ID, 'コメントした人'],
        [VIEWER_ID, '見ている人'],
      ]),
      likedRecipeIds: new Set([RECIPE_ID]),
    });
  });

  it('未ログイン (viewerId が null) なら DB に問い合わせず、名前もいいねも空', async () => {
    const result = await loadRecipeViewerLookups(await db(), null, { authorIds: [AUTHOR_ID], recipeIds: [RECIPE_ID] });

    expect(h.calls).toEqual([]);
    expect(result).toEqual({ ok: true, nicknames: new Map(), likedRecipeIds: new Set() });
  });

  it('引く作者もレシピも無ければ DB に問い合わせない (作者のいないシステムのレシピだけ・0 件の一覧)', async () => {
    const result = await loadRecipeViewerLookups(await db(), VIEWER_ID, { authorIds: [null], recipeIds: [] });

    expect(h.calls).toEqual([]);
    expect(result).toEqual({ ok: true, nicknames: new Map(), likedRecipeIds: new Set() });
  });

  it.each([
    ['user_profiles', { authorIds: [AUTHOR_ID], recipeIds: [] }],
    ['recipe_likes', { authorIds: [], recipeIds: [RECIPE_ID] }],
  ] as const)('%s が読めなければ、そのテーブルと DB のエラーを返す (名前が無い・いいねしていないことにしない)', async (table, targets) => {
    h.errors[table] = DB_FAILURE;

    const result = await loadRecipeViewerLookups(await db(), VIEWER_ID, targets);

    expect(result).toEqual({ ok: false, table, error: DB_FAILURE });
  });

  it('data が null で返っても (失敗ではない)、名前もいいねも空として扱う', async () => {
    h.nullData = true;

    const result = await loadRecipeViewerLookups(await db(), VIEWER_ID, { authorIds: [AUTHOR_ID], recipeIds: [RECIPE_ID] });

    expect(result).toEqual({ ok: true, nicknames: new Map(), likedRecipeIds: new Set() });
  });
});

describe('レシピの API: 埋め込まずに引いた名前といいねを返す (#1917)', () => {
  it('GET /api/recipes/[id]: レシピとコメントの作者の名前・自分のいいねを返す。select に user_profiles・recipe_likes を埋め込まない', async () => {
    const res = await detailRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`), params);

    expect(res.status).toBe(200);
    const { recipe } = (await res.json()) as {
      recipe: { authorName: string; isLiked: boolean; comments: Array<Record<string, unknown>> };
    };
    expect(recipe).toMatchObject({ authorName: '作者', isLiked: true });
    expect(recipe.comments).toEqual([
      { id: 'c-1', content: 'おいしい', rating: 5, authorName: 'コメントした人', createdAt: '2026-10-01T00:00:00Z' },
    ]);
    const recipeSelect = String(argsOf('recipes', 'select')[0]?.[0]);
    expect(recipeSelect).not.toMatch(/user_profiles|recipe_likes/);
    expect(argsOf('user_profiles', 'in')).toEqual([['id', [AUTHOR_ID, COMMENTER_ID]]]);
    expect(argsOf('recipe_likes', 'in')).toEqual([['recipe_id', [RECIPE_ID]]]);
  });

  it('GET /api/recipes/[id]: いいねしていないレシピは isLiked が false', async () => {
    h.rows.recipe_likes = [];

    const res = await detailRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`), params);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { recipe: { isLiked: boolean } }).recipe.isLiked).toBe(false);
  });

  it('GET /api/recipes/[id]: 未ログインなら名前もいいねも問い合わせない (作者は既定の呼称・isLiked は false)', async () => {
    h.user = null;

    const res = await detailRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`), params);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { recipe: Record<string, unknown> }).recipe).toMatchObject({ authorName: '匿名', isLiked: false });
    expect([...new Set(h.calls.map((c) => c.table))]).toEqual(['recipes']);
  });

  it('GET /api/recipes/[id]/comments: 書いた人の名前を返し、user_id は返さない。select に user_profiles を埋め込まない', async () => {
    const res = await commentsRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}/comments`), params);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: Array<Record<string, unknown>> };
    expect(body.comments).toEqual([
      { id: 'c-1', content: 'おいしい', rating: 5, authorName: 'コメントした人', createdAt: '2026-10-01T00:00:00Z' },
    ]);
    expect(JSON.stringify(body)).not.toContain(COMMENTER_ID);
    expect(String(argsOf('recipe_comments', 'select')[0]?.[0])).not.toMatch(/user_profiles/);
    // コメントの一覧では、いいねは引かない
    expect(callsOn('recipe_likes')).toEqual([]);
  });

  it('POST /api/recipes/[id]/comments: 自分の名前を返す。insert の select に user_profiles を埋め込まない', async () => {
    const res = await commentsRoute.POST(
      new Request(`http://localhost/api/recipes/${RECIPE_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'おいしい' }),
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { comment: { authorName: string } }).comment.authorName).toBe('見ている人');
    expect(argsOf('user_profiles', 'in')).toEqual([['id', [VIEWER_ID]]]);
    expect(String(argsOf('recipe_comments', 'select')[0]?.[0])).not.toMatch(/user_profiles/);
  });
});

describe('レシピの API: 名前・いいねが読めなかったときは 500 (#1917)', () => {
  const surfaces: Array<[string, () => Promise<Response>]> = [
    ['GET /api/recipes', () => listRoute.GET(new Request('http://localhost/api/recipes'))],
    ['GET /api/recipes/[id]', () => detailRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`), params)],
    ['GET /api/recipes/[id]/comments', () => commentsRoute.GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}/comments`), params)],
  ];

  it.each(surfaces)('%s: 作者の名前 (user_profiles) が読めなければ 500。DB の生の文面は本文に出さず、読めなかったテーブルをログに残す', async (_name, call) => {
    h.errors.user_profiles = DB_FAILURE;

    const res = await call();

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(RAW_DB_MESSAGE);
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(h.logError).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ table: 'user_profiles' }));
  });

  it.each(surfaces.slice(0, 2))('%s: 自分のいいね (recipe_likes) が読めなければ 500 (いいねしていないように見せない)', async (_name, call) => {
    h.errors.recipe_likes = DB_FAILURE;

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(RAW_DB_MESSAGE);
    expect(h.logError).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ table: 'recipe_likes' }));
  });

  it('POST /api/recipes/[id]/comments: 自分の名前が読めなければ、コメントを保存せずに 500', async () => {
    h.errors.user_profiles = DB_FAILURE;

    const res = await commentsRoute.POST(
      new Request(`http://localhost/api/recipes/${RECIPE_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'おいしい' }),
      }),
      params,
    );

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(RAW_DB_MESSAGE);
    expect(argsOf('recipe_comments', 'insert')).toEqual([]);
    expect(h.logError).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ table: 'user_profiles' }));
  });
});
