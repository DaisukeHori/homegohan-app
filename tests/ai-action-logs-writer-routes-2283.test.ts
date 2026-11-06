// @vitest-environment node
/**
 * #2283 判断待ち 8 の前段 Y1: AI 相談の提案の記録 (ai_action_logs) を書く route が、service role のクライアントで書き、
 * 持ち主でない利用者の行・相談には書かないことを、本物の route を通して確かめる。
 *
 * ai_action_logs は、利用者 (authenticated) には読むだけにする (後段の Y2 の migration で RLS と GRANT を絞る)。
 * 直す前は、実行の API (POST / DELETE /api/ai/consultation/actions/[actionId]/execute) と会話の続きの POST の自動実行
 * (POST /api/ai/consultation/sessions/[sessionId]/messages) が、利用者のセッションのクライアント (createClient) で
 * この表に書いていた (Y2 のあとは権限で拒まれ、行が実行中の印のまま残る)。
 *
 * 直したあと:
 *   - 書き込み (実行中の印の取得・書き戻し・却下・行の作成) は service role のクライアント (getAiActionLogWriter)
 *   - 読む経路 (行の探索) と、実行の本体 (runConsultationAction) に渡すクライアントは、利用者のセッションのまま
 *   - 持ち主の確認 (今まで RLS が担っていた) はコードで行う: 行の相談の user_id が本人でなければ、
 *     POST は 403・DELETE は 404・会話の続きの POST は 404 で、書かない (今の応答のまま)
 *
 * 差し替えるのは外との境目 (Supabase のクライアント・AI の呼び出し・ログ) と、実行の本体 runConsultationAction だけ。
 * 2 つのクライアントは見分けられるようにし (user / service)、書き込みと読み取りをどちらで行ったかを記録する。
 * route はファイルの一番外側で 1 回だけ読み込む (tests/heavy-unit-test-timeout.test.ts の「同じ型」に当たらない書き方)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_LOG_ID = '33333333-3333-4333-8333-333333333333';
const AI_MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const ACTION_LOGS = 'ai_action_logs';

type Row = Record<string, unknown>;
type ClientKind = 'user' | 'service';

const h = vi.hoisted(() => ({
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 表ごとの select (await) の結果の行 */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの書き込み ... select().single() / maybeSingle() の結果 (null なら行が返らない。キーが無ければ { id: '<表>-new' }) */
  written: {} as Record<string, Record<string, unknown> | null>,
  writes: [] as Array<{ client: string; table: string; op: string; payload: unknown; filters: Array<[string, unknown]> }>,
  reads: [] as Array<{ client: string; table: string; filters: Array<[string, unknown]> }>,
  adminCreated: 0,
  run: vi.fn(),
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

function makeQuery(client: ClientKind, table: string): unknown {
  let op = 'select';
  let write: (typeof h.writes)[number] | null = null;
  const read = { client, table, filters: [] as Array<[string, unknown]> };
  h.reads.push(read);
  const singleResult = () => {
    if (op === 'select') return { data: h.single[table] ?? null, error: null };
    return { data: table in h.written ? h.written[table] : { id: `${table}-new` }, error: null };
  };
  const awaitedResult = () => ({ data: op === 'select' ? h.rows[table] ?? [] : null, error: null });
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
            write = { client, table, op, payload, filters: [] };
            h.writes.push(write);
            // 書き込みの問い合わせは、読み取りの記録から外す
            const readIndex = h.reads.indexOf(read);
            if (readIndex >= 0) h.reads.splice(readIndex, 1);
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

function makeSupabase(client: ClientKind) {
  return {
    kind: client,
    auth: { getUser: async () => ({ data: { user: { id: USER, email: 'user@example.test' } }, error: null }) },
    from: (table: string) => makeQuery(client, table),
    rpc: async (name: string) =>
      name === 'consume_ai_usage'
        ? { data: { allowed: true, metered: true, usage_date: '2026-11-01', limit: 10, used: 1 }, error: null }
        : { data: null, error: null },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabase('user')),
  getSupabaseAdmin: vi.fn(() => {
    h.adminCreated += 1;
    return makeSupabase('service');
  }),
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
vi.mock('@/lib/ai/consultation-action-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consultation-action-executor')>()),
  runConsultationAction: h.run,
}));

const executeRoute = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');
const messagesRoute = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');
const { API_FORBIDDEN_MESSAGE } = await import('@/lib/api/error-responses');
const { AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE, AI_CONSULTATION_SESSION_NOT_FOUND_MESSAGE } = await import('@/lib/ai/ai-api-messages');
const { isAiActionLogOwnedBy, isConsultationSessionOwnedBy } = await import('@/lib/ai/ai-action-log-writer');

