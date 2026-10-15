// @vitest-environment node
/**
 * #1631: AI 相談のシステムプロンプトで、献立の行の区分の表示名を @homegohan/shared の MEAL_LABELS から、
 * 「今後1週間の献立」の同じ日の中の並びを MEAL_ORDER から引く (以前は route の中に 5 値の表を手書きしていた)。
 *
 * 書き直しの前と同じ挙動であることを、本物の route を通して確かめる (差し替えるのは Supabase のクライアント・AI の呼び出しなど
 * 外との境目だけ。consultation-pantry-expiry-jst.test.ts と同じ形):
 *   - 今後 1 週間の献立は、日付の順、同じ日の中は 朝食 → 昼食 → 夕食 → おやつ → 夜食 の順。5 値以外の区分は、その日の最後に元の値のまま
 *   - 区分の表示名は 5 値それぞれの名前 (朝食・昼食・夕食・おやつ・夜食)。5 値以外は元の値のまま
 *   - 今日の献立・最近の食事履歴の行も、同じ表示名
 * 期待する表示名と並びは、正本の定数から求めずに手で書く (正本の値が変わったら、このテストで気づく)。
 *
 * 同じ作り物で、プロフィールの「ニックネーム」の行に仮置きの 'Guest' を名前として出さないこと (#1649) も確かめる (ファイルの末尾)。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TODAY_DAILY_MEAL_ID = 'daily-today';

/** planned_meals を読む 3 つの問い合わせ (今日・今後 1 週間・最近 14 日) */
type PlannedMealsQuery = 'today' | 'upcoming' | 'recent';

const h = vi.hoisted(() => ({
  /** 表ごとの select (await) の結果の行 (planned_meals 以外) */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** planned_meals の問い合わせごとの結果の行 */
  plannedMeals: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 表ごとの書き込み ... select().single() の結果 (無ければ { id: '<表>-new' }) */
  written: {} as Record<string, Record<string, unknown>>,
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

/**
 * planned_meals の問い合わせを、繋いだメソッドから見分ける。
 * 今日 = .eq('daily_meal_id', …) / 今後 1 週間 = .gt(日付) / 最近 14 日 = .lt(日付) (route の buildSystemPrompt の問い合わせの形)
 */
function plannedMealsQueryOf(calls: Array<{ method: string; args: unknown[] }>): PlannedMealsQuery | null {
  if (calls.some((c) => c.method === 'eq' && c.args[0] === 'daily_meal_id')) return 'today';
  if (calls.some((c) => c.method === 'gt')) return 'upcoming';
  if (calls.some((c) => c.method === 'lt')) return 'recent';
  return null;
}

/** Supabase のクエリの作り物。どのメソッドを繋いでも同じ作り物を返し、await / single() で結果を返す */
function makeQuery(table: string): unknown {
  let op: 'select' | 'write' = 'select';
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const selectedRows = (): Array<Record<string, unknown>> => {
    if (table !== 'planned_meals') return h.rows[table] ?? [];
    const query = plannedMealsQueryOf(calls);
    return query === null ? [] : (h.plannedMeals[query] ?? []);
  };
  const singleResult = () =>
    op === 'select'
      ? { data: h.single[table] ?? null, error: null }
      : { data: h.written[table] ?? { id: `${table}-new` }, error: null };
  const awaitedResult = () =>
    op === 'select'
      ? { data: selectedRows(), error: null, count: selectedRows().length }
      : { data: null, error: null, count: null };
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(awaitedResult()).then(resolve, reject);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(singleResult());
        if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
          return () => {
            op = 'write';
            return builder;
          };
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return builder;
        };
      },
    },
  );
  return builder;
}

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER, email: 'user@example.test' } }, error: null }) },
    from: (table: string) => makeQuery(table),
    // AI の 1 日の利用回数の上限の判定と記録 (#1149)。許可した結果を返す
    rpc: async (name: string) =>
      name === 'consume_ai_usage'
        ? { data: { allowed: true, metered: true, usage_date: '2026-10-15', limit: 10, used: 1 }, error: null }
        : { data: null, error: null },
  };
}

