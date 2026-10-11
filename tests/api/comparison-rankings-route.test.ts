/**
 * tests/api/comparison-rankings-route.test.ts
 *
 * #1225: /api/comparison/rankings の GET は、rankings / segment_stats / user_metrics / user_badges の
 * 4 クエリを 1 つずつ await していたため、DB の往復 4 回分の待ち時間がそのままレスポンス時間に乗っていた。
 * 4 クエリは互いに依存しない (絞り込み条件は冒頭で確定済みの user.id / periodType / periodStart だけ) ので、
 * Promise.all でまとめて発行する。
 *
 * このテストが守るもの:
 *   - 4 クエリが全て、従来と同じ絞り込み条件で 1 回ずつ発行される
 *   - 4 クエリが並列に発行される (どれか 1 つの完了を待たずに残りも発行される)
 *   - 4 クエリの結果から組み立てるレスポンスが従来から変わらない (完了順にも依存しない)
 *   - エラー処理が従来どおり
 *       rankings の error  → ログに出して空のランキングとして 200
 *       他 3 クエリの error → 無視して空扱いで 200
 *       例外               → 500 と error メッセージ
 *
 * 期間 (periodStart / periodEnd) の境界 (JST の暦) は #1211 の担当で、末尾の「集計期間は JST の暦で決まる」で、
 * 固定した時刻を使って確かめる。それ以外のテストは具体的な日付を固定せず、
 * 「4 クエリに渡した periodStart とレスポンスの periodStart が一致する」ことだけを見る
 * (実行マシンのタイムゾーンにも依存しない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricDefinition, SegmentDefinition } from '@/types/comparison';
import { calculateJstPeriod } from '../../supabase/functions/_shared/jst-date.ts';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

// ── supabase/server モック ────────────────────────────────────────────────────

const mockGetUser = vi.fn();

type TableResult =
  | { data: unknown; error: unknown; delayMs?: number }
  | { rejectWith: unknown; delayMs?: number };

/** クエリの開始・完了の発生順 ('start:<table>' / 'end:<table>') */
let events: string[] = [];
/** from() で発行されたクエリと、そのチェーンで呼ばれたメソッド (メソッド名, ...引数) */
let issued: Array<{ table: string; ops: unknown[][] }> = [];
/** テーブルごとに返す結果 */
let tableResults: Record<string, TableResult> = {};

/**
 * supabase-js のクエリビルダーを模したチェーン。
 * 本物と同じく「await (= then の呼び出し) された時点で初めてクエリが発行される」遅延実行にしてある。
 * 直列 await と Promise.all の違いが start / end の発生順に現れる。
 */
function makeQuery(table: string) {
  const ops: unknown[][] = [];
  issued.push({ table, ops });
  // 例外テストで残ったタイマーが、次のテストの events に紛れ込まないよう、この時点の配列を掴んでおく
  const log = events;

  const chain: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => {
            log.push(`start:${table}`);
            const result = tableResults[table];
            return new Promise((resolve, reject) => {
              // DB の往復を模して、結果は後のマクロタスクで返す
              setTimeout(() => {
                log.push(`end:${table}`);
                if ('rejectWith' in result) {
                  reject(result.rejectWith);
                } else {
                  resolve({ data: result.data, error: result.error });
                }
              }, result.delayMs ?? 0);
            }).then(onFulfilled, onRejected);
          };
        }
        return (...args: unknown[]) => {
          ops.push([prop, ...args]);
          return chain;
        };
      },
    },
  );
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (!(table in tableResults)) throw new Error(`Unexpected table: ${table}`);
      return makeQuery(table);
    },
  }),
}));

const { GET } = await import('@/app/api/comparison/rankings/route');

// ── フィクスチャ ──────────────────────────────────────────────────────────────

const USER_ID = 'user-1';

const segAll: SegmentDefinition = { id: 'seg-all', code: 'all', name: '全ユーザー', axes: {}, level: 0 };
const seg30s: SegmentDefinition = {
  id: 'seg-30s',
  code: 'age_30s',
  name: '30代',
  axes: { age_group: '30s' },
  level: 1,
};
const seg30sFemale: SegmentDefinition = {
  id: 'seg-30s-f',
  code: 'age_30s_female',
  name: '30代女性',
  axes: { age_group: '30s', gender: 'female' },
  level: 2,
};

