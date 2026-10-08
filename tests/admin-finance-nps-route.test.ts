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
 *   - 認可 (requireRole の許可ロール) と、401 / 403 の返し方は変えない。
 *
 * Supabase クライアントはモック。関数の中身 (SQL) と RLS は
 * tests/integration/rls/csat-nps-summary-rpc.test.ts、route 全体の結果は
 * tests/integration/security/admin-finance-nps-route.test.ts で、実 DB を使って検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '../src/lib/auth/errors';
import { legacyCsatSummary, legacyNpsSummary } from './helpers/legacy-nps-summary';

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
  it('期間とプランを DB の関数に渡す (NPS はプランも、CSAT は期間だけ)', async () => {
    await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith('get_nps_summary', {
      p_from: '2026-03-01',
      p_to: '2026-03-31',
      p_plan_key: 'pro',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('get_csat_summary', { p_from: '2026-03-01', p_to: '2026-03-31' });
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
      expect(callsOf(chain, 'lte')).toEqual([]);
      expect(callsOf(chain, 'eq')).toEqual([]);
    }
  });

  it('NPS の一覧: 回答済みだけ・送信日の期間・プランで絞り、回答日の新しい順に 10 件だけ取る', async () => {
    await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    const chains = chainsOf('nps_surveys');
    expect(chains).toHaveLength(1);
    const chain = chains[0];
    expect(callsOf(chain, 'select')).toEqual([['id, score, comment, plan_key, responded_at']]);
    expect(callsOf(chain, 'not')).toEqual([['responded_at', 'is', null]]);
    expect(callsOf(chain, 'gte')).toEqual([['sent_at', '2026-03-01']]);
    expect(callsOf(chain, 'lte')).toEqual([['sent_at', '2026-03-31']]);
    expect(callsOf(chain, 'eq')).toEqual([['plan_key', 'pro']]);
    expect(callsOf(chain, 'order')).toEqual([['responded_at', { ascending: false }]]);
    expect(callsOf(chain, 'limit')).toEqual([[10]]);
  });

  it('CSAT の一覧: 作成日の期間で絞り (プランでは絞らない)、作成日の新しい順に 10 件だけ取る', async () => {
    await GET(req('?from=2026-03-01&to=2026-03-31&plan_key=pro'));
    const chains = chainsOf('csat_feedbacks');
    expect(chains).toHaveLength(1);
    const chain = chains[0];
    expect(callsOf(chain, 'select')).toEqual([['id, score, comment, ticket_id, created_at']]);
    expect(callsOf(chain, 'gte')).toEqual([['created_at', '2026-03-01']]);
    expect(callsOf(chain, 'lte')).toEqual([['created_at', '2026-03-31']]);
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
// 認可 (変えていない)
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/finance/nps — 認可', () => {
  it('許可するロールは admin / super_admin / finance (変えていない)', async () => {
    await GET(req());
    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'finance']);
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
    mocks.requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'Requires one of: admin, super_admin, finance'));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'OP_PERMISSION_DENIED', message: 'Requires one of: admin, super_admin, finance' },
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
