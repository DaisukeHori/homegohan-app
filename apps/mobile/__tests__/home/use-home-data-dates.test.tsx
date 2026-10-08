/**
 * use-home-data-dates.test.tsx
 * ホーム画面のデータ取得 (src/hooks/useHomeData.ts) が使う日付のテスト (#1049 F7-21)
 *
 * 以前は、「今日」を端末のタイムゾーンの日付 (new Date() を整形したもの) で決めていた。
 * Web・サーバー (shared の todayLocal = Asia/Tokyo) と基準が違うので、
 *   - 端末が日本以外のタイムゾーンだと、WebView のタブとネイティブ画面で「今日」が違う
 *   - 今日の記録 (health_records.record_date など) を、サーバーと別の日付で読み書きする
 * ことがあった。今は todayLocal() (Asia/Tokyo) を基準にし、日付の加減算は文字列で行う。
 *
 * テストは「JST の 2026-10-08 08:30 = UTC の 2026-10-07 23:30」に時計を固定する。
 * UTC の端末 (CI) では、端末の暦の日付は 10/7 なので、Asia/Tokyo 基準になっていなければ 10/7 ベースの日付が出る。
 */

import { act, renderHook } from '@testing-library/react-native';

// ── Supabase のモック: 呼ばれたクエリ (テーブルとフィルタ) を記録する ───────────────
type RecordedQuery = { table: string; filters: unknown[][] };
const recorded: RecordedQuery[] = [];

function mockMakeBuilder(table: string) {
  const query: RecordedQuery = { table, filters: [] };
  recorded.push(query);
  const builder: Record<string, unknown> = {};
  const chain = (name: string) => (...args: unknown[]) => {
    query.filters.push([name, ...args]);
    return builder;
  };
  for (const name of ['select', 'eq', 'neq', 'gte', 'lte', 'gt', 'lt', 'not', 'order', 'limit', 'in', 'is', 'update', 'upsert', 'insert']) {
    builder[name] = chain(name);
  }
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
  builder.single = () => Promise.resolve({ data: null, error: null });
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
  return builder;
}

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockMakeBuilder(table),
  },
}));

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: () => Promise.resolve({}),
    post: () => Promise.resolve({}),
  }),
}));

import { useHomeData } from '../../src/hooks/useHomeData';

// ── 時計: Date だけを固定する (setTimeout などは本物のまま) ──────────────────────────
const FROZEN_INSTANT = '2026-10-07T23:30:00Z'; // = 2026-10-08 08:30 JST
const JST_TODAY = '2026-10-08';

function freezeDate() {
  jest.useFakeTimers({
    now: new Date(FROZEN_INSTANT),
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 記録したクエリから、あるテーブルへの、ある条件 (例: gte day_date) の値を全部取り出す */
function filterValues(table: string, operator: string, column: string): unknown[] {
  return recorded
    .filter((q) => q.table === table)
    .flatMap((q) => q.filters.filter((f) => f[0] === operator && f[1] === column).map((f) => f[2]));
}

beforeEach(async () => {
  recorded.length = 0;
  freezeDate();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  renderHook(() => useHomeData('user-1'));
  await flush();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useHomeData — 日付は Asia/Tokyo の「今日」が基準', () => {
  it('(前提) 時計は UTC では前日、JST では 10/8 の時刻に固定されている', () => {
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-07');
  });

  it('今日の献立は、JST の今日 (2026-10-08) の行を読む', () => {
    // 今日の献立 (eq day_date) と、記録の今日 (health_records.record_date) の両方が JST の今日
    expect(filterValues('user_daily_meals', 'eq', 'day_date')).toEqual([JST_TODAY]);
    expect(filterValues('health_records', 'eq', 'record_date')).toEqual([JST_TODAY]);
  });

  it('料理の連続日数: 30 日前〜今日 (JST) の範囲で読む', () => {
    const lowers = filterValues('user_daily_meals', 'gte', 'day_date');
    const uppers = filterValues('user_daily_meals', 'lte', 'day_date');

    // 連続日数 (30 日前)・週間 (6 日前)・月間 (今月 1 日) の下限
    expect(lowers).toEqual(expect.arrayContaining(['2026-09-08', '2026-10-02', '2026-10-01']));
    // どれも上限は JST の今日
    expect(uppers).toEqual([JST_TODAY, JST_TODAY, JST_TODAY]);
  });

  it('期限が近い食材: 今日 (JST) から 3 日後までを読む', () => {
    expect(filterValues('pantry_items', 'gte', 'expiration_date')).toEqual([JST_TODAY]);
    expect(filterValues('pantry_items', 'lte', 'expiration_date')).toEqual(['2026-10-11']);
  });

  it('今週のベスト食事: 6 日前 (JST) 以降を読む', () => {
    expect(filterValues('planned_meals', 'gte', 'user_daily_meals.day_date')).toEqual(['2026-10-02']);
  });
});