const metricCalorie: MetricDefinition = {
  id: 'met-cal',
  code: 'calorie_balance',
  name: 'カロリーバランス',
  description: '目標カロリーとの差',
  category: 'nutrition',
  unit: 'kcal',
  higher_is_better: true,
};
const metricProtein: MetricDefinition = {
  id: 'met-pro',
  code: 'protein_intake',
  name: 'たんぱく質',
  description: null,
  category: 'nutrition',
  unit: 'g',
  higher_is_better: true,
};

function rankingRow(
  id: string,
  segment: SegmentDefinition,
  metric: MetricDefinition | null,
  fields: {
    rank: number;
    total_users: number;
    percentile: number;
    value: number;
    vs_avg_rate: number | null;
  },
) {
  return {
    id,
    user_id: USER_ID,
    segment_id: segment.id,
    metric_id: metric?.id ?? 'met-unknown',
    period_type: 'weekly',
    period_start: '2026-01-05',
    ...fields,
    segment_definitions: segment,
    metric_definitions: metric,
  };
}

const rankingRows = [
  // カロリー: 全ユーザー 1 位 (バッジあり) / 30代 1 位 (バッジなし) / 30代女性 3 位
  rankingRow('r1', segAll, metricCalorie, { rank: 1, total_users: 120, percentile: 99.2, value: 1980, vs_avg_rate: 12.5 }),
  rankingRow('r2', seg30s, metricCalorie, { rank: 1, total_users: 40, percentile: 97.5, value: 1980, vs_avg_rate: 9.1 }),
  rankingRow('r3', seg30sFemale, metricCalorie, { rank: 3, total_users: 18, percentile: 88.9, value: 1980, vs_avg_rate: 4.2 }),
  // たんぱく質: 上位 10% / 平均超え / どれにも当てはまらない
  rankingRow('r4', segAll, metricProtein, { rank: 7, total_users: 120, percentile: 94.4, value: 82, vs_avg_rate: 40.2 }),
  rankingRow('r5', seg30s, metricProtein, { rank: 20, total_users: 40, percentile: 60, value: 82, vs_avg_rate: 5.4 }),
  rankingRow('r6', seg30sFemale, metricProtein, { rank: 14, total_users: 18, percentile: 25, value: 82, vs_avg_rate: -8 }),
  // メトリクス定義を JOIN できなかった行は結果から除外される
  rankingRow('r7', segAll, null, { rank: 2, total_users: 120, percentile: 98, value: 5, vs_avg_rate: 1 }),
];

// ルートが使うのは segment_id / metric_id / avg_value だけ
const segmentStatRows = [
  { id: 's1', segment_id: 'seg-all', metric_id: 'met-cal', avg_value: 1760 },
  { id: 's2', segment_id: 'seg-30s', metric_id: 'met-cal', avg_value: 1815 },
  // seg-30s-f × met-cal は統計なし → avgValue は null
  { id: 's3', segment_id: 'seg-all', metric_id: 'met-pro', avg_value: 58.5 },
  { id: 's4', segment_id: 'seg-30s', metric_id: 'met-pro', avg_value: null }, // 平均値が null → avgValue も null
  { id: 's5', segment_id: 'seg-30s-f', metric_id: 'met-pro', avg_value: 61 },
  // どのランキングにも当たらない統計
  { id: 's6', segment_id: 'seg-all', metric_id: 'met-other', avg_value: 999 },
];

const userMetricRows = [
  {
    id: 'um1',
    user_id: USER_ID,
    metric_id: 'met-cal',
    period_type: 'weekly',
    period_start: '2026-01-05',
    period_end: '2026-01-11',
    value: 1980,
    previous_value: 1762,
    change_rate: 12.4,
  },
  {
    id: 'um2',
    user_id: USER_ID,
    metric_id: 'met-pro',
    period_type: 'weekly',
    period_start: '2026-01-05',
    period_end: '2026-01-11',
    value: 82,
    previous_value: 80,
    change_rate: 2.5,
  },
];

const userBadgeRows = [
  {
    id: 'ub1',
    user_id: USER_ID,
    badge_id: 'badge-champion',
    context_json: { segment_id: 'seg-all', metric_id: 'met-cal' },
    message: '全ユーザーでカロリーバランス1位',
    badges: {
      code: 'segment_champion',
      name: 'セグメントチャンピオン',
      icon: '👑',
      condition_json: { type: 'segment_rank' },
    },
  },
  {
    // どのランキングにも当たらないバッジ
    id: 'ub2',
    user_id: USER_ID,
    badge_id: 'badge-other',
    context_json: { segment_id: 'seg-all', metric_id: 'met-other' },
    message: '',
    badges: { code: 'other', name: 'その他', icon: null, condition_json: null },
  },
];

