// @vitest-environment node
/**
 * #2189 W1-a AI 相談の提案 (ai_action_logs の行) の状態と、提案のカードを出すかを、本物の route を通して確かめる。
 *
 * 問題 (修正前):
 *   (1) 会話の続きの POST の SSE は、自動実行が成功しても提案 (aiMessage.proposedActions) を返し、カードが残った
 *       (押すと 404 で『アクションの実行に失敗しました』の alert)
 *   (2) GET は保存した提案をそのまま返し、相談を開き直すと実行済みの提案のカードがまた出た
 *   (3) 失敗した提案の行は failed になり、残したカードの「実行する」は 404 で、やり直せなかった
 *   (4) 自動実行で今日の AI の利用回数の上限に当たると failed (手の実行は pending のまま)
 *   (5) 自動実行の行を作れないと actionResult が null で、何も出なかった
 *
 * 直したあと (src/lib/ai/consultation-action-lifecycle.ts の決まり):
 *   - 行は実行中の印 (approved) で作る・実行の API は pending → approved を条件つきの 1 文で取ってから実行する
 *   - 成功は executed、上限は pending、失敗はやり直せる種類なら pending・献立の生成と対応していない種類は failed
 *   - SSE も JSON も、成功なら提案を返さない。残すときは「実行する」を出すか (proposedActionExecutable) も返す
 *   - GET は行の状態で決める (executed / rejected は返さない・pending は「実行する」・それ以外は案内)
 *
 * 差し替えるのは外との境目 (Supabase のクライアント・AI の呼び出し・ログ) と、実行の本体 runConsultationAction だけ
 * (実行の本体の振る舞いは tests/consultation-action-raw-error-text.test.ts などが確かめる)。
 * route はファイルの一番外側で 1 回だけ読み込む (収集のときに読むので、1 件のテストの時間切れに入らない。
 * tests/heavy-unit-test-timeout.test.ts の「同じ型」に当たらない書き方)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_LOG_ID = '33333333-3333-4333-8333-333333333333';
const AI_MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** 表ごとの select (await) の結果の行 */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 表ごとの書き込み ... select().single() / maybeSingle() の結果 (null なら行が返らない。キーが無ければ { id: '<表>-new' }) */
  written: {} as Record<string, Record<string, unknown> | null>,
  /** この表のこの操作は DB のエラーを返す */
  failOn: null as { table: string; op: string } | null,
  writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Array<[string, unknown]> }>,
  run: vi.fn(),
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
  logError: vi.fn(),
}));

function makeQuery(table: string): unknown {
  let op = 'select';
  let write: { table: string; op: string; payload: unknown; filters: Array<[string, unknown]> } | null = null;
  const failing = () => h.failOn !== null && h.failOn.table === table && h.failOn.op === op;
  const dbError = { message: 'db error', code: 'XX000' };
  const singleResult = () => {
    if (failing()) return { data: null, error: dbError };
    if (op === 'select') return { data: h.single[table] ?? null, error: null };
    const written = table in h.written ? h.written[table] : { id: `${table}-new` };
    return { data: written, error: null };
  };
  const awaitedResult = () => {
    if (failing()) return { data: null, error: dbError };
    if (op === 'select') return { data: h.rows[table] ?? [], error: null };
    return { data: null, error: null };
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
            op = String(prop);
            write = { table, op, payload, filters: [] };
            h.writes.push(write);
            return builder;
          };
        }
        if (prop === 'eq') {
          return (column: string, value: unknown) => {
            write?.filters.push([column, value]);
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
        ? { data: { allowed: true, metered: true, usage_date: '2026-11-01', limit: 10, used: 1 }, error: null }
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
vi.mock('@/lib/ai/consultation-action-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consultation-action-executor')>()),
  runConsultationAction: h.run,
}));

const { POST: executePOST } = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');
const messagesRoute = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');
const {
  AI_CONSULTATION_ACTION_LOG_INSERT_FAILED_MESSAGE,
  aiActionLogStatusAfterRun,
  proposedActionViewOf,
} = await import('@/lib/ai/consultation-action-lifecycle');
const { AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE } = await import('@/lib/ai/ai-api-messages');

beforeEach(() => {
  h.rows = {};
  h.single = {};
  h.written = {};
  h.failOn = null;
  h.writes = [];
  h.run.mockReset();
  h.logError.mockReset();
  h.llmCreate.mockClear();
  vi.unstubAllGlobals();
});

