/**
 * #1365 段 1: 運営の審査で、通報された写真 (content_url) を保存された公開 URL のまま返さず、署名付き URL にして返す。
 *
 * tests/signed-photo-display-scan.test.ts は運営の 2 画面 (src/app/admin/moderation/**) を
 * 「API がサーバーで署名してから返す」という理由で見張りから外している。その前提をここで確かめる:
 *   - withSignedModerationContentUrls: 2 つのバケットの URL だけを署名付き URL に替える。外部の URL と null はそのまま、
 *     署名に失敗した写真は null (表示しない)。同じ URL が複数あっても全部替える
 *   - GET /api/admin/moderation・/queue・/[type]/[id] が、返す content_url をこの関数で署名している
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';
import { withSignedModerationContentUrls } from '@/lib/admin/moderation-backend';

const BASE = 'https://proj.supabase.co/storage/v1/object';
const OWNER = '22222222-2222-4222-8222-222222222222';
const TTL_PATTERN = /^\d+$/;

/** 署名付き URL の偽物 (バケット + パス から決まる) */
function signedOf(bucket: string, path: string): string {
  return `${BASE}/sign/${bucket}/${path}?token=t`;
}

function publicUrl(bucket: string, path: string): string {
  return `${BASE}/public/${bucket}/${path}`;
}

interface SignCall {
  bucket: string;
  paths: string[];
  ttl: unknown;
}

/** storage.createSignedUrls だけを持つ偽の admin。failPaths に挙げたパスは署名に失敗した答えを返す */
function fakeStorage(signCalls: SignCall[], failPaths: readonly string[] = []) {
  return {
    from: (bucket: string) => ({
      createSignedUrls: async (paths: string[], ttl: unknown) => {
        signCalls.push({ bucket, paths, ttl });
        return {
          data: paths.map((path) =>
            failPaths.includes(path)
              ? { path, error: 'Object not found', signedUrl: null }
              : { path, error: null, signedUrl: signedOf(bucket, path) },
          ),
          error: null,
        };
      },
    }),
  };
}

function fakeAdmin(failPaths: readonly string[] = []) {
  const signCalls: SignCall[] = [];
  const admin = {
    from: () => {
      throw new Error('運営の署名は持ち主を確かめないので、テーブルは読まない');
    },
    storage: fakeStorage(signCalls, failPaths),
  };
  return { admin: admin as never, signCalls };
}

describe('withSignedModerationContentUrls', () => {
  it('2 つのバケットの URL は署名付き URL、外部の URL と null はそのまま、ほかの項目は変えない', async () => {
    const { admin, signCalls } = fakeAdmin();
    const meal = publicUrl('meal_photos', `${OWNER}/a.jpg`);
    const fridge = publicUrl('fridge-images', `${OWNER}/b.jpg`);
    const external = 'https://images.example.com/c.jpg';
    const items = [
      { id: 'f1', content_url: meal },
      { id: 'f2', content_url: fridge },
      { id: 'f3', content_url: external },
      { id: 'f4', content_url: null },
    ];

    const result = await withSignedModerationContentUrls(admin, items);

    expect(result).toEqual([
      { id: 'f1', content_url: signedOf('meal_photos', `${OWNER}/a.jpg`) },
      { id: 'f2', content_url: signedOf('fridge-images', `${OWNER}/b.jpg`) },
      { id: 'f3', content_url: external },
      { id: 'f4', content_url: null },
    ]);
    // 外部の URL は署名を頼まない。有効期限は秒の整数で渡す
    expect(signCalls.map(({ bucket, paths }) => ({ bucket, paths }))).toEqual([
      { bucket: 'meal_photos', paths: [`${OWNER}/a.jpg`] },
      { bucket: 'fridge-images', paths: [`${OWNER}/b.jpg`] },
    ]);
    for (const call of signCalls) expect(String(call.ttl)).toMatch(TTL_PATTERN);
    // 渡した配列は書き換えない
    expect(items[0].content_url).toBe(meal);
  });

  it('署名に失敗した写真は null (公開 URL のまま返さない)', async () => {
    const { admin } = fakeAdmin([`${OWNER}/missing.jpg`]);
    const missing = publicUrl('meal_photos', `${OWNER}/missing.jpg`);
    const present = publicUrl('meal_photos', `${OWNER}/present.jpg`);

    const result = await withSignedModerationContentUrls(admin, [
      { id: 'f1', content_url: missing },
      { id: 'f2', content_url: present },
    ]);

    expect(result).toEqual([
      { id: 'f1', content_url: null },
      { id: 'f2', content_url: signedOf('meal_photos', `${OWNER}/present.jpg`) },
    ]);
  });

  it('同じ URL が複数の通報にあっても、全部を署名付き URL に替える', async () => {
    const { admin, signCalls } = fakeAdmin();
    const meal = publicUrl('meal_photos', `${OWNER}/a.jpg`);

    const result = await withSignedModerationContentUrls(admin, [
      { id: 'f1', content_url: meal },
      { id: 'f2', content_url: meal },
    ]);

    expect(result.map((item) => item.content_url)).toEqual([
      signedOf('meal_photos', `${OWNER}/a.jpg`),
      signedOf('meal_photos', `${OWNER}/a.jpg`),
    ]);
    expect(signCalls.map(({ paths }) => paths)).toEqual([[`${OWNER}/a.jpg`]]);
  });

  it('写真のバケットの URL が 1 つも無ければ、署名を頼まずにそのまま返す', async () => {
    const { admin, signCalls } = fakeAdmin();
    const items = [
      { id: 'f1', content_url: 'https://images.example.com/c.jpg' },
      { id: 'f2', content_url: null },
    ];
    expect(await withSignedModerationContentUrls(admin, items)).toEqual(items);
    expect(signCalls).toEqual([]);
  });
});

