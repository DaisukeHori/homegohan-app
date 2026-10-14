/**
 * tests/notification-preferences.test.ts
 *
 * /api/notification-preferences の GET / PATCH ルートの単体テスト。
 * Supabase と Next.js の server utils は全てモックで差し替える。
 *
 * #1144: data_share_enabled (旧「トレーナーと共有」) は、Web とアプリの設定画面から外したが、
 * 旧ビルドのアプリがまだ読み書きするので、API の項目としては残している。ここでは、その API の契約
 * (読める / 書ける / boolean 以外は 400 / 送っていない項目は書き換えない) が変わっていないことを確かめる。
 * 保存済みの値は利用者の同意ではない (route.ts のコメント参照)。
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

  it('DB に保存済みの値を返す (data_share_enabled は旧ビルドのアプリ向けに、そのまま返す。#1144)', async () => {
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

  it('data_share_enabled が null の行は、既定値 (false) として返す (#1144)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({
      data: { notifications_enabled: true, auto_analyze_enabled: true, data_share_enabled: null },
      error: null,
    });

    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.data_share_enabled).toBe(false);
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

  // ── #1144: data_share_enabled は画面から外したが、旧ビルドのアプリ向けに API は残している ──────────

  it('data_share_enabled だけを送ると、その項目だけを upsert する (旧ビルド互換。送っていない項目は書き換えない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockSingle.mockResolvedValueOnce({
      data: { notifications_enabled: true, auto_analyze_enabled: true, data_share_enabled: true },
      error: null,
    });

    const res = await PATCH(makeRequest('PATCH', { data_share_enabled: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.data_share_enabled).toBe(true);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [row, options] = mockUpsert.mock.calls[0];
    expect(row).toEqual(expect.objectContaining({ user_id: 'user-1', data_share_enabled: true }));
    expect(row).not.toHaveProperty('notifications_enabled');
    expect(row).not.toHaveProperty('auto_analyze_enabled');
    expect(options).toEqual({ onConflict: 'user_id' });
  });

  it('data_share_enabled が boolean 以外なら 400 を返し、何も書かない (旧ビルド向けの入力検証も変えない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

    for (const value of ['yes', 1, null]) {
      const res = await PATCH(makeRequest('PATCH', { data_share_enabled: value }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('data_share_enabled must be boolean');
    }
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('通知・自動解析だけを送っても、data_share_enabled は書き換えない (新しい画面はこの項目を送らない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockSingle.mockResolvedValueOnce({
      data: { notifications_enabled: false, auto_analyze_enabled: false, data_share_enabled: true },
      error: null,
    });

    const res = await PATCH(makeRequest('PATCH', { notifications_enabled: false, auto_analyze_enabled: false }));
    expect(res.status).toBe(200);

    const [row] = mockUpsert.mock.calls[0];
    expect(row).toEqual(
      expect.objectContaining({ user_id: 'user-1', notifications_enabled: false, auto_analyze_enabled: false }),
    );
    expect(row).not.toHaveProperty('data_share_enabled');
    // 既存の値 (旧画面で true にしたもの) は、そのまま返る。ここで同意として扱うことはしない
    const body = await res.json();
    expect(body.settings.data_share_enabled).toBe(true);
  });
});
