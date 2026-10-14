/**
 * GET /api/admin/finance/nps — NPS / CSAT 集計 (#1217)
 *
 * 修正前: nps_surveys と csat_feedbacks の該当行を全部読み込み (件数の上限なし)、JavaScript で数えていた。
 *   行が増えるほど遅くなり、API の最大行数 (Supabase の既定は 1000 行) を超えると集計が黙って切り詰められた。
 * 修正後:
 *   - 件数・合計・分布は DB の関数 (get_nps_summary / get_csat_summary) が数える。route は期間・プランを渡すだけ。
 *   - 直近の一覧 (recent_comments / recent_feedbacks) は新しい順に LIMIT 10 で取る。全件は読まない。
 *   - レスポンスの形と、平均・NPS スコア・回答率の丸めは以前と同じ。
 *   - 関数や一覧の取得に失敗したら、欠けた数字を 0 として返さず、ログに残して 500 を返す。
 *   - 401 / 403 の返し方は変えない。
 *
 * #1311: 許可するロールを admin / super_admin だけにした (財務ロール finance は外した)。
 *   finance は入口で 403 になり、DB には何も問い合わせない。admin / super_admin は今までどおり 200。
 *   RLS (csat_access / nps_select_admin) は変えていない。
 *
 * #1433: 期間 (from / to。画面の日付の入力。どちらの日も含む) を JST の暦日で絞る。
 *   以前は日付の文字列をそのまま sent_at / created_at (timestamptz) の .gte / .lte と関数の p_from / p_to に渡していて、
 *   DB は UTC の 0 時 (= JST 9 時) と読むので、開始日の JST 0:00〜8:59 の行が落ち、終了日は JST 9:00 で打ち切られていた。
 *   - 一覧: 開始日の JST 0 時以上 (.gte)・終了日の翌日の JST 0 時未満 (.lt)
 *   - 集計の関数 (両端を含む `>= p_from AND <= p_to`): p_from = 開始日の JST 0 時、p_to = 終了日の翌日の JST 0 時の 1 マイクロ秒前
 *   - 存在しない日付・時刻つきの値は 400 (DB に問い合わせない)。空文字は今までどおり「指定なし」
 *
 * Supabase クライアントはモック。関数の中身 (SQL) と RLS は
 * tests/integration/rls/csat-nps-summary-rpc.test.ts、route 全体の結果は
 * tests/integration/security/admin-finance-nps-route.test.ts で、実 DB を使って検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '../src/lib/auth/errors';
import { legacyCsatSummary, legacyNpsSummary } from './helpers/legacy-nps-summary';
import { TEST_TIME_ZONES, withTimeZoneAsync } from './helpers/time-zones';
import { JST_1010_BOUNDARY_TIMES, microsOf, satisfiesRangeFilters, type RangeFilter } from './helpers/timestamptz';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

interface Chain {
  table: string;
  calls: ChainCall[];
}

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  loggerError: vi.fn(),
  /** from() を呼ぶたびに 1 件ずつ増える (呼んだテーブルと、そのあとに呼んだメソッド) */
  chains: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
  /** テーブルごとの「一覧」の取得結果 */
  tableResults: {} as Record<string, { data: unknown; error: unknown }>,
}));

/** PostgrestFilterBuilder 相当: どのメソッドでも自分自身を返し、await すると tableResults で解決する */
function makeBuilder(table: string) {
  const chain: Chain = { table, calls: [] };
  mocks.chains.push(chain);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) =>
            resolve(mocks.tableResults[table] ?? { data: [], error: null });
        }
        return (...args: unknown[]) => {
          chain.calls.push({ method: String(prop), args });
          return builder;
        };
      },
    },
  );
  return builder;
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: mocks.rpc,
  }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError }),
  }),
  generateRequestId: () => 'req_test',
}));

import { GET } from '../src/app/api/admin/finance/nps/route';

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

/** get_nps_summary の戻り値 1 行。スコアの内訳: 10,9,9,10 / 8,7,8 / 6 (合計 67) */
const NPS_ROW = {
  sent_count: 12,
  total_responses: 8,
  promoters: 4,
  passives: 3,
  detractors: 1,
  score_sum: 67,
};

