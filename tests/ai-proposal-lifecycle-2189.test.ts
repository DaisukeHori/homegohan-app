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
  /** failOn の失敗を返す残りの回数 (null は何回でも。#2195 V2 の書き直しを確かめる) */
  failLeft: null as number | null,
  writes: [] as Array<{ table: string; op: string; payload: unknown; filters: Array<[string, unknown]> }>,
  /** 書き込みでない問い合わせ (select) の表と eq の条件 (発行順) */
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  run: vi.fn(),
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
  logError: vi.fn(),
}));

function makeQuery(table: string): unknown {
  let op = 'select';
  let write: { table: string; op: string; payload: unknown; filters: Array<[string, unknown]> } | null = null;
  const read = { table, filters: [] as Array<[string, unknown]> };
  h.reads.push(read);
  const failing = () => {
    if (h.failOn === null || h.failOn.table !== table || h.failOn.op !== op) return false;
    if (h.failLeft === null) return true;
    if (h.failLeft <= 0) return false;
    h.failLeft -= 1;
    return true;
  };
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
            (write ?? read).filters.push([column, value]);
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
  h.failLeft = null;
  h.writes = [];
  h.reads = [];
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
    // 実行中の印のまま (実行中か、書き戻せなかった) は「実行できたかを確かめられない」(#2201 U3)
    [['approved'], 'unconfirmed'],
    [['failed', 'approved'], 'unconfirmed'],
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
      expect(body).toEqual({ ...GENERATE_FAILED, actionType, retryable: false, notExecutableReason: 'failed' });
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
    expect(byId.get('m-pending')).not.toHaveProperty('proposedActionNotExecutableReason');
    // 「実行する」を出さない理由 (#2195 V2): 実行中の印のまま (実行中か、書き戻せなかった) は unconfirmed (#2201 U3)、
    // 失敗・行が無いは failed
    expect(byId.get('m-failed')).toMatchObject({
      proposedActions: PROPOSED,
      proposedActionExecutable: false,
      proposedActionNotExecutableReason: 'failed',
    });
    expect(byId.get('m-running')).toMatchObject({
      proposedActions: PROPOSED,
      proposedActionExecutable: false,
      proposedActionNotExecutableReason: 'unconfirmed',
    });
    expect(byId.get('m-no-log')).toMatchObject({
      proposedActions: PROPOSED,
      proposedActionExecutable: false,
      proposedActionNotExecutableReason: 'failed',
    });
    expect(byId.get('m-executed')).not.toHaveProperty('proposedActionNotExecutableReason');
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

// ═════════════════════════════════════════════
// #2195 V2 提案のカードの残りの縁・やり直しても直らない失敗
//   (a) 実行の中の例外の 500 に retryable を添える (献立の生成・戻せなかったときは false)
//   (b) 実行のあとの書き戻しは 1 回だけ書き直す (src/lib/ai/consultation-action-log-writes.ts)
//   (c) 「実行する」を出さない理由 (failed / runningOrDone / unconfirmed (#2201 U3)) を添え、画面は案内の文を分ける
//   (d) 上限の分岐で pending に戻せなかったら retryable: false
//   (e) 会話の続きの POST の自動実行の例外・書き戻しの失敗の経路
//   やり直しても直らない失敗 (実行の結果の notRetryable) は failed
// ═════════════════════════════════════════════
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const RUNNING_OR_DONE_GUIDE_TEXT = 'この提案は実行中か実行済みです。';
const UNCONFIRMED_GUIDE_TEXT = 'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';
const NOT_EXECUTABLE_GUIDE_TEXT = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';
const WRITE_BACK_FAILED_LOG = 'AI 相談の提案の行を実行のあとに書き戻せませんでした (実行中の印のまま残ります)';
const PANTRY_NOT_RETRYABLE = { success: false, result: { error: '権限がありません' }, notRetryable: true };

const lifecycle = await import('@/lib/ai/consultation-action-lifecycle');
const { AI_ACTION_LOG_WRITE_BACK_ATTEMPTS } = await import('@/lib/ai/consultation-action-log-writes');

describe('#2195 V2 決まりの関数', () => {
  it.each([
    ['add_pantry_item', { success: false, notRetryable: true }, 'failed'],
    ['update_meal', { success: false, notRetryable: true }, 'failed'],
    ['add_pantry_item', { success: false, notRetryable: false }, 'pending'],
    ['add_pantry_item', { success: true, notRetryable: true }, 'executed'],
    ['generate_single_meal', { success: false, aiDailyLimit: DAILY_LIMIT_DENIED, notRetryable: true }, 'pending'],
  ] as const)('%s %j → %s', (type, run, expected) => {
    expect(aiActionLogStatusAfterRun(type, run)).toBe(expected);
  });

  it.each([
    ['hidden', null],
    ['executable', null],
    ['notExecutable', 'failed'],
    ['unconfirmed', 'unconfirmed'],
  ] as const)('カードの出し方 %s → 理由 %s', (view, expected) => {
    expect(lifecycle.proposedActionNotExecutableReasonOfView(view)).toBe(expected);
  });

  it.each([
    ['approved', 'unconfirmed'],
    ['executed', 'runningOrDone'],
    ['failed', 'failed'],
    ['rejected', 'failed'],
    ['pending', 'failed'],
    [null, 'failed'],
  ] as const)('行の状態 %s → 理由 %s', (status, expected) => {
    expect(lifecycle.proposedActionNotExecutableReasonOfStatus(status)).toBe(expected);
  });

  it.each([
    ['failed', true],
    ['runningOrDone', true],
    ['unconfirmed', true],
    ['running', false],
    ['', false],
    [undefined, false],
    [1, false],
  ] as const)('理由として読めるか %j → %s', (value, expected) => {
    expect(lifecycle.isProposedActionNotExecutableReason(value)).toBe(expected);
  });

  it('案内の文は理由で分ける (実行中・実行済みは頼み直しを勧めない。理由が分からなければ頼み直しの案内)', () => {
    expect(lifecycle.AI_PROPOSED_ACTION_RUNNING_OR_DONE_GUIDE).toBe(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(lifecycle.aiProposedActionNotExecutableGuideOf('runningOrDone')).toBe(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(lifecycle.aiProposedActionNotExecutableGuideOf('failed')).toBe(NOT_EXECUTABLE_GUIDE_TEXT);
    expect(lifecycle.aiProposedActionNotExecutableGuideOf(undefined)).toBe(NOT_EXECUTABLE_GUIDE_TEXT);
    expect(RUNNING_OR_DONE_GUIDE_TEXT).not.toContain('頼んで');
  });

  it('#2201 U3 行が実行中の印のまま (書き戻せなかった) の案内は、実行したとも言い切らず、頼み直しも勧めない', () => {
    expect(lifecycle.AI_PROPOSED_ACTION_UNCONFIRMED_GUIDE).toBe(UNCONFIRMED_GUIDE_TEXT);
    expect(lifecycle.aiProposedActionNotExecutableGuideOf('unconfirmed')).toBe(UNCONFIRMED_GUIDE_TEXT);
    expect(UNCONFIRMED_GUIDE_TEXT).not.toContain('頼んで');
    expect(UNCONFIRMED_GUIDE_TEXT).not.toContain('実行済み');
    expect(UNCONFIRMED_GUIDE_TEXT).not.toContain('実行しました');
  });

  it.each([
    [true, 'unconfirmed'],
    [false, 'failed'],
  ] as const)('#2201 U3 実行のあとの理由: 書き戻せなかった %s → %s', (writeBackFailed, expected) => {
    expect(lifecycle.notExecutableReasonAfterRun(writeBackFailed)).toBe(expected);
  });

  it.each([
    [[], null],
    [['executed', 'approved'], 'runningOrDone'],
    [['approved', 'failed'], 'unconfirmed'],
    [['failed', 'rejected'], 'failed'],
  ] as const)('#2201 U3 1 つのメッセージの行たち %j → 理由 %s', (statuses, expected) => {
    expect(lifecycle.proposedActionNotExecutableReasonOfStatuses(statuses)).toBe(expected);
  });

  it('書き戻しを試す回数は 1 回目 + やり直し 1 回', () => {
    expect(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS).toBe(2);
  });
});

/** claim のあとの ai_action_logs の update (書き戻し) */
const writeBacks = () => actionLogWrites().filter((w) => w.op === 'update').slice(1);

describe('#2195 V2 実行の API (POST /api/ai/consultation/actions/[actionId]/execute)', () => {
  it('(a) 実行の中の例外・やり直せる種類: 500 に retryable: true (理由は添えない)、行は pending に戻す', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockRejectedValueOnce(new Error('boom'));

    const { status, body } = await execute();

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    expect(body).not.toHaveProperty('notExecutableReason');
    expect(writeBacks().map((w) => w.payload)).toEqual([{ status: 'pending', executed_at: null }]);
  });

  it.each(['generate_day_menu', 'generate_week_menu', 'generate_single_meal'])(
    '(a) 実行の中の例外・献立の生成 (%s): 500 に retryable: false と理由 failed (以前は「実行する」が残り、押すと 400 になった)',
    async (actionType) => {
      h.single.ai_action_logs = pendingLog(actionType);
      h.run.mockRejectedValueOnce(new Error('boom'));

      const { status, body } = await execute();

      expect(status).toBe(500);
      expect(body).toMatchObject({ code: 'INTERNAL_ERROR', retryable: false, notExecutableReason: 'failed' });
      expect(writeBacks().map((w) => (w.payload as Row).status)).toEqual(['failed']);
    },
  );

  it('(a)(b) 実行の中の例外のあと、行を戻せなかった (2 回とも失敗): retryable: false と理由 unconfirmed (開き直したときと同じ。#2201 U3)', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      throw new Error('boom');
    });

    const { status, body } = await execute();

    expect(status).toBe(500);
    expect(body).toMatchObject({ retryable: false, notExecutableReason: 'unconfirmed' });
    expect(writeBacks()).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
    expect(h.logError).toHaveBeenCalledWith(
      WRITE_BACK_FAILED_LOG,
      expect.any(Error),
      expect.objectContaining({ action_id: ACTION_LOG_ID, action_type: 'add_pantry_item', status: 'pending', attempts: 2 }),
    );
  });

  it('(b) 成功のあとの書き戻しが 1 回失敗: もう 1 回書いて executed にする (ログは残さない)', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      h.failLeft = 1;
      return { success: true, result: { itemId: 'p1', created: true } };
    });

    const { status, body } = await execute();

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, result: { itemId: 'p1', created: true }, actionType: 'add_pantry_item' });
    const backs = writeBacks();
    expect(backs).toHaveLength(2);
    expect(backs[0].payload).toEqual(backs[1].payload);
    expect(backs[1].payload).toMatchObject({ status: 'executed', result: { itemId: 'p1', created: true } });
    // 書き戻しは行が実行中の印 (approved) のときだけ書く条件つきの更新 (#2295。2 回目が、その間に別の操作が進めた行を上書きしない)
    expect(backs[0].filters).toEqual([['id', ACTION_LOG_ID], ['status', 'approved']]);
    expect(backs[1].filters).toEqual([['id', ACTION_LOG_ID], ['status', 'approved']]);
    expect(h.logError).not.toHaveBeenCalledWith(WRITE_BACK_FAILED_LOG, expect.anything(), expect.anything());
  });

  it('(b) 失敗のあとの書き戻しが 1 回失敗: もう 1 回書けたら retryable: true', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      h.failLeft = 1;
      return ADD_PANTRY_FAILED;
    });

    const { body } = await execute();

    expect(body).toEqual({ ...ADD_PANTRY_FAILED, actionType: 'add_pantry_item', retryable: true });
    expect(writeBacks()).toHaveLength(2);
  });

  it('(b) 書き戻しが 2 回とも失敗: retryable: false と理由 unconfirmed (開き直したときと同じ。#2201 U3)、ログに残す', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      return ADD_PANTRY_FAILED;
    });

    const { body } = await execute();

    expect(body).toMatchObject({ retryable: false, notExecutableReason: 'unconfirmed' });
    expect(writeBacks()).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
    expect(h.logError).toHaveBeenCalledWith(WRITE_BACK_FAILED_LOG, expect.any(Error), expect.objectContaining({ status: 'pending' }));
  });

  it('(d) 今日の上限で pending に戻せた: 429 の本文は上限の本文のまま (retryable を添えない)', async () => {
    h.single.ai_action_logs = pendingLog('generate_single_meal');
    h.run.mockResolvedValueOnce({ success: false, result: { error: '上限' }, aiDailyLimit: DAILY_LIMIT_DENIED });

    const { status, body } = await execute();

    expect(status).toBe(429);
    expect(body).toMatchObject({ code: 'AI_DAILY_LIMIT' });
    expect(body).not.toHaveProperty('retryable');
  });

  it('(d) 今日の上限で pending に戻せなかった: 429 に retryable: false と理由 unconfirmed を添える (Retry-After も残す。#2201 U3)', async () => {
    h.single.ai_action_logs = pendingLog('generate_single_meal');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      return { success: false, result: { error: '上限' }, aiDailyLimit: DAILY_LIMIT_DENIED };
    });

    const res = await executePOST(
      new Request(`http://localhost/api/ai/consultation/actions/${ACTION_LOG_ID}/execute`, { method: 'POST' }),
      { params: Promise.resolve({ actionId: ACTION_LOG_ID }) },
    );
    const body = (await res.json()) as Row;

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toEqual(expect.stringMatching(/^\d+$/));
    expect(body).toMatchObject({ code: 'AI_DAILY_LIMIT', retryable: false, notExecutableReason: 'unconfirmed' });
    expect(writeBacks()).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
  });

  it('やり直しても直らない失敗 (notRetryable): 行は failed、retryable: false と理由 failed', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.run.mockResolvedValueOnce(PANTRY_NOT_RETRYABLE);

    const { status, body } = await execute();

    expect(status).toBe(200);
    expect(body).toEqual({
      success: false,
      result: PANTRY_NOT_RETRYABLE.result,
      actionType: 'add_pantry_item',
      retryable: false,
      notExecutableReason: 'failed',
    });
    expect(lastActionLogUpdate()?.payload).toMatchObject({ status: 'failed', result: PANTRY_NOT_RETRYABLE.result });
  });

  it('(c) 取れなかった (別の画面・自動実行が先に取った): 400 に理由 runningOrDone', async () => {
    h.single.ai_action_logs = pendingLog('add_pantry_item');
    h.written.ai_action_logs = null;

    const { status, body } = await execute();

    expect(status).toBe(400);
    expect(body).toEqual({ error: AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, notExecutableReason: 'runningOrDone' });
  });

  it.each([
    ['approved', 'unconfirmed'],
    ['executed', 'runningOrDone'],
    ['failed', 'failed'],
    ['rejected', 'failed'],
  ])('(c) 行 ID で読んだ行が pending でない (%s): 400 に理由 %s', async (rowStatus, reason) => {
    h.single.ai_action_logs = { ...pendingLog('add_pantry_item'), status: rowStatus };

    const { status, body } = await execute();

    expect(status).toBe(400);
    expect(body).toEqual({ error: AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE, notExecutableReason: reason });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('(c) 対応していない種類: 400 に理由 failed', async () => {
    h.single.ai_action_logs = pendingLog('not_a_real_action');
    h.run.mockResolvedValueOnce({ success: false, result: null, unknownActionType: true });

    const { status, body } = await execute();

    expect(status).toBe(400);
    expect(body).toMatchObject({ notExecutableReason: 'failed' });
  });

  it('(c) 対応していない種類で、行を書き戻せなかった: 400 に理由 unconfirmed (開き直したときと同じ。#2201 U3)', async () => {
    h.single.ai_action_logs = pendingLog('not_a_real_action');
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      return { success: false, result: null, unknownActionType: true };
    });

    const { status, body } = await execute();

    expect(status).toBe(400);
    expect(body).toMatchObject({ notExecutableReason: 'unconfirmed' });
    expect(writeBacks()).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
  });

  describe('(c) メッセージ ID で pending の行が無い (Web のカードは メッセージ ID で呼ぶ)', () => {
    it.each([
      [['approved'], 'unconfirmed'],
      [['executed'], 'runningOrDone'],
      [['failed', 'approved'], 'unconfirmed'],
      [['approved', 'executed'], 'runningOrDone'],
      [['failed'], 'failed'],
      [['rejected'], 'failed'],
    ] as const)('そのメッセージの行 %j: 404 に理由 %s', async (statuses, reason) => {
      h.single.ai_action_logs = null;
      h.rows.ai_action_logs = statuses.map((status) => ({ status, ai_consultation_sessions: { user_id: USER } }));

      const { status, body } = await execute();

      expect(status).toBe(404);
      expect(body).toEqual({ error: '提案された操作が見つかりません', notExecutableReason: reason });
      // 理由は、そのメッセージの自分の相談の行だけから決める (ほかの人の行の有無は返さない)
      const reasonLookup = h.reads.filter((r) => r.table === 'ai_action_logs').at(-1);
      expect(reasonLookup?.filters).toEqual([
        ['message_id', ACTION_LOG_ID],
        ['ai_consultation_sessions.user_id', USER],
      ]);
    });

    it('そのメッセージの行が無い: 404 に理由を添えない (画面は頼み直しの案内)', async () => {
      h.single.ai_action_logs = null;
      h.rows.ai_action_logs = [];

      const { status, body } = await execute();

      expect(status).toBe(404);
      expect(body).toEqual({ error: '提案された操作が見つかりません' });
    });
  });
});