const DAILY_LIMIT_DENIED = { allowed: false as const, limit: 10, used: 10, usageDate: '2026-11-01' };
const ADD_PANTRY_FAILED = { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' } };
const GENERATE_FAILED = { success: false, result: { error: '献立生成の開始に失敗しました' } };

const actionLogWrites = () => h.writes.filter((w) => w.table === 'ai_action_logs');
const lastActionLogUpdate = () => actionLogWrites().filter((w) => w.op === 'update').at(-1);

// ─────────────────────────────────────────────
// 1. 決まりの関数
// ─────────────────────────────────────────────
describe('aiActionLogStatusAfterRun / proposedActionViewOf (#2189 W1-a)', () => {
  it.each([
    ['add_pantry_item', { success: true }, 'executed'],
    ['generate_single_meal', { success: true }, 'executed'],
    ['add_pantry_item', { success: false }, 'pending'],
    ['update_profile_preferences', { success: false }, 'pending'],
    ['generate_day_menu', { success: false }, 'failed'],
    ['generate_week_menu', { success: false }, 'failed'],
    ['generate_single_meal', { success: false }, 'failed'],
    ['generate_single_meal', { success: false, aiDailyLimit: DAILY_LIMIT_DENIED }, 'pending'],
    ['not_a_real_action', { success: false, unknownActionType: true }, 'failed'],
  ] as const)('%s %j → %s', (type, run, expected) => {
    expect(aiActionLogStatusAfterRun(type, run)).toBe(expected);
  });

  it.each([
    [['executed'], 'hidden'],
    [['rejected'], 'hidden'],
    [['pending'], 'executable'],
    [['failed'], 'notExecutable'],
    [['approved'], 'notExecutable'],
    [[], 'notExecutable'],
    [['failed', 'executed'], 'hidden'],
    [['failed', 'pending'], 'executable'],
  ] as const)('行の状態 %j → %s', (statuses, expected) => {
    expect(proposedActionViewOf(statuses)).toBe(expected);
  });
});

// ─────────────────────────────────────────────
// 2. 実行の API (POST /api/ai/consultation/actions/[actionId]/execute)
// ─────────────────────────────────────────────
function pendingLog(actionType: string): Row {
  return {
    id: ACTION_LOG_ID,
    action_type: actionType,
    action_params: {},
    status: 'pending',
    ai_consultation_sessions: { user_id: USER },
  };
}

async function execute() {
  const res = await executePOST(
    new Request(`http://localhost/api/ai/consultation/actions/${ACTION_LOG_ID}/execute`, { method: 'POST' }),
    { params: Promise.resolve({ actionId: ACTION_LOG_ID }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/ai/consultation/actions/[actionId]/execute (#2189 W1-a)', () => {
  it('実行の前に pending → approved を条件つきで取る (id と status=pending の 2 つの条件)', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockResolvedValueOnce({ success: true, result: { itemId: 'p1', created: true } });

    const { status, body } = await execute();

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, result: { itemId: 'p1', created: true }, actionType: 'add_pantry_item' });
    const [claim, finalize] = actionLogWrites();
    expect(claim).toMatchObject({ op: 'update', payload: { status: 'approved' } });
    expect(claim.filters).toEqual([
      ['id', ACTION_LOG_ID],
      ['status', 'pending'],
    ]);
    expect(finalize.payload).toMatchObject({ status: 'executed', result: { itemId: 'p1', created: true } });
    expect((finalize.payload as Row).executed_at).toEqual(expect.any(String));
  });

  it('取れなかった (別の画面が先に取った): 400 ALREADY_PROCESSED で、実行しない', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.written.ai_action_logs = null;

    const { status, body } = await execute();

    expect(status).toBe(400);
    expect(body.error).toBe(AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE);
    expect(h.run).not.toHaveBeenCalled();
    expect(actionLogWrites()).toHaveLength(1);
  });

  it('やり直せる種類の失敗: 行は pending に戻り (実行した日時は空)、retryable: true', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockResolvedValueOnce(ADD_PANTRY_FAILED);

    const { status, body } = await execute();

    expect(status).toBe(200);
    expect(body).toEqual({ ...ADD_PANTRY_FAILED, actionType: 'add_pantry_item', retryable: true });
    expect(lastActionLogUpdate()?.payload).toEqual({ status: 'pending', result: ADD_PANTRY_FAILED.result, executed_at: null });
  });

  it.each(['generate_day_menu', 'generate_week_menu', 'generate_single_meal'])(
    'やり直させない種類 (%s) の失敗: 行は failed、retryable: false',
    async (actionType) => {
      h.single.ai_action_logs = pendingLog(actionType);
      h.run.mockResolvedValueOnce(GENERATE_FAILED);

      const { status, body } = await execute();

      expect(status).toBe(200);
      expect(body).toEqual({ ...GENERATE_FAILED, actionType, retryable: false });
      expect(lastActionLogUpdate()?.payload).toMatchObject({ status: 'failed', result: GENERATE_FAILED.result });
    },
  );

  it('結果を書けなかった (行は実行中の印のまま): retryable: false', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      return ADD_PANTRY_FAILED;
    });

    const { body } = await execute();

    expect(body.retryable).toBe(false);
  });

  it('今日の上限: 429 で、行は pending に戻す (結果は書かない)', async () => {
    h.single.ai_action_logs = pendingLog('generate_single_meal');
    h.run.mockResolvedValueOnce({ success: false, result: { error: '上限' }, aiDailyLimit: DAILY_LIMIT_DENIED });

    const { status } = await execute();

    expect(status).toBe(429);
    expect(actionLogWrites().map((w) => w.payload)).toEqual([{ status: 'approved' }, { status: 'pending' }]);
  });

  it('対応していない種類: 400 で、行は failed (以前は pending のまま残り、何度押しても 400)', async () => {
    h.single.ai_action_logs = pendingLog('not_a_real_action');
    h.run.mockResolvedValueOnce({ success: false, result: null, unknownActionType: true });

    const { status } = await execute();

    expect(status).toBe(400);
    expect(lastActionLogUpdate()?.payload).toMatchObject({ status: 'failed' });
  });

  it.each([
    ['add_pantry_item', 'pending'],
    ['generate_week_menu', 'failed'],
  ])('実行の中で例外 (%s): 500 で、行は %s (実行中の印のまま残さない)', async (actionType, expected) => {
    h.single.ai_action_logs = pendingLog(actionType);
    h.run.mockRejectedValueOnce(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { status } = await execute();

    expect(status).toBe(500);
    expect(lastActionLogUpdate()?.payload).toMatchObject({ status: expected });
    consoleError.mockRestore();
  });

  it('pending でない行 (failed): 実行しない', async () => {
    h.single.ai_action_logs = { ...pendingLog('generate_single_meal'), status: 'failed' };

    const { status } = await execute();

    expect(status).toBe(400);
    expect(h.run).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 3. 会話の続きの POST の自動実行 (SSE と JSON)
// ─────────────────────────────────────────────
const ACTION_JSON = (type: string) => `\n\`\`\`action\n{"type":"${type}","params":{"name":"卵"}}\n\`\`\``;

function sessionRows() {
  h.single = { ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' } };
  h.written = {
    ai_consultation_messages: { id: AI_MESSAGE_ID, content: 'こんにちは', created_at: '2026-11-01T00:00:00Z' },
    ai_action_logs: { id: ACTION_LOG_ID },
  };
}

function stubAiReply(content: string, stream: boolean) {
  if (stream) {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new TextEncoder().encode(sse), { headers: { 'Content-Type': 'text/event-stream' } })),
    );
  } else {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content } }] })));
  }
}