/** get_csat_summary の戻り値 1 行。スコアの内訳: 1,3,4,4,5,5 (合計 22) */
const CSAT_ROW = {
  total_responses: 6,
  score_sum: 22,
  score_1_count: 1,
  score_2_count: 0,
  score_3_count: 1,
  score_4_count: 2,
  score_5_count: 2,
};

const NPS_RECENT = [
  { id: 'n2', score: 9, comment: '使いやすい', plan_key: 'pro', responded_at: '2026-03-05T10:00:00+00:00' },
  { id: 'n1', score: 4, comment: null, plan_key: null, responded_at: '2026-03-01T10:00:00+00:00' },
];

const CSAT_RECENT = [
  { id: 'c2', score: 5, comment: '助かりました', ticket_id: 't-1', created_at: '2026-03-06T10:00:00+00:00' },
  { id: 'c1', score: 1, comment: null, ticket_id: null, created_at: '2026-03-02T10:00:00+00:00' },
];

function actor(...roles: string[]) {
  return { id: 'actor-id', email: 'actor@example.com', roles, organization_id: null };
}

function req(query = '') {
  return new NextRequest(`http://localhost/api/admin/finance/nps${query}`);
}

interface NpsBody {
  data: {
    nps: Record<string, unknown> & { recent_comments: unknown[] };
    csat: Record<string, unknown> & { recent_feedbacks: unknown[]; score_distribution: Record<string, number> };
  };
}

/** from(table) の呼び出し (1 回につき 1 チェーン) を返す */
function chainsOf(table: string): Chain[] {
  return mocks.chains.filter((c) => c.table === table);
}

function callsOf(chain: Chain, method: string): unknown[][] {
  return chain.calls.filter((c) => c.method === method).map((c) => c.args);
}

/** RPC の戻り値を差し替える (TABLE を返す関数は 1 行の配列で返る) */
function setRpcRows(nps: unknown, csat: unknown) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_nps_summary') return { data: nps, error: null };
    if (name === 'get_csat_summary') return { data: csat, error: null };
    return { data: null, error: { code: '42883', message: `unexpected rpc ${name}` } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chains.length = 0;
  mocks.tableResults = {
    nps_surveys: { data: NPS_RECENT, error: null },
    csat_feedbacks: { data: CSAT_RECENT, error: null },
  };
  mocks.requireRole.mockResolvedValue(actor('admin'));
  setRpcRows([NPS_ROW], [CSAT_ROW]);
});

