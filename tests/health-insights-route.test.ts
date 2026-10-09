/**
 * tests/health-insights-route.test.ts
 *
 * #1040 (F2-02) / #1306: /api/health/insights が、存在しない列を参照して食事を一切読めていなかった問題の回帰テスト。
 *
 * 修正前:
 *   POST は planned_meals に対して `.select('planned_date,...')` / `.eq('user_id', ...)` / `.order('planned_date')` を発行していた。
 *   planned_meals には user_id / planned_date 列が無い (食事の所有者は daily_meal_id → user_daily_meals.user_id、
 *   日付は user_daily_meals.day_date)。PostgREST は 42703 で拒否するが、戻り値の error を見ていなかったため、
 *   食事は常に「データなし」になり、AI は食事の情報なしでインサイトを作って保存していた。
 *   3 クエリのどれが失敗してもログに残らず、失敗は「データが無い」と区別できなかった。
 *
 * 修正後に期待する挙動:
 *   - 食事は user_daily_meals を本人・sandbox 除外・今日まで (JST) で絞り、planned_meals をネストして直近 7 日分を取る
 *   - プロンプトは day_date ごとの合計値 (kcal / タンパク質 / 脂質 / 炭水化物) と食事区分になる
 *   - 3 クエリのどれかが失敗したら、続行せず (誤った文脈でインサイトを作って保存しない)、
 *     createLogger で記録して 500 を返す
 *   - クライアントには生の DB エラー文を返さない (#1172 の方針)
 *
 * このテストは Supabase をモックしているので列の有無そのものは見えない。
 * 実 DB に対する確認は tests/integration/security/health-insights-meals.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockRateLimitExceededResponse = vi.fn();
const mockGenerateGeminiJson = vi.fn();

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに止めることは tests/ai-consent-enforcement.test.ts が確かめる
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  rateLimitExceededResponse: (...args: unknown[]) => mockRateLimitExceededResponse(...args),
}));

vi.mock('@/lib/ai/gemini-json', () => ({
  generateGeminiJson: (...args: unknown[]) => mockGenerateGeminiJson(...args),
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

const { GET, POST } = await import('@/app/api/health/insights/route');

const user = { id: 'user-1' };

type QueryError = { message: string; code?: string };
type QueryResult = { data?: unknown; error?: QueryError | null; count?: number | null };
type Call = { method: string; args: unknown[] };
type Recorded = { table: string; calls: Call[] };

/** テーブルごとの結果キュー。from(table) が呼ばれるたびに 1 つ消費し、最後の 1 つは使い回す */
let queues: Record<string, QueryResult[]>;
/** from() の呼び出しと、そのクエリに対するメソッドチェーンの記録 */
let recorded: Recorded[];

function setTable(table: string, results: QueryResult[]) {
  queues[table] = [...results];
}

function nextResult(table: string): QueryResult {
  const queue = queues[table];
  if (!queue || queue.length === 0) return { data: [], error: null, count: 0 };
  return queue.length > 1 ? queue.shift()! : queue[0];
}

const CHAIN_METHODS = ['select', 'insert', 'eq', 'lte', 'gte', 'in', 'is', 'order', 'limit', 'range'] as const;

/**
 * PostgREST のクエリビルダを模した thenable。どのメソッドもチェーンでき、await された時点で結果を返す。
 * 呼び出したメソッドと引数は recorded に残るので、発行されたクエリの形を検証できる。
 */
function installSupabaseMock() {
  mockFrom.mockImplementation((table: string) => {
    const entry: Recorded = { table, calls: [] };
    recorded.push(entry);
    const result = nextResult(table);
    const builder: Record<string, unknown> = {};
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        entry.calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected);
    return builder;
  });
}

function tablesQueried(): string[] {
  return recorded.map((r) => r.table);
}

function queryOf(table: string): Recorded {
  const found = recorded.find((r) => r.table === table);
  if (!found) throw new Error(`${table} へのクエリが発行されていません (発行: ${tablesQueried().join(', ') || 'なし'})`);
  return found;
}

function argsOf(entry: Recorded, method: string): unknown[][] {
  return entry.calls.filter((c) => c.method === method).map((c) => c.args);
}

function postRequest(): NextRequest {
  return new NextRequest('http://localhost/api/health/insights', { method: 'POST' });
}

function getRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/health/insights${query}`);
}

// ---- 共通のテストデータ ---------------------------------------------------

const RECORD = {
  record_date: '2026-10-07',
  weight: 60.5,
  body_fat_percentage: 20,
  systolic_bp: 120,
  diastolic_bp: 80,
  sleep_hours: 7,
  step_count: 8000,
};

// user_daily_meals (新しい順) に planned_meals をネストした形。食事区分は順不同で、合計は day_date ごとに取る
const MEAL_DAYS = [
  {
    day_date: '2026-10-07',
    planned_meals: [
      { meal_type: 'dinner', calories_kcal: 700, protein_g: 30.5, fat_g: 20.2, carbs_g: 80 },
      { meal_type: 'breakfast', calories_kcal: 400, protein_g: 20, fat_g: 10, carbs_g: 50 },
    ],
  },
  {
    day_date: '2026-10-06',
    planned_meals: [{ meal_type: 'lunch', calories_kcal: null, protein_g: null, fat_g: null, carbs_g: null }],
  },
];

const GENERATED = {
  data: {
    insights: [{ title: '睡眠', content: '睡眠を確保しましょう', insight_type: 'sleep', is_alert: false, priority: 1 }],
  },
};

/** 3 つの入力クエリと保存が成功する状態にする */
function setupHappyPath() {
  setTable('health_records', [{ data: [RECORD], error: null }]);
  setTable('health_checkups', [{ data: [], error: null }]);
  setTable('user_daily_meals', [{ data: MEAL_DAYS, error: null }]);
  setTable('health_insights', [{ data: [{ id: 'ins-1', user_id: user.id }], error: null }]);
  mockGenerateGeminiJson.mockResolvedValue(GENERATED);
}

function promptSentToLlm(): string {
  expect(mockGenerateGeminiJson).toHaveBeenCalledTimes(1);
  return (mockGenerateGeminiJson.mock.calls[0][0] as { prompt: string }).prompt;
}

beforeEach(() => {
  vi.clearAllMocks();
  queues = {};
  recorded = [];
  installSupabaseMock();
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  mockCheckRateLimit.mockResolvedValue({ success: true });
  // JST の 2026-10-08 05:30。UTC ではまだ 10-07 なので、「今日」が JST 基準であることも確かめられる
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('POST /api/health/insights', () => {
  it('未認証なら 401 (DB にも LLM にも触れない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST(postRequest());

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGenerateGeminiJson).not.toHaveBeenCalled();
  });

  it('生成の回数制限に達していたら、DB にも LLM にも触れずにその応答を返す', async () => {
    mockCheckRateLimit.mockResolvedValue({ success: false });
    mockRateLimitExceededResponse.mockReturnValue(new Response('{}', { status: 429 }));

    const res = await POST(postRequest());

    expect(res.status).toBe(429);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockGenerateGeminiJson).not.toHaveBeenCalled();
  });

  it('食事は user_daily_meals を本人・sandbox 除外・今日まで(JST)で絞ってネスト取得する。planned_meals を直接引かない', async () => {
    setupHappyPath();

    const res = await POST(postRequest());
    expect(res.status).toBe(200);

    // planned_meals には user_id / planned_date が無い。直接 from('planned_meals') しない
    expect(tablesQueried()).not.toContain('planned_meals');

    const meals = queryOf('user_daily_meals');
    const select = argsOf(meals, 'select')[0][0] as string;
    expect(select).toContain('day_date');
    expect(select).toMatch(/planned_meals(!inner)?\(/);
    for (const column of ['meal_type', 'calories_kcal', 'protein_g', 'fat_g', 'carbs_g']) {
      expect(select).toContain(column);
    }
    expect(select).not.toContain('planned_date');

    expect(argsOf(meals, 'eq')).toEqual([
      ['user_id', user.id],
      // ハンズオンツアーが入れる sandbox の日 (ダミーの献立) は食事の記録ではない
      ['is_sandbox', false],
    ]);
    // 先の予定 (まだ食べていない献立) は直近の食事として扱わない。「今日」は JST (UTC ではまだ 10-07)
    expect(argsOf(meals, 'lte')).toEqual([['day_date', '2026-10-08']]);
    expect(argsOf(meals, 'order')).toEqual([['day_date', { ascending: false }]]);
    expect(argsOf(meals, 'limit')).toEqual([[7]]);
  });

  it('プロンプトの食事は day_date ごとの合計と食事区分になり、undefined / null / planned_date を含まない', async () => {
    setupHappyPath();

    const res = await POST(postRequest());
    expect(res.status).toBe(200);

    const prompt = promptSentToLlm();
    // 10-07: (700 + 400) kcal、タンパク 30.5 + 20、脂質 20.2 + 10、炭水化物 80 + 50。区分は朝食・夕食の順
    expect(prompt).toContain('- 2026-10-07: 1100kcal, タンパク50.5g, 脂質30.2g, 炭水化物130g（朝食・夕食）');
    // 値が 1 つも無い日は '-' (0 にしない)
    expect(prompt).toContain('- 2026-10-06: -kcal, タンパク-g, 脂質-g, 炭水化物-g（昼食）');
    // 新しい日が先
    expect(prompt.indexOf('2026-10-07: 1100kcal')).toBeLessThan(prompt.indexOf('2026-10-06: -kcal'));
    expect(prompt).not.toMatch(/undefined|null|planned_date/);
  });

  it('直近の食事が 1 件も無ければ「データなし」としてプロンプトに入れる', async () => {
    setupHappyPath();
    setTable('user_daily_meals', [{ data: [], error: null }]);

    const res = await POST(postRequest());
    expect(res.status).toBe(200);

    expect(promptSentToLlm()).toMatch(/## 食事記録[^\n]*\nデータなし/);
  });

  it('健康記録も健診も無ければ 400。食事だけでは生成しない', async () => {
    setupHappyPath();
    setTable('health_records', [{ data: [], error: null }]);

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('データが不足');
    expect(mockGenerateGeminiJson).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it.each([
    ['health_records', 'column health_records.secret_col does not exist'],
    ['health_checkups', 'permission denied for table health_checkups'],
    ['user_daily_meals', 'column planned_meals.planned_date does not exist'],
  ])('%s の取得に失敗したら 500。記録を残し、LLM を呼ばず、何も保存せず、生のエラー文を返さない', async (table, rawMessage) => {
    setupHappyPath();
    setTable(table, [{ data: null, error: { message: rawMessage, code: '42703' } }]);

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(typeof json.error).toBe('string');
    expect(JSON.stringify(json)).not.toContain(rawMessage);

    // createLogger で、どのクエリがどのエラーで失敗したかを残す
    expect(mockWithUser).toHaveBeenCalledWith(user.id);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: rawMessage }),
      expect.objectContaining({ query: table, pg_code: '42703' }),
    );

    // 失敗したまま続行すると、欠けた文脈で作ったインサイトを保存してしまう
    expect(mockGenerateGeminiJson).not.toHaveBeenCalled();
    expect(tablesQueried()).not.toContain('health_insights');
  });

  it('取得に失敗したクエリが複数あれば、すべて記録する', async () => {
    setupHappyPath();
    setTable('health_records', [{ data: null, error: { message: 'records failed', code: '57014' } }]);
    setTable('user_daily_meals', [{ data: null, error: { message: 'meals failed', code: '42703' } }]);

    const res = await POST(postRequest());

    expect(res.status).toBe(500);
    const loggedQueries = mockLogError.mock.calls.map((call) => (call[2] as { query?: string }).query).sort();
    expect(loggedQueries).toEqual(['health_records', 'user_daily_meals']);
  });

  it('入力が揃っていれば 200 で、生成したインサイトを本人の user_id で保存する', async () => {
    setupHappyPath();

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBe(1);
    expect(mockLogError).not.toHaveBeenCalled();

    const insert = queryOf('health_insights');
    const rows = argsOf(insert, 'insert')[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.id, insight_type: 'sleep', is_read: false, is_dismissed: false });
  });

  it('保存に失敗したら 500。記録を残し、生のエラー文を返さない', async () => {
    setupHappyPath();
    const rawMessage = 'new row violates row-level security policy for table "health_insights"';
    setTable('health_insights', [{ data: null, error: { message: rawMessage, code: '42501' } }]);

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain(rawMessage);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: rawMessage }),
      expect.objectContaining({ pg_code: '42501' }),
    );
  });

  it('LLM の生成に失敗したら 500。記録を残し、何も保存しない', async () => {
    setupHappyPath();
    mockGenerateGeminiJson.mockRejectedValue(new Error('gemini unavailable'));

    const res = await POST(postRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('AIによるインサイト生成に失敗しました');
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'gemini unavailable' }),
      expect.anything(),
    );
    expect(tablesQueried()).not.toContain('health_insights');
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/health/insights', () => {
  it('未認証なら 401', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('一覧と未読数・アラート数を返す', async () => {
    setTable('health_insights', [
      { data: [{ id: 'ins-1' }, { id: 'ins-2' }], error: null },
      { data: null, error: null, count: 2 },
      { data: null, error: null, count: 1 },
    ]);

    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ insights: [{ id: 'ins-1' }, { id: 'ins-2' }], unreadCount: 2, alertCount: 1 });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('一覧の取得に失敗したら 500。記録を残し、生のエラー文を返さない', async () => {
    const rawMessage = 'relation "health_insights" does not exist';
    setTable('health_insights', [{ data: null, error: { message: rawMessage, code: '42P01' } }]);

    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain(rawMessage);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: rawMessage }),
      expect.objectContaining({ pg_code: '42P01' }),
    );
  });

  it('件数の取得に失敗しても一覧は返し (件数は 0 扱い)、失敗は記録する', async () => {
    setTable('health_insights', [
      { data: [{ id: 'ins-1' }], error: null },
      { data: null, error: { message: 'count failed', code: '57014' }, count: null },
      { data: null, error: null, count: 1 },
    ]);

    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ insights: [{ id: 'ins-1' }], unreadCount: 0, alertCount: 1 });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'count failed' }),
      expect.objectContaining({ pg_code: '57014' }),
    );
  });
});