function defaultResults(): Record<string, TableResult> {
  return {
    user_segment_rankings: { data: rankingRows, error: null },
    segment_stats: { data: segmentStatRows, error: null },
    user_metrics: { data: userMetricRows, error: null },
    user_badges: { data: userBadgeRows, error: null },
  };
}

function givenResults(overrides: Record<string, TableResult> = {}) {
  tableResults = { ...defaultResults(), ...overrides };
}

// 上のフィクスチャから、従来のコードが組み立てていたレスポンス (手で書き下したもの)
const expectedRankings = [
  {
    metric: metricCalorie,
    segments: [
      {
        segment: segAll,
        rank: 1,
        totalUsers: 120,
        percentile: 99.2,
        value: 1980,
        avgValue: 1760,
        vsAvgRate: 12.5,
        prize: {
          code: 'segment_champion',
          name: 'セグメントチャンピオン',
          icon: '👑',
          category: 'segment_rank',
          message: '全ユーザーでカロリーバランス1位',
        },
      },
      {
        segment: seg30s,
        rank: 1,
        totalUsers: 40,
        percentile: 97.5,
        value: 1980,
        avgValue: 1815,
        vsAvgRate: 9.1,
        prize: { code: 'rank_1', name: '1位', icon: '🏆', category: 'rank', message: '30代で1位！' },
      },
      {
        segment: seg30sFemale,
        rank: 3,
        totalUsers: 18,
        percentile: 88.9,
        value: 1980,
        avgValue: null,
        vsAvgRate: 4.2,
        prize: { code: 'top_3', name: 'トップ3', icon: '🥉', category: 'rank', message: '30代女性でトップ3！' },
      },
    ],
  },
  {
    metric: metricProtein,
    segments: [
      {
        segment: segAll,
        rank: 7,
        totalUsers: 120,
        percentile: 94.4,
        value: 82,
        avgValue: 58.5,
        vsAvgRate: 40.2,
        prize: { code: 'top_10', name: '上位10%', icon: '🥈', category: 'percentile', message: '上位6%！' },
      },
      {
        segment: seg30s,
        rank: 20,
        totalUsers: 40,
        percentile: 60,
        value: 82,
        avgValue: null,
        vsAvgRate: 5.4,
        prize: {
          code: 'above_avg',
          name: '平均超え',
          icon: '⭐',
          category: 'achievement',
          message: '平均を5%上回っています！',
        },
      },
      {
        segment: seg30sFemale,
        rank: 14,
        totalUsers: 18,
        percentile: 25,
        value: 82,
        avgValue: 61,
        vsAvgRate: -8,
        prize: null,
      },
    ],
  },
];

const expectedHighlights = [
  { type: 'top_prize', message: '🏆 全ユーザーのカロリーバランスで1位！', metric: 'calorie_balance', icon: '🏆' },
  { type: 'top_prize', message: '🏆 30代のカロリーバランスで1位！', metric: 'calorie_balance', icon: '🏆' },
  { type: 'improvement', message: '📈 前期間より12%改善！', metric: 'met-cal', icon: '📈' },
  { type: 'above_avg', message: '⭐ 全ユーザーの平均を40%上回っています！', metric: 'protein_intake', icon: '⭐' },
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TABLES = ['segment_stats', 'user_badges', 'user_metrics', 'user_segment_rankings'];

function makeRequest(query = ''): Request {
  return new Request(`http://localhost/api/comparison/rankings${query}`);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  events = [];
  issued = [];
  givenResults();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ── テスト ────────────────────────────────────────────────────────────────────

describe('GET /api/comparison/rankings: 認証', () => {
  it('未ログインなら 401 を返し、DB クエリは 1 つも発行しない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(issued).toEqual([]);
  });

  it('getUser がエラーを返した場合も 401 で、DB クエリは発行しない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: new Error('jwt expired') });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(issued).toEqual([]);
  });
});

