/**
 * #2235 I3 YYYY-MM-DD の暦日 (DB の date 列・JST の今日) を画面に出すとき、実行環境のタイムゾーンに依らずその暦日のまま出すことの回帰テスト。
 *
 * 問題 (直す前):
 *   new Date('2026-11-05') は UTC の 0 時 (JST の 9 時) の瞬間になる。それを端末のローカル時刻 (getMonth / getDate / getDay、
 *   timeZone を付けない toLocaleDateString) で読んでいたので、端末が UTC より西 (America/Los_Angeles など) では前の日になった:
 *   - /meals/new の「保存先」(JST の今日を選んでいても「11月4日」)。曜日は表示中の週の格子 (weekDates) から引いていたので、
 *     格子に保存先の日が無い週を表示すると曜日が抜け (「11月5日（）」)、端末が JST より東 (Pacific/Kiritimati など) では
 *     格子の dateStr と曜日が 1 日ずれていて、保存先の曜日が次の日の曜日になった (「11月5日（金）」)
 *   - /meals/new の体重の「直近7日間の推移」の日 (record_date)
 *   - /health/blood-tests の検査日・/health/checkups の受診日と経年分析の日・/health/checkups/[id] の受診日・
 *     /health/insights の分析の日・/health/goals の期限・/meals/[id] の食べた日 (曜日も)
 * 今は parseLocalDate (年月日を端末のローカル時刻の 0 時の Date にする) / formatDateJa で、その文字列の年月日を読む。
 * 同じ形の全域の表と見張りは tests/date-shift-inventory-2235.test.ts (DATE_PARSE_SITES・D-4〜D-6)。
 *
 * もう 1 つの形 (直す前): /menus/weekly の「今日の栄養」の見出し (StatsModal) は、日付を JST の今日 (formatLocalDate(new Date())) で、
 * 曜日を端末の暦 (new Date().getDay()) で読んでいた。端末のタイムゾーンが日本でないと、曜日が日付と合わなかった
 * (America/Los_Angeles で JST の 11-05 (木) の朝に「11月5日（水）の栄養」、JST の 11-06 (金) 0 時に「11月6日（木）の栄養」)。
 * 今は親 (menus/weekly/page.tsx) が時計を 1 回だけ読んだ JST の今日 (todayStr。今日の栄養を引く日と同じ) を渡し、日付と曜日を
 * その暦日から読む。同じ形の全域の表と見張りは tests/date-shift-inventory-2235.test.ts (NOW_DEVICE_CALENDAR_SITES・D-7〜D-9)。
 *
 * ここでは、時計を JST 2026-11-05 (木) 10:00 (America/Los_Angeles ではまだ 11-04 の夕方、Pacific/Kiritimati では 11-05 の午後) に止め、
 * 実行環境のタイムゾーン (UTC・JST・JST より西 (UTC-8)・東 (UTC+14)) を変えて各画面を描き、出す日付・曜日を確かめる。
 * 表示の文字は、画面が出す文字と同じ組み立て (年・月・日の数) で、期待する暦日から直接書く (直した後の関数で期待値を作らない)。
 *
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** useSearchParams が返すクエリ文字列 (先頭の ? は付けない) */
  query: { value: '' },
  /** 体重のグラフ (recharts の LineChart) に渡った data の date (描くたびに上書き) */
  chartDates: null as string[] | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(mocks.query.value),
  useRouter: () => ({ push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  useParams: () => ({}),
}));
vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: ReactNode }) => react.createElement('a', { href }, children),
  };
});
vi.mock('next/image', () => ({ default: () => null }));
// StatsModal のレーダーチャート (next/dynamic で読む) は描かない (見出しの文字だけを確かめる。ほかの画面は next/dynamic を使わない)
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));
vi.mock('@/lib/db-logger', () => ({ logToServer: () => undefined }));
// アニメーションは描かずに中身だけを出す。motion.div などは毎回同じ部品を返す (違う型になると描き直しのたびに作り直される)
vi.mock('framer-motion', async () => {
  const react = await import('react');
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
          const MotionElement = react.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
            const rest: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) if (!MOTION_PROPS.has(key)) rest[key] = value;
            return react.createElement(tag, { ...rest, ref });
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
    AnimatePresence: ({ children }: { children?: ReactNode }) => react.createElement(react.Fragment, null, children),
  };
});
// recharts の ResponsiveContainer は ResizeObserver が要る。グラフは描かず、LineChart に渡った data の date を取っておく
vi.mock('recharts', async () => {
  const react = await import('react');
  const Box = ({ children }: { children?: ReactNode }) => react.createElement('div', null, children);
  const Empty = () => null;
  const LineChart = ({ data, children }: { data?: { date: string }[]; children?: ReactNode }) => {
    mocks.chartDates = (data ?? []).map((point) => point.date);
    return react.createElement('div', null, children);
  };
  return { LineChart, ResponsiveContainer: Box, Line: Empty, XAxis: Empty, YAxis: Empty, ReferenceLine: Empty };
});
vi.mock('@/lib/supabase/client', () => {
  /** どのメソッドを呼んでも自分を返し、await すると行の無い答えになる問い合わせ */
  const query = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve({ data: null, error: null, count: 0 });
        return () => query();
      },
    });
  const user = { id: 'user-2235', user_metadata: {} };
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user } }, error: null }),
      getUser: async () => ({ data: { user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
    from: () => query(),
    rpc: () => query(),
    channel: () => channel,
    removeChannel: async () => 'ok',
  };
  return { createClient: () => client };
});

