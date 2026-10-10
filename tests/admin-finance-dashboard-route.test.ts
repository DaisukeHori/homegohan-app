// @vitest-environment node
/**
 * GET /api/admin/finance/dashboard — 今月・先月のスナップショットを引く日付 (#1433)
 *
 * revenue_snapshots.date は JST の暦日。以前は今月の月初・先月の月初・先月末を
 *   new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10)
 * のように、ローカル時刻の年・月で作った 0 時を toISOString (UTC) で日付に戻して作っていたので、実行環境のタイムゾーンで結果が変わった。
 *   - TZ=UTC (Vercel)      : 月初 1 日の JST 0:00〜8:59 に、今月・先月が 1 か月前にずれる (11/1 に 10/01・09/01〜09/30)
 *   - TZ=Asia/Tokyo (開発機): 毎日、月初でも月末でもない日になる (10/01 0:00 JST → 09/30 15:00Z → '09-30')
 * ここでは、境界 (JST 0:00 ちょうど・8:59:59・月初・月末・年末・年始) と実行環境のタイムゾーンを変えても、
 * DB に渡す日付が JST の暦の今月・先月になることを確かめる。日付の計算そのもの (jstMonthBoundaries) は tests/jst-day-ranges.test.ts。
 *
 * Supabase クライアントはモックで、渡した条件 (gte / lte の日付) だけを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_TIME_ZONES } from './helpers/time-zones';

interface ChainCall {
  method: string;
  args: unknown[];
}

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  /** from() を呼ぶたびに 1 件ずつ増える (呼んだテーブルと、そのあとに呼んだメソッド) */
  chains: [] as Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }>,
}));

/** どのメソッドでも自分自身を返し、await すると 0 件 (data: null) で解決するクエリビルダー */
function makeBuilder(table: string) {
  const chain = { table, calls: [] as ChainCall[] };
  mocks.chains.push(chain);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null });
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

vi.mock('@/lib/auth/helpers', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: (table: string) => makeBuilder(table) }),
}));

import { GET } from '../src/app/api/admin/finance/dashboard/route';

/** revenue_snapshots への問い合わせのうち、date の条件 (gte / lte) だけを並べる */
function snapshotDateFilters(): Array<Record<string, unknown>> {
  return mocks.chains
    .filter((c) => c.table === 'revenue_snapshots')
    .map((c) =>
      Object.fromEntries(
        c.calls
          .filter((call) => (call.method === 'gte' || call.method === 'lte') && call.args[0] === 'date')
          .map((call) => [call.method, call.args[1]]),
      ),
    );
}

/**
 * 境界の時刻と、その時刻の JST の暦の今月の月初・先月の月初・先月末。
 * 期待値は実装とは別に、JST の暦を引いて求めた固定値。
 */
const CASES = [
  { label: 'JST 10/10 0:00 ちょうど', at: '2026-10-09T15:00:00.000Z', thisMonthStart: '2026-10-01', lastMonthStart: '2026-09-01', lastMonthEnd: '2026-09-30' },
  { label: 'JST 10/10 8:59:59', at: '2026-10-09T23:59:59.000Z', thisMonthStart: '2026-10-01', lastMonthStart: '2026-09-01', lastMonthEnd: '2026-09-30' },
  { label: '月初 (JST 10/1 0:00)', at: '2026-09-30T15:00:00.000Z', thisMonthStart: '2026-10-01', lastMonthStart: '2026-09-01', lastMonthEnd: '2026-09-30' },
  { label: '月初 (JST 11/1 3:00)', at: '2026-10-31T18:00:00.000Z', thisMonthStart: '2026-11-01', lastMonthStart: '2026-10-01', lastMonthEnd: '2026-10-31' },
  { label: '月初 (JST 11/1 8:59:59)', at: '2026-10-31T23:59:59.000Z', thisMonthStart: '2026-11-01', lastMonthStart: '2026-10-01', lastMonthEnd: '2026-10-31' },
  { label: '月末 (JST 10/31 23:59:59)', at: '2026-10-31T14:59:59.000Z', thisMonthStart: '2026-10-01', lastMonthStart: '2026-09-01', lastMonthEnd: '2026-09-30' },
  { label: '3 月の月初 (JST 2028/3/1 0:00・前月はうるう年の 2 月)', at: '2028-02-29T15:00:00.000Z', thisMonthStart: '2028-03-01', lastMonthStart: '2028-02-01', lastMonthEnd: '2028-02-29' },
  { label: '年末 (JST 12/31 23:59:59)', at: '2026-12-31T14:59:59.000Z', thisMonthStart: '2026-12-01', lastMonthStart: '2026-11-01', lastMonthEnd: '2026-11-30' },
  { label: '年始 (JST 2027/1/1 0:00)', at: '2026-12-31T15:00:00.000Z', thisMonthStart: '2027-01-01', lastMonthStart: '2026-12-01', lastMonthEnd: '2026-12-31' },
  { label: '年始 (JST 2027/1/1 8:59:59)', at: '2026-12-31T23:59:59.000Z', thisMonthStart: '2027-01-01', lastMonthStart: '2026-12-01', lastMonthEnd: '2026-12-31' },
] as const;

let savedTz: string | undefined;

beforeEach(() => {
  mocks.chains.length = 0;
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({ id: 'admin-1', roles: ['admin'] });
  vi.useFakeTimers({ toFake: ['Date'] });
  savedTz = process.env.TZ;
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe.each(CASES)('GET /api/admin/finance/dashboard: $label', (c) => {
  it.each(TEST_TIME_ZONES)('TZ=%s でも、今月 = JST の月初以降、先月 = JST の先月の月初〜末日のスナップショットを引く', async (tz) => {
    process.env.TZ = tz;
    vi.setSystemTime(new Date(c.at));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(snapshotDateFilters()).toEqual([
      // 今月の最新スナップショット
      { gte: c.thisMonthStart },
      // 先月の最新スナップショット (比較用)
      { gte: c.lastMonthStart, lte: c.lastMonthEnd },
    ]);
  });
});
