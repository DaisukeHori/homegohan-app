/**
 * src/__tests__/api/ai/menu/weekly-status-not-found.test.ts
 *
 * #1622: GET /api/ai/menu/weekly/status は、本人の行 (user_id が自分) だけを読む。
 * 他の利用者の requestId と、存在しない requestId は、どちらも同じ { status: 'not_found', requestId } を返す
 * (#780 で failed + 'Request not found' から not_found に変えた。他人の行の有無・状態・進捗を応答から見分けられない)。
 * tests/e2e/w5-3-menu-gen-adversarial.spec.ts の Security のテストは、この応答を期待する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();

// 利用者のクライアント: from('weekly_menu_requests').select(...).eq('id', ...).eq('user_id', ...).maybeSingle()
const selectFilters: Array<[string, unknown]> = [];
const mockMaybeSingle = vi.fn(async () => ({ data: null as Record<string, unknown> | null, error: null }));
const filterBuilder = {
  eq: (column: string, value: unknown) => {
    selectFilters.push([column, value]);
    return filterBuilder;
  },
  maybeSingle: mockMaybeSingle,
};
const mockSelect = vi.fn((_columns: string) => filterBuilder);
const mockFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') return { select: mockSelect };
  throw new Error(`Unexpected table in test: ${table}`);
});

// not_found の経路では service role で書かない (止まった行を failed にするのは本人の行だけ)
const mockAdminFrom = vi.fn((table: string) => {
  throw new Error(`Unexpected admin access in test: ${table}`);
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser }, from: mockFrom })),
  getSupabaseAdmin: vi.fn(() => ({ from: mockAdminFrom })),
}));

const { GET } = await import('@/app/api/ai/menu/weekly/status/route');

const user = { id: 'user-1' };
const OTHER_USERS_REQUEST_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const makeRequest = (requestId: string) =>
  new Request(`http://localhost/api/ai/menu/weekly/status?requestId=${requestId}`);

beforeEach(() => {
  vi.clearAllMocks();
  selectFilters.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe('GET /api/ai/menu/weekly/status — 本人の行でない requestId (#1622)', () => {
  it('本人の行に絞って読む (id と user_id の両方で絞る)', async () => {
    await GET(makeRequest(OTHER_USERS_REQUEST_ID));

    expect(selectFilters).toEqual([
      ['id', OTHER_USERS_REQUEST_ID],
      ['user_id', user.id],
    ]);
  });

  it('他人の行 (本人に絞ると 0 行) は、status: not_found と requestId だけを返す (状態・進捗・エラー文・時刻を返さない)', async () => {
    const res = await GET(makeRequest(OTHER_USERS_REQUEST_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'not_found', requestId: OTHER_USERS_REQUEST_ID });
    // 他人の行を failed に書き換えたりしない
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it('本人の行があれば、その状態を返す (not_found は行が無いときだけ)', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: OTHER_USERS_REQUEST_ID,
        status: 'processing',
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        worker_acquired_at: null,
        mode: 'v5',
        start_date: '2026-07-06',
        target_meal_id: null,
        progress: { currentStep: 1, totalSteps: 3 },
      },
      error: null,
    });

    const res = await GET(makeRequest(OTHER_USERS_REQUEST_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('processing');
    expect(body.progress).toEqual({ currentStep: 1, totalSteps: 3 });
  });
});