// ── 外との境目だけ差し替える ─────────────────────────────────────────
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabase()),
  getSupabaseAdmin: vi.fn(() => makeSupabase()),
}));
vi.mock('@/lib/db-logger', async (importOriginal) => {
  const logger: Record<string, unknown> = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  logger.withUser = () => logger;
  return {
    ...(await importOriginal<typeof import('@/lib/db-logger')>()),
    createLogger: () => logger,
    generateRequestId: () => 'req_test',
  };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/ai/ai-chat-gate', () => ({ aiChatDisabledResponse: vi.fn(async () => null) }));
vi.mock('@/lib/ai/consent-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consent-guard')>()),
  requireAiConsent: vi.fn(async () => null),
}));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/env-required', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env-required')>()),
  getSupabaseServiceConfig: () => ({ url: 'https://supabase.example.test', serviceRoleKey: 'service-role-key-test' }),
}));
vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: () => ({ chat: { completions: { create: h.llmCreate } } }),
  getFastLLMModel: () => 'test-model',
}));

const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

/** 献立の行 (planned_meals と、内側で結んだ user_daily_meals の日付) */
function plannedMeal(id: string, mealType: string, dayDate: string, dishName: string): Record<string, unknown> {
  return {
    id,
    meal_type: mealType,
    dish_name: dishName,
    calories_kcal: 500,
    protein_g: 20,
    is_completed: false,
    mode: 'cook',
    user_daily_meals: { day_date: dayDate, user_id: USER },
  };
}

const UPCOMING_DAY = '2099-01-21';
const UPCOMING_PREVIOUS_DAY = '2099-01-20';
const RECENT_DAY = '2000-01-10';

/**
 * 今後 1 週間の献立。同じ日の区分を、並べたい順の逆 (夜食 → 朝食) にし、5 値以外の区分 (brunch) を先頭に置く。
 * 前の日の夕食を最後に置く (日付の順が区分の並びより先に効くこと)
 */
const UPCOMING_ROWS = [
  plannedMeal('up-brunch', 'brunch', UPCOMING_DAY, 'ブランチのパンケーキ'),
  plannedMeal('up-midnight-snack', 'midnight_snack', UPCOMING_DAY, '夜食のおにぎり'),
  plannedMeal('up-snack', 'snack', UPCOMING_DAY, 'おやつのプリン'),
  plannedMeal('up-dinner', 'dinner', UPCOMING_DAY, '夕ごはんの鍋'),
  plannedMeal('up-lunch', 'lunch', UPCOMING_DAY, '昼ごはんのそば'),
  plannedMeal('up-breakfast', 'breakfast', UPCOMING_DAY, '朝ごはんのトースト'),
  plannedMeal('up-previous-day-dinner', 'dinner', UPCOMING_PREVIOUS_DAY, '前の日のカレー'),
];

/** 今後 1 週間の献立の行として、プロンプトに出る並びと文面 */
const EXPECTED_UPCOMING_LINES = [
  `- ${UPCOMING_PREVIOUS_DAY} 夕食: 前の日のカレー [内部ID: up-previous-day-dinner]`,
  `- ${UPCOMING_DAY} 朝食: 朝ごはんのトースト [内部ID: up-breakfast]`,
  `- ${UPCOMING_DAY} 昼食: 昼ごはんのそば [内部ID: up-lunch]`,
  `- ${UPCOMING_DAY} 夕食: 夕ごはんの鍋 [内部ID: up-dinner]`,
  `- ${UPCOMING_DAY} おやつ: おやつのプリン [内部ID: up-snack]`,
  `- ${UPCOMING_DAY} 夜食: 夜食のおにぎり [内部ID: up-midnight-snack]`,
  `- ${UPCOMING_DAY} brunch: ブランチのパンケーキ [内部ID: up-brunch]`,
];

const UPCOMING_HEADER = '【📆 今後1週間の献立】';