describe('GET /api/comparison/rankings: クエリの発行 (#1225)', () => {
  it('4 つのテーブルを 1 回ずつ、従来と同じ絞り込み条件で問い合わせる', async () => {
    const res = await GET(makeRequest());
    const { periodStart } = await res.json();

    // 絞り込みに使う periodStart はレスポンスの periodStart と同じ値 (具体的な日付は #1211 の担当なので固定しない)
    expect(periodStart).toMatch(DATE_PATTERN);

    expect(issued.map((q) => q.table).sort()).toEqual(TABLES);

    const opsOf = (table: string) => issued.find((q) => q.table === table)?.ops;
    expect(opsOf('user_segment_rankings')).toEqual([
      ['select', expect.stringMatching(/segment_definitions\([^)]*\)[\s\S]*metric_definitions\([^)]*\)/)],
      ['eq', 'user_id', USER_ID],
      ['eq', 'period_type', 'weekly'],
      ['eq', 'period_start', periodStart],
    ]);
    // 統計はユーザーを問わず期間単位 (user_id では絞らない)
    expect(opsOf('segment_stats')).toEqual([
      ['select', '*'],
      ['eq', 'period_type', 'weekly'],
      ['eq', 'period_start', periodStart],
    ]);
    expect(opsOf('user_metrics')).toEqual([
      ['select', '*'],
      ['eq', 'user_id', USER_ID],
      ['eq', 'period_type', 'weekly'],
      ['eq', 'period_start', periodStart],
    ]);
    expect(opsOf('user_badges')).toEqual([
      ['select', expect.stringContaining('badges(')],
      ['eq', 'user_id', USER_ID],
      ['not', 'context_json', 'is', null],
    ]);
  });

  it('periodType クエリパラメータは期間で絞る 3 クエリに同じ値で渡され、レスポンスにも返る', async () => {
    const res = await GET(makeRequest('?periodType=monthly'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.periodType).toBe('monthly');
    for (const table of ['user_segment_rankings', 'segment_stats', 'user_metrics']) {
      const ops = issued.find((q) => q.table === table)?.ops;
      expect(ops).toContainEqual(['eq', 'period_type', 'monthly']);
      expect(ops).toContainEqual(['eq', 'period_start', json.periodStart]);
    }
  });

  it('1 つ目のクエリの完了を待たずに、4 つ全てのクエリを発行する (並列)', async () => {
    await GET(makeRequest());

    // 直列 await だと start → end → start → end … の順になる。
    // 並列なら、最初の end より前に 4 つ全ての start が出揃う。
    expect(events.slice(0, 4).sort()).toEqual(TABLES.map((t) => `start:${t}`));
    expect(events.slice(4).sort()).toEqual(TABLES.map((t) => `end:${t}`));
  });
});

describe('GET /api/comparison/rankings: レスポンスの形 (並列化で変わらない)', () => {
  it('4 クエリの結果から、従来どおりのレスポンスを組み立てる', async () => {
    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      rankings: expectedRankings,
      highlights: expectedHighlights,
      userMetrics: userMetricRows,
      periodType: 'weekly',
      periodStart: expect.stringMatching(DATE_PATTERN),
      periodEnd: expect.stringMatching(DATE_PATTERN),
    });
  });

  it('クエリの完了順が発行順と逆でも、レスポンスは同じ', async () => {
    // 発行順 (rankings → stats → metrics → badges) と逆の順に完了させる
    const base = defaultResults();
    givenResults({
      user_segment_rankings: { ...base.user_segment_rankings, delayMs: 30 },
      segment_stats: { ...base.segment_stats, delayMs: 20 },
      user_metrics: { ...base.user_metrics, delayMs: 10 },
      user_badges: { ...base.user_badges, delayMs: 0 },
    });

    const res = await GET(makeRequest());
    const json = await res.json();

    // 想定どおり逆順に完了していること (このテストが空振りしていないことの確認)
    expect(events.filter((e) => e.startsWith('end:'))).toEqual([
      'end:user_badges',
      'end:user_metrics',
      'end:segment_stats',
      'end:user_segment_rankings',
    ]);
    expect(json.rankings).toEqual(expectedRankings);
    expect(json.highlights).toEqual(expectedHighlights);
    expect(json.userMetrics).toEqual(userMetricRows);
  });

  it('ランキングが 1 件も無ければ rankings は空配列で 200 を返す', async () => {
    givenResults({ user_segment_rankings: { data: [], error: null } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.rankings).toEqual([]);
    expect(json.userMetrics).toEqual(userMetricRows);
  });
});

