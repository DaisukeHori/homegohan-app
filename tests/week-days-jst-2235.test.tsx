/**
 * #2235 I3 /health・/health/streaks・ホーム (useHomeData)・買い物リストの範囲の「今日から n 日」の日付が、実行環境のタイムゾーンと
 * 時計を読んだ回数に依らず、JST の今日 (todayLocal / formatLocalDate) から暦の計算だけで並ぶことの回帰テスト。
 *
 * 問題 (直す前):
 *   - /health の週間カレンダー・今日の記録の読み取りと /health/streaks の 7 日は、端末のローカルの getFullYear / getMonth / getDate で
 *     日付を作っていた。端末のタイムゾーンが日本でないと、今日がサーバー (記録の日付・連続記録の週は JST の暦日) やほかの画面
 *     (/health/graphs・ホームは JST) とずれた
 *   - どの 7 日も日ごとに new Date() を読んでいたので、0 時をまたぐ瞬間に日が飛ぶか重なりえた。ホームの週間統計の曜日は
 *     new Date('YYYY-MM-DD').getDay() (UTC の 0 時を端末のローカル時刻で読む) で、UTC より西では前の日の曜日になった。
 *     月間統計の月の 1 日は端末のローカル時刻の月の 1 日で、月の変わり目の前後で別の月になった
 *   - 買い物リストの範囲 (明日・1週間 など) は端末のローカル時刻で日をずらしてから JST の日付にしていたので、夏時間の切り替えの日に
 *     JST の日付が 1 日ずれた
 *
 * ここでは、時計を止めた形で、実行環境のタイムゾーン (UTC・JST・JST より西 (America/Los_Angeles)・東 (Pacific/Kiritimati)) と
 * 時刻 (JST の日付が変わる前後・年の変わり目・うるう日・月の変わり目・夏時間の切り替え) を変えて、出す日付が JST の今日からの
 * 暦日であることを確かめる。加えて、時計を読むたびに 1 日進める形 (読む回数が多いほど結果が崩れる) で、時計を 1 回だけ読んで
 * 並べていること (7 日が続いた暦日で、同じ問い合わせの両端が同じ今日から求めたもの) を確かめる。
 *
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDaysToDate, calendarDaysEndingAt, WEEKDAY_LABELS_JA } from '@homegohan/shared';

/** Supabase の問い合わせの記録 (表・呼んだメソッドと引数の並び) */
interface RecordedQuery {
  table: string;
  calls: { method: string; args: unknown[] }[];
}

const supabaseMock = vi.hoisted(() => ({
  /** 表ごとの答えの行 (single / maybeSingle の問い合わせは null を返す) */
  tableRows: {} as Record<string, unknown[]>,
  /** 始めた問い合わせ (from を呼んだ順) */
  queries: [] as { table: string; calls: { method: string; args: unknown[] }[] }[],
}));

vi.mock('@/lib/supabase/client', () => {
  /** どのメソッドを呼んでも自分を返し、await すると表の行 (single なら null) になる問い合わせ */
  const query = (recorded: { table: string; calls: { method: string; args: unknown[] }[] }, single: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          const rows = supabaseMock.tableRows[recorded.table] ?? [];
          const answer = single ? { data: null, error: null } : { data: rows, error: null, count: rows.length };
          return (resolve: (value: unknown) => void) => resolve(answer);
        }
        return (...args: unknown[]) => {
          recorded.calls.push({ method: String(prop), args });
          return query(recorded, single || prop === 'single' || prop === 'maybeSingle');
        };
      },
    });
  const user = { id: 'user-1', user_metadata: {} };
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user } }, error: null }),
      getUser: async () => ({ data: { user }, error: null }),
      refreshSession: async () => ({ data: { session: { user } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
    from: (table: string) => {
      const recorded = { table, calls: [] as { method: string; args: unknown[] }[] };
      supabaseMock.queries.push(recorded);
      return query(recorded, false);
    },
    rpc: () => query({ table: 'rpc', calls: [] }, false),
    channel: () => channel,
    removeChannel: async () => 'ok',
  };
  return { createClient: () => client };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/health',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// アニメーションは描かずに中身だけを出す
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_PROPS = new Set([
    'initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap', 'whileInView', 'whileFocus',
    'layout', 'layoutId', 'drag', 'dragConstraints', 'onAnimationComplete', 'viewport', 'custom',
  ]);
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          const MotionElement = React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
            const rest: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) if (!MOTION_PROPS.has(key)) rest[key] = value;
            return React.createElement(tag, { ...rest, ref });
          });
          MotionElement.displayName = `motion.${tag}`;
          cache.set(tag, MotionElement);
        }
        return cache.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

