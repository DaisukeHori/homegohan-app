// @vitest-environment node
/**
 * #2144 S1: AI 相談の会話の続き (POST /api/ai/consultation/sessions/[sessionId]/messages) で AI に渡す過去のメッセージは、
 * 新しい側から件数の上限まで読み、古い順へ並べ直して渡す。
 *
 * 以前は古い順のまま件数 (50 件) で切っていたので、メッセージが 50 件を超えたセッションでは、いま保存した利用者のメッセージ
 * (いちばん新しい行) が文脈から落ち、AI は最新の質問を見ずに古い会話へ答えていた。
 * 一覧の GET (画面に出す会話) の並び (古い順・件数の上限なし) は変えない。
 *
 * 差し替えるのは Supabase のクライアント・AI の呼び出しなど外との境目だけ (tests/consultation-pantry-expiry-jst.test.ts と同じ形)。
 * Supabase の作り物は、ai_consultation_messages の読み込みで eq の絞り込み・order の並び (NULL の位置を含む)・limit の件数を
 * 実際に当てる (並びと件数を当てない作り物では、どの行が文脈に入るかを確かめられないため)。insert した行は次の読み込みに出る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGES_TABLE = 'ai_consultation_messages';

/** route が AI に渡す過去のメッセージの件数の上限 (route の AI_CONSULTATION_HISTORY_LIMIT と同じ値を、ここでは手で書く) */
const HISTORY_LIMIT = 50;
/** いま送る利用者のメッセージ */
const NEW_USER_MESSAGE = 'いちばん新しい質問: 明日の朝ごはんは何がいい?';
/** いま送るメッセージを保存した日時 (どの既存の行よりも新しい) */
const NEW_MESSAGE_AT = '2026-10-31T12:00:00.000Z';
/** いま送るメッセージの行の id */
const NEW_MESSAGE_ID = 'msg-999';

type Row = Record<string, unknown>;
interface OrderCall {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}
interface ReadLog {
  table: string;
  orders: OrderCall[];
  limit: number | null;
}

