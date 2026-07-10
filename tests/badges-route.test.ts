/**
 * tests/badges-route.test.ts
 *
 * #1055 (wave-3b): /api/badges の GET が、新規獲得バッジの code 一覧
 * (newEarnedBadgeCodes) を返すことを検証する。
 * バッジページの「新しいバッジを獲得！」オーバーレイがどのバッジか示せない
 * 匿名性の問題を修正するための契約テスト。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

const { GET } = await import('@/app/api/badges/route');

const user = { id: 'user-1' };

interface SetupOptions {
  allBadges: Array<{ id: string; code: string; name: string; description: string }>;
  userBadges: Array<{ badge_id: string; obtained_at: string }>;
  completedMealCount: number;
  cookCount: number;
  completedDays: Array<{ day_date: string }>;
}

function setupSupabaseMocks(opts: SetupOptions) {
  let plannedMealsCallCount = 0;
  const insertMock = vi.fn().mockResolvedValue({ data: null, error: null });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'badges') {
      return {
        select: () => Promise.resolve({ data: opts.allBadges }),
      };
    }

    if (table === 'user_badges') {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: opts.userBadges }),
        }),
        insert: insertMock,
      };
    }

    if (table === 'planned_meals') {
      plannedMealsCallCount += 1;
      const isFirstCall = plannedMealsCallCount === 1; // 完了食事数（.eq().eq() で確定）
      return {
        select: () => ({
          eq: () => ({
            eq: () =>
              isFirstCall
                ? Promise.resolve({ count: opts.completedMealCount })
                : {
                    in: () => Promise.resolve({ count: opts.cookCount }),
                  },
          }),
        }),
      };
    }

    if (table === 'user_daily_meals') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: opts.completedDays }),
              }),
            }),
          }),
        }),
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  return { insertMock };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/badges', () => {
  it('未認証なら 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await GET(new Request('http://localhost/api/badges'));
    expect(res.status).toBe(401);
  });

  it('新規に条件を満たしたバッジがある場合、newEarnedBadgeCodes にその code を含める', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [
        { id: 'b-first-bite', code: 'first_bite', name: '最初の一口', description: '1回記録する' },
        { id: 'b-streak-7', code: 'streak_7', name: '7日連続', description: '7日連続で記録する' },
      ],
      userBadges: [], // まだ何も獲得していない
      completedMealCount: 1, // first_bite の条件を満たす
      cookCount: 0,
      completedDays: [], // streak_7 の条件は満たさない
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.newEarnedCount).toBe(1);
    expect(json.newEarnedBadgeCodes).toEqual(['first_bite']);
    // streak_7 は条件未達のため含まれない
    expect(json.newEarnedBadgeCodes).not.toContain('streak_7');
  });

  it('新規獲得バッジが無い場合、newEarnedBadgeCodes は空配列', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [
        { id: 'b-first-bite', code: 'first_bite', name: '最初の一口', description: '1回記録する' },
      ],
      userBadges: [{ badge_id: 'b-first-bite', obtained_at: '2026-01-01T00:00:00.000Z' }], // 既に獲得済み
      completedMealCount: 5,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.newEarnedCount).toBe(0);
    expect(json.newEarnedBadgeCodes).toEqual([]);
  });
});