describe.each([
  ['SSE', true],
  ['JSON', false],
])('#2195 V2 (e) 会話の続きの POST の自動実行の例外・書き戻しの失敗 (%s)', (_label, stream) => {
  it('実行の中の例外・やり直せる種類: 行は pending に戻り、「実行する」を出す (理由は添えない)', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockRejectedValueOnce(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const data = await postMessage(stream);

    consoleError.mockRestore();
    expect(writeBacksOfAuto().map((w) => w.payload)).toEqual([{ status: 'pending', executed_at: null }]);
    expect(data.actionResult).toEqual({ success: false, result: null, actionType: 'add_pantry_item' });
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: true });
    expect(data.aiMessage as Row).not.toHaveProperty('proposedActionNotExecutableReason');
  });

  it('実行の中の例外・献立の生成: 行は failed、「実行する」を出さず理由 failed', async () => {
    sessionRows();
    stubAiReply(`作りますね。${ACTION_JSON('generate_single_meal')}`, stream);
    h.run.mockRejectedValueOnce(new Error('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const data = await postMessage(stream);

    consoleError.mockRestore();
    expect(writeBacksOfAuto().map((w) => (w.payload as Row).status)).toEqual(['failed']);
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: false, proposedActionNotExecutableReason: 'failed' });
  });

  it('実行の中の例外のあと、行を戻せなかった: 「実行する」を出さず理由 unconfirmed (開き直したときと同じ。#2201 U3)', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      throw new Error('boom');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const data = await postMessage(stream);

    consoleError.mockRestore();
    expect(writeBacksOfAuto()).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: false, proposedActionNotExecutableReason: 'unconfirmed' });
  });

  it('失敗のあとの書き戻しが 1 回失敗: もう 1 回書けたら「実行する」を出す', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      h.failLeft = 1;
      return ADD_PANTRY_FAILED;
    });

    const data = await postMessage(stream);

    expect(writeBacksOfAuto()).toHaveLength(2);
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: true });
  });

  it('失敗のあとの書き戻しが 2 回とも失敗: 「実行する」を出さず理由 unconfirmed (開き直したときと同じ。#2201 U3)、ログに残す', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      return ADD_PANTRY_FAILED;
    });

    const data = await postMessage(stream);

    expect(writeBacksOfAuto()).toHaveLength(AI_ACTION_LOG_WRITE_BACK_ATTEMPTS);
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: false, proposedActionNotExecutableReason: 'unconfirmed' });
    expect(h.logError).toHaveBeenCalledWith(WRITE_BACK_FAILED_LOG, expect.any(Error), expect.objectContaining({ status: 'pending' }));
  });

  it('成功のあとの書き戻しが 1 回失敗: もう 1 回書いて executed。提案は返さない', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockImplementationOnce(async () => {
      h.failOn = { table: 'ai_action_logs', op: 'update' };
      h.failLeft = 1;
      return { success: true, result: { itemId: 'p1', created: true } };
    });

    const data = await postMessage(stream);

    const backs = writeBacksOfAuto();
    expect(backs).toHaveLength(2);
    expect(backs[1].payload).toMatchObject({ status: 'executed' });
    expect((data.aiMessage as Row).proposedActions).toBeNull();
  });

  it('やり直しても直らない失敗 (notRetryable): 行は failed、「実行する」を出さず理由 failed', async () => {
    sessionRows();
    stubAiReply(`卵を足しますね。${ACTION_JSON('add_pantry_item')}`, stream);
    h.run.mockResolvedValueOnce(PANTRY_NOT_RETRYABLE);

    const data = await postMessage(stream);

    expect(writeBacksOfAuto().map((w) => (w.payload as Row).status)).toEqual(['failed']);
    expect(data.aiMessage).toMatchObject({ proposedActionExecutable: false, proposedActionNotExecutableReason: 'failed' });
  });
});

/** 自動実行の ai_action_logs の update (行は insert で作るので、update はすべて書き戻し) */
function writeBacksOfAuto() {
  return actionLogWrites().filter((w) => w.op === 'update');
}
