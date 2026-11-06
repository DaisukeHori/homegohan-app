// @vitest-environment node
/**
 * #2283 W1: 「相談を終了」が本番で動き始めたことで出る 2 つの欠陥。
 *
 * (1) 文脈の控え (context_snapshot) が相談ごとに入れ子で倍々に大きくなる
 *   以前は、新しい相談の作成 (POST /api/ai/consultation/sessions) が閉じた相談 10 件の context_snapshot を丸ごと
 *   pastSessionSummaries に入れ、閉じる route (POST .../[sessionId]/close) がその snapshot を展開して保存し直していた。
 *   閉じる → 作る をくり返すと、前の相談の snapshot (さらに前の snapshot を含む) が入れ子で入っていった。
 *   いまは、閉じた相談の要約は小さな形 (id・title・summary・key_topics・summary_generated_at と snapshot の
 *   key_facts・user_insights だけ。src/lib/ai/consultation-past-sessions.ts) で読み、入れる。
 *
 *   形の表 (作る → 閉じる をくり返したときの、相談 n の snapshot):
 *     | 段                 | pastSessionSummaries の 1 件              | 入れ子の深さ | 大きさ                      |
 *     | 修正前の作成       | 閉じた相談の snapshot を丸ごと (入れ子)   | n            | 前の 10 件の合計 (倍々)     |
 *     | 修正後の作成       | 要約の列 + key_facts・user_insights だけ  | 1            | 10 件 × 要約 1 件で頭打ち   |
 *     | 修正後の閉じる     | 作成の一覧を小さな形に詰め直して保存      | 1            | 作成のときと同じ            |
 *     | 修正前に作った相談 | 閉じるときに小さな形に詰め直す            | 1            | 作成のときと同じ            |
 *   読む側 (会話の続きの POST のプロンプト) は、いままでどおり key_facts と user_insights をプロンプトに入れる。
 *
 * (2) 同じ相談の「相談を終了」が同時に 2 本走ると、要約の AI 呼び出しと利用回数の消費 (consumeAiUsage) が 2 回走る
 *   以前は status を読んだあと、要約と利用回数のあとに id だけの条件で書き換えていた。いまは閉じたことを先に、状態の
 *   条件つきの書き換え (閉じていない行だけ) で確定し、書き換えられた 1 本目だけが要約と利用回数に進む。2 本目は 400 (すでに終了)。
 *
 * 差し替えるのは Supabase のクライアント・AI の呼び出しなど外との境目だけ。Supabase の作り物は 1 つの表の集まりを持ち、
 * select の列 (`別名:列->キー` の JSON の path を含む)・eq / neq / is / not / or の絞り込み・limit・insert・update を実際に当てる
 * (列や条件を当てない作り物では、丸ごと読んでいるか・2 本目が書き換えられるかを確かめられないため)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER = '11111111-1111-4111-8111-111111111111';
const SESSIONS_TABLE = 'ai_consultation_sessions';
const MESSAGES_TABLE = 'ai_consultation_messages';
/** 作成の route が読む、閉じた相談の要約の件数の上限 (route の .limit(10) と同じ値を、ここでは手で書く) */
const PAST_SUMMARY_LIMIT = 10;
/** 作る → 閉じる をくり返す回数 (上限の 10 件を超えて、大きさが頭打ちになることまで見る) */
const CYCLES = PAST_SUMMARY_LIMIT + 3;
/** pastSessionSummaries の 1 件が持ってよいキー */
const PAST_SUMMARY_KEYS = ['id', 'key_facts', 'key_topics', 'summary', 'summary_generated_at', 'title', 'user_insights'];

/** 要約の AI が返す key_facts・user_insights (プロンプトに入ることを確かめる) */
const KEY_FACT = { date: '2026-11-01', category: '体重', content: '62kg まで減った' };
const USER_INSIGHT = '朝食を抜きがち';
const SUMMARY_JSON = JSON.stringify({
  title: '体重の相談',
  summary: '体重を減らす相談をした',
  key_facts: [KEY_FACT],
  key_topics: ['体重'],
  actions_taken: [],
  user_insights: [USER_INSIGHT],
});

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const h = vi.hoisted(() => ({
  /** 表ごとの行 */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** select の記録 (表・列・絞り込みの種類) */
  selects: [] as Array<{ table: string; columns: string; statusEq: unknown }>,
  /** 次に作る行の番号 (id を決める) */
  nextId: 1,
  /** ai_consultation_sessions を select('*') で読む読み込みを、この本数がそろうまで待たせる (同時の 2 本を再現する。null なら待たせない) */
  sessionReadBarrier: null as null | { count: number; arrived: number; release: () => void; ready: Promise<void> },
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '' } }] })),
  consumeAiUsage: vi.fn(),
}));

