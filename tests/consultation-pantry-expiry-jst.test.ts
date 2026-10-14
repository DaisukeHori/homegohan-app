// @vitest-environment node
/**
 * #1594: AI 相談のシステムプロンプトで、冷蔵庫の食材に付ける「⚠️期限間近!」の印を、日本の暦日で判定する。
 *
 * 期限 (pantry_items.expiration_date) は date 型の日本の暦日。プロンプトの今日 (buildSystemPrompt の today) も todayLocal (日本の暦日)。
 * 以前は期限を new Date(expiration_date) (その日の UTC の 0 時 = 日本の 9 時) にして「今から 3 日後の時刻」と比べていたので、
 * 3 日後が期限の食材は日本の 9:00 まで印が付かなかった (境目が 9 時間ずれていた)。
 * 印の範囲は以前と同じ「今日から 3 日後の期限まで。期限が過ぎたものも含む」。
 *
 * 時計 (Date だけ) を日本の 0:30 と 9:30 に固定し、どちらの時刻でも同じ印になることを、実際の route を通して確かめる
 * (差し替えるのは Supabase のクライアント・AI の呼び出しなど外との境目だけ。consultation-action-raw-error-text.test.ts と同じ形)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const EXPIRING_MARK = '⚠️期限間近!';

const h = vi.hoisted(() => ({
  /** 表ごとの select (await) の結果の行 */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 表ごとの書き込み ... select().single() の結果 (無ければ { id: '<表>-new' }) */
  written: {} as Record<string, Record<string, unknown>>,
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

/** Supabase のクエリの作り物。どのメソッドを繋いでも同じ作り物を返し、await / single() で結果を返す */
function makeQuery(table: string): unknown {
  let op: 'select' | 'write' = 'select';
  const singleResult = () =>
    op === 'select'
      ? { data: h.single[table] ?? null, error: null }
      : { data: h.written[table] ?? { id: `${table}-new` }, error: null };
  const awaitedResult = () =>
    op === 'select'
      ? { data: h.rows[table] ?? [], error: null, count: (h.rows[table] ?? []).length }
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
        return () => builder;
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
        ? { data: { allowed: true, metered: true, usage_date: '2026-10-14', limit: 10, used: 1 }, error: null }
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

/**
 * 時計 (Date) を固定する時刻。どちらも日本の暦日では 2026-10-14。
 *   - JST 0:30 : UTC では前日 (10-13) の 15:30。以前の判定では、3 日後 (10-17) が期限の食材に印が付かなかった
 *   - JST 9:30 : UTC でも同じ日 (10-14) の 0:30
 */
const CLOCKS = [
  { label: 'JST 0:30 (UTC の前日の 15:30)', at: '2026-10-13T15:30:00.000Z' },
  { label: 'JST 9:30 (UTC の同じ日の 0:30)', at: '2026-10-14T00:30:00.000Z' },
] as const;

/**
 * 食材と、印を付けるか。期限の日付は、日本の今日 (2026-10-14) から手で数えた固定値 (実装の関数で求めない)。
 * 印の範囲は今日から 3 日後の期限まで (期限が過ぎたものも含む)
 */
const CASES: ReadonlyArray<{ id: string; name: string; expirationDate: string | null; marked: boolean }> = [
  { id: 'pantry-yesterday', name: '昨日が期限の牛乳', expirationDate: '2026-10-13', marked: true },
  { id: 'pantry-today', name: '今日が期限の豆腐', expirationDate: '2026-10-14', marked: true },
  { id: 'pantry-threshold', name: '3日後が期限の卵', expirationDate: '2026-10-17', marked: true },
  { id: 'pantry-after-threshold', name: '4日後が期限のチーズ', expirationDate: '2026-10-18', marked: false },
  { id: 'pantry-no-date', name: '期限なしの塩', expirationDate: null, marked: false },
];

/** AI (knowledge-gpt) へ送った本文のシステムプロンプト */
let sentSystemPrompts: string[];

beforeEach(() => {
  sentSystemPrompts = [];
  h.single = { ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' } };
  h.written = {
    ai_consultation_messages: { id: 'msg-1', content: 'こんにちは', created_at: '2026-10-14T00:00:00Z' },
  };
  h.rows = {
    pantry_items: CASES.map((c) => ({
      id: c.id,
      name: c.name,
      amount: null,
      category: 'その他',
      expiration_date: c.expirationDate,
      added_at: '2026-10-01T00:00:00Z',
    })),
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
  vi.useRealTimers();
});

/** システムプロンプトの、その食材の行 (「- 名前 ...」) */
function pantryLineOf(prompt: string, name: string): string {
  const line = prompt.split('\n').find((l) => l.startsWith(`- ${name} `));
  expect(line, name).toBeDefined();
  return line!;
}

describe.each(CLOCKS)('AI 相談のシステムプロンプト — 冷蔵庫の「期限間近」の印は日本の暦日で判定する (#1594): $label', ({ at }) => {
  it('昨日・今日・3 日後 = 印あり / 4 日後・期限なし = 印なし', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at));
    expect(new Date().toISOString()).toBe(at);
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(
      new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '冷蔵庫の中身で何か作れる?' }),
      }),
      { params: { sessionId: SESSION_ID } },
    );

    expect(res.status).toBe(200);
    expect(sentSystemPrompts).toHaveLength(1);
    const prompt = sentSystemPrompts[0];
    const actual = CASES.map((c) => ({ id: c.id, marked: pantryLineOf(prompt, c.name).includes(EXPIRING_MARK) }));
    expect(actual).toEqual(CASES.map((c) => ({ id: c.id, marked: c.marked })));
  });
});