describe('GET /api/comparison/rankings: エラー処理 (従来どおり)', () => {
  it('rankings の error はログに出し、ランキングは空として 200 を返す', async () => {
    const rankingsError = { message: 'permission denied for table user_segment_rankings', code: '42501' };
    givenResults({ user_segment_rankings: { data: null, error: rankingsError } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith('Rankings error:', rankingsError);
    expect(json.rankings).toEqual([]);
    // 他のクエリの結果は使われる (ハイライトは user_metrics の改善分だけ)
    expect(json.highlights).toEqual([expectedHighlights[2]]);
    expect(json.userMetrics).toEqual(userMetricRows);
  });

  it('segment_stats の error は無視して、平均値なし (avgValue: null) で 200 を返す', async () => {
    givenResults({ segment_stats: { data: null, error: { message: 'boom', code: 'XX000' } } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.rankings).toHaveLength(2);
    const avgValues = json.rankings.flatMap((m: any) => m.segments.map((s: any) => s.avgValue));
    expect(avgValues).toEqual([null, null, null, null, null, null]);
    expect(json.userMetrics).toEqual(userMetricRows);
  });

  it('user_metrics の error は無視して、userMetrics は空配列・改善ハイライトなしで 200 を返す', async () => {
    givenResults({ user_metrics: { data: null, error: { message: 'boom', code: 'XX000' } } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.userMetrics).toEqual([]);
    expect(json.rankings).toEqual(expectedRankings);
    expect(json.highlights.map((h: any) => h.type)).toEqual(['top_prize', 'top_prize', 'above_avg']);
  });

  it('user_badges の error は無視して、バッジなしのランキング基準でプライズを決めて 200 を返す', async () => {
    givenResults({ user_badges: { data: null, error: { message: 'boom', code: 'XX000' } } });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // 全ユーザー × カロリーは、バッジがあれば segment_champion だが、無いので順位ベースの 1 位プライズ
    expect(json.rankings[0].segments[0].prize).toEqual({
      code: 'rank_1',
      name: '1位',
      icon: '🏆',
      category: 'rank',
      message: '全ユーザーで1位！',
    });
    expect(json.userMetrics).toEqual(userMetricRows);
  });

  it('クエリが例外を投げたら、ログに出して 500 と汎用メッセージを返す (例外の文面は本文に出さない。#1172)', async () => {
    const failure = new Error('connection reset');
    givenResults({ user_metrics: { rejectWith: failure } });

    const res = await GET(makeRequest());
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(text).not.toContain('connection reset');
    // 元の例外は、route の名前でサーバーのログに残る (internalError() → db-logger)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[GET /api/comparison/rankings]'),
      failure,
      expect.anything(),
    );
  });

  it('複数のクエリが例外を投げても 500 を 1 回返すだけで、未処理の rejection を残さない', async () => {
    givenResults({
      segment_stats: { rejectWith: new Error('stats failed') },
      user_badges: { rejectWith: new Error('badges failed') },
    });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });

    // 2 つ目の reject が未処理のまま残らないこと (残ると Vitest が unhandled rejection として失敗にする)。
    // テストが終わる前に、残りのタイマーを消化させておく。
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

// ── 集計期間は JST の暦で決まる (#1211) ──────────────────────────────────────
//
// 以前は new Date() の getDay() / getDate() / getMonth() (Vercel の実行環境は UTC) で期間を求めていたので、
// JST の 00:00〜08:59 (UTC では前日) の間は、月曜の早朝が日曜日扱いで週の開始日が 1 週間前の月曜に、月初は前月に、
// 毎日は前日になっていた。集計の Edge Function (calculate-segment-stats) が保存する period_start と
// 食い違うと、新しい週の集計が見つからない (または前の週の数字が出る)。
// 期間の求め方そのものは tests/jst-period.test.ts が確かめる。ここでは、この API がその期間で読むことを見る。

describe('GET /api/comparison/rankings: 集計期間は JST の暦で決まる (#1211)', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  /** 現在時刻 (Date だけ) を固定する。DB の往復を模した setTimeout は本物のまま動かす */
  function setNow(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  // [periodType, 現在時刻 (UTC), 期間の開始日, 期間の終了日, 説明]
  const boundaries: Array<[string, string, string, string, string]> = [
    ['weekly', '2026-07-12T14:59:59.999Z', '2026-07-06', '2026-07-12', 'JST 日曜 7/12 23:59:59 は、まだ前の週'],
    ['weekly', '2026-07-12T15:00:00.000Z', '2026-07-13', '2026-07-19', 'JST 月曜 7/13 0:00 から新しい週 (UTC はまだ日曜。修正前は前の週のままだった)'],
    ['weekly', '2026-07-12T23:59:59.999Z', '2026-07-13', '2026-07-19', 'JST 月曜 7/13 8:59:59 も新しい週 (UTC はまだ日曜)'],
    ['monthly', '2026-07-31T14:59:59.999Z', '2026-07-01', '2026-07-31', 'JST 7/31 23:59:59 は、まだ 7 月'],
    ['monthly', '2026-07-31T15:00:00.000Z', '2026-08-01', '2026-08-31', 'JST 8/1 0:00 から 8 月 (UTC はまだ 7/31。修正前は 7 月のままだった)'],
    ['daily', '2026-07-12T14:59:59.999Z', '2026-07-12', '2026-07-12', 'JST 7/12 23:59:59 は、まだ 7/12'],
    ['daily', '2026-07-12T15:00:00.000Z', '2026-07-13', '2026-07-13', 'JST 7/13 0:00 から 7/13 (UTC はまだ 7/12。修正前は前日のままだった)'],
    ['all_time', '2026-07-12T15:00:00.000Z', '2024-01-01', '2026-07-13', '全期間は 2024-01-01 から JST の今日まで (集計側が保存する全期間と同じ。修正前は直近 7 日を探していた)'],
  ];

  it.each(boundaries)('%s @ %s → %s 〜 %s (%s)', async (periodType, now, start, end) => {
    setNow(now);

    const res = await GET(makeRequest(`?periodType=${periodType}`));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ periodType, periodStart: start, periodEnd: end });
    // 期間で絞る 3 クエリも、同じ開始日で読む
    for (const table of ['user_segment_rankings', 'segment_stats', 'user_metrics']) {
      expect(issued.find((q) => q.table === table)?.ops, table).toContainEqual(['eq', 'period_start', start]);
    }
  });

  it('periodType を省略すると週 (weekly) で、JST の月曜 0 時から新しい週になる', async () => {
    setNow('2026-07-12T15:00:00.000Z');

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(json).toMatchObject({ periodType: 'weekly', periodStart: '2026-07-13', periodEnd: '2026-07-19' });
  });

  it('集計の Edge Function (calculate-segment-stats) が保存する期間と、同じ期間で読む (保存側と読み出し側が食い違わない)', async () => {
    for (const now of [
      '2026-07-12T14:59:59.999Z',
      '2026-07-12T15:00:00.000Z',
      '2026-07-12T23:59:59.999Z',
      '2026-07-13T00:00:00.000Z',
      '2026-07-31T15:00:00.000Z',
      '2026-12-31T15:00:00.000Z',
      '2028-02-28T15:00:00.000Z',
    ]) {
      setNow(now);
      for (const periodType of ['daily', 'weekly', 'monthly', 'all_time']) {
        const res = await GET(makeRequest(`?periodType=${periodType}`));
        const json = await res.json();

        expect({ periodStart: json.periodStart, periodEnd: json.periodEnd }, `${periodType} @ ${now}`).toEqual(
          calculateJstPeriod(periodType, new Date(now)),
        );
      }
    }
  });

  it('実行環境のタイムゾーンに左右されない (JST の実行環境でも、サマータイムのある地域でも同じ期間)', async () => {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Midway']) {
      process.env.TZ = tz;
      setNow('2026-07-12T15:00:00.000Z'); // JST 月曜 7/13 0:00

      const weekly = await (await GET(makeRequest('?periodType=weekly'))).json();
      const monthly = await (await GET(makeRequest('?periodType=monthly'))).json();
      const daily = await (await GET(makeRequest('?periodType=daily'))).json();

      expect([weekly.periodStart, weekly.periodEnd], `${tz} weekly`).toEqual(['2026-07-13', '2026-07-19']);
      expect([monthly.periodStart, monthly.periodEnd], `${tz} monthly`).toEqual(['2026-07-01', '2026-07-31']);
      expect([daily.periodStart, daily.periodEnd], `${tz} daily`).toEqual(['2026-07-13', '2026-07-13']);
    }
  });
});
