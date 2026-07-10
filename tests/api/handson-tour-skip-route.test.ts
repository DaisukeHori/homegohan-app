/**
 * tests/api/handson-tour-skip-route.test.ts
 *
 * Issue #1045 (F6-10): /api/handson-tour/skip が UPDATE エラー・0行を無視して
 * 常に200を返していた不具合の回帰テスト。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentClient: any;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentClient,
}));

import { POST } from '../../src/app/api/handson-tour/skip/route';

function makeRequest(body: unknown = { step: 0, reason: 'user_action' }): Request {
  return new Request('https://homegohan-app.vercel.app/api/handson-tour/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

describe('#1045 F6-10: /api/handson-tour/skip', () => {
  it('正常系: UPDATE が1行成功したら 200 で skipped_at を返す', async () => {
    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn((table: string) => {
        if (table !== 'user_profiles') throw new Error(`unexpected table: ${table}`);
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                is: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue({
                    data: [{ handson_tour_skipped_at: '2026-07-10T00:00:00.000Z' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }),
    };

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    // #1045: 成功時に返す skipped_at はルートが生成した ISO 日時文字列
    expect(typeof json.skipped_at).toBe('string');
    expect(new Date(json.skipped_at).toString()).not.toBe('Invalid Date');
  });

  it('#1045: UPDATE がエラーを返す場合は 500 を返す (以前は無視されて常に200だった)', async () => {
    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn((table: string) => {
        if (table !== 'user_profiles') throw new Error(`unexpected table: ${table}`);
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                is: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'connection reset' },
                  }),
                }),
              }),
            }),
          }),
        };
      }),
    };

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it('#1045: 既に completed/skipped 済みで UPDATE が0行の場合、実際のDB値を返す (新しいタイムスタンプを捏造しない)', async () => {
    const existingSkippedAt = '2026-01-01T00:00:00.000Z';

    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn((table: string) => {
        if (table !== 'user_profiles') throw new Error(`unexpected table: ${table}`);
        return {
          select: vi.fn((cols: string) => {
            if (cols === 'id') {
              return {
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
                }),
              };
            }
            // refetch 用の select
            return {
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    handson_tour_skipped_at: existingSkippedAt,
                    handson_tour_completed_at: null,
                  },
                  error: null,
                }),
              }),
            };
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockReturnValue({
                is: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }),
    };

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped_at).toBe(existingSkippedAt);
  });

  it('プロファイルが存在しない場合は 404 を返す', async () => {
    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
          }),
        }),
      })),
    };

    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
  });

  it('リクエストボディが不正な場合は 400 を返す', async () => {
    currentClient = {
      auth: { getUser: mockGetUser },
      from: vi.fn(),
    };

    const res = await POST(makeRequest({ step: 'not-a-number' }));
    expect(res.status).toBe(400);
  });
});
