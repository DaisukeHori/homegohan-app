/**
 * #1157 (T23) GET /api/super-admin/logs の単体テスト
 *
 * 運用ログ (app_logs) の閲覧口。次を確かめる。
 *   - 認可: super_admin だけが 200。admin を含むそれ以外は 403、未ログインは 401 で、
 *     どちらも service role の client を作らず、app_logs にも触れない
 *   - 絞り込み: level / source / function_name / user_id / request_id / from / to が、単独でも組み合わせても効く
 *   - ページ送り: カーソルで続きを取ると、全行が重複も欠落もなく新しい順に 1 回ずつ出る
 *     (同じ時刻の行・マイクロ秒だけ違う行・取得の途中で新しい行が入った場合を含む)。1 回の最大は 200 行
 *   - 入力検証: 不正な値は 400 で、app_logs には触れない
 *   - エラー: DB の失敗は 500 (時間切れは 504)。中身は画面に出さず、原因と条件を記録する
 *   - 文面は保存されたまま返す (読み取り時には加工しない。秘密情報のマスクは書き込み時: #1171 / #1287)
 *
 * requireRole は本物 (src/lib/auth/helpers.ts) を使い、ログイン中のユーザーと user_profiles の取得だけを差し替える。
 * app_logs は、絞り込み・並べ替え・or 条件を実際に評価するフェイクに置き換える。列名は本番スキーマの app_logs
 * (supabase/baseline/prod_schema.sql) に存在するものだけを許す (存在しない列は 42703。#1306 と同じ考え方)。
 * 実際の PostgREST / PostgreSQL での確認は tests/integration/security/super-admin-logs.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaColumns } from './helpers/schema-checked-supabase';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  profile: null as {
    roles: string[] | null;
    organization_id: string | null;
    frozen_at: string | null;
    unban_at: string | null;
  } | null,
  adminClient: null as unknown,
  adminClientError: null as Error | null,
}));
const getSupabaseAdmin = vi.hoisted(() => vi.fn());
/** createLogger(...).withUser(user.id).error の呼び出し (DB エラーの記録) */
const logUserError = vi.hoisted(() => vi.fn());
/** createLogger(...).error の呼び出し (想定外の例外の記録) */
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  // requireRole が使う、ログイン中の本人の権限の client。user_profiles 以外 (app_logs など) に触れたら失敗させる
  createClient: () => ({
    auth: {
      getUser: async () =>
        state.user
          ? { data: { user: state.user }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing!' } },
    },
    from: (table: string) => {
      if (table !== 'user_profiles') throw new Error(`本人の権限の client が ${table} に触れた`);
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () =>
          state.profile ? { data: state.profile, error: null } : { data: null, error: { message: 'no rows' } },
      };
      return builder;
    },
  }),
  getSupabaseAdmin: () => getSupabaseAdmin(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logUserError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import * as logsRoute from '../src/app/api/super-admin/logs/route';

const { GET } = logsRoute;

// ─────────────────────────────────────────────────────────────────────────────
// app_logs のフェイク (PostgREST のうち、このルートが使う部分だけを再現する)
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface PgError {
  code: string;
  message: string;
}

/**
 * 日時は PostgreSQL と同じマイクロ秒の精度で比べる (Date.parse はミリ秒で丸めてしまう)。
 * 「秒 (13 桁にそろえる) + 小数部 (6 桁にそろえる)」の文字列にして、辞書順で大小を比べる。
 */
function timestampKey(value: unknown): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(value));
  if (!match) throw new Error(`フェイク: 日時として読めない値 ${String(value)}`);
  const seconds = Date.parse(`${match[1]}${match[3]}`) / 1000;
  return `${String(seconds).padStart(13, '0')}${(match[2] ?? '').padEnd(6, '0')}`;
}

/** SQL の比較。NULL が絡むと不明 (null) になり、条件を満たさない扱いにする */
function compareValues(column: string, actual: unknown, expected: unknown): number | null {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return null;
  const [a, b] = column === 'created_at' ? [timestampKey(actual), timestampKey(expected)] : [String(actual), String(expected)];
  return a < b ? -1 : a > b ? 1 : 0;
}