const { default: HealthDashboardPage } = await import('@/app/(main)/health/page');
const { default: StreaksPage } = await import('@/app/(main)/health/streaks/page');
const { useHomeData } = await import('@/hooks/useHomeData');
const { ShoppingRangeModal } = await import('@/app/(main)/menus/weekly/_components/modals/ShoppingRangeModal');
const { useShoppingStore } = await import('@/app/(main)/menus/weekly/_state/shoppingStore');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 30;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
/** fetch の init に method が無いときのメソッド */
const READ_METHOD = 'GET';
/** 道を取り出すための仮の起点 (fetch には相対の道が渡る) */
const URL_ORIGIN = 'http://localhost';
/** 1 日の ms (時計を読むたびに進める量) */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 止めた時計 (読んでも進まない) */
const FROZEN_CLOCK_MS = 0;
/** 7 日の表示・集計の日数 (今日を含む過去 7 日) */
const WEEK_DAYS = 7;
/** ホームの連続自炊が読む過去の日数 (今日の 30 日前から) */
const COOKING_STREAK_LOOKBACK_DAYS = 30;
/** 連続記録の応答 (/api/health/streaks の streak) */
const STREAK = { current_streak: 3, longest_streak: 5, achieved_badges: [], total_records: 8, streak_type: 'daily_record' };

/** 実行環境のタイムゾーン (UTC・JST・JST より西 (UTC-8/-7)・東 (UTC+14)) */
const RUNTIME_TIME_ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const;

interface ClockCase {
  /** 時計の時刻 (UTC) */
  readonly at: string;
  /** その時刻の JST の今日 */
  readonly jstToday: string;
  /** 今日を含む過去 7 日の、曜日の 1 文字と日 (古い順。最後が今日) */
  readonly weekCells: readonly string[];
  /** 今日を含む過去 7 日の暦日 (古い順) */
  readonly weekDates: readonly string[];
}

const CLOCK_CASES: readonly ClockCase[] = [
  // JST 12 時 (UTC 3 時。America/Los_Angeles では前の日の 20 時)
  {
    at: '2026-11-04T03:00:00.000Z',
    jstToday: '2026-11-04',
    weekCells: ['木29', '金30', '土31', '日1', '月2', '火3', '水4'],
    weekDates: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
  },
  // JST の日付が変わる直前 (JST 23:59:59.999。Pacific/Kiritimati ではもう翌日)
  {
    at: '2026-11-04T14:59:59.999Z',
    jstToday: '2026-11-04',
    weekCells: ['木29', '金30', '土31', '日1', '月2', '火3', '水4'],
    weekDates: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
  },
  // JST の日付が変わった瞬間 (JST 0:00。UTC・America/Los_Angeles ではまだ前の日)
  {
    at: '2026-11-04T15:00:00.000Z',
    jstToday: '2026-11-05',
    weekCells: ['金30', '土31', '日1', '月2', '火3', '水4', '木5'],
    weekDates: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
  },
  // JST の年の変わり目 (2027-01-01 0:00)
  {
    at: '2026-12-31T15:00:00.000Z',
    jstToday: '2027-01-01',
    weekCells: ['土26', '日27', '月28', '火29', '水30', '木31', '金1'],
    weekDates: ['2026-12-26', '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01'],
  },
  // うるう日をまたぐ 7 日 (JST 2028-03-01 9:00)
  {
    at: '2028-03-01T00:00:00.000Z',
    jstToday: '2028-03-01',
    weekCells: ['木24', '金25', '土26', '日27', '月28', '火29', '水1'],
    weekDates: ['2028-02-24', '2028-02-25', '2028-02-26', '2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'],
  },
  // JST の月の変わり目 (2026-12-01 1:00。America/Los_Angeles ではまだ 11 月 30 日)
  {
    at: '2026-11-30T16:00:00.000Z',
    jstToday: '2026-12-01',
    weekCells: ['水25', '木26', '金27', '土28', '日29', '月30', '火1'],
    weekDates: ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'],
  },
];

