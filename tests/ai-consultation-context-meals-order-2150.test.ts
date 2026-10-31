// @vitest-environment node
/**
 * #2150 Q1-b: AI 相談の文脈に入れる献立と食事は、並びを決めてから件数で切る。
 *
 * 以前は並びを指定せずに件数で切っていたので、件数を超えた利用者 (間食などで 1 日の食事が多い) では、どの行が AI に渡るかが
 * DB 任せで、AI の答えに使う記録が欠けたり、毎回変わったりしえた。いまは:
 *   - 会話の続きの POST の「明日〜1 週間の献立」: 日の古い順 → id の順で 30 件 (LIST_ORDERS.aiConsultationContextMealsByDay)。
 *     プロンプトには、いままでどおり日付 → 区分の順に並べ替えて書く
 *   - 会話の続きの POST の「過去 14 日の食事」: 日の新しい順 → id の降順で 50 件 (LIST_ORDERS.aiConsultationContextRecentMealsNewestFirst)。
 *     古い順へ戻し、今後の献立と同じく日付 → 区分の順 (同じ区分は id の順) でプロンプトに書く
 *   - 新しいセッションの POST が文脈の控え (context_snapshot.recentMeals) に入れる「7 日前からの食事」: 日の古い順 → id の順で 30 件
 *
 * 差し替えるのは Supabase のクライアント・AI の呼び出しなど外との境目だけ (tests/ai-consultation-latest-messages-2144.test.ts と同じ形)。
 * Supabase の作り物は eq・gt・gte・lt・lte の絞り込み (埋め込んだ user_daily_meals の列を含む)・order の並び (埋め込んだ表の列
 * user_daily_meals(day_date) で親の行を並べる書き方と NULL の位置を含む)・limit の件数を実際に当てる。
 * 時計 (Date だけ) は日本の 2026-10-31 12:00 に固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEAL_LABELS, MEAL_ORDER, type MealType } from '@homegohan/shared';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 1 件のテストの中で route を丸ごと読み込むので、負荷の高い機械で vitest の既定の時間切れを超えうる (#1605 の同じ型)。
// このファイルだけ延ばす (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MEALS_TABLE = 'planned_meals';
const SESSIONS_TABLE = 'ai_consultation_sessions';
/** 固定する時計 (日本の 2026-10-31 12:00。route の今日 = 2026-10-31) */
const NOW = '2026-10-31T03:00:00.000Z';

/** route の件数の上限 (route の UPCOMING_MEALS_LIMIT・RECENT_MEALS_LIMIT と sessions の route の RECENT_MEAL_LIMIT と同じ値を、ここでは手で書く) */
const UPCOMING_LIMIT = 30;
const RECENT_LIMIT = 50;
const SNAPSHOT_LIMIT = 30;

type Row = Record<string, unknown>;
interface OrderCall {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}
type Comparison = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

const h = vi.hoisted(() => ({
  /** 表ごとの行 (select の await で、絞り込み・並び・件数を当てて返す。insert した行もここに足す) */
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  /** 表ごとの select ... single() / maybeSingle() の結果 (無ければ null) */
  single: {} as Record<string, Record<string, unknown> | null>,
  /** select を await した planned_meals の読み込みの記録 (どの並び・件数で読んだか) */
  mealReads: [] as Array<{ orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>; limit: number | null }>,
  llmCreate: vi.fn(async () => ({ choices: [{ message: { content: '{"isImportant": false}' } }] })),
}));

/**
 * 行の列の値。埋め込んだ表の列は、絞り込みでは user_daily_meals.day_date、並びでは user_daily_meals(day_date) と書く
 * (PostgREST / supabase-js の書き方)
 */
function valueOf(row: Row, column: string): unknown {
  const related = /^(\w+)\((\w+)\)$/.exec(column) ?? /^(\w+)\.(\w+)$/.exec(column);
  if (!related) return row[column];
  const embedded = row[related[1]];
  return embedded && typeof embedded === 'object' ? (embedded as Row)[related[2]] : undefined;
}

