/**
 * #2245 K2 献立表 (/menus/weekly) を JST の 0 時をまたいで開いたままにしたときの「今日」の回帰テスト。
 *
 * 問題 (直す前):
 *   - 空欄の数 (countEmptySlots)・これからの献立の数 (countFutureMeals)・期限までの日数 (getDaysUntil) は関数ごとに時計を読み直し、
 *     見出しの今日 (描画の todayStr) は描画の終わりの方で読んでいた。1 回の描画の途中で 0 時をまたぐと、空欄の数は前の日から数え、
 *     見出しは新しい日を「今日」とする (前の日を「過去」と出す) ように食い違った
 *   - 今日のフィードバックを読む effect (栄養分析の今日のタブ) は、その場で時計を読み、日付が変わっても読み直さなかった
 *     (開いたまま 0 時をまたいで描き直すと、見出しの今日は新しい日なのに、フィードバックは前の日のまま)
 *   - 献立の改善のモーダル (ImproveMealModal) は、「今日」の印と過去の日の判断で時計を別々に読み、親の見出しの今日とも別に読んでいた
 *
 * 直したあと:
 *   - 描画ごとに 1 回だけ今日 (todayStr) を読み、見出し・今日の印・空欄の数・期限までの日数・その描画の effect はどれもこの値を使う
 *   - 今日のフィードバックの effect は todayStr を依存に持ち、描き直しで今日が変わったら新しい今日のフィードバックを読む
 *   - 献立の改善のモーダルは、親の描画の今日 (todayStr) を受け取り、印と過去の日の判断をその今日で行う
 *
 * 描画の途中で 0 時をまたぐのは、@homegohan/shared の今日を読む関数 (todayLocal・今の時刻の formatLocalDate) を包み、
 * 「次に今日を読んだら時計を 0 時の後へ進める」形で作る (vi.setSystemTime)。
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 * 描画の部品のモックと作り物のサーバーは tests/weekly-date-param-2245.test.tsx と同じ。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 開いたときの時計 (JST 2026-11-04 (水) 23:59:00。実行環境は UTC で、端末の暦でも 2026-11-04 (水)) */
const BEFORE_MIDNIGHT = '2026-11-04T14:59:00.000Z';
/** 0 時をまたいだあとの時計 (JST 2026-11-05 (木) 00:00:01。端末の暦 (UTC) はまだ 2026-11-04 なので、週の格子は動かない) */
const AFTER_MIDNIGHT = '2026-11-04T15:00:01.000Z';

const navigation = vi.hoisted(() => {
  // ページの週の始まりの初期値はモジュールを読んだときの時計で決まるので、読む前に時計を止める (setTimeout などは止めない)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T14:59:00.000Z'));
  return {
    router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
    searchParams: new URLSearchParams(),
  };
});

/**
 * 今日を読む関数の包み。crossTo が null でなければ、次に今日を読んだあと (その読み取りは今の時計の日を返す) に時計を crossTo へ進める
 * (描画の途中で 0 時をまたぐ)。今日を読む = todayLocal()、または今の時刻 (Date.now() と同じ時刻) の formatLocalDate
 */
const clockCross = vi.hoisted(() => ({ crossTo: null as string | null }));
vi.mock('@homegohan/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@homegohan/shared')>();
  const crossAfterTodayRead = () => {
    if (clockCross.crossTo === null) return;
    const to = clockCross.crossTo;
    clockCross.crossTo = null;
    vi.setSystemTime(new Date(to));
  };
  return {
    ...actual,
    todayLocal: (timeZone?: string) => {
      const today = actual.todayLocal(timeZone);
      crossAfterTodayRead();
      return today;
    },
    formatLocalDate: (date?: Date, timeZone?: string) => {
      const readsNow = date === undefined || date.getTime() === Date.now();
      const formatted = actual.formatLocalDate(date, timeZone);
      if (readsNow) crossAfterTodayRead();
      return formatted;
    },
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/menus/weekly',
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// 画像・生成のモーダル・グラフ (dynamic import)・Markdown はこの検査に関係しないので描かない
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => undefined }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));

/** Supabase のモック。ログインしていて、プロフィールは全部入り (週の始まりは月曜)。ほかの表は空 */
vi.mock('@/lib/supabase/client', () => {
  const USER = { id: '22450000-0000-4000-8000-0000000000b1', user_metadata: {} };
  const PROFILE = {
    profile_completeness: 100,
    height: 170,
    weight: 65,
    age: 35,
    fitness_goals: ['健康維持'],
    health_conditions: ['なし'],
    week_start_day: 'monday',
    family_id: null,
  };
  const resultOf = (table: string | null, single: boolean) => {
    if (table === 'user_profiles') return single ? { data: PROFILE, error: null, count: 1 } : { data: [PROFILE], error: null, count: 1 };
    return single ? { data: null, error: null, count: 0 } : { data: [], error: null, count: 0 };
  };
  const query = (table: string | null, single: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(resultOf(table, single));
        return () => query(table, single || prop === 'single' || prop === 'maybeSingle');
      },
    });
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  return {
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: USER }, error: null }),
        getSession: async () => ({ data: { session: { user: USER } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: (table: string) => query(table, false),
      rpc: () => query(null, false),
      channel: () => channel,
      removeChannel: async () => 'ok',
    }),
  };
});

