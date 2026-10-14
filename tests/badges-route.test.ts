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
 *
 * #1314: 次の 2 点を検証する。
 *   - ハンズオンツアーのお試しの記録 (user_daily_meals.is_sandbox = true) は、完了した食事数・自炊数・連続日数に数えない
 *   - 付与処理の無いバッジ (src/lib/badges/awardable.ts に無いコード) は、未獲得なら一覧に出さない。
 *     獲得済みなら、リストに無くても出す
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STEP3_SUB_STEP_TO_TARGET } from '@homegohan/handson-tour-shared';

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
  /**
   * ハンズオンツアーのお試しの記録 (user_daily_meals.is_sandbox = true の日に属する、完了済みの食事と日)。
   * 実 DB と同じく、クエリが is_sandbox = false で絞っていなければ、上の数にこれが足されて返る
   * (絞っていれば、お試しの記録は結果に入らない)。
   */
  sandbox?: {
    completedMealCount: number;
    cookCount: number;
    completedDays: Array<{ day_date: string }>;
  };
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
  // 連続日数の計算に使う user_daily_meals の取得 (#1314: is_sandbox の絞り込みを確かめるため、絞り込みを記録する)
  const dailyMealsQueries: Array<{ columns: unknown; eq: Array<[string, unknown]> }> = [];
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
   * resolve は await された時点で行うので、呼び出し順ではなく実際のチェーン内容 (in があるか、どの eq が付いたか) で
   * 結果を決められる。eq は record に積む (省略時は結果の判定にだけ使う)。
   */
  const makeQuery = (
    resolveResult: (state: { inCalled: boolean; eq: Array<[string, unknown]> }) => unknown,
    record: Array<[string, unknown]> = [],
  ) => {
    const state = { inCalled: false, eq: record };
    const q: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        record.push([column, value]);
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
          return makeQuery(({ inCalled, eq }) => {
            // 実 DB と同じく、user_daily_meals.is_sandbox = false の絞り込みが無ければ、お試しの記録も数えられる
            const excludesSandbox = eq.some(([column, value]) => column === 'user_daily_meals.is_sandbox' && value === false);
            const sandboxCount = excludesSandbox
              ? 0
              : (inCalled ? opts.sandbox?.cookCount : opts.sandbox?.completedMealCount) ?? 0;
            return inCalled
              ? { count: opts.cookCount + sandboxCount, error: err('cookCount') }
              : { count: opts.completedMealCount + sandboxCount, error: err('mealCount') };
          }, entry.eq);
        },
      };
    }

    if (table === 'user_daily_meals') {
      return {
        select: (columns: unknown) => {
          const entry = { columns, eq: [] as Array<[string, unknown]> };
          dailyMealsQueries.push(entry);
          return makeQuery(({ eq }) => {
            // 同上。user_daily_meals 自身の is_sandbox で絞る
            const excludesSandbox = eq.some(([column, value]) => column === 'is_sandbox' && value === false);
            const sandboxDays = excludesSandbox ? [] : (opts.sandbox?.completedDays ?? []);
            return { data: [...opts.completedDays, ...sandboxDays], error: err('completedDays') };
          }, entry.eq);
        },
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

  return {
    upsertMock,
    upsertSelectMock,
    sessionUserBadgesWrite,
    fromCallsWhenSettled,
    plannedMealsQueries,
    dailyMealsQueries,
  };
}

const FIRST_BITE: Badge = { id: 'b-first-bite', code: 'first_bite', name: '最初の一口', description: '1回記録する' };
const PHOTO_10: Badge = { id: 'b-photo-10', code: 'photo_10', name: 'カメラマン', description: '10食記録する' };
const STREAK_3: Badge = { id: 'b-streak-3', code: 'streak_3', name: '3日連続', description: '3日連続で記録する' };
const STREAK_7: Badge = { id: 'b-streak-7', code: 'streak_7', name: '7日連続', description: '7日連続で記録する' };
const HOME_CHEF: Badge = { id: 'b-home-chef', code: 'home_chef', name: '自炊の達人', description: '自炊10回' };
// #1314: 付与処理の無いバッジ (本番のマスターに行があるが、獲得のしようが無い)
const HEALTH_STREAK_7: Badge = { id: 'b-health-streak-7', code: 'health_streak_7', name: '健康記録1週間', description: '7日連続で健康記録を達成' };
const EARLY_BIRD: Badge = { id: 'b-early-bird', code: 'early_bird', name: '朝活の達人', description: '朝食を7回記録しました' };
// #1314: 付与処理のあるバッジのうち、/api/badges 以外が付与するもの
const PLANNER: Badge = { id: 'b-planner', code: 'planner', name: '計画上手', description: '1週間の献立を作成しました' };
const TUTORIAL_COMPLETE: Badge = { id: 'b-tutorial-complete', code: 'tutorial_complete', name: '使い方マスター', description: 'ガイド完走' };
const SEGMENT_RANK_1: Badge = { id: 'b-segment-rank-1', code: 'segment_rank_1', name: 'セグメント1位', description: '1位を獲得' };

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

describe('GET /api/badges (#1314 ハンズオンツアーのお試しの記録は数えない)', () => {
  it('お試しの記録 (is_sandbox = true) だけがあるユーザーは、食事数・自炊数・連続日数が 0 で、バッジも付かず保存もされない', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    // 修正前の挙動: ダミーの献立を「完了」にしただけで、12 食・自炊 12 回・3 日連続として数えられ、
    // first_bite / photo_10 / streak_3 が付いた
    const { upsertMock } = setupSupabaseMocks({
      allBadges: [FIRST_BITE, PHOTO_10, STREAK_3],
      userBadges: [],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
      sandbox: { completedMealCount: 12, cookCount: 12, completedDays: consecutiveDays(3) },
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats).toEqual({ completedMeals: 0, cookMeals: 0, streak: 0 });
    expect(json.newEarnedCount).toBe(0);
    expect(json.newEarnedBadgeCodes).toEqual([]);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
    // 3 つとも付与処理のあるバッジなので一覧には出るが、未獲得のまま
    expect(json.badges.map((b: { code: string }) => b.code)).toEqual(['first_bite', 'photo_10', 'streak_3']);
    for (const badge of json.badges) {
      expect(badge).toMatchObject({ earned: false, obtainedAt: null });
    }
  });

  it('お試しの記録と通常の記録が混ざっていても、通常の記録だけで数える', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    // 通常の記録は今日の 1 食だけ。お試しの記録は 20 食・前の 2 日。
    // 数えてしまうと 21 食・3 日連続になり、photo_10 / streak_3 まで付く
    setupSupabaseMocks({
      allBadges: [FIRST_BITE, PHOTO_10, STREAK_3],
      userBadges: [],
      completedMealCount: 1,
      cookCount: 1,
      completedDays: consecutiveDays(1),
      sandbox: { completedMealCount: 20, cookCount: 20, completedDays: [{ day_date: dayStr(1) }, { day_date: dayStr(2) }] },
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats).toEqual({ completedMeals: 1, cookMeals: 1, streak: 1 });
    expect(json.newEarnedBadgeCodes).toEqual(['first_bite']);
  });

  it('完了数・自炊数・連続日数の 3 本すべてに is_sandbox = false の絞り込みを付ける (health-insight-meals と同じ規則)', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { plannedMealsQueries, dailyMealsQueries } = setupSupabaseMocks({
      allBadges: [],
      userBadges: [],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    expect(res.status).toBe(200);

    // planned_meals (完了数・自炊数の 2 本): 埋め込んだ user_daily_meals の is_sandbox で絞る
    expect(plannedMealsQueries).toHaveLength(2);
    for (const q of plannedMealsQueries) {
      expect(q.eq).toContainEqual(['user_daily_meals.user_id', 'user-1']);
      expect(q.eq).toContainEqual(['user_daily_meals.is_sandbox', false]);
    }

    // user_daily_meals (連続日数の 1 本): user_daily_meals 自身の is_sandbox で絞る
    expect(dailyMealsQueries).toHaveLength(1);
    expect(dailyMealsQueries[0].eq).toContainEqual(['user_id', 'user-1']);
    expect(dailyMealsQueries[0].eq).toContainEqual(['is_sandbox', false]);
    // 自身の列なので、埋め込みの書き方 (user_daily_meals.is_sandbox) にはしない
    expect(dailyMealsQueries[0].eq.map(([column]) => column)).not.toContain('user_daily_meals.is_sandbox');
  });
});

describe('GET /api/badges (#1314 付与処理の無いバッジを一覧から隠す)', () => {
  const codesOf = (json: { badges: Array<{ code: string }> }) => json.badges.map((b) => b.code);

  it('付与処理の無いバッジ (health_streak_7 / early_bird) は、未獲得なら一覧に出さない。出るのは付与処理のあるバッジだけ', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    // 修正前の挙動: マスターの全バッジが、獲得のしようが無いものも含めて未獲得のまま並んでいた
    setupSupabaseMocks({
      allBadges: [FIRST_BITE, HEALTH_STREAK_7, EARLY_BIRD, STREAK_7],
      userBadges: [],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(codesOf(json)).toEqual(['first_bite', 'streak_7']);
    for (const badge of json.badges) {
      expect(badge).toMatchObject({ earned: false, obtainedAt: null });
    }
  });

  it('付与処理の無いバッジでも、獲得済みなら一覧に出す (earned: true と獲得日時つき)。ほかの未獲得の非対象は出さない', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    // early_bird は付与処理が無いが、過去に獲得している (別の経路・手作業・昔の仕組みなど)
    setupSupabaseMocks({
      allBadges: [FIRST_BITE, HEALTH_STREAK_7, EARLY_BIRD],
      userBadges: [{ badge_id: 'b-early-bird', obtained_at: '2026-02-03T00:00:00.000Z' }],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(codesOf(json)).toEqual(['first_bite', 'early_bird']);
    const earlyBird = json.badges.find((b: { code: string }) => b.code === 'early_bird');
    expect(earlyBird).toMatchObject({ earned: true, obtainedAt: '2026-02-03T00:00:00.000Z' });
    // 隠す前と同じく、獲得済みのバッジは新規獲得には数えない
    expect(json.newEarnedCount).toBe(0);
  });

  it('/api/badges 以外が付与するバッジ (planner / tutorial_complete / セグメント系) も、付与処理があるので未獲得のまま一覧に出す', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [PLANNER, TUTORIAL_COMPLETE, SEGMENT_RANK_1, HEALTH_STREAK_7],
      userBadges: [],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(codesOf(json)).toEqual(['planner', 'tutorial_complete', 'segment_rank_1']);
    for (const badge of json.badges) {
      expect(badge).toMatchObject({ earned: false, obtainedAt: null });
    }
  });

  it('ハンズオンツアーの Step 3 が Spotlight で指すバッジ (first_bite / planner / tutorial_complete) は、未獲得でも必ず返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    // Step 3 のカードは `badge-card-<code>`。ここで指しているバッジが一覧から消えると、Spotlight の対象が無くなる。
    // お試しの記録は first_bite に数えないため、新規ユーザーはこの 3 つとも未獲得のまま Step 3 に来る
    const tourBadgeCodes = Object.values(STEP3_SUB_STEP_TO_TARGET)
      .flatMap((target) => (Array.isArray(target) ? target : target ? [target] : []))
      .filter((testId) => testId.startsWith('badge-card-'))
      .map((testId) => testId.slice('badge-card-'.length));
    expect(tourBadgeCodes).toEqual(['first_bite', 'planner', 'tutorial_complete']);

    setupSupabaseMocks({
      allBadges: [
        ...tourBadgeCodes.map((code, i) => ({ id: `b-tour-${i}`, code, name: code, description: '' })),
        HEALTH_STREAK_7,
      ],
      userBadges: [],
      completedMealCount: 0,
      cookCount: 0,
      completedDays: [],
      sandbox: { completedMealCount: 1, cookCount: 1, completedDays: consecutiveDays(1) }, // ツアーのお試しの記録
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(codesOf(json)).toEqual(tourBadgeCodes);
    for (const badge of json.badges) {
      expect(badge).toMatchObject({ earned: false, obtainedAt: null });
    }
  });
});

describe('GET /api/badges (#1314 home_chef / master_chef / century の判定は今のまま。出すかどうかはオーナー判断待ち)', () => {
  it('条件を満たせば獲得して保存し、そのリクエストの一覧にも獲得済みで出す (リストに無くても、獲得済みは必ず返す)', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    const { upsertMock } = setupSupabaseMocks({
      allBadges: [FIRST_BITE, HOME_CHEF],
      userBadges: [],
      completedMealCount: 10,
      cookCount: 10, // home_chef (自炊 10 回) の条件を満たす
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toEqual([
      { user_id: 'user-1', badge_id: 'b-first-bite' },
      { user_id: 'user-1', badge_id: 'b-home-chef' },
    ]);
    expect(json.newEarnedBadgeCodes).toEqual(['first_bite', 'home_chef']);
    expect(json.badges.find((b: { code: string }) => b.code === 'home_chef')).toMatchObject({
      earned: true,
      obtainedAt: OBTAINED_AT,
    });
  });

  it('条件を満たしていなければ、未獲得のまま一覧に出さない', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [FIRST_BITE, HOME_CHEF],
      userBadges: [],
      completedMealCount: 2,
      cookCount: 2,
      completedDays: [],
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.badges.map((b: { code: string }) => b.code)).toEqual(['first_bite']);
  });

  it('獲得の条件を満たしても保存に失敗したら、獲得扱いにせず一覧にも出さない (次回アクセスで再判定される)', async () => {
    mockGetUser.mockResolvedValue({ data: { user }, error: null });

    setupSupabaseMocks({
      allBadges: [HOME_CHEF],
      userBadges: [],
      completedMealCount: 10,
      cookCount: 10,
      completedDays: [],
      upsertResult: () => ({ data: null, error: { message: 'boom', code: '42501' } }),
    });

    const res = await GET(new Request('http://localhost/api/badges'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.badges).toEqual([]);
    expect(json.newEarnedCount).toBe(0);
  });
});