// ═════════════════════════════════════════════════════════════════════════════
// レスポンスの形 (以前と同じ)
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/finance/nps — レスポンス', () => {
  it('DB の関数の戻り値と直近の一覧から、以前と同じ形のレスポンスを組み立てる', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        nps: {
          total_responses: 8,
          promoters: 4,
          passives: 3,
          detractors: 1,
          nps_score: 37.5, // (4 - 1) / 8 * 100
          avg_score: 8.4, // 67 / 8 = 8.375 → 小数第 1 位に丸め
          response_rate: 66.7, // 回答 8 / 送信 12 = 66.666...%
          recent_comments: [
            { id: 'n2', score: 9, comment: '使いやすい', plan_key: 'pro', responded_at: '2026-03-05T10:00:00+00:00' },
            { id: 'n1', score: 4, comment: null, plan_key: null, responded_at: '2026-03-01T10:00:00+00:00' },
          ],
        },
        csat: {
          total_responses: 6,
          avg_score: 3.7, // 22 / 6 = 3.666...
          score_distribution: { '1': 1, '2': 0, '3': 1, '4': 2, '5': 2 },
          recent_feedbacks: [
            { id: 'c2', score: 5, comment: '助かりました', ticket_id: 't-1', created_at: '2026-03-06T10:00:00+00:00' },
            { id: 'c1', score: 1, comment: null, ticket_id: null, created_at: '2026-03-02T10:00:00+00:00' },
          ],
        },
      },
    });
  });

  it('一覧の各行は、画面が使う列だけを返す (取得結果に余分な列があっても出さない)', async () => {
    mocks.tableResults = {
      nps_surveys: { data: [{ ...NPS_RECENT[0], user_id: 'secret-user', sent_at: 'x' }], error: null },
      csat_feedbacks: { data: [{ ...CSAT_RECENT[0], user_id: 'secret-user' }], error: null },
    };
    const body = (await (await GET(req())).json()) as NpsBody;
    expect(Object.keys(body.data.nps.recent_comments[0] as object).sort()).toEqual([
      'comment',
      'id',
      'plan_key',
      'responded_at',
      'score',
    ]);
    expect(Object.keys(body.data.csat.recent_feedbacks[0] as object).sort()).toEqual([
      'comment',
      'created_at',
      'id',
      'score',
      'ticket_id',
    ]);
  });

  it('0 件のときは全部 0 (0 で割らない)。星 1〜5 の分布は 0 で埋まる', async () => {
    setRpcRows(
      [{ sent_count: 0, total_responses: 0, promoters: 0, passives: 0, detractors: 0, score_sum: 0 }],
      [{ total_responses: 0, score_sum: 0, score_1_count: 0, score_2_count: 0, score_3_count: 0, score_4_count: 0, score_5_count: 0 }],
    );
    mocks.tableResults = {
      nps_surveys: { data: [], error: null },
      csat_feedbacks: { data: [], error: null },
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        nps: {
          total_responses: 0,
          promoters: 0,
          passives: 0,
          detractors: 0,
          nps_score: 0,
          avg_score: 0,
          response_rate: 0,
          recent_comments: [],
        },
        csat: {
          total_responses: 0,
          avg_score: 0,
          score_distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
          recent_feedbacks: [],
        },
      },
    });
  });

  it('送信はあるが回答が 0 件のとき、回答率は 0 (NaN にならない)', async () => {
    setRpcRows(
      [{ sent_count: 5, total_responses: 0, promoters: 0, passives: 0, detractors: 0, score_sum: 0 }],
      [CSAT_ROW],
    );
    const body = (await (await GET(req())).json()) as NpsBody;
    expect(body.data.nps.response_rate).toBe(0);
    expect(body.data.nps.nps_score).toBe(0);
    expect(body.data.nps.avg_score).toBe(0);
  });

  it('NPS が負になる (批判者のほうが多い) とき、以前と同じ丸めになる', async () => {
    // 回答 16 件 (中立 15・批判者 1)、推奨者 0 → -6.25。Math.round(-62.5) は -62 なので -6.2 (以前の画面と同じ。
    // SQL の round() だと -6.3 になるため、丸めは DB に移さず TS に残している)
    const scores = [...Array.from({ length: 15 }, () => ({ score: 7 })), { score: 6 }];
    setRpcRows(
      [{ sent_count: 16, total_responses: 16, promoters: 0, passives: 15, detractors: 1, score_sum: 111 }],
      [CSAT_ROW],
    );
    const body = (await (await GET(req())).json()) as NpsBody;
    expect(body.data.nps.nps_score).toBe(-6.2);
    expect(body.data.nps.nps_score).toBe(legacyNpsSummary(scores, 16).nps_score);
  });

  it('一覧が 10 件を超えて返ってきても、レスポンスは 10 件までにする', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      score: 8,
      comment: null,
      plan_key: null,
      responded_at: '2026-03-01T10:00:00+00:00',
    }));
    mocks.tableResults = {
      nps_surveys: { data: many, error: null },
      csat_feedbacks: { data: CSAT_RECENT, error: null },
    };
    const body = (await (await GET(req())).json()) as NpsBody;
    expect(body.data.nps.recent_comments).toHaveLength(10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 集計は DB の関数、一覧は LIMIT 10
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/finance/nps — DB への問い合わせ', () => {
  it('期間 (JST の暦日の時刻) とプランを DB の関数に渡す (NPS はプランも、CSAT は期間だけ) (#1433)', async () => {
    await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    // 開始日 3/1 の JST 0 時 = 2/28 15:00 (UTC)、終了日 3/31 の最後の瞬間 = 4/1 の JST 0 時の 1 マイクロ秒前
    expect(mocks.rpc).toHaveBeenCalledWith('get_nps_summary', {
      p_from: '2026-02-28T15:00:00.000Z',
      p_to: '2026-03-31T14:59:59.999999Z',
      p_plan_key: 'pro',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', {
      p_from: '2026-02-28T15:00:00.000Z',
      p_to: '2026-03-31T14:59:59.999999Z',
    });
  });

  it('指定が無いときは NULL (= 絞らない) を渡す', async () => {
    await GET(req());
    expect(mocks.rpc).toHaveBeenCalledWith('get_nps_summary', { p_from: null, p_to: null, p_plan_key: null });
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', { p_from: null, p_to: null });
  });

  it('空文字は「指定なし」として NULL にする (以前の if (query.from) と同じ)', async () => {
    await GET(req('?from=&to=&plan_key='));
    expect(mocks.rpc).toHaveBeenCalledWith('get_nps_summary', { p_from: null, p_to: null, p_plan_key: null });
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', { p_from: null, p_to: null });
    // 一覧にも絞り込みは付かない
    for (const chain of mocks.chains) {
      expect(callsOf(chain, 'gte')).toEqual([]);
      expect(callsOf(chain, 'lt')).toEqual([]);
      expect(callsOf(chain, 'lte')).toEqual([]);
      expect(callsOf(chain, 'eq')).toEqual([]);
    }
  });

  it('NPS の一覧: 回答済みだけ・送信日の期間 (JST の暦日)・プランで絞り、回答日の新しい順に 10 件だけ取る', async () => {
    await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    const chains = chainsOf('nps_surveys');
    expect(chains).toHaveLength(1);
    const chain = chains[0];
    expect(callsOf(chain, 'select')).toEqual([['id, score, comment, plan_key, responded_at']]);
    expect(callsOf(chain, 'not')).toEqual([['responded_at', 'is', null]]);
    // 開始日 3/1 の JST 0 時以上・終了日 3/31 の翌日 (4/1) の JST 0 時未満 (#1433)
    expect(callsOf(chain, 'gte')).toEqual([['sent_at', '2026-02-28T15:00:00.000Z']]);
    expect(callsOf(chain, 'lt')).toEqual([['sent_at', '2026-03-31T15:00:00.000Z']]);
    expect(callsOf(chain, 'lte')).toEqual([]);
    expect(callsOf(chain, 'eq')).toEqual([['plan_key', 'pro']]);
    expect(callsOf(chain, 'order')).toEqual([['responded_at', { ascending: false }]]);
    expect(callsOf(chain, 'limit')).toEqual([[10]]);
  });

  it('CSAT の一覧: 作成日の期間 (JST の暦日) で絞り (プランでは絞らない)、作成日の新しい順に 10 件だけ取る', async () => {
    await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    const chains = chainsOf('csat_feedbacks');
    expect(chains).toHaveLength(1);
    const chain = chains[0];
    expect(callsOf(chain, 'select')).toEqual([['id, score, comment, ticket_id, created_at']]);
    expect(callsOf(chain, 'gte')).toEqual([['created_at', '2026-02-28T15:00:00.000Z']]);
    expect(callsOf(chain, 'lt')).toEqual([['created_at', '2026-03-31T15:00:00.000Z']]);
    expect(callsOf(chain, 'lte')).toEqual([]);
    expect(callsOf(chain, 'eq')).toEqual([]);
    expect(callsOf(chain, 'order')).toEqual([['created_at', { ascending: false }]]);
    expect(callsOf(chain, 'limit')).toEqual([[10]]);
  });

  it('表を読む問い合わせは 2 本だけで、どちらも LIMIT 10 が付く (全行を読む作りに戻らない)', async () => {
    await GET(req());
    expect(mocks.chains.map((c) => c.table).sort()).toEqual(['csat_feedbacks', 'nps_surveys']);
    for (const chain of mocks.chains) {
      expect(callsOf(chain, 'limit')).toEqual([[10]]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 期間は JST の暦日 (#1433)
// ═════════════════════════════════════════════════════════════════════════════

/** 一覧の問い合わせ (from(table) のチェーン) に付いた、列 column の範囲の絞り込み */
function rangeFiltersOf(table: string, column: string): RangeFilter[] {
  return chainsOf(table).flatMap((chain) =>
    chain.calls
      .filter((c) => ['gte', 'gt', 'lte', 'lt'].includes(c.method) && c.args[0] === column)
      .map((c) => ({ method: c.method as RangeFilter['method'], value: String(c.args[1]) })),
  );
}

/** DB の関数の期間の条件 (`列 >= coalesce(p_from, -infinity) AND 列 <= coalesce(p_to, infinity)`) を、範囲の絞り込みの形にする */
function rpcRangeFilters(name: 'get_nps_summary' | 'get_csat_summary'): RangeFilter[] {
  const call = mocks.rpc.mock.calls.find((c) => c[0] === name);
  expect(call, `${name} が呼ばれていない`).toBeDefined();
  const args = call![1] as { p_from: string | null; p_to: string | null };
  const filters: RangeFilter[] = [];
  if (args.p_from !== null) filters.push({ method: 'gte', value: args.p_from });
  if (args.p_to !== null) filters.push({ method: 'lte', value: args.p_to });
  return filters;
}

/** 境界の時刻のうち、絞り込みで残るもの (id) */
function idsKeptBy(filters: readonly RangeFilter[]): string[] {
  return JST_1010_BOUNDARY_TIMES.filter((row) => satisfiesRangeFilters(row.at, filters)).map((row) => row.id);
}

const JST_1010_IDS = JST_1010_BOUNDARY_TIMES.filter((row) => row.inJst1010).map((row) => row.id);

describe('GET /api/admin/finance/nps — 期間は JST の暦日 (#1433)', () => {
  it.each(TEST_TIME_ZONES)(
    'TZ=%s でも、from=to=10/10 は一覧・集計とも JST 10/10 0:00 〜 23:59:59.999999 の行だけ (JST 0:00 ちょうど・8:59:59 は入り、翌日の 0:00 は入らない)',
    async (tz) => {
      const res = await withTimeZoneAsync(tz, () => GET(req('?from=2026-10-10&to=2026-10-10')));
      expect(res.status).toBe(200);

      // 一覧 (自分で組み立てる問い合わせ): .gte と .lt
      expect(rangeFiltersOf('nps_surveys', 'sent_at')).toEqual([
        { method: 'gte', value: '2026-10-09T15:00:00.000Z' },
        { method: 'lt', value: '2026-10-10T15:00:00.000Z' },
      ]);
      expect(rangeFiltersOf('csat_feedbacks', 'created_at')).toEqual([
        { method: 'gte', value: '2026-10-09T15:00:00.000Z' },
        { method: 'lt', value: '2026-10-10T15:00:00.000Z' },
      ]);
      // 集計の関数 (両端を含む): 終了日の最後の瞬間 (翌日の JST 0 時の 1 マイクロ秒前)
      expect(rpcRangeFilters('get_nps_summary')).toEqual([
        { method: 'gte', value: '2026-10-09T15:00:00.000Z' },
        { method: 'lte', value: '2026-10-10T14:59:59.999999Z' },
      ]);
      expect(rpcRangeFilters('get_csat_summary')).toEqual(rpcRangeFilters('get_nps_summary'));

      // 実際に残る行 (timestamptz と同じくマイクロ秒の精度で比べる)。一覧と集計で同じ行を数える
      for (const filters of [
        rangeFiltersOf('nps_surveys', 'sent_at'),
        rangeFiltersOf('csat_feedbacks', 'created_at'),
        rpcRangeFilters('get_nps_summary'),
        rpcRangeFilters('get_csat_summary'),
      ]) {
        expect(idsKeptBy(filters)).toEqual(JST_1010_IDS);
      }
    },
  );

  it('以前の書き方 (日付の文字列をそのまま .gte / .lte と関数に渡す) では、JST 10/10 0:00〜8:59 と 9:00 以降の行が落ちていた (直した不具合)', () => {
    const legacy: RangeFilter[] = [
      { method: 'gte', value: '2026-10-10T00:00:00Z' }, // DB は '2026-10-10' を UTC の 0 時と読む
      { method: 'lte', value: '2026-10-10T00:00:00Z' },
    ];
    expect(idsKeptBy(legacy)).toEqual(['jst-10-10-09:00']);
  });

  it('from だけ: 開始日の JST 0 時以上 (上限なし)。関数の p_to は NULL', async () => {
    await GET(req('?from=2026-10-10'));
    expect(rangeFiltersOf('nps_surveys', 'sent_at')).toEqual([{ method: 'gte', value: '2026-10-09T15:00:00.000Z' }]);
    expect(rangeFiltersOf('csat_feedbacks', 'created_at')).toEqual([{ method: 'gte', value: '2026-10-09T15:00:00.000Z' }]);
    expect(mocks.rpc).toHaveBeenCalledWith('get_nps_summary', {
      p_from: '2026-10-09T15:00:00.000Z',
      p_to: null,
      p_plan_key: null,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', { p_from: '2026-10-09T15:00:00.000Z', p_to: null });
  });

  it('to だけ: 終了日の翌日の JST 0 時未満 (下限なし)。関数の p_from は NULL、p_to は終了日の最後の瞬間', async () => {
    await GET(req('?to=2026-10-10'));
    expect(rangeFiltersOf('nps_surveys', 'sent_at')).toEqual([{ method: 'lt', value: '2026-10-10T15:00:00.000Z' }]);
    expect(rangeFiltersOf('csat_feedbacks', 'created_at')).toEqual([{ method: 'lt', value: '2026-10-10T15:00:00.000Z' }]);
    expect(mocks.rpc).toHaveBeenCalledWith('get_nps_summary', {
      p_from: null,
      p_to: '2026-10-10T14:59:59.999999Z',
      p_plan_key: null,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', { p_from: null, p_to: '2026-10-10T14:59:59.999999Z' });
  });

  it.each([
    ['月末をまたぐ (10/31 〜 11/1)', '?from=2026-10-31&to=2026-11-01', '2026-10-30T15:00:00.000Z', '2026-11-01T15:00:00.000Z', '2026-11-01T14:59:59.999999Z'],
    ['年末をまたぐ (12/31 〜 1/1)', '?from=2026-12-31&to=2027-01-01', '2026-12-30T15:00:00.000Z', '2027-01-01T15:00:00.000Z', '2027-01-01T14:59:59.999999Z'],
    ['うるう日 (2/29 だけ)', '?from=2028-02-29&to=2028-02-29', '2028-02-28T15:00:00.000Z', '2028-02-29T15:00:00.000Z', '2028-02-29T14:59:59.999999Z'],
  ])('%s: 開始日の JST 0 時 〜 終了日の翌日の JST 0 時 (関数には、その 1 マイクロ秒前)', async (_label, query, from, toExclusive, toInclusive) => {
    await GET(req(query));
    expect(rangeFiltersOf('nps_surveys', 'sent_at')).toEqual([
      { method: 'gte', value: from },
      { method: 'lt', value: toExclusive },
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', { p_from: from, p_to: toInclusive });
    expect(microsOf(toExclusive) - microsOf(toInclusive)).toBe(1n);
  });

  it.each([
    '?from=2026-02-30',
    '?to=2026-13-01',
    '?from=2026/10/10',
    '?to=garbage',
    '?to=2026-03-31T23:59:59Z',
    '?from=not-a-date',
    // 実在するが受け付ける範囲 (0101-01-02〜9998-12-30) の外。翌日の JST 0 時を求められず、通すと 500 になる (#1433)
    '?to=9999-12-31',
    '?from=0100-01-01',
  ])(
    '存在しない日付・形の違う日付・時刻つきの値 (%s) は 400。DB には問い合わせない',
    async (query) => {
      const res = await GET(req(query));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.chains).toHaveLength(0);
      expect(mocks.loggerError).not.toHaveBeenCalled();
    },
  );

  it('400 より先に認可を確かめる (財務ロールは、期間の形が違っても 403)', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'Requires one of: admin, super_admin'));
    const res = await GET(req('?from=2026-02-30'));
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 以前の実装 (全行を JS で数える) と同じ数字になる
// ═════════════════════════════════════════════════════════════════════════════

/** 乱数 (seed 固定。テストが毎回同じデータで動くようにする) */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('GET /api/admin/finance/nps — 以前の JS 集計と同じ数字になる', () => {
  it('乱数のデータ 500 通りで、画面に出る数字 (件数・平均・NPS・回答率・分布) が以前と一致する', async () => {
    const rand = mulberry32(1217);
    const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

    for (let i = 0; i < 500; i += 1) {
      // 回答済みの NPS (スコア 0〜10)、未回答の送信、CSAT (スコア 1〜5)。件数は小さめにして、丸めの境界を踏みやすくする
      const npsScores = Array.from({ length: int(0, 40) }, () => int(0, 10));
      const unanswered = int(0, 15);
      const csatScores = Array.from({ length: int(0, 40) }, () => int(1, 5));

      // 「DB の関数が数えた結果」を、ここで別の書き方 (ループ) で作る
      const count = (xs: number[], pred: (s: number) => boolean) => xs.filter(pred).length;
      setRpcRows(
        [
          {
            sent_count: npsScores.length + unanswered,
            total_responses: npsScores.length,
            promoters: count(npsScores, (s) => s >= 9),
            passives: count(npsScores, (s) => s === 7 || s === 8),
            detractors: count(npsScores, (s) => s <= 6),
            score_sum: npsScores.reduce((a, b) => a + b, 0),
          },
        ],
        [
          {
            total_responses: csatScores.length,
            score_sum: csatScores.reduce((a, b) => a + b, 0),
            score_1_count: count(csatScores, (s) => s === 1),
            score_2_count: count(csatScores, (s) => s === 2),
            score_3_count: count(csatScores, (s) => s === 3),
            score_4_count: count(csatScores, (s) => s === 4),
            score_5_count: count(csatScores, (s) => s === 5),
          },
        ],
      );
      mocks.tableResults = {
        nps_surveys: { data: [], error: null },
        csat_feedbacks: { data: [], error: null },
      };

      const body = (await (await GET(req())).json()) as NpsBody;
      const { recent_comments: _nps, ...nps } = body.data.nps;
      const { recent_feedbacks: _csat, ...csat } = body.data.csat;
      void _nps;
      void _csat;

      expect(nps, `NPS (${i} 通り目)`).toEqual(
        legacyNpsSummary(
          npsScores.map((score) => ({ score })),
          npsScores.length + unanswered,
        ),
      );
      expect(csat, `CSAT (${i} 通り目)`).toEqual(legacyCsatSummary(csatScores.map((score) => ({ score }))));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 認可 (#1311: 財務ロール finance を外した。admin / super_admin は今までどおり)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 本物の requireRole と同じく、route が渡した許可ロールと本人のロールの重なりで判定する。
 * (route が許可ロールの一覧を間違えたら、ここで気づける。呼び出しの引数だけを見るテストでは分からない)
 */
function actAs(...roles: string[]) {
  mocks.requireRole.mockImplementation(async (allowedRoles: readonly string[]) => {
    if (!roles.some((role) => allowedRoles.includes(role))) {
      throw new ForbiddenError('PERM_DENIED', `Requires one of: ${allowedRoles.join(', ')}`);
    }
    return actor(...roles);
  });
}

describe('GET /api/admin/finance/nps — 認可', () => {
  it('許可するロールは admin / super_admin だけ。財務ロール (finance) は含めない (#1311)', async () => {
    await GET(req());
    expect(mocks.requireRole).toHaveBeenCalledTimes(1);
    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin']);
    expect(mocks.requireRole.mock.calls[0][0]).not.toContain('finance');
  });

  it.each([
    ['admin', ['admin']],
    ['super_admin', ['super_admin']],
    ['admin と finance の両方を持つ人', ['admin', 'finance']],
  ])('%s は 200 (今までどおり)', async (_label, roles) => {
    actAs(...roles);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as NpsBody;
    expect(body.data.nps.total_responses).toBe(8);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('財務ロール (finance) だけの人は 403。NPS / CSAT のデータは返さず、DB にも何も問い合わせない', async () => {
    actAs('finance');
    const res = await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: 'OP_PERMISSION_DENIED', message: 'Requires one of: admin, super_admin' },
    });
    // 本文にデータが混ざっていない
    expect(text).not.toContain('recent_comments');
    expect(text).not.toContain('使いやすい');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.chains).toHaveLength(0);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it.each([
    ['support (RLS は読めるが、この API は通さない。今までどおり)', ['support']],
    ['sales', ['sales']],
    ['content_moderator', ['content_moderator']],
    ['org_admin', ['user', 'org_admin']],
    ['一般ユーザー', ['user']],
  ])('%s は 403。DB には何も問い合わせない', async (_label, roles) => {
    actAs(...roles);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.chains).toHaveLength(0);
  });

  it('未認証は 401。DB には何も問い合わせない', async () => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'AUTH_UNAUTHENTICATED' } });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.chains).toHaveLength(0);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('権限なしは 403。DB には何も問い合わせない', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'Requires one of: admin, super_admin'));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'OP_PERMISSION_DENIED', message: 'Requires one of: admin, super_admin' },
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.chains).toHaveLength(0);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 失敗したら 500 (欠けた数字を 0 として返さない) + ログ
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/finance/nps — 失敗時', () => {
  const INTERNAL = { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };

  it('NPS の関数が失敗したら 500。ログに残し、DB のエラー文はレスポンスに出さない', async () => {
    const dbError = new Error('permission denied for function get_nps_summary');
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'get_nps_summary'
        ? { data: null, error: dbError }
        : { data: [CSAT_ROW], error: null },
    );
    const res = await GET(req('?from=2026-03-01&plan_key=pro'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(INTERNAL);
    expect(text).not.toContain('permission denied');

    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toEqual(expect.any(String));
    expect(error).toBe(dbError);
    expect(metadata).toEqual({
      failed_queries: ['get_nps_summary'],
      from: '2026-03-01',
      to: null,
      plan_key: 'pro',
    });
  });

  it('CSAT の関数が失敗したら 500 + ログ', async () => {
    const dbError = new Error('boom');
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'get_csat_summary'
        ? { data: null, error: dbError }
        : { data: [NPS_ROW], error: null },
    );
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(INTERNAL);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][1]).toBe(dbError);
    expect(mocks.loggerError.mock.calls[0][2]).toMatchObject({ failed_queries: ['get_csat_summary'] });
  });

  it('直近の一覧の取得が失敗したら 500 + ログ (一覧だけ空にして 200 を返さない)', async () => {
    const dbError = new Error('nps list failed');
    mocks.tableResults = {
      nps_surveys: { data: null, error: dbError },
      csat_feedbacks: { data: CSAT_RECENT, error: null },
    };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(INTERNAL);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][2]).toMatchObject({ failed_queries: ['nps_surveys (recent)'] });
  });

  it('複数が同時に失敗したら、失敗した問い合わせをすべてログに書く (1 回のログ)', async () => {
    mocks.rpc.mockImplementation(async () => ({ data: null, error: new Error('down') }));
    mocks.tableResults = {
      nps_surveys: { data: null, error: new Error('down') },
      csat_feedbacks: { data: null, error: new Error('down') },
    };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][2]).toMatchObject({
      failed_queries: ['get_nps_summary', 'nps_surveys (recent)', 'get_csat_summary', 'csat_feedbacks (recent)'],
    });
  });

  it('関数が 0 行を返した (想定外) ときは 500 + ログ。0 件として返さない', async () => {
    setRpcRows([], [CSAT_ROW]);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(INTERNAL);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it('関数の戻り値の形が想定と違う (列が欠けている・文字列・負数) ときは 500 + ログ', async () => {
    const bad = [
      [{ ...NPS_ROW, promoters: undefined }],
      [{ ...NPS_ROW, promoters: '4' }],
      [{ ...NPS_ROW, detractors: -1 }],
      [{ ...NPS_ROW, sent_count: null }],
    ];
    for (const nps of bad) {
      mocks.loggerError.mockClear();
      setRpcRows(nps, [CSAT_ROW]);
      const res = await GET(req());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(INTERNAL);
      expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    }
  });

  it('想定外の例外 (認可以外) も 500 + ログ', async () => {
    const boom = new Error('unexpected');
    mocks.requireRole.mockRejectedValue(boom);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(INTERNAL);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][1]).toBe(boom);
  });
});
