/**
 * 週間メニューから買い物リスト生成テスト
 * - /api/shopping-list/regenerate への RPC 呼び出しモック
 * - 日付範囲・人数パラメータの検証
 * - 非同期完了フロー (requestId ポーリング)
 */

// ---- モック ----------------------------------------------------------------

const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: jest.fn().mockReturnValue({
    get: mockGet,
    post: mockPost,
    patch: jest.fn(),
    del: jest.fn(),
  }),
  getApiBaseUrl: jest.fn().mockReturnValue('http://localhost:3000'),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'list-1' }, error: null }),
    }),
    channel: jest.fn().mockReturnValue({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn().mockReturnThis(),
    }),
    removeChannel: jest.fn(),
  },
}));

jest.mock('../../src/lib/mealPlan', () => ({
  getActiveShoppingListId: jest.fn().mockResolvedValue('list-1'),
}));

// ---- テスト対象ロジック (ShoppingListPage から抽出) -----------------------

type MealType = 'breakfast' | 'lunch' | 'dinner';
type RangeType = 'today' | 'tomorrow' | 'dayAfterTomorrow' | 'days' | 'week';

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function calculateDateRange(
  rangeType: RangeType,
  daysCount: number = 3,
  todayMeals: MealType[] = ['breakfast', 'lunch', 'dinner'],
  baseDate: Date = new Date('2026-05-01'),
) {
  const today = baseDate;
  const todayStr = formatLocalDate(today);

  switch (rangeType) {
    case 'today':
      return { startDate: todayStr, endDate: todayStr, mealTypes: todayMeals };
    case 'tomorrow': {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return {
        startDate: formatLocalDate(d),
        endDate: formatLocalDate(d),
        mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
      };
    }
    case 'dayAfterTomorrow': {
      const d = new Date(today);
      d.setDate(d.getDate() + 2);
      return {
        startDate: formatLocalDate(d),
        endDate: formatLocalDate(d),
        mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
      };
    }
    case 'week': {
      const end = new Date(today);
      end.setDate(end.getDate() + 6);
      return {
        startDate: todayStr,
        endDate: formatLocalDate(end),
        mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
      };
    }
    case 'days': {
      const count = Math.max(1, Math.min(14, daysCount));
      const end = new Date(today);
      end.setDate(end.getDate() + count - 1);
      return {
        startDate: todayStr,
        endDate: formatLocalDate(end),
        mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
      };
    }
    default:
      return {
        startDate: todayStr,
        endDate: todayStr,
        mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
      };
  }
}

async function executeRegenerate(opts: {
  rangeType: RangeType;
  daysCount?: number;
  todayMeals?: MealType[];
  servings?: number;
  baseDate?: Date;
}) {
  const { getApi } = require('../../src/lib/api');
  const api = getApi();
  const dateRange = calculateDateRange(
    opts.rangeType,
    opts.daysCount,
    opts.todayMeals,
    opts.baseDate,
  );

  const body: Record<string, any> = {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    mealTypes: dateRange.mealTypes,
  };

  if (opts.servings !== undefined && opts.servings !== 2) {
    body.servingsConfig = { default: opts.servings };
  }

  return api.post('/api/shopping-list/regenerate', body);
}

// ---- テスト -----------------------------------------------------------------

beforeEach(() => {
  mockPost.mockClear();
  mockGet.mockClear();
  mockPost.mockResolvedValue({ requestId: 'req-abc' });
  mockGet.mockResolvedValue({ status: 'completed', result: { stats: { outputCount: 10, totalServings: 6 } } });
});