let container: HTMLDivElement;
let root: Root;
let requests: string[];
/** /api/health/streaks の weeklyRecords (記録のある日) */
let weeklyRecords: string[];
let originalTimeZone: string | undefined;

/**
 * 時計を startIso に合わせる。引数なしの new Date() と Date.now() は、読むたびに tickMs だけ進む (0 なら止まったまま)。
 * 引数つきの new Date(...) (暦日の計算) はそのまま (tests/health-graphs-today-range-2227.test.tsx と同じ形)
 */
function installClock(startIso: string, tickMs: number) {
  const RealDate = globalThis.Date;
  let nowMs = RealDate.parse(startIso);
  const read = () => {
    const value = nowMs;
    nowMs += tickMs;
    return value;
  };
  class ClockDate extends RealDate {
    constructor(...args: [] | [number | string | Date] | [number, number, number?, number?, number?, number?, number?]) {
      if (args.length === 0) super(read());
      else if (args.length === 1) super(args[0]);
      else super(...args);
    }

    static now(): number {
      return read();
    }
  }
  vi.stubGlobal('Date', ClockDate);
}

beforeEach(() => {
  requests = [];
  weeklyRecords = [];
  supabaseMock.tableRows = {};
  supabaseMock.queries = [];
  originalTimeZone = process.env.TZ;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), URL_ORIGIN);
      requests.push(`${(init?.method ?? READ_METHOD).toUpperCase()} ${url.pathname}${url.search}`);
      if (url.pathname === '/api/health/streaks') {
        return Response.json({ streak: STREAK, nextBadge: 7, daysToNextBadge: 4, weeklyRecords }, { status: OK_STATUS });
      }
      if (url.pathname.startsWith('/api/health/records/')) return Response.json({ record: null, previous: null }, { status: OK_STATUS });
      if (url.pathname === '/api/health/goals') return Response.json({ goals: [] }, { status: OK_STATUS });
      return Response.json({}, { status: NOT_FOUND_STATUS });
    }),
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useShoppingStore.getState().resetShoppingState();
  // 元が未設定なら消す (undefined を入れると文字列 "undefined" になる)
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** タイムゾーンと時計を合わせて描き、読み込みを流しきる */
async function renderAt(timeZone: string, at: string, tickMs: number, element: React.ReactElement) {
  process.env.TZ = timeZone;
  installClock(at, tickMs);
  await act(async () => {
    root.render(element);
  });
  await settle();
}

/** /health の週間カレンダーのボタン (aria-pressed を持つ 7 つ) */
function healthCalendarButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
}

/** /health/streaks の「今週の記録」の 7 つのセル */
function streaksWeekCells(): HTMLElement[] {
  const heading = [...container.querySelectorAll('h2')].find((h) => h.textContent === '今週の記録');
  const row = heading?.nextElementSibling?.firstElementChild;
  return row ? ([...row.children] as HTMLElement[]) : [];
}

/** 曜日の 1 文字と日 ("水4") の並びが、続いた 7 日 (曜日が 1 つずつ進み、日が 1 つずつ進むか月の初めの 1 に戻る) か */
function expectConsecutiveCells(cells: readonly string[]) {
  expect(cells).toHaveLength(WEEK_DAYS);
  const parsed = cells.map((cell) => ({ weekday: WEEKDAY_LABELS_JA.indexOf(cell.slice(0, 1) as (typeof WEEKDAY_LABELS_JA)[number]), day: Number(cell.slice(1)) }));
  for (let i = 1; i < parsed.length; i += 1) {
    expect((parsed[i - 1].weekday + 1) % WEEKDAY_LABELS_JA.length, `${cells.join(' ')}: ${i} 番目で曜日が飛んだ・重なった`).toBe(parsed[i].weekday);
    expect([parsed[i - 1].day + 1, 1], `${cells.join(' ')}: ${i} 番目で日が飛んだ・重なった`).toContain(parsed[i].day);
  }
}

