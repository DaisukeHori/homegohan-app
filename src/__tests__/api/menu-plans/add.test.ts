import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1306 POST /api/menu-plans/add の badge_awarded のレスポンス形式の契約テスト。
//
// awardBadge は badges の実列 icon を読むように直したが、クライアント (web / モバイル) に返す
// badge_awarded のキーは従来どおり icon_url のままにする (complete_handson_tour RPC と同じ)。
// ここでは awardBadge をモックし、ルートが結果をそのキーで返すこと、
// バッジの付与に失敗しても献立の追加自体は成功のままであることを固定する。

const mockGetUser = vi.fn();
const mockSessionFrom = vi.fn();
const mockAdminFrom = vi.fn();
const mockAwardBadge = vi.fn();
const adminClient = { from: mockAdminFrom };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockSessionFrom,
  })),
  getSupabaseAdmin: () => adminClient,
}));

vi.mock('@/lib/badges/awardBadge', () => ({
  awardBadge: (...args: unknown[]) => mockAwardBadge(...args),
}));

const { POST } = await import('@/app/api/menu-plans/add/route');

const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };
const OBTAINED_AT = '2026-10-08T03:00:00.000Z';

const postRequest = () =>
  new Request('http://localhost/api/menu-plans/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dish_name: 'テスト献立', calories: 500 }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });

  // セッション client: weekly_menu_requests の作成 (insert→select→single) と完了への更新 (update→eq)
  mockSessionFrom.mockImplementation((table: string) => {
    if (table !== 'weekly_menu_requests') throw new Error(`想定外のテーブル (session): ${table}`);
    return {
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'req-1' }, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  });

  // service role の client: weekly_menus の作成 (insert→select→single)
  mockAdminFrom.mockImplementation((table: string) => {
    if (table !== 'weekly_menus') throw new Error(`想定外のテーブル (admin): ${table}`);
    return {
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'menu-1' }, error: null }) }) }),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/menu-plans/add の badge_awarded', () => {
  it('planner バッジを付与できたら、code / name / obtained_at / icon_url を返す (icon_url のキーは維持)', async () => {
    mockAwardBadge.mockResolvedValue({
      awarded: true,
      badge_id: 'badge-1',
      obtained_at: OBTAINED_AT,
      name: '計画上手',
      icon_url: '📋',
    });

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      menu_id: 'menu-1',
      badge_awarded: { code: 'planner', name: '計画上手', obtained_at: OBTAINED_AT, icon_url: '📋' },
    });
    // 付与は service role の client で、認証済みユーザー本人に対してだけ行う
    expect(mockAwardBadge).toHaveBeenCalledTimes(1);
    expect(mockAwardBadge).toHaveBeenCalledWith(adminClient, USER.id, 'planner');
  });

  it('badges.icon が null のバッジでも icon_url のキーを null で返す', async () => {
    mockAwardBadge.mockResolvedValue({
      awarded: true,
      badge_id: 'badge-1',
      obtained_at: OBTAINED_AT,
      name: '計画上手',
      icon_url: null,
    });

    const json = await (await POST(postRequest())).json();

    expect(json.badge_awarded).toHaveProperty('icon_url', null);
  });

  it('獲得済みなどで付与しなかったときは badge_awarded: null を返す', async () => {
    mockAwardBadge.mockResolvedValue({
      awarded: false,
      badge_id: 'badge-1',
      obtained_at: OBTAINED_AT,
      name: '計画上手',
      icon_url: '📋',
    });

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, menu_id: 'menu-1', badge_awarded: null });
  });

  it('バッジの付与が例外になっても、献立の追加は成功のまま badge_awarded: null を返す', async () => {
    mockAwardBadge.mockRejectedValue({ code: '42703', message: 'column badges.icon_url does not exist' });

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, menu_id: 'menu-1', badge_awarded: null });
    expect(console.error).toHaveBeenCalledWith(
      'planner badge award failed (non-fatal):',
      expect.objectContaining({ code: '42703' }),
    );
  });
});