const { default: WeeklyMenuPage } = await import('@/app/(main)/menus/weekly/page');
const { ImproveMealModal } = await import('@/app/(main)/menus/weekly/_components/modals/ImproveMealModal');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
/** ページの API の相対 URL を解く起点 (fetch のモックの中だけで使う) */
const PAGE_ORIGIN = 'http://localhost';
const NOT_FOUND_STATUS = 404;
/** 0 時の前の今日・後の今日 (JST) */
const DAY_BEFORE = '2026-11-04';
const DAY_AFTER = '2026-11-05';
/** 献立の基本の区分の数 (朝・昼・夕。空欄の数は今日以降の日ごとにこの数を数える) */
const BASE_MEAL_SLOTS_PER_DAY = 3;
/** 今日の週 (月曜始まり 2026-11-02〜11-08) の、今日 (11-04 / 11-05) 以降の日の数 */
const DAYS_FROM_DAY_BEFORE_TO_WEEK_END = 5;
const DAYS_FROM_DAY_AFTER_TO_WEEK_END = 4;
/** 今日のフィードバックの API */
const FEEDBACK_PATH = '/api/ai/nutrition/feedback';

let fetchCalls: { path: string; method: string; range: string | null; date: string | null }[];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** GET /api/meal-plans の答え。範囲の初日に夕食を 1 つ置く (買い物の範囲を選ぶ欄は、表示中の週に献立があるときだけ開ける) */
function mealPlansJson(startDate: string, endDate: string) {
  return {
    dailyMeals: [
      {
        id: `day-${startDate}`,
        dayDate: startDate,
        theme: null,
        nutritionalFocus: null,
        isCheatDay: false,
        meals: [
          {
            id: `meal-${startDate}`,
            dailyMealId: `day-${startDate}`,
            mealType: 'dinner',
            dishName: 'カレー',
            mode: 'cook',
            isCompleted: false,
            recipeUrl: null,
            imageUrl: null,
            description: null,
            ingredients: [],
            recipeSteps: null,
            caloriesKcal: null,
            dishes: null,
            displayOrder: 0,
          },
        ],
      },
    ],
    startDate,
    endDate,
    shoppingList: { id: 'shopping-list-1', status: 'active', items: [] },
  };
}

function installFakeServer() {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: { method?: string; body?: unknown }) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), PAGE_ORIGIN);
    const method = (init?.method ?? 'GET').toUpperCase();
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { date?: unknown }) : null;
    fetchCalls.push({
      path: url.pathname,
      method,
      range: startDate !== null && endDate !== null ? `${startDate}..${endDate}` : null,
      date: typeof body?.date === 'string' ? body.date : null,
    });
    // 祝日の一覧 (外の API) は、この検査では祝日なし
    if (url.origin !== PAGE_ORIGIN) return jsonResponse({});
    switch (url.pathname) {
      case '/api/meal-plans':
        return jsonResponse(mealPlansJson(url.searchParams.get('startDate') ?? '', url.searchParams.get('endDate') ?? ''));
      case '/api/ai/menu/weekly/pending':
        return jsonResponse({ hasPending: false });
      case '/api/ai/menu/meal/pending':
        return jsonResponse({ hasPending: false, requests: [] });
      case '/api/ai/menu/weekly/cleanup':
        return jsonResponse({ cleaned: 0 });
      case '/api/pantry':
        return jsonResponse({ items: [] });
      case '/api/profile':
        return jsonResponse({ family_size: 2, servings_config: null, radar_chart_nutrients: null });
      case '/api/shopping-list':
        return jsonResponse({ shoppingList: mealPlansJson('', '').shoppingList });
      default:
        return jsonResponse({}, NOT_FOUND_STATUS);
    }
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  process.env.TZ = 'UTC';
  vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
  clockCross.crossTo = null;
  navigation.searchParams = new URLSearchParams();
  localStorage.clear();
  installFakeServer();
  // framer-motion がアニメーションの寸法を測るときに呼ぶ (jsdom には無い)
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
});

afterAll(() => {
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderWeeklyPage() {
  await act(async () => {
    root.render(<WeeklyMenuPage />);
  });
  await settle();
}

/** 親が描き直した (献立表を同じ形でもう一度描く。描画ごとの値はこの描画で読み直す) */
async function rerenderWeeklyPage() {
  await act(async () => {
    root.render(<WeeklyMenuPage />);
  });
  await settle();
}

function requireElement<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) throw new Error(`${what} が無い`);
  return element;
}

/** 選んでいる日の見出しの印 (「今日」か「過去」。どちらも無ければ '') */
function selectedDayBadge(): string {
  const badges = [...container.querySelectorAll('span')].map((span) => span.textContent ?? '').filter((text) => text === '今日' || text === '過去');
  return badges.join(',');
}