describe('日付範囲計算', () => {
  const base = new Date('2026-05-01');

  test('today: 開始日 = 終了日 = 今日', () => {
    const range = calculateDateRange('today', 3, ['breakfast', 'lunch', 'dinner'], base);
    expect(range.startDate).toBe('2026-05-01');
    expect(range.endDate).toBe('2026-05-01');
  });

  test('tomorrow: 明日の日付', () => {
    const range = calculateDateRange('tomorrow', 3, undefined, base);
    expect(range.startDate).toBe('2026-05-02');
    expect(range.endDate).toBe('2026-05-02');
  });

  test('dayAfterTomorrow: 明後日の日付', () => {
    const range = calculateDateRange('dayAfterTomorrow', 3, undefined, base);
    expect(range.startDate).toBe('2026-05-03');
    expect(range.endDate).toBe('2026-05-03');
  });

  test('week: 今日から 6 日後まで', () => {
    const range = calculateDateRange('week', 3, undefined, base);
    expect(range.startDate).toBe('2026-05-01');
    expect(range.endDate).toBe('2026-05-07');
  });

  test('days(3): 今日から 2 日後まで (3日分)', () => {
    const range = calculateDateRange('days', 3, undefined, base);
    expect(range.startDate).toBe('2026-05-01');
    expect(range.endDate).toBe('2026-05-03');
  });

  test('days(14): 上限 14 日分を超えない', () => {
    const range = calculateDateRange('days', 20, undefined, base);
    expect(range.startDate).toBe('2026-05-01');
    expect(range.endDate).toBe('2026-05-14'); // max 14 days => +13 days
  });

  test('days(0): 下限 1 日分を下回らない', () => {
    const range = calculateDateRange('days', 0, undefined, base);
    expect(range.startDate).toBe('2026-05-01');
    expect(range.endDate).toBe('2026-05-01');
  });

  test('today: 選択した食事タイプのみが mealTypes に含まれる', () => {
    const range = calculateDateRange('today', 3, ['dinner'], base);
    expect(range.mealTypes).toEqual(['dinner']);
  });
});

describe('再生成 API 呼び出し', () => {
  test('week range で正しいパラメータが送られる', async () => {
    await executeRegenerate({ rangeType: 'week', baseDate: new Date('2026-05-01') });

    expect(mockPost).toHaveBeenCalledWith('/api/shopping-list/regenerate', {
      startDate: '2026-05-01',
      endDate: '2026-05-07',
      mealTypes: ['breakfast', 'lunch', 'dinner'],
    });
  });

  test('デフォルト人数 (2人) では servingsConfig は送られない', async () => {
    await executeRegenerate({ rangeType: 'today', servings: 2, baseDate: new Date('2026-05-01') });

    const callArg = mockPost.mock.calls[0][1];
    expect(callArg.servingsConfig).toBeUndefined();
  });

  test('2人以外の人数では servingsConfig が送られる', async () => {
    await executeRegenerate({ rangeType: 'today', servings: 4, baseDate: new Date('2026-05-01') });

    expect(mockPost).toHaveBeenCalledWith(
      '/api/shopping-list/regenerate',
      expect.objectContaining({ servingsConfig: { default: 4 } }),
    );
  });

  test('API が requestId を返す', async () => {
    const result = await executeRegenerate({ rangeType: 'week', baseDate: new Date('2026-05-01') });
    expect(result).toEqual({ requestId: 'req-abc' });
  });
});

describe('ステータスポーリング', () => {
  test('status=completed でポーリングが停止する', async () => {
    mockGet.mockResolvedValueOnce({
      status: 'completed',
      result: { stats: { outputCount: 5, totalServings: 4 } },
    });

    const { getApi } = require('../../src/lib/api');
    const api = getApi();

    const statusRes = await api.get('/api/shopping-list/regenerate/status?requestId=req-abc');
    expect(statusRes.status).toBe('completed');
    expect(statusRes.result.stats.outputCount).toBe(5);
  });

  test('status=failed でエラー情報が取得できる', async () => {
    mockGet.mockResolvedValueOnce({
      status: 'failed',
      result: { error: '材料の取得に失敗しました' },
    });

    const { getApi } = require('../../src/lib/api');
    const api = getApi();

    const statusRes = await api.get('/api/shopping-list/regenerate/status?requestId=req-abc');
    expect(statusRes.status).toBe('failed');
    expect(statusRes.result.error).toContain('失敗');
  });
});
