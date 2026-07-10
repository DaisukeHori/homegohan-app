/**
 * tests/notification-preferences.test.ts
 *
 * /api/notification-preferences の GET / PATCH ルートの単体テスト。
 * Supabase と Next.js の server utils は全てモックで差し替える。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Supabase サーバークライアントのモック ────────────────────────────────────
const mockMaybeSingle = vi.fn();
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockUpsert = vi.fn();

const buildChain = () => ({
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
  upsert: mockUpsert,
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
  single: mockSingle,
});

const mockFrom = vi.fn(() => buildChain());
const mockGetUser = vi.fn();

// chaining: from().select().eq().maybeSingle() など
mockSelect.mockReturnValue({ eq: mockEq, maybeSingle: mockMaybeSingle, single: mockSingle });
mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, single: mockSingle, select: mockSelect });
mockInsert.mockReturnValue({ select: mockSelect });
mockUpdate.mockReturnValue({ eq: mockEq });
// route.ts の PATCH は select→insert/update の分岐ではなく単一の upsert() を使う
// (並列アクセス時の競合とレイテンシを解消するため)。upsert().select().single() の形。
mockUpsert.mockReturnValue({ select: mockSelect });

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

// ── Next.js の NextResponse は実装をそのまま使う ────────────────────────────
// (route.ts は NextResponse.json を使っているため Node 環境で動く)

import { GET, PATCH } from '../src/app/api/notification-preferences/route';

const makeRequest = (method: string, body?: unknown) =>
  new NextRequest('http://localhost/api/notification-preferences', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

describe('GET /api/notification-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ eq: mockEq, maybeSingle: mockMaybeSingle, single: mockSingle });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, single: mockSingle, select: mockSelect });
    mockInsert.mockReturnValue({ select: mockSelect });
    mockUpdate.mockReturnValue({ eq: mockEq });
  });

  it('未認証なら 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
  });

  it('row が存在しない場合はデフォルト値を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({
      notifications_enabled: true,
      auto_analyze_enabled: true,
      data_share_enabled: false,
    });
  });

  it('DB に保存済みの値を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({
      data: {
        notifications_enabled: false,
        auto_analyze_enabled: true,
        data_share_enabled: true,
      },
      error: null,
    });

    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.notifications_enabled).toBe(false);
    expect(body.settings.data_share_enabled).toBe(true);
  });
});

describe('PATCH /api/notification-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ eq: mockEq, maybeSingle: mockMaybeSingle, single: mockSingle });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, single: mockSingle, select: mockSelect });
    mockInsert.mockReturnValue({ select: mockSelect });
    mockUpdate.mockReturnValue({ eq: mockEq });
    mockUpsert.mockReturnValue({ select: mockSelect });
  });

  it('未認証なら 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await PATCH(makeRequest('PATCH', { notifications_enabled: false }));
    expect(res.status).toBe(401);
  });

  it('不正な JSON は 400 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    const req = new NextRequest('http://localhost/api/notification-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('boolean 以外の値は 400 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    const res = await PATCH(makeRequest('PATCH', { notifications_enabled: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('有効なフィールドがゼロの場合は 400 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    const res = await PATCH(makeRequest('PATCH', { unknown_field: true }));
    expect(res.status).toBe(400);
  });

  it('row が存在しない場合は upsert で新規作成する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    // upsert().select().single() → 新規作成された row
    mockSingle.mockResolvedValueOnce({
      data: { notifications_enabled: false, auto_analyze_enabled: true, data_share_enabled: false },
      error: null,
    });

    const res = await PATCH(makeRequest('PATCH', { notifications_enabled: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.notifications_enabled).toBe(false);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', notifications_enabled: false }),
      { onConflict: 'user_id' },
    );
  });

  it('row が存在する場合は upsert で更新する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    // upsert().select().single() → 既存 row が更新された結果
    mockSingle.mockResolvedValueOnce({
      data: { notifications_enabled: false, auto_analyze_enabled: true, data_share_enabled: false },
      error: null,
    });

    const res = await PATCH(makeRequest('PATCH', { notifications_enabled: false }));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', notifications_enabled: false }),
      { onConflict: 'user_id' },
    );
  });
});