const { default: MealCaptureModal } = await import('@/app/(main)/meals/new/page');
const { default: BloodTestsPage } = await import('@/app/(main)/health/blood-tests/page');
const { default: HealthCheckupsPage } = await import('@/app/(main)/health/checkups/page');
const { default: CheckupDetailClient } = await import('@/app/(main)/health/checkups/[id]/CheckupDetailClient');
const { default: HealthInsightsPage } = await import('@/app/(main)/health/insights/page');
const { default: HealthGoalsPage } = await import('@/app/(main)/health/goals/page');
const { default: MealDetailPage } = await import('@/app/(main)/meals/[id]/page');
const { StatsModal } = await import('@/app/(main)/menus/weekly/_components/modals/StatsModal');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 実行環境のタイムゾーン (UTC・JST・JST より西 (UTC-8)・東 (UTC+14)) */
const RUNTIME_TIME_ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'] as const;
/** 止めた時計 (JST 2026-11-05 (木) 10:00。America/Los_Angeles では 11-04 17:00、Pacific/Kiritimati では 11-05 15:00) */
const CLOCK_AT = '2026-11-05T01:00:00.000Z';
/** その時刻の JST の今日 (/meals/new の保存先の既定) の、画面に出す月日と曜日 */
const JST_TODAY_SAVE_TARGET = '11月5日（木）の';
/** 画面に出す暦日 (DB の date 列の値。どれも木曜日) */
const SHOWN_DAY = '2026-11-05';
/** その前の日 (直す前の形が UTC より西で出していた日) の月日 */
const PREVIOUS_DAY_MONTH_DAY = '11月4日';
/** 経年分析の日 (受診日と別の日にして、どちらの欄の文字かを分ける) */
const REVIEW_DAY = '2026-11-01';

/** fetch → res.json() → setState → useEffect の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 30;
/** 条件を待つときに、1 回あたり待つ ms と、待つ回数の上限 (時計を止めているので Date.now で時間切れを測らない) */
const WAIT_STEP_MS = 10;
const WAIT_MAX_STEPS = 300;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
/** 解析の確からしさ (画面が読み取れたとみなす値より上) */
const CONFIDENT = 0.92;
/** AI が読み取った体重 */
const AI_READ_WEIGHT = 62.3;

const MEAL_ID = 'meal-2235';
const CHECKUP_ID = 'checkup-2235';
/** 食事の写真の解析の応答 (結果の画面に進むための最小の料理 1 品) */
const MEAL_ANALYSIS = {
  dishes: [{ name: '白ごはん', role: 'main', cal: 252, calories_kcal: 252 }],
  totalCalories: 252,
  totalProtein: 3.8,
  totalCarbs: 55.7,
  totalFat: 0.5,
  overallScore: 72,
  vegScore: 0,
  praiseComment: '',
  nutritionTip: '',
  nutritionalAdvice: '',
};
/** 体重の直近 7 日の記録 (record_date は YYYY-MM-DD の暦日) */
const WEIGHT_HISTORY = [
  { record_date: '2026-11-03', weight: 62.5 },
  { record_date: '2026-11-04', weight: 62.4 },
  { record_date: SHOWN_DAY, weight: AI_READ_WEIGHT },
];