/** 応答の最後のデータ (SSE は actionResult を持つ最後の事象、JSON は本文) */
async function postMessage(stream: boolean): Promise<Row> {
  const res = await messagesRoute.POST(
    new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages${stream ? '?stream=true' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '卵を追加して' }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  expect(res.status).toBe(200);
  const raw = await res.text();
  if (!stream) return JSON.parse(raw) as Row;
  const events = raw
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Row);
  const finalData = events.find((event) => 'actionResult' in event);
  expect(finalData).toBeDefined();
  return finalData!;
}

describe.each([
  ['SSE', true],
  ['JSON', false],
])('POST /api/ai/consultation/sessions/[sessionId]/messages の自動実行 (%s。#2189 W1-a)', (_label, stream) => {
  it('行は実行中の印 (approved) で作り、成功したら executed。提案は返さない (カードを出さない)', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockResolvedValueOnce({ success: true, result: { itemId: 'p1', created: true } });

    const data = await postMessage(stream);

    expect(actionLogWrites()[0]).toMatchObject({ op: 'insert', payload: { status: 'approved', action_type: 'add_pantry_item' } });
    expect(lastActionLogUpdate()?.payload).toMatchObject({ status: 'executed' });
    expect(data.actionResult).toEqual({ success: true, result: { itemId: 'p1', created: true }, actionType: 'add_pantry_item' });
    expect((data.aiMessage as Row).proposedActions).toBeNull();
    expect(data.aiMessage as Row).not.toHaveProperty('proposedActionExecutable');
  });

  it('やり直せる種類の失敗: 行は pending、提案を返し「実行する」を出す (proposedActionExecutable: true)', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockResolvedValueOnce(ADD_PANTRY_FAILED);

    const data = await postMessage(stream);

    expect(lastActionLogUpdate()?.payload).toEqual({ status: 'pending', result: ADD_PANTRY_FAILED.result, executed_at: null });
    expect(data.actionResult).toEqual({ ...ADD_PANTRY_FAILED, actionType: 'add_pantry_item' });
    expect(data.aiMessage).toMatchObject({
      proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
      proposedActionExecutable: true,
    });
  });

  it('献立の生成の失敗: 行は failed、提案は返すが「実行する」は出さない (proposedActionExecutable: false)', async () => {
    sessionRows();
    stubAiReply(`作りますね。${ACTION_JSON('generate_single_meal')}`, stream);
    h.run.mockResolvedValueOnce(GENERATE_FAILED);

    const data = await postMessage(stream);

    expect(lastActionLogUpdate()?.payload).toMatchObject({ status: 'failed' });
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: false });
  });

  it('今日の上限: 行は pending (手の実行と同じ。以前は failed)、「実行する」を出す', async () => {
    sessionRows();
    stubAiReply(`作りますね。${ACTION_JSON('generate_single_meal')}`, stream);
    h.run.mockResolvedValueOnce({ success: false, result: { error: '上限' }, aiDailyLimit: DAILY_LIMIT_DENIED });

    const data = await postMessage(stream);

    expect(lastActionLogUpdate()?.payload).toMatchObject({ status: 'pending', executed_at: null });
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: true });
  });

  it('行を作れなかった: 実行せず、actionResult に失敗の文を返す (以前は null で何も出なかった)。「実行する」は出さない', async () => {
    sessionRows();
    h.written.ai_action_logs = null;
    stubAiReply(`作りますね。${ACTION_JSON('generate_single_meal')}`, stream);

    const data = await postMessage(stream);

    expect(h.run).not.toHaveBeenCalled();
    expect(data.actionResult).toEqual({
      success: false,
      result: { error: AI_CONSULTATION_ACTION_LOG_INSERT_FAILED_MESSAGE },
      actionType: 'generate_single_meal',
    });
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: false });
    expect(h.logError).toHaveBeenCalledWith(
      'AI 相談の提案を記録できなかったため、自動実行しませんでした',
      expect.any(Error),
      expect.objectContaining({ action_type: 'generate_single_meal' }),
    );
  });
});