const OPERATORS: Record<string, (cmp: number) => boolean> = {
  eq: (cmp) => cmp === 0,
  lt: (cmp) => cmp < 0,
  lte: (cmp) => cmp <= 0,
  gt: (cmp) => cmp > 0,
  gte: (cmp) => cmp >= 0,
};

/** 括弧の外にあるカンマで区切る */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

interface Condition {
  columns: string[];
  test: (row: Row) => boolean;
}

/** `col.op.value` または `and(...)` / `or(...)` の入れ子 (PostgREST の論理演算の書き方) を読む */
function parseCondition(term: string): Condition {
  const group = /^(and|or)\(([\s\S]*)\)$/.exec(term);
  if (group) {
    const children = splitTopLevel(group[2]).map(parseCondition);
    const combine = group[1] === 'and' ? 'every' : 'some';
    return {
      columns: children.flatMap((c) => c.columns),
      test: (row) => children[combine]((c) => c.test(row)),
    };
  }
  const first = term.indexOf('.');
  const second = term.indexOf('.', first + 1);
  if (first < 0 || second < 0) throw new Error(`フェイク: 読めない条件 ${term}`);
  const column = term.slice(0, first);
  const operator = term.slice(first + 1, second);
  const value = term.slice(second + 1);
  const predicate = OPERATORS[operator];
  if (!predicate) throw new Error(`フェイク: 未対応の演算子 ${operator}`);
  return {
    columns: [column],
    test: (row) => {
      const cmp = compareValues(column, row[column], value);
      return cmp !== null && predicate(cmp);
    },
  };
}

interface FakeAppLogs {
  client: { from: (table: string) => unknown };
  /** app_logs の中身 (テストが直接足してよい) */
  rows: Row[];
  /** 実行されたクエリごとの、呼び出しの記録 */
  queries: RecordedCall[][];
  /** 次のクエリを実行せずに、このエラーで失敗させる */
  failNext(error: PgError): void;
}

