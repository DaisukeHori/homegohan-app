/**
 * #1365 段 1: 写真の署名付き URL を返す API (POST /api/storage/signed-urls) のテスト
 *   - 未ログインは 401 (署名しない)
 *   - 本文に NULL 文字があれば、認証より前に 400 INVALID_CHARACTER (#1657。未ログインでも 400 が先)
 *   - 本文の形が違う・件数が多すぎるのは 400
 *   - 本人は認証で確かめた user.id (本文の値は使わない) で、本人の写真にだけ署名する
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PHOTO_URLS_PER_SIGN_REQUEST } from '@homegohan/shared';
import { NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from '@/lib/api/null-character';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  signCalls: [] as Array<{ bucket: string; paths: string[] }>,
  ownedPlannedMealIds: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
  getSupabaseAdmin: () => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: (_column: string, ids: string[]) =>
          Promise.resolve({ data: ids.filter((id) => mocks.ownedPlannedMealIds.includes(id)).map((id) => ({ id })), error: null }),
      };
      return builder;
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[]) => {
          mocks.signCalls.push({ bucket, paths });
          return { data: paths.map((path) => ({ path, error: null, signedUrl: `signed:${bucket}/${path}` })), error: null };
        },
      }),
    },
  }),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

import { POST } from '@/app/api/storage/signed-urls/route';
import { PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS } from '@/lib/photo-storage-signing';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://proj.supabase.co/storage/v1/object/public';

function request(body: unknown): Request {
  return new Request('http://localhost/api/storage/signed-urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/storage/signed-urls', () => {
  beforeEach(() => {
    mocks.getUser.mockReset();
    mocks.signCalls.length = 0;
    mocks.ownedPlannedMealIds = [];
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
  });

  it('未ログインは 401 で、署名しない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(request({ urls: [`${BASE}/fridge-images/${USER}/a.jpg`] }));
    expect(res.status).toBe(401);
    expect(mocks.signCalls).toEqual([]);
  });

  it('本文に NULL 文字があれば、未ログインでも認証より前に 400 INVALID_CHARACTER で断り、署名しない (#1657)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(request({ urls: [`${BASE}/fridge-images/${USER}/a\u0000.jpg`] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.signCalls).toEqual([]);
  });

  it.each([
    ['JSON でない', 'not json'],
    ['urls が無い', {}],
    ['urls が配列でない', { urls: 'x' }],
    ['文字列でない要素', { urls: [1] }],
    ['空の文字列', { urls: [''] }],
    ['件数が多すぎる', { urls: Array.from({ length: MAX_PHOTO_URLS_PER_SIGN_REQUEST + 1 }, (_, i) => `${BASE}/fridge-images/${USER}/${i}.jpg`) }],
  ])('%s は 400', async (_label, body) => {
    const res = await POST(request(body));
    expect(res.status).toBe(400);
    expect(mocks.signCalls).toEqual([]);
  });

  it('本人の写真にだけ署名し、他人の写真は null を返す', async () => {
    const own = `${BASE}/fridge-images/${USER}/a.jpg`;
    const others = `${BASE}/fridge-images/${OTHER}/b.jpg`;
    const external = 'https://images.unsplash.com/x.jpg';
    const res = await POST(request({ urls: [own, others, external, own], userId: OTHER }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const json = await res.json();
    expect(json).toEqual({
      signedUrls: { [own]: `signed:fridge-images/${USER}/a.jpg`, [others]: null, [external]: null },
      expiresInSeconds: PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS,
    });
    expect(mocks.signCalls).toEqual([{ bucket: 'fridge-images', paths: [`${USER}/a.jpg`] }]);
  });
});
