// @vitest-environment node
/**
 * #2157 R1: AI 相談の文脈に入れるレシピのコレクションは、並びを決めてから件数で切る。
 *
 * 以前は並びを指定せずに件数で切っていたので、件数の上限を超えるコレクションを持つ利用者では、どのコレクションが AI に渡るかが
 * DB 任せで、問い合わせごとに入れ替わりえた (AI はプロンプトに載った collectionId しか指せないので、載らなかったコレクションに
 * ついて答えたり、追加・参照したりできない回がある)。いまは会話の続きの POST が、作った日時の新しい順 → id の順で件数の上限まで読み
 * (LIST_ORDERS.aiConsultationRecipeCollections)、読んだ順のままプロンプトの「レシピコレクション」に書く。
 *
 * 差し替えるのは Supabase のクライアント・AI の呼び出しなど外との境目だけ (tests/ai-consultation-context-meals-order-2150.test.ts と同じ形)。
 * Supabase の作り物は eq の絞り込み・order の並び (NULL の位置を含む)・limit の件数を実際に当てる。
 * 時計 (Date だけ) は日本の 2026-10-31 12:00 に固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const COLLECTIONS_TABLE = 'recipe_collections';
const SESSIONS_TABLE = 'ai_consultation_sessions';
/** 固定する時計 (日本の 2026-10-31 12:00) */
const NOW = '2026-10-31T03:00:00.000Z';
/** プロンプトのレシピのコレクションの見出し (route の collectionsInfo) */
const COLLECTIONS_HEADING = '【📚 レシピコレクション】';

/** route の件数の上限 (route の RECIPE_COLLECTIONS_LIMIT と同じ値を、ここでは手で書く) */
const COLLECTIONS_LIMIT = 10;

