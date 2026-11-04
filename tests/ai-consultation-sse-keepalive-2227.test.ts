// @vitest-environment node
/**
 * #2227 H1 AI 相談の送信 (SSE) の route (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) の残りの縁 (回帰テスト)
 *
 * 1. 画面が切断したあとも返答の保存と自動実行を続ける (#2206 G2) が、直す前は ReadableStream の start() の中で続けるだけで、
 *    after() / waitUntil に載せていなかった。Vercel の文書は切断のあとの処理を保証せず、必ず終えたい処理は waitUntil か after に
 *    載せるよう求める (https://vercel.com/docs/functions/functions-api-reference の Cancel requests)。直したあとは、流れの処理が
 *    終わるまで解けない Promise を @vercel/functions の waitUntil に渡す
 * 2. SSE の 1 件を送るとき、JSON.stringify の例外 (BigInt・循環参照) まで切断として黙って捨て、ログも残らなかった。
 *    直したあとは、文にできない例外はログに残し、切断としては扱わない
 *
 * 差し替えるのは Supabase のクライアント・AI の呼び出し・ログ・waitUntil など外との境目だけ (route は本物を通す)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_LOG_ID = '99999999-9999-4999-8999-999999999991';
/** route が失敗のときに足す assistant の行の文 (route の errorContent と同じ) */
const ROUTE_ERROR_ROW_CONTENT = 'すみません、応答の生成中にエラーが発生しました。しばらく待ってから再度お試しください。';
/** AI の返答 (提案つき。route は自動で実行する) */
const AI_REPLY_TEXT = '卵を冷蔵庫に追加しますね。';
const AI_REPLY_WITH_ACTION = `${AI_REPLY_TEXT}\n\`\`\`action\n{"type":"add_pantry_item","params":{"name":"卵"}}\n\`\`\``;
/** route の終わり (成功・失敗のどちらか) を待つときの、1 回ぶんの「後の仕事」を流す回数 (insert・enqueue の後の約束を流しきる) */
const SETTLE_TICKS = 20;

type WriteOp = 'insert' | 'update' | 'upsert' | 'delete';

const h = vi.hoisted(() => ({
  /** 表ごとの select ... single() / maybeSingle() の結果 */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 表ごとの書き込み ... select().single() の結果 */
  written: {} as Record<string, Record<string, unknown>>,
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  /** 相談の updated_at の更新 (返答を保存した後) で投げるか */
  throwOnSessionUpdate: false,
  logError: vi.fn(),
  /** route が @vercel/functions の waitUntil に渡した Promise と、それが解けたか */
  keepAlives: [] as Array<{ settled: boolean }>,
  /** 自動実行の結果を差し替える (null なら本物の実行) */
  actionRunOverride: null as null | { success: boolean; result: unknown },
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

function makeQuery(table: string): unknown {
  let op: 'select' | WriteOp = 'select';
  const singleResult = () => {
    if (op === 'select') return { data: h.single[table] ?? null, error: null };
    return { data: h.written[table] ?? { id: `${table}-new` }, error: null };
  };
  const awaitedResult = () => {
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
            if (table === 'ai_consultation_sessions' && prop === 'update' && h.throwOnSessionUpdate) {
              throw new Error('session update failed (test)');
            }
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
    rpc: async (name: string) =>
      name === 'consume_ai_usage'
        ? { data: { allowed: true, metered: true, usage_date: '2026-11-04', limit: 10, used: 1 }, error: null }
        : { data: null, error: null },
  };
}

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
vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    const entry = { settled: false };
    h.keepAlives.push(entry);
    void promise.then(() => {
      entry.settled = true;
    });
  },
}));
vi.mock('@/lib/ai/consultation-action-executor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai/consultation-action-executor')>();
  return {
    ...original,
    runConsultationAction: (...args: Parameters<typeof original.runConsultationAction>) =>
      h.actionRunOverride ? Promise.resolve(h.actionRunOverride) : original.runConsultationAction(...args),
  };
});
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

// route はファイルの一番外側で 1 回だけ読む (テストの中で読むと、負荷の高い機械で既定の時間切れを超えうる。tests/heavy-unit-test-timeout.test.ts)。
// AI の呼び出し (fetch) は各テストで差し替える (route は呼ぶときに global の fetch を使う)
const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

beforeEach(() => {
  h.single = { ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' } };
  h.written = {
    ai_consultation_messages: { id: 'msg-1', content: '卵を追加して', created_at: '2026-11-04T00:00:00Z' },
    ai_action_logs: { id: ACTION_LOG_ID },
  };
  h.writes = [];
  h.throwOnSessionUpdate = false;
  h.logError.mockReset();
  h.keepAlives = [];
  h.actionRunOverride = null;
  h.llmCreate.mockClear();
  vi.unstubAllGlobals();
});

/** 外から開ける扉 (AI の流れの区切りを、テストが決めた時点まで止める) */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const encoder = new TextEncoder();
const deltaEvent = `data: ${JSON.stringify({ choices: [{ delta: { content: AI_REPLY_WITH_ACTION } }] })}\n\n`;

/**
 * AI (knowledge-gpt) の SSE を 2 段に分けて流す作り物。beforeDelta を開けると本文の断片を、beforeEnd を開けると [DONE] を流して閉じる
 */
function stubKnowledgeGpt(beforeDelta: Promise<void>, beforeEnd: Promise<void>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              await beforeDelta;
              controller.enqueue(encoder.encode(deltaEvent));
              await beforeEnd;
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    ),
  );
}

