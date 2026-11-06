// @vitest-environment node
/**
 * #2283 (B): 会話の続き (POST /api/ai/consultation/sessions/[sessionId]/messages) は、終了した (status が closed の) 相談への
 * 送信を 409 と `{ error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code: AI_CONSULTATION_SESSION_CLOSED_CODE }` で拒む。
 *
 * 以前は所有者の確認 (`!session || session.user_id !== user.id`) だけで status を見ず、アーカイブのあとに新しい相談の作成が
 * 失敗して閉じた相談が画面に残ると、閉じた相談に会話が足されていった。拒むときは本文を読む前に断り、メッセージの行・
 * AI の呼び出し・提案の記録 (ai_action_logs) を作らず、AI の利用回数 (consume_ai_usage) も数えない。
 * 開いた相談は今まで通り送れる。所有者の確認 (404) が先 (他人の閉じた相談は 409 でなく 404 にして、有無を漏らさない)。
 * 拒否は AI を呼ばないので、AI の部品の用意 (getFastLLMClient) より前に断る (AI の設定が欠けた環境でも 409)。
 *
 * 差し替えるのは Supabase のクライアント・AI の呼び出しなど外との境目だけ (tests/ai-consultation-latest-messages-2144.test.ts と
 * 同じ形)。Supabase の作り物は、表ごとの insert / update / upsert / delete と rpc の呼び出しを記録する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';
import { AI_CONSULTATION_SESSION_CLOSED_CODE, AI_CONSULTATION_SESSION_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { CONSULTATION_SESSION_CLOSED_STATUS } from '@/lib/ai/consultation-session-closed';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGES_TABLE = 'ai_consultation_messages';
const ACTION_LOGS_TABLE = 'ai_action_logs';
const SESSIONS_TABLE = 'ai_consultation_sessions';
/** 送る文 */
const USER_MESSAGE = '明日の朝ごはんは何がいい?';
/** 本文として JSON に読めない文字列 (閉じた相談では本文を読む前に断るので、400 でなく 409 になる) */
const NOT_JSON_BODY = '{not json';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** select ... single() / maybeSingle() の結果 (表ごと。無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 書き込み (insert / update / upsert / delete) の記録 */
  writes: [] as Array<{ table: string; op: string }>,
  /** rpc の呼び出しの記録 (consume_ai_usage など) */
  rpcCalls: [] as string[],
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
  /** 真なら AI の呼び出しの部品 (getFastLLMClient) が、設定の欠けた環境と同じく MissingEnvError を投げる */
  llmMissing: false,
}));