/** 道 → 応答の本文。無い道は 404 */
const FETCH_BODIES: Record<string, unknown> = {
  '/api/ai/analyze-meal-photo': MEAL_ANALYSIS,
  '/api/ai/analyze-weight-scale': { weight: AI_READ_WEIGHT, confidence: CONFIDENT },
  '/api/health/records/history?days=7': WEIGHT_HISTORY,
  '/api/health/blood-tests?limit=20': { results: [{ id: 'blood-2235', test_date: SHOWN_DAY, hemoglobin: 12.5 }] },
  '/api/health/checkups': {
    checkups: [{ id: CHECKUP_ID, checkup_date: SHOWN_DAY }],
    longitudinalReview: {
      review_date: REVIEW_DAY,
      trend_analysis: { overallAssessment: '経年の評価', improvingMetrics: [], worseningMetrics: [] },
    },
  },
  [`/api/health/checkups/${CHECKUP_ID}`]: { checkup: { id: CHECKUP_ID, checkup_date: SHOWN_DAY, hemoglobin: 12.5 } },
  '/api/health/insights?limit=50': {
    insights: [
      {
        id: 'insight-2235',
        analysis_date: SHOWN_DAY,
        period_type: 'weekly',
        insight_type: 'trend',
        title: '分析の見出し',
        summary: '分析のまとめ',
        priority: 'low',
        is_alert: false,
        is_read: true,
        created_at: '2026-11-05T00:00:00.000Z',
      },
    ],
    unreadCount: 0,
    alertCount: 0,
  },
  '/api/health/goals?status=all': {
    goals: [
      {
        id: 'goal-2235',
        goal_type: 'weight',
        target_value: 60,
        target_unit: 'kg',
        current_value: 64,
        start_value: 66,
        progress_percentage: 33,
        status: 'active',
        target_date: SHOWN_DAY,
        milestones: [],
      },
    ],
  },
  [`/api/meals/${MEAL_ID}`]: {
    id: MEAL_ID,
    daily_meal_id: 'day-2235',
    meal_type: 'dinner',
    mode: 'cook',
    dish_name: '日付の検査の料理',
    is_completed: false,
    completed_at: null,
    user_daily_meals: { day_date: SHOWN_DAY },
  },
};

/** jsdom / happy-dom は画像を読み込まないので、読み込み失敗として返す偽物 (/meals/new は元の画像をそのまま送る経路に進む) */
class UnloadableImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
/** 差し替えた URL の静的メソッドを元に戻す (元から無ければ消す) */
function restoreUrlMethod(name: 'createObjectURL' | 'revokeObjectURL', original: PropertyDescriptor | undefined) {
  if (original) Object.defineProperty(URL, name, original);
  else delete (URL as unknown as Record<string, unknown>)[name];
}

let container: HTMLDivElement;
let root: Root;
let originalTimeZone: string | undefined;

beforeEach(() => {
  mocks.query.value = '';
  mocks.chartDates = null;
  originalTimeZone = process.env.TZ;
  // 引数なしの new Date() と Date.now() だけを止める (setTimeout などは本物のまま)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CLOCK_AT));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url in FETCH_BODIES) return Response.json(FETCH_BODIES[url], { status: OK_STATUS });
      return Response.json({}, { status: NOT_FOUND_STATUS });
    }),
  );
  vi.stubGlobal('Image', UnloadableImage);
  vi.stubGlobal('alert', vi.fn());
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:http://localhost/photo-2235'), configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreUrlMethod('createObjectURL', originalCreateObjectURL);
  restoreUrlMethod('revokeObjectURL', originalRevokeObjectURL);
  // 元が未設定なら消す (undefined を入れると文字列 "undefined" になる)
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