describe('calendarDaysEndingAt: lastDay で終わる count 日の暦日・曜日・日 (#2235 I3)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    it(`実行環境のタイムゾーン ${timeZone} でも、暦の計算だけで並べる`, () => {
      process.env.TZ = timeZone;
      for (const clock of CLOCK_CASES) {
        const cells = calendarDaysEndingAt(clock.jstToday, WEEK_DAYS);
        expect(cells.map((cell) => cell.date)).toEqual(clock.weekDates);
        expect(cells.map((cell) => `${WEEKDAY_LABELS_JA[cell.dayOfWeek]}${cell.dayOfMonth}`)).toEqual(clock.weekCells);
      }
    });
  }

  it('1 日だけなら lastDay だけを返す', () => {
    expect(calendarDaysEndingAt('2026-11-05', 1)).toEqual([{ date: '2026-11-05', dayOfWeek: 4, dayOfMonth: 5 }]);
  });

  it('形の違う日付・存在しない日付・1 以上の整数でない日数は RangeError', () => {
    expect(() => calendarDaysEndingAt('2026-11-5', WEEK_DAYS)).toThrow(RangeError);
    expect(() => calendarDaysEndingAt('2026-02-30', WEEK_DAYS)).toThrow(RangeError);
    expect(() => calendarDaysEndingAt('2026-11-05', 0)).toThrow(RangeError);
    expect(() => calendarDaysEndingAt('2026-11-05', -1)).toThrow(RangeError);
    expect(() => calendarDaysEndingAt('2026-11-05', 1.5)).toThrow(RangeError);
  });
});

describe('/health: 今日と週間カレンダーは実行環境のタイムゾーンに依らず JST の今日から (#2235 I3)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    describe(`実行環境のタイムゾーン ${timeZone}`, () => {
      for (const clock of CLOCK_CASES) {
        it(`時計を止めて ${clock.at} (JST の今日 ${clock.jstToday}): 今日の記録を JST の今日で読み、7 日を JST の今日まで並べる`, async () => {
          weeklyRecords = [clock.jstToday];
          await renderAt(timeZone, clock.at, FROZEN_CLOCK_MS, <HealthDashboardPage />);
          expect(requests).toContain(`GET /api/health/records/${clock.jstToday}`);
          const buttons = healthCalendarButtons();
          // ボタンの読み上げは「曜日 日 日」。記録のある日 (サーバーの weeklyRecords = JST の今日) には「（記録あり）」が付く
          expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(
            clock.weekCells.map((cell, i) => `${cell}日${i === WEEK_DAYS - 1 ? '（記録あり）' : ''}`),
          );
          // 何も選んでいないときは今日 (最後の日) が押された状態
          expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(
            clock.weekCells.map((_, i) => String(i === WEEK_DAYS - 1)),
          );
        });
      }
    });
  }
});

describe('/health/streaks: 今週の記録の 7 日は実行環境のタイムゾーンに依らず JST の今日から (#2235 I3)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    describe(`実行環境のタイムゾーン ${timeZone}`, () => {
      for (const clock of CLOCK_CASES) {
        it(`時計を止めて ${clock.at} (JST の今日 ${clock.jstToday}): 7 日を JST の今日まで並べ、記録のある日に印を付ける`, async () => {
          weeklyRecords = [clock.jstToday];
          await renderAt(timeZone, clock.at, FROZEN_CLOCK_MS, <StreaksPage />);
          const cells = streaksWeekCells();
          expect(cells.map((cell) => cell.textContent)).toEqual([...clock.weekCells]);
          // 記録のある日 (JST の今日 = 最後の日) だけに印 (CheckCircle2 の svg) が付く
          expect(cells.map((cell) => cell.querySelector('svg') !== null)).toEqual(clock.weekCells.map((_, i) => i === WEEK_DAYS - 1));
        });
      }
    });
  }

  it('時計を読むたびに 1 日進めても、7 日は 1 回の時計の読み取りから続いた暦日で並ぶ (日ごとに時計を読まない)', async () => {
    await renderAt('UTC', CLOCK_CASES[0].at, DAY_MS, <StreaksPage />);
    expectConsecutiveCells(streaksWeekCells().map((cell) => cell.textContent ?? ''));
  });
});

/** ホームの記録の集計を出す (週間統計の日・曜日・カロリー) */
function HomeWeeklyProbe() {
  const { weeklyStats } = useHomeData();
  return (
    <ul data-testid="weekly">
      {weeklyStats?.days.map((day) => (
        <li key={day.date}>{`${day.date} ${day.dayOfWeek} ${day.totalCalories}`}</li>
      ))}
    </ul>
  );
}