/** Supabase のクエリの作り物。select の await は空の行、single は h.single の行。書き込みは記録する */
function makeQuery(table: string): unknown {
  let op: 'select' | 'insert' | 'write' = 'select';
  let inserted: Row | null = null;
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: op === 'select' ? [] : null, error: null, count: 0 }).then(resolve, reject);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () =>
            Promise.resolve(
              op === 'insert'
                ? { data: inserted, error: null }
                : op === 'write'
                  ? { data: { id: `${table}-new` }, error: null }
                  : { data: h.single[table] ?? null, error: null },
            );
        }
        if (prop === 'insert') {
          return (values: Row) => {
            op = 'insert';
            h.writes.push({ table, op: 'insert' });
            inserted = { id: `${table}-new`, created_at: '2026-11-06T00:00:00.000Z', metadata: null, is_important: false, ...values };
            return builder;
          };
        }
        if (prop === 'update' || prop === 'upsert' || prop === 'delete') {
          return () => {
            op = 'write';
            h.writes.push({ table, op: String(prop) });
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
    rpc: async (name: string) => {
      h.rpcCalls.push(name);
      return name === 'consume_ai_usage'
        ? { data: { allowed: true, metered: true, usage_date: '2026-11-06', limit: 10, used: 1 }, error: null }
        : { data: null, error: null };
    },
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
vi.mock('@/lib/ai/fast-llm', async () => {
  const { MissingEnvError } = await import('@/lib/env-required');
  return {
    getFastLLMClient: () => {
      if (h.llmMissing) throw new MissingEnvError('XAI_API_KEY');
      return { chat: { completions: { create: h.llmCreate } } };
    },
    getFastLLMModel: () => 'test-model',
  };
});

/** AI (knowledge-gpt) への呼び出し (fetch) */
const aiFetch = vi.fn(async () => Response.json({ choices: [{ message: { content: 'わかりました。' } }] }));

beforeEach(() => {
  h.single = {};
  h.writes = [];
  h.rpcCalls = [];
  h.llmMissing = false;
  h.llmCreate.mockClear();
  aiFetch.mockClear();
  vi.stubGlobal('fetch', aiFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 相談の行 (所有者と status) を置く */
function placeSession(status: string, userId: string = USER) {
  h.single[SESSIONS_TABLE] = { id: SESSION_ID, user_id: userId, status };
}

/** 会話の続きを 1 回送る (本文は既定で送る文の JSON。stream を真にすると ?stream=true で送る) */
async function post(options: { body?: string; stream?: boolean } = {}): Promise<Response> {
  const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');
  const query = options.stream ? '?stream=true' : '';
  return POST(
    new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ?? JSON.stringify({ message: USER_MESSAGE }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
}

/** 相談に何も書いていない・AI を呼んでいない・回数を数えていない */
function expectNothingWritten() {
  expect(h.writes.filter((w) => w.table === MESSAGES_TABLE)).toEqual([]);
  expect(h.writes.filter((w) => w.table === ACTION_LOGS_TABLE)).toEqual([]);
  expect(h.writes).toEqual([]);
  expect(h.rpcCalls).not.toContain('consume_ai_usage');
  expect(aiFetch).not.toHaveBeenCalled();
  expect(h.llmCreate).not.toHaveBeenCalled();
}

describe('#2283 (B) 終了した相談への会話の続きの POST', () => {
  it('終了した相談には 409 と名前付きの文・code を返し、メッセージの行・提案の記録・AI の呼び出し・回数を作らない', async () => {
    placeSession('closed');

    const res = await post();

    expect(res.status).toBe(CONSULTATION_SESSION_CLOSED_STATUS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE,
      code: AI_CONSULTATION_SESSION_CLOSED_CODE,
    });
    expectNothingWritten();
  });

  it('流れで返す送信 (?stream=true) も同じく 409 で、何も作らない', async () => {
    placeSession('closed');

    const res = await post({ stream: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: AI_CONSULTATION_SESSION_CLOSED_CODE });
    expectNothingWritten();
  });

  it('本文を読む前に断る (本文が JSON でなくても 400 でなく 409)', async () => {
    placeSession('closed');

    const res = await post({ body: NOT_JSON_BODY });

    expect(res.status).toBe(409);
    expectNothingWritten();
  });

  it('所有者の確認が先: 他人の終了した相談は 409 でなく 404 (相談の有無と状態を漏らさない)', async () => {
    placeSession('closed', OTHER_USER);

    const res = await post();

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBeUndefined();
    expectNothingWritten();
  });

  it('AI の設定が欠けた環境でも、終了した相談は 409 で断る (拒否は AI を呼ばないので、AI の部品の用意より前に断る)', async () => {
    // 結合テストの next dev には AI の鍵が無い。以前は AI の部品の用意 (getFastLLMClient) が相談の確認より前にあり、500 になった
    placeSession('closed');
    h.llmMissing = true;

    const res = await post();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: AI_CONSULTATION_SESSION_CLOSED_CODE });
    expectNothingWritten();
  });

  it('AI の設定が欠けた環境では、開いた相談への送信はメッセージを保存する前に 500 (#1182 の順を保つ)', async () => {
    placeSession('active');
    h.llmMissing = true;

    const res = await post();

    expect(res.status).toBe(500);
    expectNothingWritten();
  });

  it('開いた相談は今まで通り送れる (メッセージの行を作り、回数を数え、AI を呼ぶ)', async () => {
    placeSession('active');

    const res = await post();

    expect(res.status).toBe(200);
    expect(h.writes.filter((w) => w.table === MESSAGES_TABLE && w.op === 'insert').length).toBeGreaterThan(0);
    expect(h.rpcCalls).toContain('consume_ai_usage');
    expect(aiFetch).toHaveBeenCalled();
  });
});