function messagesRequest() {
  return new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '卵を追加して' }),
  });
}

const insertsOf = (table: string) => h.writes.filter((w) => w.table === table && w.op === 'insert');
const assistantInserts = () =>
  insertsOf('ai_consultation_messages')
    .map((w) => w.payload as { role?: unknown; content?: unknown })
    .filter((payload) => payload.role === 'assistant');
const sessionUpdated = () => h.writes.some((w) => w.table === 'ai_consultation_sessions' && w.op === 'update');
const errorRowInserted = () => assistantInserts().some((payload) => payload.content === ROUTE_ERROR_ROW_CONTENT);

/** route の流れが終わる (相談の更新まで進んだか、失敗の行を足した) のを待ち、残りの後の仕事を流しきる */
async function waitForRouteToSettle(done: () => boolean = () => sessionUpdated() || errorRowInserted()) {
  await vi.waitFor(() => expect(done()).toBe(true), { timeout: 5_000, interval: 5 });
  for (let i = 0; i < SETTLE_TICKS; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 返答を保存し、提案を自動で実行した (冷蔵庫に追加した) こと */
function expectReplySavedAndActionExecuted() {
  expect(assistantInserts().map((payload) => payload.content)).toEqual([AI_REPLY_TEXT]);
  expect(insertsOf('pantry_items')).toHaveLength(1);
  const logUpdate = h.writes.filter((w) => w.table === 'ai_action_logs' && w.op === 'update').at(-1);
  expect(logUpdate?.payload).toMatchObject({ status: 'executed' });
}

/** 流れの処理が終わったら解ける Promise を waitUntil に 1 回だけ渡したか (渡した Promise が解けたか) */
function keepAliveSettled(): boolean {
  expect(h.keepAlives).toHaveLength(1);
  return h.keepAlives[0].settled;
}

/** ログに残した文 (createLogger(...).error の 1 つ目の引数) */
const loggedMessages = () => h.logError.mock.calls.map((call) => call[0]);
const STRINGIFY_FAILED_LOG = '相談の応答の SSE を文にできませんでした';

describe('#2227 H1 messages の route (SSE): 切断のあとの返答の保存と自動実行が終わるまで関数を止めさせない', () => {
  it('画面が切断しても、waitUntil に渡した Promise は返答の保存・自動実行・相談の更新が済むまで解けない', async () => {
    const beforeDelta = gate();
    const beforeEnd = gate();
    stubKnowledgeGpt(beforeDelta.wait, beforeEnd.wait);

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    expect(res.status).toBe(200);
    // 画面の時間切れ: 応答の本文を読むのをやめる (流れは cancel される。Vercel はここで応答を終えたとみなしうる)
    await res.body?.cancel();
    for (let i = 0; i < SETTLE_TICKS; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    // AI の返答はまだ届いていない: 関数を止めさせない
    expect(keepAliveSettled()).toBe(false);
    expect(assistantInserts()).toEqual([]);

    beforeDelta.open();
    beforeEnd.open();
    await waitForRouteToSettle();

    expectReplySavedAndActionExecuted();
    expect(sessionUpdated()).toBe(true);
    expect(keepAliveSettled()).toBe(true);
  });

  it('切断しないときも、流れを閉じたあとに Promise が解ける (関数を止めてよくなる)', async () => {
    const opened = gate();
    opened.open();
    stubKnowledgeGpt(opened.wait, opened.wait);

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    const raw = await res.text();
    for (let i = 0; i < SETTLE_TICKS; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(raw).toContain('"userMessage"');
    expect(keepAliveSettled()).toBe(true);
  });

  it('AI の呼び出しが失敗して失敗の行を足したときも、Promise が解ける (finally で止めてよくする)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream failed', { status: 502 })));

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    await res.text();
    for (let i = 0; i < SETTLE_TICKS; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorRowInserted()).toBe(true);
    expect(keepAliveSettled()).toBe(true);
  });
});

describe('#2227 H1 messages の route (SSE): 送る文にできない例外は切断として捨てずにログに残す', () => {
  it('finalData の自動実行の結果に BigInt が入って文にできないと、ログに残す (失敗の行は足さない・返答は保存済み)', async () => {
    h.actionRunOverride = { success: true, result: { count: BigInt(1) } };
    const opened = gate();
    opened.open();
    stubKnowledgeGpt(opened.wait, opened.wait);

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    const raw = await res.text();

    expect(loggedMessages()).toEqual([STRINGIFY_FAILED_LOG]);
    // 文にできなかった finalData だけ送らない (画面は finalData が欠けたときと同じく会話を取り直す)
    expect(raw).not.toContain('"userMessage"');
    expect(raw).toContain(AI_REPLY_TEXT);
    expect(errorRowInserted()).toBe(false);
    expect(assistantInserts().map((payload) => payload.content)).toEqual([AI_REPLY_TEXT]);
  });
});
