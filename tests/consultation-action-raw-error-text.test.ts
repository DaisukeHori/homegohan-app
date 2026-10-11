// @vitest-environment node
/**
 * #1172 AI 相談のアクションの結果 (result) に、DB の生のエラー文を入れない (回帰テスト)
 *
 * 修正前の runConsultationAction (src/lib/ai/consultation-action-executor.ts) は、DB の書き込み・読み取りに失敗すると
 * `result = { error: insertError.message }` のように PostgREST の生のエラー文 (テーブル名・列名・制約名・衝突した値) を
 * result に入れていた。この result は次の 3 か所にそのまま入る:
 *   - POST /api/ai/consultation/actions/[actionId]/execute の本文 ({ success, result, actionType })
 *   - POST /api/ai/consultation/sessions/[sessionId]/messages の本文 (JSON の actionResult / SSE の finalData.actionResult)
 *   - ai_action_logs.result (保存した値)
 * 修正後は result.error を固定の文にし、元のエラーは構造化ログにだけ残す。
 *
 * ここでは、DB のエラー文に目印 (SENTINEL) を入れ、実際の executor と route を通して、どの本文・保存値にも目印が出ないことを確かめる
 * (executor は差し替えない。差し替えるのは Supabase のクライアント・AI の呼び出し・ログなど外との境目だけ)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
/** DB が返す生のエラー文の目印。どの応答の本文にも、保存する値にも出てはいけない */
const SENTINEL = 'duplicate key value violates unique constraint "pantry_items_sentinel_1172"';
const SENTINEL_DETAILS = 'Key (user_id, name)=(sentinel-details-1172) already exists.';
const SENTINEL_HINT = 'sentinel-hint-1172';
const SENTINEL_PG_CODE = '23505';

type Row = Record<string, unknown>;
type WriteOp = 'insert' | 'update' | 'upsert' | 'delete';

const h = vi.hoisted(() => ({
  /** この表のこの操作だけ、目印入りの DB エラーを返す */
  failOn: null as { table: string; op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' } | null,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 表ごとの書き込み ... select().single() の結果 (無ければ { id: '<表>-new' }) */
  written: {} as Record<string, Record<string, unknown>>,
  /** 書き込みの記録 */
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  logError: vi.fn(),
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

function dbError() {
  return { message: SENTINEL, details: SENTINEL_DETAILS, hint: SENTINEL_HINT, code: SENTINEL_PG_CODE };
}

/** Supabase のクエリの作り物。どのメソッドを繋いでも同じ作り物を返し、await / single() で結果を返す */
function makeQuery(table: string): unknown {
  let op: 'select' | WriteOp = 'select';
  const failing = () => h.failOn !== null && h.failOn.table === table && h.failOn.op === op;
  const singleResult = () => {
    if (failing()) return { data: null, error: dbError() };
    if (op === 'select') return { data: h.single[table] ?? null, error: null };
    return { data: h.written[table] ?? { id: `${table}-new` }, error: null };
  };
  const awaitedResult = () => {
    if (failing()) return { data: null, error: dbError(), count: null };
    if (op === 'select') return { data: [], error: null, count: 0 };
    return { data: null, error: null, count: null };
  };
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
          return (payload: unknown) => {
            op = prop;
            h.writes.push({ table, op: prop, payload });
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
    rpc: async () => ({ data: null, error: null }),
  };
}

// ── 外との境目だけ差し替える ─────────────────────────────────────────
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabase()),
  getSupabaseAdmin: vi.fn(() => makeSupabase()),
}));
vi.mock('@/lib/db-logger', async (importOriginal) => {
  const logger: Record<string, unknown> = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => h.logError(...args),
  };
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
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  invokeGenerateMenuV4WithRetry: vi.fn(),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));
vi.mock('@/lib/v4-target-slots', () => ({ resolveExistingTargetSlots: vi.fn() }));
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

const { runConsultationAction } = await import('@/lib/ai/consultation-action-executor');

beforeEach(() => {
  h.failOn = null;
  h.single = {};
  h.written = {};
  h.writes = [];
  h.logError.mockReset();
  h.llmCreate.mockClear();
  vi.unstubAllGlobals();
});