/** 番号 n の UUID の形の id (route の isUuid を通す) */
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 括弧の外のカンマで分ける */
function splitColumns(columns: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** select の列を当てる。`*`・`列`・`別名:列->キー`・`列->キー` を解き、埋め込み (`表(…)`) は落とす */
function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const item of splitColumns(columns)) {
    if (item === '*') {
      Object.assign(out, structuredClone(row));
      continue;
    }
    if (item.includes('(')) continue;
    const aliasMatch = /^(\w+):(.+)$/.exec(item);
    const expr = aliasMatch ? aliasMatch[2] : item;
    const path = expr.split('->');
    const name = aliasMatch ? aliasMatch[1] : path[path.length - 1];
    let value: unknown = row[path[0]];
    for (const key of path.slice(1)) {
      value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[key] : undefined;
    }
    out[name] = value === undefined ? null : structuredClone(value);
  }
  return out;
}

/** or('列.演算子.値,…') の 1 つの条件 (eq・neq・is だけ) */
function orCondition(text: string): Filter | null {
  const m = /^(\w+)\.(eq|neq|is)\.(.+)$/.exec(text);
  if (!m) return null;
  const [, column, op, raw] = m;
  const value = raw === 'null' ? null : raw;
  if (op === 'is') return (row) => (row[column] ?? null) === value;
  if (op === 'eq') return (row) => row[column] === value;
  // neq は NULL を外す (SQL の <> と同じ)
  return (row) => row[column] !== null && row[column] !== undefined && row[column] !== value;
}