/** その日の献立のカロリー (日ごとに違う値にして、日付と集計の取り違えを見分ける) */
const CALORIES_STEP = 100;
const caloriesOfDay = (index: number) => CALORIES_STEP * (index + 1);

/** 問い合わせの、あるメソッドの最初の呼び出しの引数 */
function callArgs(query: RecordedQuery, method: string): unknown[] | undefined {
  return query.calls.find((call) => call.method === method)?.args;
}
/** user_daily_meals の問い合わせのうち、select の列に needle を含むもの */
function dailyMealsQueries(needle: string): RecordedQuery[] {
  return supabaseMock.queries.filter(
    (q) => q.table === 'user_daily_meals' && String(callArgs(q, 'select')?.[0] ?? '').includes(needle) && callArgs(q, 'gte') !== undefined,
  );
}
/** 週間統計の問い合わせ (カロリーを読む) */
const weeklyStatsQuery = () => dailyMealsQueries('calories_kcal')[0];
/** 連続自炊の問い合わせ (新しい順に並べる) */
const cookingStreakQuery = () =>
  dailyMealsQueries('planned_meals(mode, is_completed)').find((q) => (callArgs(q, 'order')?.[1] as { ascending?: boolean } | undefined)?.ascending === false);
/** 月間統計の問い合わせ (並べない) */
const monthlyStatsQuery = () => dailyMealsQueries('planned_meals(mode, is_completed)').find((q) => callArgs(q, 'order') === undefined);
/** 今週のベスト料理の問い合わせ */
const bestMealQuery = () => supabaseMock.queries.find((q) => q.table === 'planned_meals' && callArgs(q, 'gte')?.[0] === 'user_daily_meals.day_date');

describe('ホーム (useHomeData): 記録の集計の期間と週間統計の日・曜日は JST の今日から (#2235 I3)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    describe(`実行環境のタイムゾーン ${timeZone}`, () => {
      for (const clock of CLOCK_CASES) {
        it(`時計を止めて ${clock.at} (JST の今日 ${clock.jstToday}): 期間の両端を JST の今日から求め、週間統計の 7 日と曜日を JST の暦で出す`, async () => {
          supabaseMock.tableRows = {
            user_daily_meals: clock.weekDates.map((date, i) => ({
              day_date: date,
              planned_meals: [{ mode: 'cook', is_completed: true, calories_kcal: caloriesOfDay(i) }],
            })),
          };
          await renderAt(timeZone, clock.at, FROZEN_CLOCK_MS, <HomeWeeklyProbe />);
          const weekly = [...container.querySelectorAll('[data-testid="weekly"] li')].map((li) => li.textContent);
          expect(weekly).toEqual(clock.weekDates.map((date, i) => `${date} ${clock.weekCells[i].slice(0, 1)} ${caloriesOfDay(i)}`));

          expect(callArgs(weeklyStatsQuery(), 'gte')).toEqual(['day_date', clock.weekDates[0]]);
          expect(callArgs(weeklyStatsQuery(), 'lte')).toEqual(['day_date', clock.jstToday]);
          expect(callArgs(cookingStreakQuery()!, 'gte')).toEqual(['day_date', addDaysToDate(clock.jstToday, -COOKING_STREAK_LOOKBACK_DAYS)]);
          expect(callArgs(cookingStreakQuery()!, 'lte')).toEqual(['day_date', clock.jstToday]);
          expect(callArgs(monthlyStatsQuery()!, 'gte')).toEqual(['day_date', `${clock.jstToday.slice(0, 'YYYY-MM'.length)}-01`]);
          expect(callArgs(monthlyStatsQuery()!, 'lte')).toEqual(['day_date', clock.jstToday]);
          expect(callArgs(bestMealQuery()!, 'gte')).toEqual(['user_daily_meals.day_date', clock.weekDates[0]]);
        });
      }
    });
  }

  it('時計を読むたびに 1 日進めても、同じ問い合わせの両端と週間統計の 7 日は 1 回の時計の読み取りから求める', async () => {
    await renderAt('UTC', CLOCK_CASES[0].at, DAY_MS, <HomeWeeklyProbe />);
    // 問い合わせの終わり (lte) は、ホームが読んだ今日。始まり (gte) はそこから暦の計算でずらした日 (時計を読み直さない)
    const today = callArgs(weeklyStatsQuery(), 'lte')?.[1] as string;
    const weekDates = calendarDaysEndingAt(today, WEEK_DAYS).map((cell) => cell.date);
    expect(callArgs(weeklyStatsQuery(), 'gte')).toEqual(['day_date', weekDates[0]]);
    expect(callArgs(cookingStreakQuery()!, 'gte')).toEqual(['day_date', addDaysToDate(callArgs(cookingStreakQuery()!, 'lte')?.[1] as string, -COOKING_STREAK_LOOKBACK_DAYS)]);
    expect(callArgs(bestMealQuery()!, 'gte')).toEqual(['user_daily_meals.day_date', weekDates[0]]);
    const weekly = [...container.querySelectorAll('[data-testid="weekly"] li')].map((li) => li.textContent?.split(' ')[0]);
    expect(weekly).toEqual(weekDates);
  });
});