// ─────────────────────────────────────────────
// 4. 相談を開き直す (GET)
// ─────────────────────────────────────────────
async function getMessages() {
  const res = await messagesRoute.GET(new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`), {
    params: Promise.resolve({ sessionId: SESSION_ID }),
  });
  return { status: res.status, body: (await res.json()) as { messages?: Row[] } };
}

function messageRow(id: string, proposed: Row | null): Row {
  return { id, role: 'assistant', content: `メッセージ ${id}`, proposed_actions: proposed, created_at: '2026-11-01T00:00:00Z' };
}

const PROPOSED = { type: 'add_pantry_item', params: { name: '卵' } };

describe('GET /api/ai/consultation/sessions/[sessionId]/messages の提案 (#2189 W1-a)', () => {
  it('行の状態でカードを決める: executed / rejected は返さない・pending は「実行する」・failed / approved / 行が無いは案内', async () => {
    h.single.ai_consultation_sessions = { user_id: USER };
    h.rows.ai_consultation_messages = [
      messageRow('m-executed', PROPOSED),
      messageRow('m-rejected', PROPOSED),
      messageRow('m-pending', PROPOSED),
      messageRow('m-failed', PROPOSED),
      messageRow('m-running', PROPOSED),
      messageRow('m-no-log', PROPOSED),
      messageRow('m-plain', null),
    ];
    h.rows.ai_action_logs = [
      { message_id: 'm-executed', status: 'executed' },
      { message_id: 'm-rejected', status: 'rejected' },
      { message_id: 'm-pending', status: 'pending' },
      { message_id: 'm-failed', status: 'failed' },
      { message_id: 'm-running', status: 'approved' },
    ];

    const { status, body } = await getMessages();

    expect(status).toBe(200);
    const byId = new Map((body.messages ?? []).map((m) => [m.id, m]));
    expect(byId.get('m-executed')).toMatchObject({ proposedActions: null });
    expect(byId.get('m-executed')).not.toHaveProperty('proposedActionExecutable');
    expect(byId.get('m-rejected')).toMatchObject({ proposedActions: null });
    expect(byId.get('m-pending')).toMatchObject({ proposedActions: PROPOSED, proposedActionExecutable: true });
    expect(byId.get('m-failed')).toMatchObject({ proposedActions: PROPOSED, proposedActionExecutable: false });
    expect(byId.get('m-running')).toMatchObject({ proposedActions: PROPOSED, proposedActionExecutable: false });
    expect(byId.get('m-no-log')).toMatchObject({ proposedActions: PROPOSED, proposedActionExecutable: false });
    expect(byId.get('m-plain')).toMatchObject({ proposedActions: null });
  });

  it('行を読めなかった: 500 (提案を出すかを決められないので、黙って全部を出さない)', async () => {
    h.single.ai_consultation_sessions = { user_id: USER };
    h.rows.ai_consultation_messages = [messageRow('m-pending', PROPOSED)];
    h.failOn = { table: 'ai_action_logs', op: 'select' };

    const { status, body } = await getMessages();

    expect(status).toBe(500);
    expect(body.messages).toBeUndefined();
  });
});