// ---- 3 つの管理 API の配線 ----

const mockRequireRole = vi.fn();
const mockGetSupabaseAdmin = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({ withUser: () => ({ error: vi.fn() }) }),
}));
// 閲覧の監査ログ (#1326) は tests/admin-view-audit-1326.test.ts が確かめる。ここでは記録したことにする
vi.mock('@/lib/admin/audit', () => ({ recordAdminAudit: vi.fn(async () => undefined) }));

let routeAdmin: ReturnType<typeof createFakeSupabase> & { storage: ReturnType<typeof fakeStorage> };
let routeSignCalls: SignCall[];

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(routeAdmin),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { GET: detailGET } = await import('@/app/api/admin/moderation/[type]/[id]/route');
const { GET: queueGET } = await import('@/app/api/admin/moderation/queue/route');
const { GET: listGET } = await import('@/app/api/admin/moderation/route');

const MEAL_PHOTO = publicUrl('meal_photos', `${OWNER}/meal.jpg`);
const RECIPE_PHOTO = publicUrl('fridge-images', `${OWNER}/recipe.jpg`);

function mealFlagRow() {
  return {
    id: 'f1a90000-0000-4000-8000-000000000001',
    status: 'pending',
    reason: null,
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-01-01T00:00:00Z',
    user_id: 'reporter-x',
    meal_id: 'meal-1',
    meals: { user_id: OWNER, photo_url: MEAL_PHOTO },
  };
}

function recipeFlagRow() {
  return {
    id: 'f1a90000-0000-4000-8000-000000000002',
    status: 'pending',
    reason: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-01-02T00:00:00Z',
    recipe_id: 'recipe-1',
    recipes: { user_id: OWNER, image_url: RECIPE_PHOTO },
  };
}

function setRouteAdmin(tables: Parameters<typeof createFakeSupabase>[0]) {
  routeSignCalls = [];
  routeAdmin = Object.assign(createFakeSupabase(tables), { storage: fakeStorage(routeSignCalls) });
}

beforeEach(() => {
  mockRequireRole.mockReset();
  mockGetSupabaseAdmin.mockReset();
  mockRequireRole.mockResolvedValue({ id: 'admin-1', email: 'admin@example.com', roles: ['admin'], organization_id: null });
  mockGetSupabaseAdmin.mockImplementation(() => routeAdmin);
});

describe('運営の審査の API は content_url を署名付き URL で返す', () => {
  it('GET /api/admin/moderation/[type]/[id]', async () => {
    setRouteAdmin({ moderation_flags: [{ data: mealFlagRow(), error: null }] });

    const res = await detailGET(new Request('http://localhost/api/admin/moderation/food/f1a90000-0000-4000-8000-000000000001'), {
      params: { type: 'food', id: 'f1a90000-0000-4000-8000-000000000001' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { content_url: string | null; id: string } };
    expect(json.data.id).toBe('f1a90000-0000-4000-8000-000000000001');
    expect(json.data.content_url).toBe(signedOf('meal_photos', `${OWNER}/meal.jpg`));
    expect(routeSignCalls.map(({ bucket, paths }) => ({ bucket, paths }))).toEqual([
      { bucket: 'meal_photos', paths: [`${OWNER}/meal.jpg`] },
    ]);
  });

  it('GET /api/admin/moderation/queue (食事とレシピの両方)', async () => {
    setRouteAdmin({
      // 1 回目: fetchModerationList の一覧、2 回目: countModeration の件数
      moderation_flags: [{ data: [mealFlagRow()], error: null }, { count: 1, error: null }],
      recipe_flags: [{ data: [recipeFlagRow()], error: null }, { count: 1, error: null }],
    });

    const res = await queueGET(new Request('http://localhost/api/admin/moderation/queue'));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ id: string; content_url: string | null }> };
    expect(json.data).toEqual([
      expect.objectContaining({ id: 'f1a90000-0000-4000-8000-000000000001', content_url: signedOf('meal_photos', `${OWNER}/meal.jpg`) }),
      expect.objectContaining({ id: 'f1a90000-0000-4000-8000-000000000002', content_url: signedOf('fridge-images', `${OWNER}/recipe.jpg`) }),
    ]);
  });

  it('GET /api/admin/moderation (mealFlags と recipeFlags の両方)', async () => {
    setRouteAdmin({
      moderation_flags: [{ data: [mealFlagRow()], error: null }],
      recipe_flags: [{ data: [recipeFlagRow()], error: null }],
    });

    const res = await listGET(new Request('http://localhost/api/admin/moderation?status=pending'));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mealFlags: Array<{ content_url: string | null }>;
      recipeFlags: Array<{ content_url: string | null }>;
    };
    expect(json.mealFlags.map((item) => item.content_url)).toEqual([signedOf('meal_photos', `${OWNER}/meal.jpg`)]);
    expect(json.recipeFlags.map((item) => item.content_url)).toEqual([signedOf('fridge-images', `${OWNER}/recipe.jpg`)]);
  });
});