interface ShoppingRangeCase {
  readonly timeZone: string;
  /** 時計の時刻 (UTC) */
  readonly at: string;
  /** 範囲を選ぶ欄に出る「今日」「明日」「明後日」「1週間分」「3日分」の日付 (formatDateJa の表記) */
  readonly today: string;
  readonly tomorrow: string;
  readonly dayAfterTomorrow: string;
  readonly weekEnd: string;
  readonly threeDaysEnd: string;
}

const SHOPPING_RANGE_CASES: readonly ShoppingRangeCase[] = [
  // America/Los_Angeles の夏時間の始まりの前の日の朝 (2027-03-13 7:30 PST = JST 2027-03-14 0:30)。端末のローカル時刻で 1 日ずらすと
  // 夏時間に入って 23 時間しか進まず、JST の日付が 1 日手前になる
  { timeZone: 'America/Los_Angeles', at: '2027-03-13T15:30:00.000Z', today: '3月14日', tomorrow: '3月15日', dayAfterTomorrow: '3月16日', weekEnd: '3月20日', threeDaysEnd: '3月16日' },
  // 夏時間の終わり (2026-11-01 PDT → PST) の前の日の朝 (2026-10-31 7:30 PDT = JST 2026-10-31 23:30)。端末のローカル時刻で 1 日ずらすと
  // 25 時間進み、JST の日付が 1 日先になる
  { timeZone: 'America/Los_Angeles', at: '2026-10-31T14:30:00.000Z', today: '10月31日', tomorrow: '11月1日', dayAfterTomorrow: '11月2日', weekEnd: '11月6日', threeDaysEnd: '11月2日' },
  { timeZone: 'UTC', at: '2026-11-04T15:00:00.000Z', today: '11月5日', tomorrow: '11月6日', dayAfterTomorrow: '11月7日', weekEnd: '11月11日', threeDaysEnd: '11月7日' },
  { timeZone: 'Pacific/Kiritimati', at: '2026-12-31T14:59:59.999Z', today: '12月31日', tomorrow: '1月1日', dayAfterTomorrow: '1月2日', weekEnd: '1月6日', threeDaysEnd: '1月2日' },
];

describe('買い物リストの範囲を選ぶ欄: 今日から n 日は JST の今日から暦の計算だけでずらす (#2235 I3)', () => {
  for (const c of SHOPPING_RANGE_CASES) {
    it(`実行環境のタイムゾーン ${c.timeZone}・${c.at} (JST の今日 ${c.today}): 明日・明後日・1週間分・3日分の日付`, async () => {
      await renderAt(
        c.timeZone,
        c.at,
        FROZEN_CLOCK_MS,
        <ShoppingRangeModal
          isTodayExpanded={false}
          currentWeekStart={new Date(c.at)}
          onClose={() => undefined}
          onToggleTodayExpanded={() => undefined}
          onGenerate={async () => undefined}
        />,
      );
      const text = container.textContent ?? '';
      expect(text).toContain(`（${c.today}）`);
      expect(text).toContain(`明日の分（${c.tomorrow}）`);
      expect(text).toContain(`明後日の分（${c.dayAfterTomorrow}）`);
      expect(text).toContain(`${c.today}〜${c.weekEnd}`);
      expect(text).toContain(`${c.today}〜${c.threeDaysEnd}`);
    });
  }
});
