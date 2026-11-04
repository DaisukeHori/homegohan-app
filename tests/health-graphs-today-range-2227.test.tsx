/**
 * #2227 H6 /health/graphs のグラフの期間が、時計を読んだ瞬間に依らず「今日 (JST の暦日) まで」になることの回帰テスト。
 *
 * 問題 (直す前):
 *   グラフの日を並べるとき、期間の終わり (endDate = new Date()) と始まり (startDate = new Date() から日数を引く) で時計を 2 回読み、
 *   始まりから 1 日ずつ進めた日時が終わりの日時以下のあいだを並べていた。2 回の読み取りの間に時計が 1 ms 進むと、最後の日 (今日) の
 *   日時が終わりの日時を 1 ms 超えて、今日が期間から落ちた (今日の記録しか無ければ「データがありません」)。
 *   tests/ai-consultation-refetch-reads-2195.test.tsx の /health/graphs の it が、開いたときの画面だけ「データがありません」になって
 *   ときどき赤になっていた (CI の run 41810070656 と、docs-1104b の検証 a44fbfcc)。時刻ではなく、時計の読み取りの間に ms の境目が
 *   来たかどうかで決まる (k270 で 2 回続けて読むと約 0.004% の割合で別の ms になった。描画の途中では間がもっと空く)。
 *
 * ここでは、時計を止めた形 (どの時刻でも緑になること) と、時計を読むたびに 1 ms 進める形 (直す前の形が赤になること) で、
 * 1 日の中の時刻 (UTC の 0 時・9:30・9:50・JST の日付が変わる前後・UTC の 23:59) と年の変わり目、実行環境のタイムゾーン 3 つで確かめる。
 *
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/health/graphs',
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
vi.mock('@/lib/supabase/client', () => {
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  // 本物の createClient (ブラウザではシングルトン) と同じく、毎回同じクライアントを返す (このページは Realtime の購読だけに使う)
  const client = { channel: () => channel, removeChannel: async () => 'ok' };
  return { createClient: () => client };
});

const { default: HealthGraphsPage } = await import('@/app/(main)/health/graphs/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 30;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
/** fetch の init に method が無いときのメソッド */
const READ_METHOD = 'GET';
/** 道を取り出すための仮の起点 (fetch には相対の道が渡る) */
const URL_ORIGIN = 'http://localhost';
const RECORDS_PATH = '/api/health/records';
/** 今日の記録の体重 (グラフの見出しに 65.0 と出る) */
const TODAY_WEIGHT = 65;
const NO_DATA = 'データがありません';
/** 時計を読むたびに進める ms (直す前の形が、終わりと始まりの 2 回の読み取りの間に ms の境目をまたいだときと同じになる) */
const CLOCK_TICK_MS = 1;
/** 止めた時計 (読んでも進まない) */
const FROZEN_CLOCK_MS = 0;

/** 実行環境のタイムゾーン (UTC と、JST より東 (UTC+14)・西 (UTC-11) の端) */
const RUNTIME_TIME_ZONES = ['UTC', 'Pacific/Kiritimati', 'Pacific/Midway'] as const;

interface ClockCase {
  /** 時計の時刻 (UTC) */
  readonly at: string;
  /** その時刻の JST の今日 (グラフの最後の日) */
  readonly jstToday: string;
  /** 1ヶ月 (開いたときの期間、30 日) のグラフの最初の日 (今日の 29 日前) */
  readonly monthFirstDay: string;
  /** 記録の読み取りの開始日 (今日の 30 日前) */
  readonly recordsStartDate: string;
  /** 時計を進めると、描画の途中で JST の日付が変わる時刻 (時計を止めた形でだけ確かめる) */
  readonly atJstDayEnd?: boolean;
}