beforeEach(() => {
  h.single = {};
  h.rows = {};
  h.written = {};
  h.writes = [];
  h.reads = [];
  h.adminCreated = 0;
  h.run.mockReset();
  h.llmCreate.mockClear();
  vi.unstubAllGlobals();
});

const actionLogWrites = () => h.writes.filter((w) => w.table === ACTION_LOGS);
const actionLogReads = () => h.reads.filter((r) => r.table === ACTION_LOGS);

/** 行の相談の持ち主が ownerId の、実行を待っている (pending の) 提案の行 (相談と結んで読んだ形) */
function pendingLog(ownerId: string): Row {
  return {
    id: ACTION_LOG_ID,
    session_id: SESSION_ID,
    message_id: AI_MESSAGE_ID,
    action_type: 'add_pantry_item',
    action_params: { name: '卵' },
    status: 'pending',
    ai_consultation_sessions: { user_id: ownerId },
  };
}

const actionRequest = (method: 'POST' | 'DELETE') =>
  [
    new Request(`http://localhost/api/ai/consultation/actions/${ACTION_LOG_ID}/execute`, { method }),
    { params: Promise.resolve({ actionId: ACTION_LOG_ID }) },
  ] as const;

describe('持ち主の確かめ (isAiActionLogOwnedBy / isConsultationSessionOwnedBy)', () => {
  it('相談の user_id が本人のときだけ true。行が無い・相談が結ばれていない・user_id が文字でないときは false', () => {
    expect(isConsultationSessionOwnedBy({ user_id: USER }, USER)).toBe(true);
    expect(isConsultationSessionOwnedBy({ user_id: OTHER_USER }, USER)).toBe(false);
    expect(isConsultationSessionOwnedBy({ user_id: null }, USER)).toBe(false);
    expect(isConsultationSessionOwnedBy({}, USER)).toBe(false);
    expect(isConsultationSessionOwnedBy(null, USER)).toBe(false);
    expect(isAiActionLogOwnedBy({ ai_consultation_sessions: { user_id: USER } }, USER)).toBe(true);
    expect(isAiActionLogOwnedBy({ ai_consultation_sessions: { user_id: OTHER_USER } }, USER)).toBe(false);
    expect(isAiActionLogOwnedBy({ ai_consultation_sessions: null }, USER)).toBe(false);
    expect(isAiActionLogOwnedBy({}, USER)).toBe(false);
    expect(isAiActionLogOwnedBy(null, USER)).toBe(false);
  });
});

describe('POST /api/ai/consultation/actions/[actionId]/execute (#2283 Y1)', () => {
  it('実行中の印の取得と書き戻しを service role のクライアントで書く。行の探索と実行の本体は利用者のセッションのまま', async () => {
    h.single[ACTION_LOGS] = pendingLog(USER);
    h.run.mockResolvedValueOnce({ success: true, result: { itemId: 'p1', created: true } });

    const res = await executeRoute.POST(...actionRequest('POST'));

    expect(res.status).toBe(200);
    const writes = actionLogWrites();
    expect(writes.map((w) => [w.client, w.op, (w.payload as Row).status])).toEqual([
      ['service', 'update', 'approved'],
      ['service', 'update', 'executed'],
    ]);
    // 取得は行の id と pending の 2 つの条件 (今の条件のまま)・書き戻しは行の id
    expect(writes[0].filters).toEqual([
      ['id', ACTION_LOG_ID],
      ['status', 'pending'],
    ]);
    expect(writes[1].filters).toEqual([['id', ACTION_LOG_ID]]);
    expect(actionLogReads().length).toBeGreaterThan(0);
    expect(actionLogReads().every((r) => r.client === 'user')).toBe(true);
    expect((h.run.mock.calls[0][0] as { kind: string }).kind).toBe('user');
  });

  it('実行が投げたときの書き戻しも service role のクライアント', async () => {
    h.single[ACTION_LOGS] = pendingLog(USER);
    h.run.mockRejectedValueOnce(new Error('boom'));

    const res = await executeRoute.POST(...actionRequest('POST'));

    expect(res.status).toBe(500);
    expect(actionLogWrites().map((w) => [w.client, (w.payload as Row).status])).toEqual([
      ['service', 'approved'],
      ['service', 'pending'],
    ]);
  });

  it('持ち主でない利用者の行: 403 で、書かない (service role のクライアントも作らない)・実行しない', async () => {
    h.single[ACTION_LOGS] = pendingLog(OTHER_USER);

    const res = await executeRoute.POST(...actionRequest('POST'));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: API_FORBIDDEN_MESSAGE });
    expect(actionLogWrites()).toEqual([]);
    expect(h.adminCreated).toBe(0);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('見えない行 (他人の行は利用者のセッションでは読めない): 404 で、書かない', async () => {
    h.single[ACTION_LOGS] = null;

    const res = await executeRoute.POST(...actionRequest('POST'));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE);
    expect(actionLogWrites()).toEqual([]);
    expect(h.adminCreated).toBe(0);
  });
});

