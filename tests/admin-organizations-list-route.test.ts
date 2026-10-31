/**
 * 運営の組織の一覧 GET /api/admin/organizations の route テスト (#1912 の続き)
 * operator/02-api-spec.md の GET /api/admin/organizations
 *
 * 確かめること:
 *  - 件数より後ろのページ (最後のページの唯一の行が消えたあと、同じページで読み直したときなど) は、PostgREST が
 *    416 (PGRST103) を返す。これを 200 の「0 件」(total 0) にせず、空のページと本当の件数を返す
 *    (画面は件数から最後のページへ取り直す)。件数は一覧と同じ絞り込み (組織名・プラン) で数え直す。
 *    ローカルの Supabase では 416 の本文が切れて code が取れないことがあるので、HTTP の 416 だけでも同じ扱い
 *  - 件数も数え直せなければ 500
 *  - それ以外の読み出しの失敗・想定外の例外は、200 の空の一覧にせず 500 (画面が「組織はまだありません」と見分けられるように)
 *  - 普通の読み出しは 200 で行と件数を返す (絞り込み・範囲・並び順はこれまでどおり)
 *  - 一覧と件数は service_role で読む (organizations の SELECT のポリシーは所属している人の行だけで、運営の client では
 *    自分の組織しか読めず、一覧が欠けていた。#2112 Z2。実 DB では tests/integration/security/org-create-atomic.test.ts の OC-10)
 *  - 行はオーナーの id (owner_id) も返す (画面が、作成の応答を受け取れなかったあとの確かめでオーナーも比べる。#2112 Z2)
 *  - 組織名の検索 (q) の % と _ (と \) は文字どおりに一致させる (「100%」で全部の組織に当てない。#2112 Z2)
 *
 * PostgREST の呼び出しは、ここで作る小さな偽物 (fakeOrganizationsClient) が受ける。偽物は route が組み立てた
 * クエリ (列・件数の数え方・head・絞り込み・範囲・並び順) を記録し、テストが決めた応答を返す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedQuery {
  table: string;
  columns: string;
  count: string | undefined;
  head: boolean;
  ilike: Array<[string, string]>;
  eq: Array<[string, unknown]>;
  range: [number, number] | null;
  order: Array<[string, { ascending?: boolean; nullsFirst?: boolean } | undefined]>;
}

interface QueryResult {
  data: unknown[] | null;
  error: { code?: string; message: string } | null;
  count: number | null;
  status: number;
}

/** 記録したクエリ (送った順) */
let queries: RecordedQuery[] = [];
/** i 回目のクエリへの応答を決める (送った順・0 始まり) */
let respond: (query: RecordedQuery, index: number) => QueryResult | Promise<QueryResult>;

function fakeOrganizationsClient() {
  return {
    from(table: string) {
      const rec: RecordedQuery = { table, columns: '', count: undefined, head: false, ilike: [], eq: [], range: null, order: [] };
      const builder = {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          rec.columns = columns;
          rec.count = options?.count;
          rec.head = options?.head === true;
          return builder;
        },
        ilike(column: string, pattern: string) {
          rec.ilike.push([column, pattern]);
          return builder;
        },
        eq(column: string, value: unknown) {
          rec.eq.push([column, value]);
          return builder;
        },
        range(from: number, to: number) {
          rec.range = [from, to];
          return builder;
        },
        order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
          rec.order.push([column, options]);
          return builder;
        },
        then<T1, T2>(onFulfilled?: (value: QueryResult) => T1 | PromiseLike<T1>, onRejected?: (reason: unknown) => T2 | PromiseLike<T2>) {
          const index = queries.length;
          queries.push(rec);
          return Promise.resolve()
            .then(() => respond(rec, index))
            .then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000001' })),
}));

// 一覧は service_role で読む (organizations の SELECT のポリシーは所属している人の行だけで、運営の client では自分の組織しか読めない。#2112 Z2)。
// 運営の client (createClient) で読むと、このテストは失敗する
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('GET は運営の client で organizations を読まない (所属している組織しか見えない)');
  },
  getSupabaseAdmin: () => fakeOrganizationsClient(),
}));

const route = await import('@/app/api/admin/organizations/route');

const LIST_COLUMNS = 'id, name, plan, owner_id, created_at, updated_at';

function row(n: number) {
  return {
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
    name: `組織${n}`,
    plan: 'standard',
    owner_id: `${String(n).padStart(8, '0')}-1111-4000-8000-000000000000`,
    created_at: '2026-10-08T04:30:00.000Z',
    updated_at: '2026-10-08T04:30:00.000Z',
  };
}

const ok = (data: unknown[] | null, count: number | null): QueryResult => ({ data, error: null, count, status: 200 });
const fail = (status: number, error: { code?: string; message: string }): QueryResult => ({ data: null, error, count: null, status });
/** PostgREST が件数より後ろのページで返す 416 */
const RANGE_NOT_SATISFIABLE = fail(416, {
  code: 'PGRST103',
  message: 'Requested range not satisfiable',
});