const CLOCK_CASES: readonly ClockCase[] = [
  { at: '2026-11-04T00:00:00.000Z', jstToday: '2026-11-04', monthFirstDay: '2026-10-06', recordsStartDate: '2026-10-05' },
  { at: '2026-11-04T09:30:00.000Z', jstToday: '2026-11-04', monthFirstDay: '2026-10-06', recordsStartDate: '2026-10-05' },
  // 赤が出はじめたと報告された時刻 (JST 18:50)
  { at: '2026-11-04T09:50:00.000Z', jstToday: '2026-11-04', monthFirstDay: '2026-10-06', recordsStartDate: '2026-10-05' },
  // JST の日付が変わる直前 (JST 23:59:59.999) と、変わった瞬間 (JST 0:00)
  { at: '2026-11-04T14:59:59.999Z', jstToday: '2026-11-04', monthFirstDay: '2026-10-06', recordsStartDate: '2026-10-05', atJstDayEnd: true },
  { at: '2026-11-04T15:00:00.000Z', jstToday: '2026-11-05', monthFirstDay: '2026-10-07', recordsStartDate: '2026-10-06' },
  { at: '2026-11-04T15:30:00.000Z', jstToday: '2026-11-05', monthFirstDay: '2026-10-07', recordsStartDate: '2026-10-06' },
  // UTC の日付が変わる直前 (JST では翌日の 8:59)
  { at: '2026-11-04T23:59:59.999Z', jstToday: '2026-11-05', monthFirstDay: '2026-10-07', recordsStartDate: '2026-10-06' },
  // JST の年の変わり目 (2027-01-01 0:00)
  { at: '2026-12-31T15:00:00.000Z', jstToday: '2027-01-01', monthFirstDay: '2026-12-03', recordsStartDate: '2026-12-02' },
];

/** 読み上げの日付 (YYYY-MM-DD → 2026年10月6日)。src/lib/health-trend-chart-a11y.ts と同じ形をここで書き下す */
function jaDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return `${year}年${month}月${date}日`;
}

let container: HTMLDivElement;
let root: Root;
let requests: string[];
let recordDate: string;
let originalTimeZone: string | undefined;

/**
 * 時計を startIso に合わせる。引数なしの new Date() と Date.now() は、読むたびに tickMs だけ進む (0 なら止まったまま)。
 * 引数つきの new Date(...) (暦日の計算) はそのまま
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
  recordDate = '';
  originalTimeZone = process.env.TZ;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), URL_ORIGIN);
      requests.push(`${(init?.method ?? READ_METHOD).toUpperCase()} ${url.pathname}${url.search}`);
      if (url.pathname === RECORDS_PATH) {
        return Response.json({ records: [{ record_date: recordDate, weight: TODAY_WEIGHT }] }, { status: OK_STATUS });
      }
      if (url.pathname === '/api/health/checkups') return Response.json({ checkups: [] }, { status: OK_STATUS });
      if (url.pathname === '/api/health/goals') return Response.json({ goals: [] }, { status: OK_STATUS });
      return Response.json({}, { status: NOT_FOUND_STATUS });
    }),
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
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

/** 時計とタイムゾーンを合わせてグラフの画面を開き、読み込みを流しきる */
async function openGraphsAt(timeZone: string, clock: ClockCase, tickMs: number) {
  process.env.TZ = timeZone;
  recordDate = clock.jstToday;
  installClock(clock.at, tickMs);
  await act(async () => {
    root.render(<HealthGraphsPage />);
  });
  await settle();
}

/** グラフ (role="img" の svg) の読み上げの説明 */
function chartDescription(): string {
  const desc = container.querySelector('svg[role="img"] desc');
  return desc?.textContent ?? '';
}

function expectTodayRecordShown(clock: ClockCase) {
  const text = container.textContent ?? '';
  expect(text, `今日 (${clock.jstToday}) の記録がグラフの期間から落ちた`).not.toContain(NO_DATA);
  expect(text).toContain(TODAY_WEIGHT.toFixed(1));
  // 期間は今日の 29 日前から今日まで (30 日)、記録がある日は今日の 1 日
  expect(chartDescription()).toContain(`${jaDate(clock.monthFirstDay)}から${jaDate(clock.jstToday)}までの日ごとの値です。値がある日は1日。`);
}

describe('/health/graphs: グラフの期間は時計を読んだ瞬間に依らず今日 (JST の暦日) まで (#2227 H6)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    describe(`実行環境のタイムゾーン ${timeZone}`, () => {
      for (const clock of CLOCK_CASES) {
        it(`時計を止めて ${clock.at} (JST の今日 ${clock.jstToday}): 今日の記録を出し、記録を今日の 30 日前から読む`, async () => {
          await openGraphsAt(timeZone, clock, FROZEN_CLOCK_MS);
          expectTodayRecordShown(clock);
          expect(requests).toContain(`GET ${RECORDS_PATH}?start_date=${clock.recordsStartDate}&limit=365`);
        });

        if (clock.atJstDayEnd === true) continue;
        it(`時計を読むたびに 1 ms 進めて ${clock.at}: 期間の終わりと始まりの読み取りの間に時計が進んでも、今日の記録を落とさない`, async () => {
          await openGraphsAt(timeZone, clock, CLOCK_TICK_MS);
          expectTodayRecordShown(clock);
          expect(requests).toContain(`GET ${RECORDS_PATH}?start_date=${clock.recordsStartDate}&limit=365`);
        });
      }
    });
  }
});