/** 並びの鍵 1 つで 2 行を比べる (NULL の位置も order の指定どおり) */
function compareBy(a: Row, b: Row, order: OrderCall): number {
  const x = valueOf(a, order.column);
  const y = valueOf(b, order.column);
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

/** 絞り込み 1 つを行に当てる */
function matches(row: Row, [comparison, column, value]: [Comparison, string, unknown]): boolean {
  const actual = valueOf(row, column);
  if (comparison === 'eq') return actual === value;
  if (actual === null || actual === undefined) return false;
  const a = String(actual);
  const b = String(value);
  if (comparison === 'gt') return a > b;
  if (comparison === 'gte') return a >= b;
  if (comparison === 'lt') return a < b;
  return a <= b;
}

/** Supabase のクエリの作り物。絞り込み・order・limit を当て、insert した行は表に足す */
function makeQuery(table: string): unknown {
  let op: 'select' | 'insert' | 'write' = 'select';
  let inserted: Row | null = null;
  const filters: Array<[Comparison, string, unknown]> = [];
  const orders: OrderCall[] = [];
  let limit: number | null = null;

  const selectedRows = (): Row[] => {
    let rows = (h.rows[table] ?? []).filter((row) => filters.every((filter) => matches(row, filter)));
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
    if (table === MEALS_TABLE) h.mealReads.push({ orders: [...orders], limit });
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
        if (prop === 'eq' || prop === 'gt' || prop === 'gte' || prop === 'lt' || prop === 'lte') {
          return (column: string, value: unknown) => {
            filters.push([prop, column, value]);
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

/** 献立の 1 行 (料理の名前は「料理<id>」。日は埋め込んだ user_daily_meals に持つ) */
function mealRow(id: string, dayDate: string, mealType: MealType): Row {
  return {
    id,
    meal_type: mealType,
    dish_name: `料理${id}`,
    is_completed: false,
    user_daily_meals: { day_date: dayDate, user_id: USER },
  };
}

/** 1 日ぶんの 5 区分 (MEAL_ORDER の順)。id は <接頭辞>-<MMDD>-<区分の位置> (id の順 = 区分の順) */
function fullDay(prefix: string, dayDate: string): Row[] {
  const mmdd = dayDate.slice(5).replace('-', '');
  return MEAL_ORDER.map((mealType, index) => mealRow(`${prefix}-${mmdd}-${index}`, dayDate, mealType));
}

/** 2026-10-<dd> / 2026-11-<dd> の日付 */
const october = (day: number) => `2026-10-${String(day).padStart(2, '0')}`;
const november = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;
/** 範囲の日 (両端を含む) */
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** プロンプトの見出しから次の空行までの、料理の id を書いた順に */
function mealIdsInSection(prompt: string, heading: string): string[] {
  const start = prompt.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const end = prompt.indexOf('\n\n', start);
  const section = prompt.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/: 料理(\S+)/g)].map(([, id]) => id);
}

/** 1 日ぶんの 5 区分の id を区分の順に */
const fullDayIds = (prefix: string, dayDate: string) => fullDay(prefix, dayDate).map((row) => String(row.id));

/** AI (knowledge-gpt) へ送った本文の messages (送った回ごと) */
let sentMessages: Array<Array<{ role: string; content: string }>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  sentMessages = [];
  h.mealReads = [];
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
      body: JSON.stringify({ message: '明日の献立を見直したい' }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  expect(res.status).toBe(200);
  expect(sentMessages).toHaveLength(1);
  const [system] = sentMessages[0];
  expect(system.role).toBe('system');
  return system.content;
}

describe('#2150 Q1-b AI 相談の文脈の献立と食事の並び', () => {
  it('会話の続き: 明日〜1 週間の献立は日の古い順 → id の順で件数の上限まで読み、日付 → 区分の順で書く', async () => {
    // 11/01〜11/05 は 5 区分ずつ (25 件)、11/06 は 6 件 (おやつが 2 つ。id の順と区分の順をずらす)、11/07 は 5 件。計 36 件
    const day6 = november(6);
    const day6Rows = [
      mealRow('up-1106-0', day6, 'dinner'),
      mealRow('up-1106-1', day6, 'snack'),
      mealRow('up-1106-2', day6, 'breakfast'),
      mealRow('up-1106-3', day6, 'midnight_snack'),
      mealRow('up-1106-4', day6, 'lunch'),
      mealRow('up-1106-5', day6, 'snack'),
    ];
    const upcoming = [...range(1, 5).flatMap((day) => fullDay('up', november(day))), ...day6Rows, ...fullDay('up', november(7))];
    // 行の配列は逆順に置く (配列の順のまま件数で切ると、11/07 の行が入ってしまう)
    h.rows[MEALS_TABLE] = [...upcoming].reverse();

    const prompt = await postAndCollectSystemPrompt();

    // 古い側の 30 件 = 11/01〜11/05 の 25 件と、11/06 の id の小さい 5 件 (up-1106-5 は入らない)。
    // 書く順は日付 → 区分の順 (11/06 は 朝食・昼食・夕食・おやつ・夜食)
    expect(mealIdsInSection(prompt, '【📆 今後1週間の献立】')).toEqual([
      ...range(1, 5).flatMap((day) => fullDayIds('up', november(day))),
      'up-1106-2',
      'up-1106-4',
      'up-1106-0',
      'up-1106-1',
      'up-1106-3',
    ]);
    expect(prompt).not.toContain('料理up-1106-5');
    expect(prompt).not.toContain(`料理up-1107-`);
    expect(prompt).toContain(`- ${day6} ${MEAL_LABELS.breakfast}: 料理up-1106-2 [内部ID: up-1106-2]`);
    expect(h.mealReads).toContainEqual({
      orders: [
        { column: 'user_daily_meals(day_date)', ascending: true, nullsFirst: false },
        { column: 'id', ascending: true, nullsFirst: false },
      ],
      limit: UPCOMING_LIMIT,
    });
  });

  it('会話の続き: 過去 14 日の食事は日の新しい側から件数の上限まで読み、古い順 (日付 → 区分の順・同じ区分は id の順) で書く', async () => {
    // 10/17〜10/20 は 5 区分ずつ (20 件)、10/21 は 6 件 (おやつが 2 つ)、10/22〜10/30 は 5 区分ずつ (45 件)。計 71 件
    const day21 = october(21);
    const day21Rows = [
      mealRow('rc-1021-0', day21, 'lunch'),
      mealRow('rc-1021-1', day21, 'snack'),
      mealRow('rc-1021-2', day21, 'breakfast'),
      mealRow('rc-1021-3', day21, 'snack'),
      mealRow('rc-1021-4', day21, 'dinner'),
      mealRow('rc-1021-5', day21, 'midnight_snack'),
    ];
    // 行の配列は古い順に置く (配列の順のまま件数で切ると、古い側の行が入ってしまう)
    h.rows[MEALS_TABLE] = [
      ...range(17, 20).flatMap((day) => fullDay('rc', october(day))),
      ...day21Rows,
      ...range(22, 30).flatMap((day) => fullDay('rc', october(day))),
    ];

    const prompt = await postAndCollectSystemPrompt();

    // 新しい側の 50 件 = 10/22〜10/30 の 45 件と、10/21 の id の大きい 5 件 (rc-1021-0 と 10/20 以前は入らない)。
    // 書く順は古い順: 10/21 (朝食・夕食・おやつ (id の順に 2 つ)・夜食) → 10/22 → … → 10/30
    expect(mealIdsInSection(prompt, '【最近の食事履歴（過去14日）】')).toEqual([
      'rc-1021-2',
      'rc-1021-4',
      'rc-1021-1',
      'rc-1021-3',
      'rc-1021-5',
      ...range(22, 30).flatMap((day) => fullDayIds('rc', october(day))),
    ]);
    expect(prompt).not.toContain('料理rc-1021-0');
    expect(prompt).not.toContain('料理rc-1020-');
    expect(h.mealReads).toContainEqual({
      orders: [
        { column: 'user_daily_meals(day_date)', ascending: false, nullsFirst: true },
        { column: 'id', ascending: false, nullsFirst: true },
      ],
      limit: RECENT_LIMIT,
    });
  });

  it('新しいセッション: 文脈の控えの最近の食事は 7 日前からの日の古い順 → id の順で件数の上限まで入れる (先の日の献立より過去の食事が先)', async () => {
    // 7 日前 = 10/24。10/23 (範囲の外)・10/24〜10/28 は 5 区分ずつ、10/29 は 6 件 (id の順と区分の順をずらす)、11/01〜11/03 は 5 区分ずつ
    const day29 = october(29);
    const day29Rows = [
      mealRow('sn-1029-0', day29, 'dinner'),
      mealRow('sn-1029-1', day29, 'breakfast'),
      mealRow('sn-1029-2', day29, 'snack'),
      mealRow('sn-1029-3', day29, 'lunch'),
      mealRow('sn-1029-4', day29, 'midnight_snack'),
      mealRow('sn-1029-5', day29, 'snack'),
    ];
    const rows = [
      ...fullDay('sn', october(23)),
      ...range(24, 28).flatMap((day) => fullDay('sn', october(day))),
      ...day29Rows,
      ...range(1, 3).flatMap((day) => fullDay('sn', november(day))),
    ];
    // 行の配列は逆順に置く (配列の順のまま件数で切ると、先の日の献立が入ってしまう)
    h.rows[MEALS_TABLE] = [...rows].reverse();
    const { POST } = await import('@/app/api/ai/consultation/sessions/route');

    const res = await POST(
      new Request('http://localhost/api/ai/consultation/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '相談' }),
      }),
    );

    expect(res.status).toBe(200);
    const created = (h.rows[SESSIONS_TABLE] ?? []).at(-1);
    const snapshot = created?.context_snapshot as { recentMeals: Row[] } | undefined;
    // 古い側の 30 件 = 10/24〜10/28 の 25 件と、10/29 の id の小さい 5 件。控えには読んだ順 (日 → id の順) のまま入る
    expect(snapshot?.recentMeals.map((row) => row.dish_name)).toEqual([
      ...range(24, 28).flatMap((day) => fullDayIds('sn', october(day))),
      'sn-1029-0',
      'sn-1029-1',
      'sn-1029-2',
      'sn-1029-3',
      'sn-1029-4',
    ].map((id) => `料理${id}`));
    expect(h.mealReads).toEqual([
      {
        orders: [
          { column: 'user_daily_meals(day_date)', ascending: true, nullsFirst: false },
          { column: 'id', ascending: true, nullsFirst: false },
        ],
        limit: SNAPSHOT_LIMIT,
      },
    ]);
  });
});