async function get(search = '') {
  const res = await route.GET(new Request(`http://localhost/api/admin/organizations${search}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  queries = [];
  respond = () => ok([], 0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/admin/organizations: 普通の読み出し', () => {
  it('絞り込み (組織名の部分一致・プラン)・範囲・新しい順で読み、行と件数を 200 で返す', async () => {
    respond = () => ok([row(31), row(32)], 32);
    const { status, body } = await get('?q=テスト&plan=premium&page=2&per_page=30');

    expect(status).toBe(200);
    expect(body).toEqual({ organizations: [row(31), row(32)], meta: { total: 32, page: 2, per_page: 30 } });
    expect(queries).toEqual([
      {
        table: 'organizations',
        columns: LIST_COLUMNS,
        count: 'exact',
        head: false,
        ilike: [['name', '%テスト%']],
        eq: [['plan', 'premium']],
        range: [30, 59],
        // 作った日時の新しい順。同じ日時は id の順で、ページの境目でも順が変わらない (#2139 T1)
        order: [
          ['created_at', { ascending: false, nullsFirst: true }],
          ['id', { ascending: true, nullsFirst: false }],
        ],
      },
    ]);
  });

  it('条件が無ければ絞り込みを付けず、既定の 1 ページ目 (30 件) を読む', async () => {
    respond = () => ok([row(1)], 1);
    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.meta).toEqual({ total: 1, page: 1, per_page: 30 });
    expect(queries[0].ilike).toEqual([]);
    expect(queries[0].eq).toEqual([]);
    expect(queries[0].range).toEqual([0, 29]);
  });
});

describe('GET /api/admin/organizations: 組織名の検索の % と _ (#2112 Z2)', () => {
  it.each([
    ['%', '%\\%%'],
    ['100%', '%100\\%%'],
    ['a_b', '%a\\_b%'],
    ['a\\b', '%a\\\\b%'],
    ['株式会社テスト', '%株式会社テスト%'],
  ])('q=%s は、ワイルドカード (%% _) とエスケープの文字を文字どおりに一致させる形 (%s) で絞り込む (q=%% で全部の組織にしない)', async (q, pattern) => {
    respond = () => ok([], 0);
    const { status } = await get(`?${new URLSearchParams({ q }).toString()}`);

    expect(status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].ilike).toEqual([['name', pattern]]);
  });

  it('件数より後ろのページで件数を数え直すときも、同じエスケープの絞り込みで数える', async () => {
    respond = (_query, index) => (index === 0 ? RANGE_NOT_SATISFIABLE : ok(null, 1));
    const { status } = await get(`?${new URLSearchParams({ q: '100%', page: '2' }).toString()}`);

    expect(status).toBe(200);
    expect(queries.map((query) => query.ilike)).toEqual([
      [['name', '%100\\%%']],
      [['name', '%100\\%%']],
    ]);
  });
});

describe('GET /api/admin/organizations: 件数より後ろのページ (416)', () => {
  it('416 (PGRST103) なら、同じ絞り込みで件数だけを数え直し、空のページと本当の件数を 200 で返す', async () => {
    respond = (_query, index) => (index === 0 ? RANGE_NOT_SATISFIABLE : ok(null, 30));
    const { status, body } = await get('?q=テスト&plan=enterprise&page=2&per_page=30');

    expect(status).toBe(200);
    expect(body).toEqual({ organizations: [], meta: { total: 30, page: 2, per_page: 30 } });
    expect(queries).toHaveLength(2);
    // 数え直しは行を読まず (head)、一覧と同じ絞り込みで数える (範囲は付けない)
    expect(queries[1]).toEqual({
      table: 'organizations',
      columns: LIST_COLUMNS,
      count: 'exact',
      head: true,
      ilike: [['name', '%テスト%']],
      eq: [['plan', 'enterprise']],
      range: null,
      order: [],
    });
  });

  it('本文が切れて code が取れない 416 でも、HTTP のステータスで同じ扱いにする', async () => {
    respond = (_query, index) => (index === 0 ? fail(416, { message: '{"' }) : ok(null, 0));
    const { status, body } = await get('?page=3');

    expect(status).toBe(200);
    expect(body).toEqual({ organizations: [], meta: { total: 0, page: 3, per_page: 30 } });
  });

  it('ステータスが取れず code だけが PGRST103 のときも同じ扱いにする', async () => {
    respond = (_query, index) =>
      index === 0 ? fail(0, { code: 'PGRST103', message: 'Requested range not satisfiable' }) : ok(null, 12);
    const { status, body } = await get('?page=2');

    expect(status).toBe(200);
    expect(body.meta).toEqual({ total: 12, page: 2, per_page: 30 });
  });

  it('件数の数え直しが失敗したら (エラー・件数なし・例外)、空の一覧にせず 500', async () => {
    const countFailures: Array<() => QueryResult> = [
      () => fail(500, { code: 'XX000', message: 'boom' }),
      () => ok(null, null),
      () => {
        throw new Error('network');
      },
    ];
    for (const countFailure of countFailures) {
      queries = [];
      respond = (_query, index) => (index === 0 ? RANGE_NOT_SATISFIABLE : countFailure());
      const { status, body } = await get('?page=2');

      expect(status).toBe(500);
      expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '組織の一覧を取得できませんでした' } });
      expect(queries).toHaveLength(2);
    }
  });
});

describe('GET /api/admin/organizations: 読み出しの失敗', () => {
  it('416 以外の失敗は、200 の空の一覧 (total 0) にせず 500 で返し、件数の数え直しもしない', async () => {
    respond = () => fail(500, { code: '57014', message: 'canceling statement due to statement timeout' });
    const { status, body } = await get('?page=2');

    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '組織の一覧を取得できませんでした' } });
    expect(body).not.toHaveProperty('organizations');
    expect(queries).toHaveLength(1);
  });

  it('想定外の例外も、空の一覧にせず 500 で返す', async () => {
    respond = () => {
      throw new Error('fetch failed');
    };
    const { status, body } = await get();

    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '組織の一覧を取得できませんでした' } });
  });
});