/** 本文・保存値のどこにも、DB の生のエラー文 (message / details / hint) が無いこと */
function expectNoRawDbText(text: string) {
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain(SENTINEL_DETAILS);
  expect(text).not.toContain(SENTINEL_HINT);
}

/** 構造化ログに、元のエラー (目印) と、どのアクション・どの操作かが残っていること */
function expectLoggedDbFailure(actionType: string, operation: string) {
  expect(h.logError).toHaveBeenCalledTimes(1);
  const [message, error, metadata] = h.logError.mock.calls[0] as [string, Error, Row];
  expect(message).toBe('AI 相談のアクションの DB 操作に失敗しました');
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe(SENTINEL);
  expect(metadata).toMatchObject({ action_type: actionType, operation, error_code: SENTINEL_PG_CODE });
}

// ── 1. executor: DB に失敗する 7 か所を表で全部 ─────────────────────────────
interface DbFailureCase {
  actionType: string;
  params: Row;
  failOn: NonNullable<typeof h.failOn>;
  /** 失敗の前に読む行 (所有者の確認など) */
  single?: Record<string, Row>;
  operation: string;
  expectedError: string;
}

const PLANNED_MEAL_OWNED = { id: 'meal-1', dish_name: '前の料理', dishes: [], image_url: null, user_daily_meals: { user_id: USER } };
const PANTRY_ITEM_OWNED = { user_id: USER };

const DB_FAILURE_CASES: DbFailureCase[] = [
  {
    actionType: 'update_meal',
    params: { mealId: 'meal-1', updates: { dish_name: '新しい料理' } },
    failOn: { table: 'planned_meals', op: 'select' },
    operation: 'planned_meals.select',
    expectedError: '食事の取得に失敗しました',
  },
  {
    actionType: 'update_meal',
    params: { mealId: 'meal-1', updates: { dish_name: '新しい料理' } },
    failOn: { table: 'planned_meals', op: 'update' },
    single: { planned_meals: PLANNED_MEAL_OWNED },
    operation: 'planned_meals.update',
    expectedError: '食事の更新に失敗しました',
  },
  {
    actionType: 'add_pantry_item',
    params: { name: '卵', amount: '6個' },
    failOn: { table: 'pantry_items', op: 'insert' },
    operation: 'pantry_items.insert',
    expectedError: '冷蔵庫の食材の追加に失敗しました',
  },
  {
    actionType: 'update_pantry_item',
    params: { itemId: 'pantry-1', updates: { name: '卵' } },
    failOn: { table: 'pantry_items', op: 'update' },
    single: { pantry_items: PANTRY_ITEM_OWNED },
    operation: 'pantry_items.update',
    expectedError: '冷蔵庫の食材の更新に失敗しました',
  },
  {
    actionType: 'delete_pantry_item',
    params: { itemId: 'pantry-1' },
    failOn: { table: 'pantry_items', op: 'delete' },
    single: { pantry_items: PANTRY_ITEM_OWNED },
    operation: 'pantry_items.delete',
    expectedError: '冷蔵庫の食材の削除に失敗しました',
  },
  {
    actionType: 'set_health_goal',
    params: { goalType: 'weight', targetValue: 60, targetUnit: 'kg' },
    failOn: { table: 'health_goals', op: 'insert' },
    operation: 'health_goals.insert',
    expectedError: '健康目標の保存に失敗しました',
  },
  {
    actionType: 'add_health_record',
    params: { weight: 60 },
    failOn: { table: 'health_records', op: 'upsert' },
    operation: 'health_records.upsert',
    expectedError: '健康記録の保存に失敗しました',
  },
];

describe('runConsultationAction: DB の失敗は固定の文で返し、元のエラーはログにだけ残す (#1172)', () => {
  it.each(DB_FAILURE_CASES)(
    '$actionType ($operation が失敗): result.error は「$expectedError」',
    async ({ actionType, params, failOn, single, operation, expectedError }) => {
      h.failOn = failOn;
      h.single = { ...(single ?? {}) };

      const out = await runConsultationAction(makeSupabase(), { id: USER }, {
        id: 'action-1',
        action_type: actionType,
        action_params: params,
        ai_consultation_sessions: { user_id: USER },
      });

      expect(out.success).toBe(false);
      expect(out.result).toEqual({ error: expectedError });
      expectNoRawDbText(JSON.stringify(out));
      expectLoggedDbFailure(actionType, operation);
    },
  );
});

