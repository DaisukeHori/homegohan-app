/**
 * tests/badges-route.test.ts
 *
 * #1055 (wave-3b): /api/badges の GET が、新規獲得バッジの code 一覧
 * (newEarnedBadgeCodes) を返すことを検証する。
 * バッジページの「新しいバッジを獲得！」オーバーレイがどのバッジか示せない
 * 匿名性の問題を修正するための契約テスト。
 *
 * #1215: 独立した 5 クエリを直列 await していた性能問題と、新規獲得バッジを 1 件ずつ
 * INSERT していた問題の修正を検証する。あわせて、モックでは見えなかった次の 2 つの不具合も固定する。
 *   - user_badges には SELECT ポリシーしか無く、セッションの client では常に RLS 違反 (42501) になる。
 *     戻り値の error を見ていなかったため、保存されないまま「新規獲得」を返していた。
 *     → service role の client で保存し、保存できた行だけを「新規獲得」として返す。
 *   - planned_meals には user_id 列が無い (所有者は daily_meal_id → user_daily_meals.user_id)。
 *     `.eq('user_id', ...)` は PostgREST が 42703 で拒否し、count が常に null (= 0 扱い) だった。
 *     → user_daily_meals!inner 経由で本人の行に絞る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockGetSupabaseAdmin = vi.fn();
const mockAdminFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}));

// 構造化ログのモック (失敗は createLogger(...).withUser(user.id).error(...) で記録される)
const mockLogError = vi.fn();
const mockWithUser = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: mockLogError,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    withUser: mockWithUser,
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const { GET } = await import('@/app/api/badges/route');

const user = { id: 'user-1' };

type Badge = { id: string; code: string; name: string; description: string };
type QueryError = { message: string; code?: string };
type QueryName = 'badges' | 'user_badges' | 'mealCount' | 'cookCount' | 'completedDays';

interface SetupOptions {
  allBadges: Badge[];
  userBadges: Array<{ badge_id: string; obtained_at: string }>;
  completedMealCount: number;
  cookCount: number;
  completedDays: Array<{ day_date: string }>;
  /** クエリごとのエラー注入 (省略時は成功) */
  queryErrors?: Partial<Record<QueryName, QueryError>>;
  /**
   * admin client の upsert().select() の結果を差し替える。
   * 省略時は渡された行を全て「挿入できた」として返す。
   */
  upsertResult?: (rows: Array<{ user_id: string; badge_id: string }>) => {
    data: Array<{ badge_id: string; obtained_at: string | null }> | null;
    error: QueryError | null;
  };
}

// DB が付けた obtained_at。レスポンスの obtainedAt が「リクエスト時刻 (new Date())」ではなく
// DB の値であることを区別できるよう、固定した現在時刻 (beforeEach) とは数 ms ずらしている
const OBTAINED_AT = '2026-10-07T03:00:00.123Z';

/** route.ts の連続日数計算と同じ方法で「n 日前」の日付文字列を作る */
function dayStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

/** 今日から daysCount 日連続の完了日 */
function consecutiveDays(daysCount: number): Array<{ day_date: string }> {
  return Array.from({ length: daysCount }, (_, i) => ({ day_date: dayStr(i) }));
}