const h = vi.hoisted(() => ({
  /** 表ごとの行 (select の await で、絞り込み・並び・件数を当てて返す。insert した行もここに足す) */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** 次に insert する行に付ける id と日時 (表ごと。無ければ <表>-new と、日時は付けない) */
  nextInsert: {} as Record<string, { id: string; created_at: string }>,
  /** select を await した読み込みの記録 (どの並び・件数で読んだか) */
  reads: [] as Array<{ table: string; orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>; limit: number | null }>,
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

/** 並びの鍵 1 つで 2 行を比べる (NULL の位置も order の指定どおり) */
function compareBy(a: Row, b: Row, order: OrderCall): number {
  const x = a[order.column];
  const y = b[order.column];
  const xNull = x === null || x === undefined;
  const yNull = y === null || y === undefined;
  if (xNull || yNull) {
    if (xNull && yNull) return 0;
    return xNull === order.nullsFirst ? -1 : 1;
  }
  const sign = order.ascending ? 1 : -1;
  if (String(x) < String(y)) return -sign;
  if (String(x) > String(y)) return sign;
  return 0;
}

/** Supabase のクエリの作り物。eq (列名に . の無いもの)・order・limit を当て、insert した行は表に足す */
function makeQuery(table: string): unknown {
  let op: 'select' | 'insert' | 'write' = 'select';
  let inserted: Row | null = null;
  const filters: Array<[string, unknown]> = [];
  const orders: OrderCall[] = [];
  let limit: number | null = null;

  const selectedRows = (): Row[] => {
    let rows = (h.rows[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
    if (orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const order of orders) {
          const c = compareBy(a, b, order);
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    return limit === null ? rows : rows.slice(0, limit);
  };
  const singleResult = () => {
    if (op === 'insert') return { data: inserted, error: null };
    if (op === 'write') return { data: { id: `${table}-new` }, error: null };
    return { data: h.single[table] ?? null, error: null };
  };
  const awaitedResult = () => {
    if (op !== 'select') return { data: null, error: null, count: null };
    h.reads.push({ table, orders: [...orders], limit });
    const rows = selectedRows();
    return { data: rows, error: null, count: rows.length };
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
        if (prop === 'eq') {
          return (column: string, value: unknown) => {
            if (!column.includes('.')) filters.push([column, value]);
            return builder;
          };
        }
        if (prop === 'order') {
          return (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => {
            const ascending = options?.ascending ?? true;
            orders.push({ column, ascending, nullsFirst: options?.nullsFirst ?? !ascending });
            return builder;
          };
        }
        if (prop === 'limit') {
          return (n: number) => {
            limit = n;
            return builder;
          };
        }
        if (prop === 'insert') {
          return (values: Row) => {
            op = 'insert';
            const next = h.nextInsert[table];
            inserted = { id: `${table}-new`, ...(next ?? {}), metadata: null, is_important: false, ...values };
            h.rows[table] = [...(h.rows[table] ?? []), inserted];
            delete h.nextInsert[table];
            return builder;
          };
        }
        if (prop === 'update' || prop === 'upsert' || prop === 'delete') {
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
        ? { data: { allowed: true, metered: true, usage_date: '2026-10-31', limit: 10, used: 1 }, error: null }
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

/** n 番目 (1 始まり) の既存のメッセージの id。文字列の順 = 数の順になるよう 3 桁にそろえる */
const messageId = (n: number) => `msg-${String(n).padStart(3, '0')}`;
/** n 番目の既存のメッセージの本文 */
const messageContent = (n: number) => `${n} 番目のメッセージ`;
/** 既存のメッセージを書いた日時の起点と間隔 (1 分ごと) */
const BASE_AT_MS = Date.parse('2026-10-31T09:00:00.000Z');
const MINUTE_MS = 60_000;

/**
 * セッションの既存のメッセージ count 件 (利用者と AI が交互)。n 番目は起点から n 分後に書いた行。
 * ただし最後の 2 件 (count - 1 番目と count 番目) は同じ日時にし、行の配列の中でも id の大きい方を先に置く
 * (同じ日時の行は id の順に並ぶこと = 一覧の GET と同じ順になることを確かめるため。配列の順のまま返ったら崩れる)
 */
function existingMessages(count: number): Row[] {
  const rows = Array.from({ length: count }, (_, i): Row => {
    const n = i + 1;
    const minutes = n === count ? count - 1 : n;
    return {
      id: messageId(n),
      session_id: SESSION_ID,
      role: n % 2 === 1 ? 'user' : 'assistant',
      content: messageContent(n),
      created_at: new Date(BASE_AT_MS + minutes * MINUTE_MS).toISOString(),
      metadata: null,
      is_important: false,
    };
  });
  return [...rows.slice(0, -2), rows[count - 1], rows[count - 2]];
}

/** ほかのセッションの、いちばん新しいメッセージ (このセッションの文脈に入らないこと) */
const OTHER_SESSION_ROW: Row = {
  id: 'msg-000',
  session_id: OTHER_SESSION_ID,
  role: 'user',
  content: 'ほかのセッションのメッセージ',
  created_at: '2026-10-31T23:59:00.000Z',
  metadata: null,
  is_important: false,
};

/** AI (knowledge-gpt) へ送った本文の messages (送った回ごと) */
let sentMessages: Array<Array<{ role: string; content: string }>>;

beforeEach(() => {
  sentMessages = [];
  h.reads = [];
  h.single = { ai_consultation_sessions: { id: SESSION_ID, user_id: USER, status: 'active' } };
  h.nextInsert = { [MESSAGES_TABLE]: { id: NEW_MESSAGE_ID, created_at: NEW_MESSAGE_AT } };
  h.rows = {};
  h.llmCreate.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
      if (body.messages) sentMessages.push(body.messages);
      return Response.json({ choices: [{ message: { content: 'わかりました。' } }] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 会話の続きを 1 回送り、AI へ送った messages の system 以外 (本文だけ) を返す */
async function postAndCollectHistory(): Promise<string[]> {
  const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');
  const res = await POST(
    new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: NEW_USER_MESSAGE }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  expect(res.status).toBe(200);
  expect(sentMessages).toHaveLength(1);
  const [system, ...history] = sentMessages[0];
  expect(system.role).toBe('system');
  expect(history.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  return history.map((m) => m.content);
}

describe('#2144 S1 AI 相談の会話の続きで AI に渡す過去のメッセージ', () => {
  it('件数の上限を超えたセッションでは、新しい側の 50 件を古い順に渡し、いま送ったメッセージが最後に入る', async () => {
    const existingCount = 60;
    h.rows[MESSAGES_TABLE] = [OTHER_SESSION_ROW, ...existingMessages(existingCount)];

    const history = await postAndCollectHistory();

    // 既存の 60 件といま送った 1 件の計 61 件のうち、新しい側の 50 件 = 既存の 12〜60 番目 (49 件) といま送った 1 件。
    // 59 番目と 60 番目は同じ日時で、id の順 (59 → 60) に並ぶ
    const firstIncluded = existingCount + 1 - HISTORY_LIMIT + 1;
    const expected = [
      ...Array.from({ length: existingCount - firstIncluded + 1 }, (_, i) => messageContent(firstIncluded + i)),
      NEW_USER_MESSAGE,
    ];
    expect(firstIncluded).toBe(12);
    expect(history).toEqual(expected);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history.at(-1)).toBe(NEW_USER_MESSAGE);
    expect(history).not.toContain(messageContent(firstIncluded - 1));
    expect(history).not.toContain(OTHER_SESSION_ROW.content);
  });

  it('件数の上限ちょうど (既存 49 件 + いま送った 1 件) では、全部を古い順に渡す', async () => {
    const existingCount = HISTORY_LIMIT - 1;
    h.rows[MESSAGES_TABLE] = existingMessages(existingCount);

    const history = await postAndCollectHistory();

    expect(history).toEqual([...Array.from({ length: existingCount }, (_, i) => messageContent(i + 1)), NEW_USER_MESSAGE]);
  });

  it('件数の上限より少ないセッションでも、全部を古い順に渡し、いま送ったメッセージが最後に入る', async () => {
    h.rows[MESSAGES_TABLE] = existingMessages(3);

    const history = await postAndCollectHistory();

    expect(history).toEqual([messageContent(1), messageContent(2), messageContent(3), NEW_USER_MESSAGE]);
  });

  it('システムプロンプトの印の付いた行は、新しい側にあっても渡さない (件数の上限には数える)', async () => {
    const existingCount = 60;
    const rows = existingMessages(existingCount).map((row) =>
      row.id === messageId(existingCount - 2) ? { ...row, metadata: { isSystemPrompt: true } } : row,
    );
    h.rows[MESSAGES_TABLE] = rows;

    const history = await postAndCollectHistory();

    expect(history).not.toContain(messageContent(existingCount - 2));
    expect(history).toHaveLength(HISTORY_LIMIT - 1);
    expect(history[0]).toBe(messageContent(12));
    expect(history.at(-1)).toBe(NEW_USER_MESSAGE);
  });

  it('一覧の GET は、いままでどおり全部を古い順 (同じ日時は id の順) に返し、件数で切らない', async () => {
    const existingCount = 60;
    h.rows[MESSAGES_TABLE] = [OTHER_SESSION_ROW, ...existingMessages(existingCount)];
    const { GET } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');

    const res = await GET(new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`), {
      params: Promise.resolve({ sessionId: SESSION_ID }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; content: string }> };
    expect(body.messages.map((m) => m.id)).toEqual(Array.from({ length: existingCount }, (_, i) => messageId(i + 1)));
    const messageReads: ReadLog[] = h.reads.filter((read) => read.table === MESSAGES_TABLE);
    expect(messageReads).toEqual([
      {
        table: MESSAGES_TABLE,
        orders: [
          { column: 'created_at', ascending: true, nullsFirst: false },
          { column: 'id', ascending: true, nullsFirst: false },
        ],
        limit: null,
      },
    ]);
  });
});