describe('DELETE /api/ai/consultation/actions/[actionId]/execute (却下。#2283 Y1)', () => {
  it('却下を service role のクライアントで書く (行の id に絞る)', async () => {
    h.single[ACTION_LOGS] = pendingLog(USER);

    const res = await executeRoute.DELETE(...actionRequest('DELETE'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(actionLogWrites().map((w) => [w.client, w.op, w.payload, w.filters])).toEqual([
      ['service', 'update', { status: 'rejected' }, [['id', ACTION_LOG_ID]]],
    ]);
    expect(actionLogReads().every((r) => r.client === 'user')).toBe(true);
  });

  it('持ち主でない利用者の行: 404 で、書かない (service role のクライアントも作らない)', async () => {
    h.single[ACTION_LOGS] = pendingLog(OTHER_USER);

    const res = await executeRoute.DELETE(...actionRequest('DELETE'));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE);
    expect(actionLogWrites()).toEqual([]);
    expect(h.adminCreated).toBe(0);
  });
});

const ACTION_JSON = `\n\`\`\`action\n{"type":"add_pantry_item","params":{"name":"卵"}}\n\`\`\``;

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

function sessionOf(ownerId: string) {
  h.single.ai_consultation_sessions = { id: SESSION_ID, user_id: ownerId, status: 'active' };
  h.written = {
    ai_consultation_messages: { id: AI_MESSAGE_ID, content: 'こんにちは', created_at: '2026-11-01T00:00:00Z' },
    ai_action_logs: { id: ACTION_LOG_ID },
  };
}

async function postMessage(stream: boolean) {
  const res = await messagesRoute.POST(
    new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages${stream ? '?stream=true' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '卵を追加して' }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  return { status: res.status, raw: await res.text() };
}

describe.each([
  ['SSE', true],
  ['JSON', false],
])('POST /api/ai/consultation/sessions/[sessionId]/messages の自動実行 (%s。#2283 Y1)', (_label, stream) => {
  it('行の作成と確定を service role のクライアントで書く。行の session_id は確かめた相談。実行の本体は利用者のセッションのまま', async () => {
    sessionOf(USER);
    stubAiReply(`卵を足しますね。${ACTION_JSON}`, stream);
    h.run.mockResolvedValueOnce({ success: true, result: { itemId: 'p1', created: true } });

    const { status } = await postMessage(stream);

    expect(status).toBe(200);
    const writes = actionLogWrites();
    expect(writes.map((w) => [w.client, w.op, (w.payload as Row).status])).toEqual([
      ['service', 'insert', 'approved'],
      ['service', 'update', 'executed'],
    ]);
    expect(writes[0].payload).toMatchObject({ session_id: SESSION_ID, message_id: AI_MESSAGE_ID, action_type: 'add_pantry_item' });
    expect(writes[1].filters).toEqual([['id', ACTION_LOG_ID]]);
    expect((h.run.mock.calls[0][0] as { kind: string }).kind).toBe('user');
    // 提案の記録のほか (メッセージ・相談) は、利用者のセッションのまま書く (この Y1 では移さない)
    expect(h.writes.filter((w) => w.table !== ACTION_LOGS).every((w) => w.client === 'user')).toBe(true);
  });

  it('実行が投げたときの確定も service role のクライアント', async () => {
    sessionOf(USER);
    stubAiReply(`卵を足しますね。${ACTION_JSON}`, stream);
    h.run.mockRejectedValueOnce(new Error('boom'));

    const { status } = await postMessage(stream);

    expect(status).toBe(200);
    expect(actionLogWrites().map((w) => [w.client, w.op, (w.payload as Row).status])).toEqual([
      ['service', 'insert', 'approved'],
      ['service', 'update', 'pending'],
    ]);
  });

  it('持ち主でない利用者の相談: 404 で、提案の行を作らない (service role のクライアントも作らない)・AI を呼ばない', async () => {
    sessionOf(OTHER_USER);
    stubAiReply(`卵を足しますね。${ACTION_JSON}`, stream);

    const { status, raw } = await postMessage(stream);

    expect(status).toBe(404);
    expect(JSON.parse(raw)).toEqual({ error: AI_CONSULTATION_SESSION_NOT_FOUND_MESSAGE });
    expect(h.writes).toEqual([]);
    expect(h.adminCreated).toBe(0);
    expect(h.run).not.toHaveBeenCalled();
  });
});