// ── 2. execute route: 本文と ai_action_logs.result に出ない ────────────────────
describe('POST /api/ai/consultation/actions/[actionId]/execute (#1172)', () => {
  it('アクションの DB 操作が失敗しても、本文の result と ai_action_logs.result に DB の生のエラー文が無い', async () => {
    h.failOn = { table: 'pantry_items', op: 'insert' };
    h.single = {
      ai_action_logs: {
        id: 'log-1',
        action_type: 'add_pantry_item',
        action_params: { name: '卵' },
        status: 'pending',
        ai_consultation_sessions: { user_id: USER },
      },
    };
    const { POST } = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');

    const res = await POST(new Request('http://localhost/api/ai/consultation/actions/log-1/execute', { method: 'POST' }), {
      params: { actionId: 'log-1' },
    });

    expect(res.status).toBe(200);
    const raw = await res.text();
    expectNoRawDbText(raw);
    expect(JSON.parse(raw)).toEqual({
      success: false,
      result: { error: '冷蔵庫の食材の追加に失敗しました' },
      actionType: 'add_pantry_item',
    });

    const logUpdate = h.writes.find((w) => w.table === 'ai_action_logs' && w.op === 'update');
    expect(logUpdate?.payload).toMatchObject({ status: 'failed', result: { error: '冷蔵庫の食材の追加に失敗しました' } });
    expectNoRawDbText(JSON.stringify(logUpdate?.payload));
    expectLoggedDbFailure('add_pantry_item', 'pantry_items.insert');
  });
});

// ── 3. messages route: 自動実行の actionResult (JSON / SSE) に出ない ───────────────
const AI_REPLY_WITH_ACTION = '卵を冷蔵庫に追加しますね。\n```action\n{"type":"add_pantry_item","params":{"name":"卵"}}\n```';

function sessionAndMessageRows() {
  h.single = { ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' } };
  h.written = {
    ai_consultation_messages: { id: 'msg-1', content: 'こんにちは', created_at: '2026-10-10T00:00:00Z' },
    ai_action_logs: { id: 'log-1' },
  };
}

function messagesRequest(stream: boolean) {
  const query = stream ? '?stream=true' : '';
  return new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '卵を追加して' }),
  });
}

describe('POST /api/ai/consultation/sessions/[sessionId]/messages の自動実行 (#1172)', () => {
  it('JSON (stream なし): actionResult.result に DB の生のエラー文が無い', async () => {
    h.failOn = { table: 'pantry_items', op: 'insert' };
    sessionAndMessageRows();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ choices: [{ message: { content: AI_REPLY_WITH_ACTION } }] })),
    );
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(false), { params: { sessionId: SESSION_ID } });

    expect(res.status).toBe(200);
    const raw = await res.text();
    expectNoRawDbText(raw);
    const json = JSON.parse(raw) as { actionExecuted: boolean; actionResult: unknown };
    expect(json.actionExecuted).toBe(false);
    expect(json.actionResult).toEqual({ success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' } });
    const logUpdate = h.writes.find((w) => w.table === 'ai_action_logs' && w.op === 'update');
    expectNoRawDbText(JSON.stringify(logUpdate?.payload));
    expectLoggedDbFailure('add_pantry_item', 'pantry_items.insert');
  });

  it('SSE (stream=true): 最後の finalData.actionResult.result に DB の生のエラー文が無い', async () => {
    h.failOn = { table: 'pantry_items', op: 'insert' };
    sessionAndMessageRows();
    const encoder = new TextEncoder();
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: AI_REPLY_WITH_ACTION } }] })}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(sse));
                controller.close();
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(true), { params: { sessionId: SESSION_ID } });

    expect(res.status).toBe(200);
    const raw = await res.text();
    expectNoRawDbText(raw);
    const events = raw
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
    const finalData = events.find((event) => 'actionResult' in event);
    expect(finalData?.actionResult).toEqual({ success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' } });
    expectLoggedDbFailure('add_pantry_item', 'pantry_items.insert');
  });
});