function createFakeAppLogs(seed: Row[]): FakeAppLogs {
  const known = schemaColumns('app_logs');
  const rows = seed.map((row) => ({ ...row }));
  const queries: RecordedCall[][] = [];
  let injected: PgError | null = null;

  const client = {
    from(table: string) {
      if (table !== 'app_logs') throw new Error(`service role の client が想定外のテーブル ${table} に触れた`);

      const calls: RecordedCall[] = [];
      queries.push(calls);
      const conditions: Condition[] = [];
      const sorts: Array<{ column: string; ascending: boolean }> = [];
      let selected: string[] | null = null;
      let max: number | null = null;

      const record = (method: string, args: unknown[]) => calls.push({ method, args });
      const addComparison = (method: string, column: string, value: unknown) => {
        record(method, [column, value]);
        const predicate = OPERATORS[method];
        conditions.push({
          columns: [column],
          test: (row) => {
            const cmp = compareValues(column, row[column], value);
            return cmp !== null && predicate(cmp);
          },
        });
      };

      function execute(): { data: Row[] | null; error: PgError | null } {
        if (injected) {
          const error = injected;
          injected = null;
          return { data: null, error };
        }
        const used = [...(selected ?? []), ...conditions.flatMap((c) => c.columns), ...sorts.map((s) => s.column)];
        const missing = used.find((column) => !known.includes(column));
        if (missing) return { data: null, error: { code: '42703', message: `column app_logs.${missing} does not exist` } };

        let result = rows.filter((row) => conditions.every((c) => c.test(row)));
        result = [...result].sort((a, b) => {
          for (const { column, ascending } of sorts) {
            const cmp = compareValues(column, a[column], b[column]) ?? 0;
            if (cmp !== 0) return ascending ? cmp : -cmp;
          }
          return 0;
        });
        if (max !== null) result = result.slice(0, max);
        const columns = selected ?? known;
        return {
          data: result.map((row) => structuredClone(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])))),
          error: null,
        };
      }

      const builder = {
        select(list: string) {
          record('select', [list]);
          selected = list.split(',').map((s) => s.trim());
          return builder;
        },
        eq: (column: string, value: unknown) => (addComparison('eq', column, value), builder),
        gt: (column: string, value: unknown) => (addComparison('gt', column, value), builder),
        gte: (column: string, value: unknown) => (addComparison('gte', column, value), builder),
        lt: (column: string, value: unknown) => (addComparison('lt', column, value), builder),
        lte: (column: string, value: unknown) => (addComparison('lte', column, value), builder),
        or(filters: string) {
          record('or', [filters]);
          conditions.push(parseCondition(`or(${filters})`));
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          record('order', [column, options]);
          sorts.push({ column, ascending: options?.ascending ?? true });
          return builder;
        },
        limit(count: number) {
          record('limit', [count]);
          max = count;
          return builder;
        },
        then<T1, T2>(
          onFulfilled?: ((value: ReturnType<typeof execute>) => T1 | PromiseLike<T1>) | null,
          onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ) {
          return Promise.resolve().then(execute).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return {
    client,
    rows,
    queries,
    failNext(error) {
      injected = error;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 種まきと呼び出しの補助
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const BASE = Date.parse('2026-10-08T00:00:00.000Z');

/** PostgREST が timestamptz を返す形 (マイクロ秒まで、+00:00) */
function pgTimestamp(ms: number, micro = 0): string {
  return `${new Date(ms).toISOString().slice(0, 23)}${String(micro).padStart(3, '0')}+00:00`;
}

/** i が大きいほど新しく、id も大きい (新しい順 = i の大きい順) */
const logId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function log(i: number, overrides: Row = {}): Row {
  return {
    id: logId(i),
    created_at: pgTimestamp(BASE + i * 60_000),
    level: 'info',
    source: 'api-route',
    function_name: 'GET /api/example',
    user_id: null,
    request_id: null,
    message: `message ${i}`,
    error_message: null,
    error_stack: null,
    metadata: {},
    ...overrides,
  };
}

let fake: FakeAppLogs;

function seed(rows: Row[]) {
  fake = createFakeAppLogs(rows);
  state.adminClient = fake.client;
}

function asUser(roles: string[] | null, extra: Partial<NonNullable<typeof state.profile>> = {}) {
  state.user = { id: ADMIN_ID, email: 'ops@example.com' };
  state.profile = { roles, organization_id: null, frozen_at: null, unban_at: null, ...extra };
}

async function get(query = '') {
  const res = await GET(new Request(`http://localhost/api/super-admin/logs${query}`) as never);
  return { res, json: await res.json() };
}

/** 応答の行を、log(i) の i の並びにして返す */
function indexes(json: { data: Array<{ id: string }> }): number[] {
  return json.data.map((row) => Number(row.id.slice(-12)));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.adminClientError = null;
  getSupabaseAdmin.mockImplementation(() => {
    if (state.adminClientError) throw state.adminClientError;
    return state.adminClient;
  });
  asUser(['super_admin']);
  seed([log(1), log(2), log(3)]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/super-admin/logs: 認可', () => {
  it('未ログインは 401。service role の client を作らず、app_logs にも触れない', async () => {
    state.user = null;

    const { res, json } = await get();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it('プロフィールが無いユーザーは 401', async () => {
    state.profile = null;

    const { res } = await get();

    expect(res.status).toBe(401);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ['一般ユーザー', ['user']],
    ['admin (監査ログと同じく super_admin だけに限る)', ['admin']],
    ['support', ['support']],
    ['sales + finance', ['sales', 'finance']],
    ['content_moderator', ['content_moderator']],
    ['org_admin (組織の管理者)', ['org_admin']],
    ['roles が空 (user とみなす)', null],
  ])('%s は 403。service role の client を作らず、app_logs にも触れない', async (_label, roles) => {
    asUser(roles);

    const { res, json } = await get();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it('凍結中の super_admin は 403', async () => {
    asUser(['super_admin'], { frozen_at: '2026-10-01T00:00:00.000Z', unban_at: null });

    const { res } = await get();

    expect(res.status).toBe(403);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('super_admin は 200。他ロールも持っている場合も 200', async () => {
    expect((await get()).res.status).toBe(200);

    asUser(['admin', 'super_admin']);
    expect((await get()).res.status).toBe(200);
  });

  it('入力が不正でも、認可が先 (一般ユーザーが 400 で検証の中身を知れない)', async () => {
    asUser(['user']);

    const { res } = await get('?level=fatal');

    expect(res.status).toBe(403);
  });
});

describe('GET /api/super-admin/logs: 一覧', () => {
  it('新しい順に全列を返す。続きが無ければ has_more は false / next_cursor は null', async () => {
    const { res, json } = await get();

    expect(res.status).toBe(200);
    expect(indexes(json)).toEqual([3, 2, 1]);
    expect(Object.keys(json.data[0]).sort()).toEqual(
      [
        'created_at',
        'error_message',
        'error_stack',
        'function_name',
        'id',
        'level',
        'message',
        'metadata',
        'request_id',
        'source',
        'user_id',
      ].sort(),
    );
    expect(json.meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
  });

  it('ログの中身を返すので、保存させない (Cache-Control: no-store)', async () => {
    const { res } = await get();

    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('毎回 DB を読む (force-dynamic)。Next の fetch キャッシュに、古いログを返させない', () => {
    // supabase-js の GET は fetch で行われ、Next 14 は fetch の結果を既定でキャッシュする。
    // force-dynamic にすると、この route の fetch は no-store になる
    expect(logsRoute.dynamic).toBe('force-dynamic');
  });

  it('GET 以外のメソッドは公開しない (読み取り専用)', () => {
    const exported = Object.keys(logsRoute).filter((name) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(name));
    expect(exported).toEqual([]);
  });

  it('service role の client で app_logs を読む。select する列と並べ替えの列は、本番スキーマに存在する', async () => {
    await get();

    expect(getSupabaseAdmin).toHaveBeenCalledTimes(1);
    const calls = fake.queries[0];
    const select = calls.find((c) => c.method === 'select')!;
    const selected = (select.args[0] as string).split(',').map((s) => s.trim());
    const real = schemaColumns('app_logs');
    for (const column of selected) expect(real).toContain(column);
    // 画面が使う列がそろっている
    expect(selected.sort()).toEqual(
      [
        'created_at',
        'error_message',
        'error_stack',
        'function_name',
        'id',
        'level',
        'message',
        'metadata',
        'request_id',
        'source',
        'user_id',
      ].sort(),
    );
    // 新しい順。同時刻の行は id の大きい順にして、並びを一意にする
    expect(calls.filter((c) => c.method === 'order').map((c) => c.args)).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('message / error_message / error_stack / metadata は保存されたまま返す (読み取り時には加工しない)', async () => {
    const stored = {
      message: 'token=*** from [email] <script>alert(1)</script> & "quoted"',
      error_message: 'duplicate key value violates unique constraint "x_key"',
      error_stack: 'Error: boom\n    at handler (/var/task/route.js:1:1)',
      metadata: { nested: { list: [1, 'two', null] }, authorization: '***' },
    };
    seed([log(1, stored)]);

    const { json } = await get();

    expect(json.data[0]).toMatchObject(stored);
  });

  it('行が 1 件も無いときは、空の配列を返す', async () => {
    seed([]);

    const { res, json } = await get();

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(json.meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
  });
});

describe('GET /api/super-admin/logs: 絞り込み', () => {
  const rows = () => [
    log(1, { level: 'error', source: 'api-route', function_name: 'GET /api/a', user_id: USER_A, request_id: 'req_1' }),
    log(2, { level: 'warn', source: 'edge-function', function_name: 'fn-b', user_id: USER_B, request_id: 'req_2' }),
    log(3, { level: 'error', source: 'client', function_name: null, user_id: null, request_id: null }),
    log(4, { level: 'info', source: 'api-route', function_name: 'GET /api/a', user_id: USER_A, request_id: 'req_3' }),
    log(5, { level: 'error', source: 'edge-function', function_name: 'fn-b', user_id: USER_B, request_id: 'req_1' }),
    log(6, { level: 'debug', source: 'api-route', function_name: 'GET /api/a', user_id: null, request_id: 'req_4' }),
  ];

  beforeEach(() => seed(rows()));

  const eqCalls = () => fake.queries[0].filter((c) => c.method === 'eq').map((c) => c.args);

  it('絞り込みを付けなければ、条件は何も付けない', async () => {
    await get();

    expect(fake.queries[0].map((c) => c.method)).toEqual(['select', 'order', 'order', 'limit']);
  });

  it.each([
    ['level', '?level=error', [['level', 'error']], [5, 3, 1]],
    ['source', '?source=edge-function', [['source', 'edge-function']], [5, 2]],
    ['function_name (完全一致)', '?function_name=GET%20%2Fapi%2Fa', [['function_name', 'GET /api/a']], [6, 4, 1]],
    ['user_id', `?user_id=${USER_B}`, [['user_id', USER_B]], [5, 2]],
    ['request_id (完全一致)', '?request_id=req_1', [['request_id', 'req_1']], [5, 1]],
  ])('%s: その値の行だけを返す', async (_label, query, expectedEq, expectedRows) => {
    const { res, json } = await get(query);

    expect(res.status).toBe(200);
    expect(eqCalls()).toEqual(expectedEq);
    expect(indexes(json)).toEqual(expectedRows);
  });

  it('request_id は部分一致にしない (req_1 で req_10 を拾わない)', async () => {
    fake.rows.push(log(7, { request_id: 'req_10' }));

    const { json } = await get('?request_id=req_1');

    expect(indexes(json)).toEqual([5, 1]);
  });

  it('組み合わせると AND (どれか 1 つでも外れる行は出ない)', async () => {
    const both = await get(`?level=error&source=edge-function`);
    expect(indexes(both.json)).toEqual([5]);

    const three = await get(`?level=error&function_name=fn-b&user_id=${USER_B}`);
    expect(indexes(three.json)).toEqual([5]);

    const all = await get(`?level=error&source=api-route&function_name=${encodeURIComponent('GET /api/a')}&user_id=${USER_A}&request_id=req_1`);
    expect(indexes(all.json)).toEqual([1]);
    expect(fake.queries[2].filter((c) => c.method === 'eq')).toHaveLength(5);
  });

  it('条件に合う行が無い組み合わせは、空の配列 (エラーにしない)', async () => {
    const { res, json } = await get(`?level=debug&source=client`);

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(json.meta.has_more).toBe(false);
  });

  it('from / to: どちらの端も含む。範囲の外は出ない', async () => {
    const from = new Date(BASE + 2 * 60_000).toISOString();
    const to = new Date(BASE + 4 * 60_000).toISOString();

    const { json } = await get(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

    expect(indexes(json)).toEqual([4, 3, 2]);
    expect(fake.queries[0].filter((c) => ['gte', 'lte'].includes(c.method))).toEqual([
      { method: 'gte', args: ['created_at', from] },
      { method: 'lte', args: ['created_at', to] },
    ]);
  });

  it('from だけ / to だけでも効く', async () => {
    const at = encodeURIComponent(new Date(BASE + 4 * 60_000).toISOString());

    expect(indexes((await get(`?from=${at}`)).json)).toEqual([6, 5, 4]);
    expect(indexes((await get(`?to=${at}`)).json)).toEqual([4, 3, 2, 1]);
  });

  it('日時は時差付きでも指定できる (14:02+09:00 は 05:02Z)', async () => {
    // 行は 2026-10-08T00:0i:00Z。+09:00 の 09:02 は 00:02Z
    const { json } = await get(`?from=${encodeURIComponent('2026-10-08T09:02:00+09:00')}&to=${encodeURIComponent('2026-10-08T09:03:00+09:00')}`);

    expect(indexes(json)).toEqual([3, 2]);
  });

  it('日時の比較はマイクロ秒まで見る (同じミリ秒でも、to より後の行は出ない)', async () => {
    seed([
      log(1, { created_at: '2026-10-08T00:00:00.000400+00:00' }),
      log(2, { created_at: '2026-10-08T00:00:00.000900+00:00' }),
    ]);

    const { json } = await get(`?to=${encodeURIComponent('2026-10-08T00:00:00.000Z')}`);

    // 0.000400 / 0.000900 はどちらも 0.000 (to) より後
    expect(indexes(json)).toEqual([]);
  });

  it('日時の絞り込みと level などの組み合わせ', async () => {
    const from = encodeURIComponent(new Date(BASE + 2 * 60_000).toISOString());

    const { json } = await get(`?level=error&from=${from}`);

    expect(indexes(json)).toEqual([5, 3]);
  });

  it('空文字・空白だけの値は「指定なし」。知らないパラメータは無視する', async () => {
    const { res, json } = await get('?level=&source=%20%20&function_name=&user_id=&request_id=&from=&to=&cursor=&page=3&foo=bar');

    expect(res.status).toBe(200);
    expect(indexes(json)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(fake.queries[0].map((c) => c.method)).toEqual(['select', 'order', 'order', 'limit']);
  });

  it('値の前後の空白は取り除いてから比べる', async () => {
    const { json } = await get('?source=%20client%20');

    expect(eqCalls()).toEqual([['source', 'client']]);
    expect(indexes(json)).toEqual([3]);
  });

  it('値に PostgREST の記号 (カンマ・括弧・ピリオド) があっても、条件の意味を変えない', async () => {
    fake.rows.push(log(7, { function_name: 'a,b).c' }));

    const { json } = await get(`?function_name=${encodeURIComponent('a,b).c')}`);

    expect(indexes(json)).toEqual([7]);
    expect(eqCalls()).toEqual([['function_name', 'a,b).c']]);
  });
});

describe('GET /api/super-admin/logs: ページ送り', () => {
  /** 1 から n までを新しい順に 1 件ずつ並べた行 */
  const sequence = (n: number) => Array.from({ length: n }, (_, k) => log(k + 1));

  /** next_cursor が null になるまで読み、各ページの i を返す */
  async function readAllPages(query: string, maxPages = 50) {
    const pages: number[][] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const suffix: string = cursor ? `${query}${query.includes('?') ? '&' : '?'}cursor=${cursor}` : query;
      const { res, json } = await get(suffix);
      expect(res.status).toBe(200);
      pages.push(indexes(json));
      cursor = json.meta.next_cursor;
      if (!cursor) return pages;
    }
    throw new Error('ページ送りが終わらない');
  }

  it('既定は 50 件。続きがあれば has_more と next_cursor を返し、DB には limit + 1 件を頼む', async () => {
    seed(sequence(120));

    const { json } = await get();

    expect(json.data).toHaveLength(50);
    expect(indexes(json)[0]).toBe(120);
    expect(indexes(json)[49]).toBe(71);
    expect(json.meta.limit).toBe(50);
    expect(json.meta.has_more).toBe(true);
    expect(typeof json.meta.next_cursor).toBe('string');
    expect(fake.queries[0].find((c) => c.method === 'limit')!.args).toEqual([51]);
  });

  it('カーソルで最後まで読むと、全行が重複も欠落もなく新しい順に 1 回ずつ出る', async () => {
    seed(sequence(120));

    const pages = await readAllPages('?limit=50');

    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    expect(pages.flat()).toEqual(Array.from({ length: 120 }, (_, k) => 120 - k));
  });

  it('次のページの条件は「前のページの最後の行より古い」(created_at が小さい、または同時刻で id が小さい)', async () => {
    seed(sequence(5));
    const first = await get('?limit=2');
    const last = first.json.data[1];

    await get(`?limit=2&cursor=${first.json.meta.next_cursor}`);

    const or = fake.queries[1].find((c) => c.method === 'or')!;
    expect(or.args).toEqual([`created_at.lt.${last.created_at},and(created_at.eq.${last.created_at},id.lt.${last.id})`]);
  });

  it('次のページでは created_at <= カーソルの日時 も付ける (索引の範囲条件にして、深いページでも先頭から読み飛ばさない)', async () => {
    // or 条件だけだと、PostgreSQL は新しい行から順に当てはめて、カーソルより前の全行を読み飛ばす。
    // ローカルで 30 万行の 20 万行目のページを EXPLAIN すると、読み飛ばし 20 万行・29ms が 1 行・0.08ms になった
    seed(sequence(5));
    const first = await get('?limit=2');
    const last = first.json.data[1];

    await get(`?limit=2&cursor=${first.json.meta.next_cursor}`);

    expect(fake.queries[0].map((c) => c.method)).not.toContain('or');
    expect(fake.queries[0].map((c) => c.method)).not.toContain('lte');
    expect(fake.queries[1].filter((c) => c.method === 'lte')).toEqual([
      { method: 'lte', args: ['created_at', last.created_at] },
    ]);
  });

  it('ちょうど limit 件で終わるときは、続きなし (空のページを返す次のカーソルを作らない)', async () => {
    seed(sequence(100));

    const pages = await readAllPages('?limit=50');

    expect(pages.map((p) => p.length)).toEqual([50, 50]);
  });

  it('同じ時刻の行が limit をまたいでも、飛ばさず重複もしない (id の大きい順)', async () => {
    const sameTime = '2026-10-08T05:00:00+00:00'; // 小数部の無い形も混ぜる
    seed([1, 2, 3, 4, 5].map((i) => log(i, { created_at: sameTime })));

    const pages = await readAllPages('?limit=2');

    expect(pages).toEqual([[5, 4], [3, 2], [1]]);
  });

  it('ミリ秒が同じでマイクロ秒だけ違う行も、飛ばさず重複もしない (カーソルは DB が返した日時のまま)', async () => {
    seed([
      log(1, { created_at: '2026-10-08T00:00:00.123100+00:00' }),
      log(2, { created_at: '2026-10-08T00:00:00.123456+00:00' }),
      log(3, { created_at: '2026-10-08T00:00:00.123999+00:00' }),
    ]);

    const pages = await readAllPages('?limit=1');

    expect(pages).toEqual([[3], [2], [1]]);
  });

  it('絞り込みと組み合わせても、該当する行が 1 回ずつ出る', async () => {
    // 偶数番だけ error
    seed(Array.from({ length: 60 }, (_, k) => log(k + 1, { level: (k + 1) % 2 === 0 ? 'error' : 'info' })));
    const from = encodeURIComponent(new Date(BASE + 10 * 60_000).toISOString());

    const pages = await readAllPages(`?level=error&from=${from}&limit=7`);

    const expected = Array.from({ length: 60 }, (_, k) => 60 - k).filter((i) => i % 2 === 0 && i >= 10);
    expect(pages.flat()).toEqual(expected);
    expect(pages.slice(0, -1).every((p) => p.length === 7)).toBe(true);
  });

  it('to と組み合わせても、カーソルの条件と to の条件の両方が効く (created_at の上限が 2 つ付く)', async () => {
    seed(Array.from({ length: 60 }, (_, k) => log(k + 1)));
    const from = encodeURIComponent(new Date(BASE + 10 * 60_000).toISOString());
    const to = encodeURIComponent(new Date(BASE + 50 * 60_000).toISOString());

    const pages = await readAllPages(`?from=${from}&to=${to}&limit=9`);

    expect(pages.flat()).toEqual(Array.from({ length: 41 }, (_, k) => 50 - k)); // 50 から 10 まで
    expect(pages.map((p) => p.length)).toEqual([9, 9, 9, 9, 5]);
    // 2 ページ目: to と、カーソル (1 ページ目の最後の行 = 42 番目) の 2 つの上限
    const uppers = fake.queries.slice(-4)[0].filter((c) => c.method === 'lte').map((c) => c.args[1]);
    expect(uppers).toHaveLength(2);
  });

  it('読んでいる間に新しい行が入っても、次のページはずれない (ページ番号方式だと 1 ページ目の最後の行が重複する)', async () => {
    seed(sequence(10));
    const first = await get('?limit=3');
    expect(indexes(first.json)).toEqual([10, 9, 8]);

    fake.rows.push(log(11), log(12)); // 取得の途中で新しい行が入った

    const second = await get(`?limit=3&cursor=${first.json.meta.next_cursor}`);
    expect(indexes(second.json)).toEqual([7, 6, 5]);
  });

  it('limit の範囲: 最大 200。0 以下は 1、数字でなければ既定の 50、小数は切り捨て', async () => {
    seed(sequence(300));
    /** 直前のクエリで DB に頼んだ件数 */
    const requestedRows = () => fake.queries.at(-1)!.find((c) => c.method === 'limit')!.args[0];

    const exact = await get('?limit=200');
    expect(exact.json.data).toHaveLength(200);
    expect(exact.json.meta).toMatchObject({ limit: 200, has_more: true });

    // 200 を超える指定は 200 にそろえる。DB に頼むのも 201 件まで
    const tooMany = await get('?limit=1000');
    expect(tooMany.json.meta.limit).toBe(200);
    expect(tooMany.json.data).toHaveLength(200);
    expect(requestedRows()).toBe(201);

    expect((await get('?limit=0')).json.data).toHaveLength(1);
    expect((await get('?limit=-5')).json.meta.limit).toBe(1);
    expect((await get('?limit=abc')).json.meta.limit).toBe(50);
    expect((await get('?limit=')).json.meta.limit).toBe(50);
    expect((await get('?limit=7.9')).json.meta.limit).toBe(7);
  });
});

describe('GET /api/super-admin/logs: 入力検証 (400。app_logs には触れない)', () => {
  it.each([
    ['level が列挙にない', '?level=fatal', 'level'],
    ['level の大文字', '?level=ERROR', 'level'],
    ['user_id が UUID でない', '?user_id=not-a-uuid', 'user_id'],
    ['user_id が UUID より長い', `?user_id=${USER_A}0`, 'user_id'],
    ['from が日時でない', '?from=yesterday', 'from'],
    ['to が日付だけ (時刻が無い)', '?to=2026-10-08', 'to'],
    ['存在しない日 (2 月 30 日)', '?from=2026-02-30T00:00:00Z', 'from'],
    ['存在しない月', '?to=2026-13-01T00:00:00Z', 'to'],
    ['時差の無い日時', '?from=2026-10-08T00:00:00', 'from'],
    ['from が to より後', '?from=2026-10-09T00:00:00Z&to=2026-10-08T00:00:00Z', 'from'],
    ['function_name が長すぎる (201 文字)', `?function_name=${'a'.repeat(201)}`, 'function_name'],
    ['request_id が長すぎる (201 文字)', `?request_id=${'a'.repeat(201)}`, 'request_id'],
    ['source が長すぎる (65 文字)', `?source=${'a'.repeat(65)}`, 'source'],
    ['cursor が壊れている', '?cursor=not-a-cursor', 'cursor'],
    [
      'cursor の中身が絞り込みの記号を含む (or 条件を書き換えさせない)',
      `?cursor=${Buffer.from(JSON.stringify(['2026-10-08T00:00:00Z),id.not.is.null,and(id.eq.x', logId(1)])).toString('base64url')}`,
      'cursor',
    ],
  ])('%s は 400', async (_label, query, field) => {
    const { res, json } = await get(query);

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(json.error.details.fieldErrors)).toContain(field);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it('from と to が同じ日時なら通る', async () => {
    const at = encodeURIComponent(new Date(BASE + 60_000).toISOString());

    const { res, json } = await get(`?from=${at}&to=${at}`);

    expect(res.status).toBe(200);
    expect(indexes(json)).toEqual([1]);
  });
});

describe('GET /api/super-admin/logs: エラー', () => {
  it('DB の失敗は 500。エラー文は画面に出さず、原因と検索条件を記録する', async () => {
    fake.failNext({ code: '42P01', message: 'relation "public.app_logs" does not exist' });

    const { res, json } = await get(`?level=error&function_name=fn-b&limit=20`);

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('app_logs');
    expect(logUserError).toHaveBeenCalledWith(
      'アプリログの取得に失敗',
      expect.any(Error),
      expect.objectContaining({ pg_code: '42P01', level: 'error', function_name: 'fn-b', limit: 20 }),
    );
    // postgrest-js の error は Error ではない素のオブジェクトで、そのまま渡すと db-logger が '[object Object]' を書く
    expect(logUserError.mock.calls[0][1]).toHaveProperty('message', 'relation "public.app_logs" does not exist');
  });

  it('DB の時間切れ (57014) は 504 で、期間を絞るよう伝える。request_id には索引が無いので起こりうる', async () => {
    fake.failNext({ code: '57014', message: 'canceling statement due to statement timeout' });

    const { res, json } = await get('?request_id=req_unindexed');

    expect(res.status).toBe(504);
    expect(json.error.code).toBe('QUERY_TIMEOUT');
    expect(json.error.message).toContain('期間');
    expect(JSON.stringify(json)).not.toContain('statement timeout');
    expect(logUserError).toHaveBeenCalledWith(
      'アプリログの取得に失敗',
      expect.any(Error),
      expect.objectContaining({ pg_code: '57014', request_id: 'req_unindexed' }),
    );
  });

  it('service role の設定が無い (client を作れない) ときは 500。中身は出さず記録する', async () => {
    const boom = new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    state.adminClientError = boom;

    const { res, json } = await get();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('SERVICE_ROLE');
    expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it('DB が返した行の日時が想定外の形でカーソルにできないときは、黙って打ち切らずに 500 にして記録する', async () => {
    // 続きがある (2 行返る) 状態で、最後に返す行の created_at が読めない形。次のページの 400 を待たず、ここで失敗させる
    const rows = [log(2, { created_at: 'garbage' }), log(1)];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'limit']) builder[method] = () => builder;
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
    state.adminClient = { from: () => builder };

    const { res, json } = await get('?limit=1');

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(logError).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });
});
