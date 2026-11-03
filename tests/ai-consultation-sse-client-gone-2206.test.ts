// @vitest-environment node
/**
 * #2206 G2 AI 相談の送信 (SSE) で、クライアントへの送出の失敗 (時間切れで画面が切断した) を AI の失敗として扱わない (回帰テスト)
 *
 * 修正前の messages の route (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) は、本文の断片・最後の finalData を
 * controller.enqueue でそのまま送っていた。画面が時間切れ (Web 28 秒・モバイル) で切断すると、閉じた流れへの enqueue が投げ、
 * その例外が catch に入って『すみません、応答の生成中にエラーが発生しました。しばらく待ってから再度お試しください。』を
 * assistant の行として足していた。返答の保存と自動実行 (献立の生成など) が済んだ後でも足すので、開き直すと実行済みの返答の後ろに
 * 頼み直しを勧める文が並び、頼み直すと二重に作りうる。
 * 修正後は、送出の失敗は印すだけにして返答の保存と自動実行を続け、返答を保存した後の例外では失敗の行を足さない。
 *
 * ここでは、route を通して画面の切断 (応答の本文の cancel) を起こし、失敗の行を足さないこと・返答の保存と自動実行が済むことを確かめる
 * (差し替えるのは Supabase のクライアント・AI の呼び出し・ログなど外との境目だけ)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えて落ちうる (tests/helpers/heavy-unit-test-timeout.ts)
applyHeavyUnitTestTimeout();

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
vi.mock('@/lib/health-streaks', () => ({ updateHealthStreak: vi.fn() }));

beforeEach(() => {
  h.single = { ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' } };
  h.written = {
    ai_consultation_messages: { id: 'msg-1', content: '卵を追加して', created_at: '2026-11-04T00:00:00Z' },
    ai_action_logs: { id: ACTION_LOG_ID },
  };
  h.writes = [];
  h.throwOnSessionUpdate = false;
  h.logError.mockReset();
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

describe('messages の route (SSE): クライアントへの送出の失敗を AI の失敗として扱わない (#2206 G2)', () => {
  it('本文の断片を送る前に画面が切断した: 返答を最後まで受け取って保存し、自動実行し、失敗の行を足さない', async () => {
    const beforeDelta = gate();
    const beforeEnd = gate();
    stubKnowledgeGpt(beforeDelta.wait, beforeEnd.wait);
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    expect(res.status).toBe(200);
    // 画面の時間切れ: 応答の本文を読むのをやめる (route の流れは cancel され、以後の enqueue は投げる)
    await res.body?.cancel();
    beforeDelta.open();
    beforeEnd.open();
    await waitForRouteToSettle();

    expect(errorRowInserted()).toBe(false);
    expectReplySavedAndActionExecuted();
    expect(sessionUpdated()).toBe(true);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('本文の断片を受け取った後、finalData の前に画面が切断した: 失敗の行を足さない (返答と自動実行は済んでいる)', async () => {
    const beforeDelta = gate();
    const beforeEnd = gate();
    stubKnowledgeGpt(beforeDelta.wait, beforeEnd.wait);
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('応答の本文が無い');
    beforeDelta.open();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(AI_REPLY_TEXT);
    // 断片を受け取った後に画面が切断した (finalData の enqueue が投げる)
    await reader.cancel();
    beforeEnd.open();
    await waitForRouteToSettle();

    expect(errorRowInserted()).toBe(false);
    expectReplySavedAndActionExecuted();
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('返答を保存した後の例外 (相談の更新が投げた): 失敗の行を足さない (画面は会話を取り直して保存済みの返答を出す)', async () => {
    h.throwOnSessionUpdate = true;
    const opened = gate();
    opened.open();
    stubKnowledgeGpt(opened.wait, opened.wait);
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    const raw = await res.text();

    expect(errorRowInserted()).toBe(false);
    expectReplySavedAndActionExecuted();
    // 例外はログに残す
    expect(h.logError).toHaveBeenCalledTimes(1);
    // finalData も失敗の行の応答も送らない (画面は finalData が無いので会話を取り直す)
    expect(raw).not.toContain('"userMessage"');
    expect(raw).not.toContain(ROUTE_ERROR_ROW_CONTENT);
  });

  it('AI の呼び出しの失敗 (返答を保存する前): 今までどおり失敗の行を足し、画面に失敗を送る', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream failed', { status: 502 })));
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    const raw = await res.text();

    expect(assistantInserts().map((payload) => payload.content)).toEqual([ROUTE_ERROR_ROW_CONTENT]);
    expect(raw).toContain(ROUTE_ERROR_ROW_CONTENT);
    expect(h.logError).toHaveBeenCalledTimes(1);
  });

  it('AI の呼び出しの失敗のあと画面が切断していても、失敗の行は足し、流れの片付けで投げない', async () => {
    const failed = gate();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await failed.wait;
        return new Response('upstream failed', { status: 502 });
      }),
    );
    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await POST(messagesRequest(), { params: { sessionId: SESSION_ID } });
    await res.body?.cancel();
    failed.open();
    await waitForRouteToSettle(errorRowInserted);

    expect(assistantInserts().map((payload) => payload.content)).toEqual([ROUTE_ERROR_ROW_CONTENT]);
    expect(h.logError).toHaveBeenCalledTimes(1);
  });
});