function setupSupabaseMocks(opts: SetupOptions) {
  let fromCalls = 0;
  // 各クエリが解決した時点で、セッション client の from() が何回呼ばれていたか。
  // 5 クエリが並列なら、どれが解決した時点でも 5 回呼ばれ済みになる (直列なら 1,2,3,4,5 になる)。
  const fromCallsWhenSettled: number[] = [];
  const plannedMealsQueries: Array<{ columns: unknown; options: unknown; eq: Array<[string, unknown]> }> = [];
  const sessionUserBadgesWrite = vi.fn(); // セッション client での user_badges への書き込み (insert / upsert など)
  const upsertMock = vi.fn();
  const upsertSelectMock = vi.fn();

  const settle = <T>(value: T): Promise<T> =>
    new Promise((resolve) => {
      setTimeout(() => {
        fromCallsWhenSettled.push(fromCalls);
        resolve(value);
      }, 0);
    });

  const err = (name: QueryName) => opts.queryErrors?.[name] ?? null;

  /**
   * PostgREST のクエリビルダを模した thenable。eq / in / order / limit はどれもチェーンできる。
   * resolve は await された時点で行うので、呼び出し順ではなく実際のチェーン内容 (in があるか) で結果を決められる。
   */
  const makeQuery = (resolveResult: (state: { inCalled: boolean }) => unknown, record?: Array<[string, unknown]>) => {
    const state = { inCalled: false };
    const q: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        record?.push([column, value]);
        return q;
      },
      in: () => {
        state.inCalled = true;
        return q;
      },
      order: () => q,
      limit: () => q,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        settle(resolveResult(state)).then(onFulfilled, onRejected),
    };
    return q;
  };

  mockFrom.mockImplementation((table: string) => {
    fromCalls += 1;

    if (table === 'badges') {
      return {
        select: () => makeQuery(() => ({ data: opts.allBadges, error: err('badges') })),
      };
    }

    if (table === 'user_badges') {
      return {
        select: () => makeQuery(() => ({ data: opts.userBadges, error: err('user_badges') })),
        insert: sessionUserBadgesWrite,
        upsert: sessionUserBadgesWrite,
        update: sessionUserBadgesWrite,
        delete: sessionUserBadgesWrite,
      };
    }

    if (table === 'planned_meals') {
      return {
        select: (columns: unknown, options: unknown) => {
          const entry = { columns, options, eq: [] as Array<[string, unknown]> };
          plannedMealsQueries.push(entry);
          return makeQuery(
            ({ inCalled }) =>
              inCalled
                ? { count: opts.cookCount, error: err('cookCount') }
                : { count: opts.completedMealCount, error: err('mealCount') },
            entry.eq,
          );
        },
      };
    }

    if (table === 'user_daily_meals') {
      return {
        select: () => makeQuery(() => ({ data: opts.completedDays, error: err('completedDays') })),
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  // service role の client。user_badges への保存はここだけを通る
  mockGetSupabaseAdmin.mockReturnValue({ from: mockAdminFrom });
  mockAdminFrom.mockImplementation((table: string) => {
    if (table !== 'user_badges') throw new Error(`Unexpected admin table: ${table}`);
    return {
      upsert: (rows: Array<{ user_id: string; badge_id: string }>, options: unknown) => {
        upsertMock(rows, options);
        return {
          select: (columns: unknown) => {
            upsertSelectMock(columns);
            const result = opts.upsertResult
              ? opts.upsertResult(rows)
              : {
                  data: rows.map((r) => ({ badge_id: r.badge_id, obtained_at: OBTAINED_AT })),
                  error: null,
                };
            return Promise.resolve(result);
          },
        };
      },
    };
  });

  return { upsertMock, upsertSelectMock, sessionUserBadgesWrite, fromCallsWhenSettled, plannedMealsQueries };
}

const FIRST_BITE: Badge = { id: 'b-first-bite', code: 'first_bite', name: '最初の一口', description: '1回記録する' };
const PHOTO_10: Badge = { id: 'b-photo-10', code: 'photo_10', name: 'カメラマン', description: '10食記録する' };
const STREAK_3: Badge = { id: 'b-streak-3', code: 'streak_3', name: '3日連続', description: '3日連続で記録する' };
const STREAK_7: Badge = { id: 'b-streak-7', code: 'streak_7', name: '7日連続', description: '7日連続で記録する' };
const HOME_CHEF: Badge = { id: 'b-home-chef', code: 'home_chef', name: '自炊の達人', description: '自炊10回' };

beforeEach(() => {
  vi.clearAllMocks();
  // 連続日数の計算は「今日」基準なので、UTC 日付をまたいで揺れないよう Date だけ固定する
  // (setTimeout は本物のまま。モックの解決タイミングに使っている)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T03:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/badges', () => {
  it('未認証なら 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await GET(new Request('http://localhost/api/badges'));
    expect(res.status).toBe(401);
    // 未認証ではクエリも保存も一切走らせない
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('新規に条件を満たしたバッジがある場合、newEarnedBadgeCodes にその code を含める', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [FIRST_BITE, STREAK_7],
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

    // 新規獲得したバッジは earned: true で、obtainedAt は DB に保存された値を返す
    const firstBite = json.badges.find((b: { code: string }) => b.code === 'first_bite');
    expect(firstBite).toMatchObject({ earned: true, obtainedAt: OBTAINED_AT });
    const streak7 = json.badges.find((b: { code: string }) => b.code === 'streak_7');
    expect(streak7).toMatchObject({ earned: false, obtainedAt: null });
  });

  it('新規獲得バッジが無い場合、newEarnedBadgeCodes は空配列で、保存も行わない', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { upsertMock } = setupSupabaseMocks({
      allBadges: [FIRST_BITE],
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
    // 獲得済みバッジは earned のまま、obtainedAt は user_badges の値を返す
    expect(json.badges[0]).toMatchObject({ earned: true, obtainedAt: '2026-01-01T00:00:00.000Z' });
    // 保存対象が無いので service role の client も作らない
    expect(upsertMock).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('stats に完了した食事数・自炊数・連続日数を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [],
      userBadges: [],
      completedMealCount: 12,
      cookCount: 6,
      completedDays: consecutiveDays(3),
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.badges).toEqual([]);
    expect(json.stats).toEqual({ completedMeals: 12, cookMeals: 6, streak: 3 });
  });
});

describe('GET /api/badges (#1215 性能: 並列化と一括保存)', () => {
  it('互いに独立な 5 クエリを並列に発行する (1 本ずつ直列 await しない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { fromCallsWhenSettled } = setupSupabaseMocks({
      allBadges: [FIRST_BITE],
      userBadges: [],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    expect(res.status).toBe(200);

    // 5 クエリ全てが解決した時点で、最初の 1 本が解決するより前に 5 本とも発行済みでなければならない
    expect(fromCallsWhenSettled).toHaveLength(5);
    expect(Math.min(...fromCallsWhenSettled)).toBe(5);
  });

  it('新規獲得バッジが複数あっても user_badges への保存は 1 回の upsert にまとめる', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { upsertMock, upsertSelectMock } = setupSupabaseMocks({
      allBadges: [FIRST_BITE, PHOTO_10, STREAK_3, STREAK_7, HOME_CHEF],
      userBadges: [],
      completedMealCount: 12, // first_bite / photo_10
      cookCount: 2, // home_chef (10 回) には届かない
      completedDays: consecutiveDays(7), // streak_3 / streak_7
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    // バッジ数だけ INSERT を繰り返さず、upsert は全体で 1 回
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertSelectMock).toHaveBeenCalledTimes(1);

    const [rows, options] = upsertMock.mock.calls[0];
    // user_id は認証済みユーザー固定、badge_id は条件を満たしたマスターの id だけ
    expect(rows).toEqual([
      { user_id: 'user-1', badge_id: 'b-first-bite' },
      { user_id: 'user-1', badge_id: 'b-photo-10' },
      { user_id: 'user-1', badge_id: 'b-streak-3' },
      { user_id: 'user-1', badge_id: 'b-streak-7' },
    ]);
    // 既に行がある場合 (同時リクエスト等) は DO NOTHING。1 件の重複で全件失敗させない
    expect(options).toEqual({ onConflict: 'user_id,badge_id', ignoreDuplicates: true });

    expect(json.newEarnedCount).toBe(4);
    expect(json.newEarnedBadgeCodes).toEqual(['first_bite', 'photo_10', 'streak_3', 'streak_7']);
    expect(json.stats.streak).toBe(7);
  });

  it('保存は service role の client で行い、セッションの client では user_badges に書かない (RLS で常に 42501 になるため)', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { sessionUserBadgesWrite, upsertMock } = setupSupabaseMocks({
      allBadges: [FIRST_BITE],
      userBadges: [],
      completedMealCount: 1,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    expect(res.status).toBe(200);

    expect(sessionUserBadgesWrite).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(mockAdminFrom).toHaveBeenCalledWith('user_badges');
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it('planned_meals の集計は user_daily_meals!inner 経由で本人の行に絞る (存在しない planned_meals.user_id を使わない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { plannedMealsQueries } = setupSupabaseMocks({
      allBadges: [FIRST_BITE],
      userBadges: [],
      completedMealCount: 3,
      cookCount: 1,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();
    expect(res.status).toBe(200);

    // 完了数・自炊数の 2 本
    expect(plannedMealsQueries).toHaveLength(2);
    for (const q of plannedMealsQueries) {
      expect(String(q.columns)).toContain('user_daily_meals!inner');
      expect(q.options).toEqual({ count: 'exact', head: true });
      expect(q.eq).toContainEqual(['user_daily_meals.user_id', 'user-1']);
      expect(q.eq).toContainEqual(['is_completed', true]);
      // planned_meals に user_id 列は無い。PostgREST が 42703 で拒否し、count が常に null になる
      expect(q.eq.map(([column]) => column)).not.toContain('user_id');
    }
    expect(json.stats).toMatchObject({ completedMeals: 3, cookMeals: 1 });
  });
});

describe('GET /api/badges (#1215 エラー処理)', () => {
  it('保存に失敗したバッジは新規獲得として返さず (earned: false)、一覧は 200 で返してエラーを記録する', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    // 修正前の挙動: 保存が 42501 で失敗しても error を見ず、保存されていないバッジを「新規獲得」として返していた
    const { upsertMock } = setupSupabaseMocks({
      allBadges: [FIRST_BITE, PHOTO_10],
      userBadges: [],
      completedMealCount: 10,
      cookCount: 0,
      completedDays: [],
      upsertResult: () => ({
        data: null,
        error: { message: 'new row violates row-level security policy for table "user_badges"', code: '42501' },
      }),
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(json.newEarnedCount).toBe(0);
    expect(json.newEarnedBadgeCodes).toEqual([]);
    expect(json.badges).toHaveLength(2);
    for (const badge of json.badges) {
      expect(badge).toMatchObject({ earned: false, obtainedAt: null });
    }

    // 失敗は構造化ログに記録される (握りつぶさない)
    expect(mockWithUser).toHaveBeenCalledWith('user-1');
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][0]).toContain('user_badges');
    expect(mockLogError.mock.calls[0][1]).toMatchObject({ code: '42501' });
    expect(mockLogError.mock.calls[0][2]).toMatchObject({ badge_codes: ['first_bite', 'photo_10'] });
  });

  it('service role の client を作れなくても (env 欠落など)、一覧は 200 で返してエラーを記録する', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [FIRST_BITE],
      userBadges: [],
      completedMealCount: 1,
      cookCount: 0,
      completedDays: [],
    });
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.newEarnedCount).toBe(0);
    expect(json.newEarnedBadgeCodes).toEqual([]);
    expect(json.badges[0]).toMatchObject({ code: 'first_bite', earned: false });
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it('同時リクエストが先に保存済みのバッジ (upsert が行を返さない) は earned だが、新規獲得には含めない', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [FIRST_BITE, PHOTO_10],
      userBadges: [],
      completedMealCount: 10,
      cookCount: 0,
      completedDays: [],
      // first_bite は別リクエストが先に保存済み (DO NOTHING で返らない)。photo_10 だけ今回挿入できた
      upsertResult: (rows) => ({
        data: rows
          .filter((r) => r.badge_id === 'b-photo-10')
          .map((r) => ({ badge_id: r.badge_id, obtained_at: OBTAINED_AT })),
        error: null,
      }),
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.newEarnedCount).toBe(1);
    expect(json.newEarnedBadgeCodes).toEqual(['photo_10']);
    const firstBite = json.badges.find((b: { code: string }) => b.code === 'first_bite');
    expect(firstBite.earned).toBe(true);
    // これは異常ではないのでエラーとしては記録しない
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it.each<[QueryName]>([['badges'], ['user_badges'], ['mealCount'], ['cookCount'], ['completedDays']])(
    '独立 5 クエリのうち %s が失敗したら、嘘の結果を返さず 500 を返し、保存もしない',
    async (failing) => {
      mockGetUser.mockResolvedValue({ data: { user }, error: null });

      const { upsertMock } = setupSupabaseMocks({
        allBadges: [FIRST_BITE],
        userBadges: [],
        completedMealCount: 1,
        cookCount: 0,
        completedDays: [],
        queryErrors: { [failing]: { message: 'column planned_meals.user_id does not exist', code: '42703' } },
      });

      const res = await GET(new Request('http://localhost/api/badges'));

      expect(res.status).toBe(500);
      expect(upsertMock).not.toHaveBeenCalled();
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][1]).toMatchObject({ code: '42703' });
    },
  );
});