function makeQuery(table: string): unknown {
  let op: 'select' | 'insert' | 'update' | 'write' = 'select';
  let columns: string | null = null;
  let values: Row | null = null;
  let limit: number | null = null;
  let statusEq: unknown = undefined;
  const filters: Filter[] = [];
  let executed: { rows: Row[] } | null = null;

  const matching = () => (h.rows[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const execute = (): { rows: Row[] } => {
    if (executed) return executed;
    if (op === 'insert' && values) {
      const id = uuidOf(h.nextId++);
      const defaults: Row = table === SESSIONS_TABLE
        ? { status: 'active', summary: null, key_topics: null, action_history: [], summary_generated_at: null, created_at: new Date().toISOString() }
        : {};
      const row: Row = { id, ...defaults, ...structuredClone(values) };
      h.rows[table] = [...(h.rows[table] ?? []), row];
      executed = { rows: [row] };
    } else if (op === 'update' && values) {
      const targets = matching();
      for (const row of targets) Object.assign(row, structuredClone(values));
      executed = { rows: targets };
    } else if (op === 'select') {
      h.selects.push({ table, columns: columns ?? '*', statusEq });
      const rows = matching();
      executed = { rows: limit === null ? rows : rows.slice(0, limit) };
    } else {
      executed = { rows: [] };
    }
    return executed;
  };
  const projected = (rows: Row[]) => (columns === null ? null : rows.map((row) => project(row, columns ?? '*')));
  const listResult = () => {
    const { rows } = execute();
    const data = op === 'select' ? rows.map((row) => project(row, columns ?? '*')) : projected(rows);
    return { data, error: null, count: rows.length };
  };
  const oneResult = async (single: boolean) => {
    const barrier = h.sessionReadBarrier;
    if (barrier && table === SESSIONS_TABLE && op === 'select' && columns === '*') {
      barrier.arrived += 1;
      if (barrier.arrived >= barrier.count) barrier.release();
      await barrier.ready;
    }
    const { rows } = execute();
    const first = rows[0] ? project(rows[0], columns ?? '*') : null;
    if (!first && single) return { data: null, error: { message: 'not found', code: 'PGRST116' } };
    return { data: first, error: null };
  };

  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(listResult()).then(resolve, reject);
        }
        if (prop === 'single') return () => oneResult(true);
        if (prop === 'maybeSingle') return () => oneResult(false);
        if (prop === 'select') {
          return (cols?: string) => {
            columns = cols ?? '*';
            return builder;
          };
        }
        if (prop === 'insert') {
          return (v: Row) => {
            op = 'insert';
            values = v;
            return builder;
          };
        }
        if (prop === 'update') {
          return (v: Row) => {
            op = 'update';
            values = v;
            return builder;
          };
        }
        if (prop === 'upsert' || prop === 'delete') {
          return () => {
            op = 'write';
            return builder;
          };
        }
        if (prop === 'eq' || prop === 'neq') {
          return (column: string, value: unknown) => {
            if (column === 'status' && prop === 'eq') statusEq = value;
            // 埋め込んだ表の列 (表.列) の絞り込みは当てない (この作り物では、埋め込みの表に行を置かない)
            if (!column.includes('.')) {
              filters.push(prop === 'eq'
                ? (row) => row[column] === value
                : (row) => row[column] !== null && row[column] !== undefined && row[column] !== value);
            }
            return builder;
          };
        }
        if (prop === 'is') {
          return (column: string, value: unknown) => {
            filters.push((row) => (row[column] ?? null) === value);
            return builder;
          };
        }
        if (prop === 'not') {
          return (column: string, operator: string, value: unknown) => {
            if (operator === 'is') filters.push((row) => (row[column] ?? null) !== value);
            return builder;
          };
        }
        if (prop === 'or') {
          return (text: string) => {
            const conditions = text.split(',').map(orCondition);
            if (conditions.every((c): c is Filter => c !== null)) {
              filters.push((row) => conditions.some((c) => c(row)));
            }
            return builder;
          };
        }
        if (prop === 'limit') {
          return (n: number) => {
            limit = n;
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
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: h.consumeAiUsage,
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

/** AI (knowledge-gpt) へ送った本文の system の文 (会話の続きの POST の回ごと) */
let sentSystemPrompts: string[];

beforeEach(() => {
  h.rows = {};
  h.selects = [];
  h.nextId = 1;
  h.sessionReadBarrier = null;
  h.llmCreate.mockReset();
  h.llmCreate.mockImplementation(async () => ({ choices: [{ message: { content: SUMMARY_JSON } }] }));
  h.consumeAiUsage.mockReset();
  h.consumeAiUsage.mockImplementation(async () => AI_USAGE_ALLOWED);
  sentSystemPrompts = [];
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
});

/** 新しい相談を作り、作った相談の id を返す */
async function createSession(): Promise<string> {
  const { POST } = await import('@/app/api/ai/consultation/sessions/route');
  const res = await POST(
    new Request('http://localhost/api/ai/consultation/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { session: { id: string } };
  return body.session.id;
}

/** 相談に会話 (利用者と AI の 2 件) を足す (要約は会話が 2 件以上のときだけ作る) */
function addConversation(sessionId: string): void {
  h.rows[MESSAGES_TABLE] = [
    ...(h.rows[MESSAGES_TABLE] ?? []),
    { id: `m-${sessionId}-1`, session_id: sessionId, role: 'user', content: '体重を減らしたい', created_at: '2026-11-01T00:00:00.000Z', is_important: false },
    { id: `m-${sessionId}-2`, session_id: sessionId, role: 'assistant', content: '一緒に考えましょう', created_at: '2026-11-01T00:01:00.000Z', is_important: false },
  ];
}

async function closeSession(sessionId: string): Promise<Response> {
  const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/close/route');
  return POST(new Request(`http://localhost/api/ai/consultation/sessions/${sessionId}/close`, { method: 'POST' }), {
    params: Promise.resolve({ sessionId }),
  });
}

function sessionRow(sessionId: string): Row {
  const row = (h.rows[SESSIONS_TABLE] ?? []).find((r) => r.id === sessionId);
  if (!row) throw new Error(`相談 ${sessionId} の行が無い`);
  return row;
}

/** 値の中の pastSessionSummaries の入れ子の深さ (無ければ 0。snapshot の直下にあれば 1) */
function pastSummariesDepth(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(pastSummariesDepth));
  if (!value || typeof value !== 'object') return 0;
  let depth = 0;
  for (const [key, child] of Object.entries(value as Row)) {
    const childDepth = pastSummariesDepth(child);
    depth = Math.max(depth, key === 'pastSessionSummaries' ? childDepth + 1 : childDepth);
  }
  return depth;
}

/** 値の中に context_snapshot のキーがあるか (snapshot の丸ごとが入れ子で入っていないか) */
function hasNestedSnapshot(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNestedSnapshot);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Row).some(([key, child]) => key === 'context_snapshot' || hasNestedSnapshot(child));
}

/** 閉じた相談の要約を読む select (作成の route と会話の続きの route) の列 */
function closedSummaryReads(): string[] {
  return h.selects.filter((s) => s.table === SESSIONS_TABLE && s.statusEq === 'closed').map((s) => s.columns);
}

describe('#2283 W1 (1) 閉じる → 作る をくり返しても、文脈の控え (context_snapshot) が入れ子で大きくならない', () => {
  it(`${CYCLES} 回くり返しても pastSessionSummaries の入れ子の深さは 1 で、10 件を超えたあとの大きさは変わらない`, async () => {
    const createdSizes: number[] = [];
    const closedSizes: number[] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const id = await createSession();
      const created = sessionRow(id).context_snapshot as Row;
      const past = created.pastSessionSummaries as Row[];
      expect(past).toHaveLength(Math.min(cycle - 1, PAST_SUMMARY_LIMIT));
      expect(pastSummariesDepth(created), `${cycle} 回目の作成`).toBeLessThanOrEqual(1);
      expect(hasNestedSnapshot(created), `${cycle} 回目の作成`).toBe(false);
      for (const entry of past) {
        expect(Object.keys(entry).sort()).toEqual(PAST_SUMMARY_KEYS);
        expect(entry.key_facts).toEqual([KEY_FACT]);
        expect(entry.user_insights).toEqual([USER_INSIGHT]);
        expect(entry.summary).toBe('体重を減らす相談をした');
      }
      createdSizes.push(JSON.stringify(created).length);

      addConversation(id);
      const res = await closeSession(id);
      expect(res.status).toBe(200);
      const closed = sessionRow(id);
      expect(closed.status).toBe('closed');
      const closedSnapshot = closed.context_snapshot as Row;
      expect(pastSummariesDepth(closedSnapshot), `${cycle} 回目の閉じる`).toBeLessThanOrEqual(1);
      expect(hasNestedSnapshot(closedSnapshot), `${cycle} 回目の閉じる`).toBe(false);
      expect(closedSnapshot.key_facts).toEqual([KEY_FACT]);
      expect(closedSnapshot.user_insights).toEqual([USER_INSIGHT]);
      closedSizes.push(JSON.stringify(closedSnapshot).length);
    }
    // 閉じた相談が上限の 10 件そろったあと (11 回目以降) は、作った snapshot も閉じた snapshot も大きさが変わらない
    const steadyCreated = createdSizes.slice(PAST_SUMMARY_LIMIT);
    const steadyClosed = closedSizes.slice(PAST_SUMMARY_LIMIT);
    expect(new Set(steadyCreated).size, JSON.stringify(createdSizes)).toBe(1);
    expect(new Set(steadyClosed).size, JSON.stringify(closedSizes)).toBe(1);
    // 閉じた相談の要約は、snapshot を丸ごと読まない
    expect(closedSummaryReads().length).toBeGreaterThan(0);
    for (const columns of closedSummaryReads()) {
      expect(splitColumns(columns)).not.toContain('context_snapshot');
      expect(splitColumns(columns)).not.toContain('*');
    }
  });

  it('修正前の形 (前の相談の snapshot を丸ごと持つ) の行が残っていても、作る・閉じるは小さな形にし、key_facts・user_insights を引き継ぐ', async () => {
    const legacyInner = { profile: { age: 30 }, recentMeals: [{ dish_name: 'カレー' }], pastSessionSummaries: [], key_facts: [KEY_FACT], user_insights: [USER_INSIGHT] };
    const legacyEntry = { id: uuidOf(900), title: '前の相談', summary: '前の要約', key_topics: ['食事'], summary_generated_at: '2026-10-01T00:00:00.000Z', context_snapshot: legacyInner };
    // 閉じた相談 (snapshot に、前の相談の snapshot を丸ごと持つ pastSessionSummaries がある)
    h.rows[SESSIONS_TABLE] = [
      {
        id: uuidOf(901),
        user_id: USER,
        title: '閉じた相談',
        status: 'closed',
        summary: '閉じた要約',
        key_topics: ['体重'],
        summary_generated_at: '2026-10-02T00:00:00.000Z',
        action_history: [],
        context_snapshot: { profile: { age: 30 }, pastSessionSummaries: [legacyEntry], key_facts: [KEY_FACT], user_insights: [USER_INSIGHT] },
      },
      // 修正前に作った、まだ閉じていない相談 (pastSessionSummaries に snapshot の丸ごとがある)
      {
        id: uuidOf(902),
        user_id: USER,
        title: 'AI相談',
        status: 'active',
        summary: null,
        key_topics: null,
        summary_generated_at: null,
        action_history: [],
        context_snapshot: { profile: { age: 30 }, pastSessionSummaries: [legacyEntry] },
      },
    ];
    h.nextId = 1000;

    const createdId = await createSession();
    const created = sessionRow(createdId).context_snapshot as Row;
    expect(created.pastSessionSummaries).toEqual([
      {
        id: uuidOf(901),
        title: '閉じた相談',
        summary: '閉じた要約',
        key_topics: ['体重'],
        summary_generated_at: '2026-10-02T00:00:00.000Z',
        key_facts: [KEY_FACT],
        user_insights: [USER_INSIGHT],
      },
    ]);

    addConversation(uuidOf(902));
    const res = await closeSession(uuidOf(902));
    expect(res.status).toBe(200);
    const closedSnapshot = sessionRow(uuidOf(902)).context_snapshot as Row;
    expect(hasNestedSnapshot(closedSnapshot)).toBe(false);
    expect(closedSnapshot.pastSessionSummaries).toEqual([
      {
        id: uuidOf(900),
        title: '前の相談',
        summary: '前の要約',
        key_topics: ['食事'],
        summary_generated_at: '2026-10-01T00:00:00.000Z',
        key_facts: [KEY_FACT],
        user_insights: [USER_INSIGHT],
      },
    ]);
    expect(closedSnapshot.profile).toEqual({ age: 30 });
  });

  it('会話の続きの POST は、閉じた相談の key_facts と user_insights を今まで通りプロンプトに入れ、snapshot を丸ごと読まない', async () => {
    h.llmCreate.mockImplementation(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] }));
    h.rows[SESSIONS_TABLE] = [
      {
        id: uuidOf(901),
        user_id: USER,
        title: '閉じた相談',
        status: 'closed',
        summary: '閉じた要約',
        key_topics: ['体重'],
        summary_generated_at: '2026-10-02T00:00:00.000Z',
        action_history: [],
        // 修正前の形の入れ子が残っていても、読むのは key_facts・user_insights だけ
        context_snapshot: { pastSessionSummaries: [{ context_snapshot: { pastSessionSummaries: [] } }], key_facts: [KEY_FACT], user_insights: [USER_INSIGHT] },
      },
      { id: uuidOf(902), user_id: USER, title: 'AI相談', status: 'active', summary: null, key_topics: null, action_history: [], context_snapshot: {} },
    ];
    h.nextId = 1000;

    const { POST } = await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route');
    const res = await POST(
      new Request(`http://localhost/api/ai/consultation/sessions/${uuidOf(902)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '今日の夕食は?' }),
      }),
      { params: Promise.resolve({ sessionId: uuidOf(902) }) },
    );
    expect(res.status).toBe(200);
    expect(sentSystemPrompts).toHaveLength(1);
    const prompt = sentSystemPrompts[0];
    expect(prompt).toContain('■ 閉じた相談');
    expect(prompt).toContain('概要: 閉じた要約');
    expect(prompt).toContain('トピック: 体重');
    expect(prompt).toContain(`    - [${KEY_FACT.category}] ${KEY_FACT.date}: ${KEY_FACT.content}`);
    expect(prompt).toContain(`判明したこと: ${USER_INSIGHT}`);
    expect(closedSummaryReads()).toHaveLength(1);
    expect(splitColumns(closedSummaryReads()[0])).not.toContain('context_snapshot');
  });
});

describe('#2283 W1 (2) 同じ相談の「相談を終了」が同時に 2 本来ても、要約と利用回数は 1 回だけ', () => {
  it('2 本が同時に状態を読んでも、閉じられるのは 1 本目だけ。要約の AI と consumeAiUsage は 1 回、2 本目は 400 (すでに終了)', async () => {
    const id = uuidOf(500);
    h.rows[SESSIONS_TABLE] = [
      { id, user_id: USER, title: 'AI相談', status: 'active', summary: null, key_topics: null, action_history: [], context_snapshot: { pastSessionSummaries: [] } },
    ];
    addConversation(id);
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 2 本とも status を読み終える (どちらも active を見る) まで、どちらも先へ進ませない
    h.sessionReadBarrier = { count: 2, arrived: 0, release, ready };

    const [first, second] = await Promise.all([closeSession(id), closeSession(id)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const rejected = first.status === 400 ? first : second;
    expect(((await rejected.json()) as { error: string }).error).toBe(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE);
    expect(h.consumeAiUsage).toHaveBeenCalledTimes(1);
    expect(h.llmCreate).toHaveBeenCalledTimes(1);
    const row = sessionRow(id);
    expect(row.status).toBe('closed');
    expect(row.summary).toBe('体重を減らす相談をした');
  });

  it('status が NULL の相談も閉じられる (閉じていない相談として扱う。前の比較と同じ)', async () => {
    const id = uuidOf(600);
    h.rows[SESSIONS_TABLE] = [{ id, user_id: USER, title: 'AI相談', status: null, summary: null, key_topics: null, action_history: [], context_snapshot: null }];
    addConversation(id);
    const res = await closeSession(id);
    expect(res.status).toBe(200);
    expect(sessionRow(id).status).toBe('closed');
    expect(h.consumeAiUsage).toHaveBeenCalledTimes(1);
  });
});