type Row = Record<string, unknown>;
interface OrderCall {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

const h = vi.hoisted(() => ({
  /** 表ごとの行 (select の await で、絞り込み・並び・件数を当てて返す。insert した行もここに足す) */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** select を await した recipe_collections の読み込みの記録 (どの並び・件数で読んだか) */
  collectionReads: [] as Array<{ orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>; limit: number | null }>,
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

/** Supabase のクエリの作り物。eq の絞り込み・order・limit を当て、insert した行は表に足す */
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
    if (table === COLLECTIONS_TABLE) h.collectionReads.push({ orders: [...orders], limit });
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
            filters.push([column, value]);
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
            inserted = { id: `${table}-new`, created_at: NOW, status: 'active', metadata: null, is_important: false, ...values };
            h.rows[table] = [...(h.rows[table] ?? []), inserted];
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

/** レシピのコレクションの 1 行 (名前は「コレクション<id>」。収めたレシピは id の末尾の数字の件数) */
function collectionRow(id: string, createdAt: string | null, userId: string = USER): Row {
  const recipeCount = Number(id.split('-').at(-1));
  return {
    id,
    user_id: userId,
    name: `コレクション${id}`,
    created_at: createdAt,
    recipe_ids: Array.from({ length: recipeCount }, (_, i) => `recipe-${id}-${i}`),
  };
}

/** プロンプトのレシピのコレクションの見出しから次の空行までの、collectionId を書いた順に */
function collectionIdsInPrompt(prompt: string): string[] {
  const start = prompt.indexOf(COLLECTIONS_HEADING);
  expect(start, COLLECTIONS_HEADING).toBeGreaterThan(-1);
  const end = prompt.indexOf('\n\n', start);
  const section = prompt.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/\(collectionId: "([^"]+)"\)/g)].map(([, id]) => id);
}

/** AI (knowledge-gpt) へ送った本文の messages (送った回ごと) */
let sentMessages: Array<Array<{ role: string; content: string }>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  sentMessages = [];
  h.collectionReads = [];
  h.single = { [SESSIONS_TABLE]: { id: SESSION_ID, user_id: USER, status: 'active' } };
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 会話の続きを 1 回送り、AI へ送ったシステムプロンプトを返す */
async function postAndCollectSystemPrompt(): Promise<string> {
  const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');
  const res = await POST(
    new Request(`http://localhost/api/ai/consultation/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'このコレクションにレシピを足したい' }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  expect(res.status).toBe(200);
  expect(sentMessages).toHaveLength(1);
  const [system] = sentMessages[0];
  expect(system.role).toBe('system');
  return system.content;
}

describe('#2157 R1 AI 相談の文脈のレシピのコレクションの並び', () => {
  it('会話の続き: レシピのコレクションは作った日時の新しい順 → id の順で件数の上限まで読み、読んだ順のまま書く', async () => {
    // 13 件。上限の境目 (10 件目と 11 件目) は同じ日時の 3 件 (col-c-1・col-c-2・col-c-3) にまたがる。
    // 作った日時の空 (NULL) の 1 件は、降順の既定 (NULL は最初) どおり先頭に来る
    const tie = '2026-10-20T00:00:00.000Z';
    const collections = [
      collectionRow('col-n-1', null),
      collectionRow('col-a-9', '2026-10-30T00:00:00.000Z'),
      collectionRow('col-a-8', '2026-10-29T00:00:00.000Z'),
      collectionRow('col-a-7', '2026-10-28T00:00:00.000Z'),
      collectionRow('col-a-6', '2026-10-27T00:00:00.000Z'),
      collectionRow('col-a-5', '2026-10-26T00:00:00.000Z'),
      collectionRow('col-a-4', '2026-10-25T00:00:00.000Z'),
      collectionRow('col-a-3', '2026-10-24T00:00:00.000Z'),
      collectionRow('col-c-1', tie),
      collectionRow('col-c-2', tie),
      collectionRow('col-c-3', tie),
      collectionRow('col-o-2', '2026-10-10T00:00:00.000Z'),
      collectionRow('col-o-1', '2026-10-01T00:00:00.000Z'),
    ];
    // 行の配列は古い順 (同じ日時は id の降順) に置く (配列の順のまま件数で切ると、古い側のコレクションが入ってしまう)。
    // ほかの利用者のコレクションも混ぜる (user_id で絞る)
    h.rows[COLLECTIONS_TABLE] = [
      collectionRow('col-x-1', '2026-10-31T00:00:00.000Z', OTHER_USER),
      ...[...collections].reverse(),
    ];

    const prompt = await postAndCollectSystemPrompt();

    // 新しい側の 10 件 = 空の 1 件・col-a-9〜col-a-3 の 7 件と、同じ日時の 3 件のうち id の小さい 2 件 (col-c-3 と col-o-* は入らない)
    expect(collectionIdsInPrompt(prompt)).toEqual([
      'col-n-1',
      'col-a-9',
      'col-a-8',
      'col-a-7',
      'col-a-6',
      'col-a-5',
      'col-a-4',
      'col-a-3',
      'col-c-1',
      'col-c-2',
    ]);
    expect(prompt).toContain(`- コレクションcol-a-9: 9件 (collectionId: "col-a-9")`);
    expect(prompt).not.toContain('col-c-3');
    expect(prompt).not.toContain('col-o-');
    expect(prompt).not.toContain('col-x-');
    expect(h.collectionReads).toEqual([
      {
        orders: [
          { column: 'created_at', ascending: false, nullsFirst: true },
          { column: 'id', ascending: true, nullsFirst: false },
        ],
        limit: COLLECTIONS_LIMIT,
      },
    ]);
  });

  it('会話の続き: レシピのコレクションが件数の上限より少なければ全部を書く (並びは同じ)', async () => {
    h.rows[COLLECTIONS_TABLE] = [
      collectionRow('col-b-1', '2026-10-01T00:00:00.000Z'),
      collectionRow('col-b-3', '2026-10-15T00:00:00.000Z'),
      collectionRow('col-b-2', '2026-10-15T00:00:00.000Z'),
    ];

    const prompt = await postAndCollectSystemPrompt();

    expect(collectionIdsInPrompt(prompt)).toEqual(['col-b-2', 'col-b-3', 'col-b-1']);
  });
});