/** AI (knowledge-gpt) へ送った本文のシステムプロンプト */
let sentSystemPrompts: string[];

beforeEach(() => {
  sentSystemPrompts = [];
  h.single = {
    ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' },
    user_daily_meals: { id: TODAY_DAILY_MEAL_ID },
  };
  h.written = {
    ai_consultation_messages: { id: 'msg-1', content: 'こんにちは', created_at: '2026-10-15T00:00:00Z' },
  };
  h.rows = {};
  h.plannedMeals = {
    today: [plannedMeal('today-lunch', 'lunch', '2026-10-15', '今日の親子丼')],
    upcoming: UPCOMING_ROWS,
    recent: [
      plannedMeal('recent-midnight-snack', 'midnight_snack', RECENT_DAY, '履歴のラーメン'),
      plannedMeal('recent-brunch', 'brunch', RECENT_DAY, '履歴のワッフル'),
    ],
  };
  h.llmCreate.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
      const system = body.messages?.find((m) => m.role === 'system');
      if (system) sentSystemPrompts.push(system.content);
      return Response.json({ choices: [{ message: { content: 'わかりました。' } }] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** POST を呼び、AI へ送ったシステムプロンプトを返す */
async function systemPrompt(): Promise<string> {
  const res = await POST(
    new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '来週の献立を見て' }),
    }),
    { params: { sessionId: SESSION_ID } },
  );
  expect(res.status).toBe(200);
  expect(sentSystemPrompts).toHaveLength(1);
  return sentSystemPrompts[0];
}

/** 見出しのすぐ後に続く「- 」の行 (空行か別の行で終わる) */
function linesUnder(prompt: string, header: string): string[] {
  const lines = prompt.split('\n');
  const start = lines.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    section.push(line);
  }
  return section;
}

/** その料理の行 (1 行だけ) */
function lineOf(prompt: string, dishName: string): string {
  const matched = prompt.split('\n').filter((line) => line.includes(dishName));
  expect(matched, dishName).toHaveLength(1);
  return matched[0];
}

describe('AI 相談のシステムプロンプト — 献立の区分の表示名は MEAL_LABELS、並びは MEAL_ORDER から引く (#1631)', () => {
  it('今後 1 週間の献立は、日付の順、同じ日は 朝食 → 昼食 → 夕食 → おやつ → 夜食、5 値以外は最後に元の値のまま', async () => {
    const prompt = await systemPrompt();
    expect(linesUnder(prompt, UPCOMING_HEADER)).toEqual(EXPECTED_UPCOMING_LINES);
  });

  it('今日の献立の行は、区分の表示名で出る', async () => {
    const prompt = await systemPrompt();
    expect(lineOf(prompt, '今日の親子丼')).toMatch(/^- 昼食（\d{4}-\d{2}-\d{2}）: 今日の親子丼 /);
  });

  it('最近の食事履歴の行は、区分の表示名で出る (5 値以外は元の値のまま)', async () => {
    const prompt = await systemPrompt();
    expect(lineOf(prompt, '履歴のラーメン').startsWith(`- ${RECENT_DAY} 夜食: 履歴のラーメン (`)).toBe(true);
    expect(lineOf(prompt, '履歴のワッフル').startsWith(`- ${RECENT_DAY} brunch: 履歴のワッフル (`)).toBe(true);
  });
});

describe('AI 相談のシステムプロンプト — ニックネームに仮置きの Guest を名前として渡さない (#1649)', () => {
  it.each([
    ['Guest', '未設定'],
    [' Guest ', '未設定'],
    ['   ', '未設定'],
    ['', '未設定'],
    ['guest', 'guest'],
    [' 花子 ', '花子'],
  ])('user_profiles.nickname が %j なら「- ニックネーム: %s」', async (nickname, expected) => {
    h.single.user_profiles = { id: USER, nickname };

    const prompt = await systemPrompt();

    expect(prompt.split('\n')).toContain(`- ニックネーム: ${expected}`);
  });
});