const text = () => container.textContent ?? '';

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** 条件を満たすまで待つ (FileReader など、act だけでは進まない非同期の処理を待つ) */
async function waitUntil(predicate: () => boolean, what: string) {
  for (let step = 0; !predicate(); step += 1) {
    if (step >= WAIT_MAX_STEPS) throw new Error(`待ちきれなかった: ${what}\n--- 画面の文字 ---\n${text()}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    });
  }
}

/** タイムゾーンを合わせて描き、読み込みを流しきる */
async function renderIn(timeZone: string, element: ReactNode, query = '') {
  process.env.TZ = timeZone;
  mocks.query.value = query;
  await act(async () => {
    root.render(element);
  });
  await settle();
}

function buttonContaining(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label));
}

async function click(element: HTMLElement | undefined | null, what: string) {
  expect(element, `押すものが無い: ${what}\n--- 画面の文字 ---\n${text()}`).toBeTruthy();
  await act(async () => {
    element!.click();
  });
}

/** /meals/new の撮影ステップで写真を 1 枚選び、「AIで解析する」を押す */
async function takePhotoAndAnalyze() {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  expect(input, '撮影ステップに写真の入力が無い').not.toBeNull();
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input!, 'files', { value: [file], configurable: true });
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitUntil(() => buttonContaining('AIで解析する') !== undefined, '「AIで解析する」ボタン');
  await click(buttonContaining('AIで解析する'), 'AIで解析する');
}

/** /meals/new の日時の選択の「保存先」の見出しの次の段落 (保存する日と食事の区分) の文字 */
function saveTargetText(): string | null | undefined {
  const heading = [...container.querySelectorAll('p')].find((p) => p.textContent === '保存先');
  return heading?.nextElementSibling?.textContent;
}

/** 食事の写真を解析して、日時の選択 (保存先) まで進む */
async function openMealSaveTarget(timeZone: string) {
  await renderIn(timeZone, createElement(MealCaptureModal), 'mode=meal');
  await takePhotoAndAnalyze();
  await waitUntil(() => container.querySelector('[data-testid="meal-save-button"]') !== null, '「日時を選んで保存」ボタン');
  await click(container.querySelector<HTMLButtonElement>('[data-testid="meal-save-button"]'), '日時を選んで保存');
  await waitUntil(() => saveTargetText() != null, '保存先');
}

describe('YYYY-MM-DD の暦日を、実行環境のタイムゾーンに依らずその暦日のまま出す (#2235 I3)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    describe(`実行環境のタイムゾーン ${timeZone}`, () => {
      it('/meals/new の保存先: 既定の JST の今日を、その月日と曜日で出す (前の日・格子の次の日の曜日にしない)', async () => {
        await openMealSaveTarget(timeZone);
        expect(saveTargetText()).toMatch(new RegExp(`^${JST_TODAY_SAVE_TARGET}`));
      });

      it('/meals/new の保存先: 保存先の日が無い次の週を表示しても、曜日を抜かさない', async () => {
        await openMealSaveTarget(timeZone);
        // 週の範囲の表示 ("11/2 - 11/8" など) のすぐ右が次の週へのボタン
        const weekRange = [...container.querySelectorAll('span')].find((span) => /^\d+\/\d+ - \d+\/\d+$/.test(span.textContent ?? ''));
        const before = weekRange?.textContent;
        await click(weekRange?.nextElementSibling as HTMLElement | null, '次の週へ');
        expect(weekRange?.textContent, '次の週に進んでいない').not.toBe(before);
        expect(saveTargetText()).toMatch(new RegExp(`^${JST_TODAY_SAVE_TARGET}`));
      });

      it('/meals/new の体重の直近7日間の推移: 記録の日 (record_date) の日をそのまま出す', async () => {
        await renderIn(timeZone, createElement(MealCaptureModal), 'mode=weight_scale');
        await takePhotoAndAnalyze();
        await waitUntil(() => text().includes('直近7日間の推移') && mocks.chartDates !== null, '直近7日間の推移');
        expect(mocks.chartDates).toEqual(['3日', '4日', '5日']);
      });

      it('/health/blood-tests: 検査日 (test_date) をその暦日で出す', async () => {
        await renderIn(timeZone, createElement(BloodTestsPage));
        expect(text()).toContain('2026年11月5日');
        expect(text()).not.toContain(PREVIOUS_DAY_MONTH_DAY);
      });

      it('/health/checkups: 受診日 (checkup_date) と経年分析の日 (review_date) をその暦日で出す', async () => {
        await renderIn(timeZone, createElement(HealthCheckupsPage));
        expect(text()).toContain('2026/11/05');
        expect(text()).toContain('2026/11/01');
        expect(text()).not.toContain('2026/11/04');
        expect(text()).not.toContain('2026/10/31');
      });

      it('/health/checkups/[id]: 受診日 (checkup_date) をその暦日で出す', async () => {
        await renderIn(timeZone, createElement(CheckupDetailClient, { id: CHECKUP_ID }));
        expect(text()).toContain('2026年11月5日');
        expect(text()).not.toContain(PREVIOUS_DAY_MONTH_DAY);
      });

      it('/health/insights: 分析の日 (analysis_date) をその暦日で出す', async () => {
        await renderIn(timeZone, createElement(HealthInsightsPage));
        expect(text()).toContain('分析のまとめ');
        expect(text()).toContain('11月5日');
        expect(text()).not.toContain(PREVIOUS_DAY_MONTH_DAY);
      });

      it('/health/goals: 期限 (target_date) をその暦日で出す', async () => {
        await renderIn(timeZone, createElement(HealthGoalsPage));
        expect(text()).toContain('期限: 2026/11/5');
        expect(text()).not.toContain('期限: 2026/11/4');
      });

      it('/meals/[id]: 食べた日 (day_date) をその暦日と曜日で出す', async () => {
        await renderIn(timeZone, createElement(MealDetailPage, { params: Promise.resolve({ id: MEAL_ID }) }));
        expect(text()).toContain('日付の検査の料理');
        expect(text()).toContain('11月5日(木)');
        expect(text()).not.toContain(PREVIOUS_DAY_MONTH_DAY);
      });
    });
  }
});

/**
 * 「今日の栄養」の見出しを確かめる時刻と、そのときの JST の今日 (親が渡す todayStr) と見出しの文字。
 * 親は todayStr を formatLocalDate(new Date()) (JST) で作る。見出しの文字は期待する暦日から直接書く
 */
const STATS_TODAY_CASES = [
  // JST 2026-11-05 (木) 10:00 (America/Los_Angeles では 11-04 (水) 17:00)
  { at: CLOCK_AT, todayStr: SHOWN_DAY, heading: '11月5日（木）の栄養' },
  // JST の日付が変わる直前: JST 2026-11-05 (木) 23:59:59 (Pacific/Kiritimati ではもう 11-06 (金) 04:59)
  { at: '2026-11-05T14:59:59.000Z', todayStr: SHOWN_DAY, heading: '11月5日（木）の栄養' },
  // JST の日付が変わった直後: JST 2026-11-06 (金) 0:00 (UTC ではまだ 11-05 (木) 15:00、America/Los_Angeles では 11-05 (木) 7:00)
  { at: '2026-11-05T15:00:00.000Z', todayStr: '2026-11-06', heading: '11月6日（金）の栄養' },
] as const;

/** StatsModal を「今日」のタブで描く (今日の栄養の見出しだけを確かめるので、ほかの値は空) */
function statsModalElement(todayStr: string) {
  return createElement(StatsModal, {
    stats: { cookRate: 0, avgCal: 0, cookCount: 0, buyCount: 0, outCount: 0 },
    weekDates: [],
    weeklySummaryTab: 'today',
    radarChartNutrients: [],
    todayStr,
    todayNutrition: {},
    todayMealCount: 0,
    weekNutrition: { daysWithMeals: 0, averages: { caloriesKcal: 0, proteinG: 0, fatG: 0, carbsG: 0, fiberG: 0, sodiumG: 0 } },
    isLoadingFeedback: false,
    isLoadingHint: false,
    praiseComment: null,
    nutritionFeedback: null,
    nutritionTip: null,
    aiHint: null,
    onClose: () => undefined,
    onChangeTab: () => undefined,
    onOpenNutritionDetail: () => undefined,
  });
}

/** 「今日の栄養」の見出しの文字 */
function statsTodayHeadingText(): string | undefined {
  return [...container.querySelectorAll('p')].map((p) => p.textContent ?? '').find((t) => t.endsWith('の栄養'));
}

describe('/menus/weekly の「今日の栄養」の見出し: 日付と曜日を同じ JST の今日から読む (#2235 I3)', () => {
  for (const timeZone of RUNTIME_TIME_ZONES) {
    describe(`実行環境のタイムゾーン ${timeZone}`, () => {
      for (const c of STATS_TODAY_CASES) {
        it(`${c.at}: ${c.heading}`, async () => {
          vi.setSystemTime(new Date(c.at));
          await renderIn(timeZone, statsModalElement(c.todayStr));
          expect(statsTodayHeadingText()).toBe(c.heading);
        });
      }
    });
  }
});