/** AI 献立アシスタントの帯の文 (空欄の数を出す) */
function assistantBannerText(): string {
  return requireElement(container.querySelector<HTMLElement>('[data-testid="ai-assistant-banner-button"]'), 'AI 献立アシスタントの帯').textContent ?? '';
}

const emptySlotsLabel = (days: number) => `空欄${days * BASE_MEAL_SLOTS_PER_DAY}件`;

/** 今日のフィードバックを読んだ日 (POST /api/ai/nutrition/feedback の date) */
const feedbackDatesRead = () => fetchCalls.filter((call) => call.path === FEEDBACK_PATH && call.method === 'POST').map((call) => call.date);

describe('献立表の 1 回の描画は、今日を 1 回だけ読む (#2245 K2)', () => {
  it('開いたとき: 選んでいる日 (今日) に「今日」の印、空欄は今日から週末まで (検査の前提)', async () => {
    await renderWeeklyPage();
    expect(window.__weeklyCurrentDate).toBe(DAY_BEFORE);
    expect(selectedDayBadge()).toBe('今日');
    expect(assistantBannerText()).toContain(emptySlotsLabel(DAYS_FROM_DAY_BEFORE_TO_WEEK_END));
  });

  it('描画の途中で 0 時をまたいでも、見出しの今日と空欄の数は同じ今日から決まる', async () => {
    await renderWeeklyPage();
    // 次の描画で、最初に今日を読んだあとに 0 時をまたぐ
    clockCross.crossTo = AFTER_MIDNIGHT;
    await rerenderWeeklyPage();
    expect(clockCross.crossTo, '描画が今日を読んでいない (検査が空振りしている)').toBeNull();
    // 最初に読んだ今日 (11-04) で見出しも空欄の数も決まる。直す前は、空欄の数は 11-04 から数え、見出しは 11-05 を今日として 11-04 を「過去」と出した
    expect(selectedDayBadge(), '見出しの今日が、空欄の数を数えた今日と違う').toBe('今日');
    expect(assistantBannerText()).toContain(emptySlotsLabel(DAYS_FROM_DAY_BEFORE_TO_WEEK_END));

    // 次の描画は新しい今日 (11-05) で、見出しも空欄の数もそろって変わる
    await rerenderWeeklyPage();
    expect(selectedDayBadge()).toBe('過去');
    expect(assistantBannerText()).toContain(emptySlotsLabel(DAYS_FROM_DAY_AFTER_TO_WEEK_END));
  });
});

describe('栄養分析の今日のタブのフィードバックは、見出しの今日で読む (#2245 K2)', () => {
  it('開いたまま 0 時をまたいで描き直したら、新しい今日のフィードバックを読む', async () => {
    await renderWeeklyPage();
    await act(async () => {
      requireElement(container.querySelector<HTMLButtonElement>('button[aria-label="栄養分析を見る"]'), '栄養分析のボタン').click();
    });
    await settle();
    expect(feedbackDatesRead(), '開いた日の今日のフィードバックを読んでいない (検査の前提が崩れた)').toEqual([DAY_BEFORE]);

    vi.setSystemTime(new Date(AFTER_MIDNIGHT));
    await rerenderWeeklyPage();
    expect(feedbackDatesRead(), '0 時をまたいで描き直したのに、新しい今日のフィードバックを読んでいない').toEqual([DAY_BEFORE, DAY_AFTER]);
  });
});

describe('献立の改善のモーダルは、親の描画の今日 1 つで「今日」の印と過去の日を決める (#2245 K2)', () => {
  /** 親の描画が 0 時の前に今日 (11-04) を読み、モーダルを描く前に 0 時をまたいだ */
  async function renderImproveModalAfterParentRead() {
    vi.setSystemTime(new Date(AFTER_MIDNIGHT));
    await act(async () => {
      root.render(
        <ImproveMealModal
          showImproveMealModal
          isImprovingMeal={false}
          selectedDayIndex={0}
          weekDates={[{ date: new Date(2026, 10, 4), dateStr: DAY_BEFORE, dayOfWeek: '水' }]}
          todayStr={DAY_BEFORE}
          improveMealTargets={[]}
          improveNextDay={false}
          nutritionFeedback={null}
          currentPlanDays={[]}
          onClose={() => undefined}
          onToggleMealTarget={() => undefined}
          onSelectAllDay={() => undefined}
          onSelectNextDay={() => undefined}
          onImprove={() => undefined}
        />,
      );
    });
  }

  it('親が今日とした日に「今日」の印を出し、過去の日として扱わない (モーダルの中で時計を読み直さない)', async () => {
    await renderImproveModalAfterParentRead();
    const todayBadges = [...document.body.querySelectorAll('span')].filter((span) => span.textContent === '今日');
    expect(todayBadges, '親の今日の日に「今日」の印が無い').toHaveLength(1);
    expect(document.body.textContent ?? '', '親の今日の日を過去の日として扱った').not.toContain('この日は過去のため');
  });
});
