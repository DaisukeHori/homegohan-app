/**
 * #2245 K4 献立表 (/menus/weekly) の ?date= を確かめずに使っていた欠陥と、表示中の週の買い物の範囲が描画中に投げる欠陥の回帰テスト。
 *
 * 問題 (直す前):
 *   - page.tsx は ?date= を isCalendarDate で確かめずに parseLocalDate していた。手で打った URL の 2026-02-30 は 3/2 の週へ繰り上がり、
 *     9998-12-31 (CALENDAR_DATE_MAX の翌日) はその週へ移り、9999-12-31 は暦の計算で扱える範囲の端の週 (9999-12-27〜) になった。
 *     保存の知らせ (?saved=1) も確かめない日付を formatDateJa に渡し、2026-02-30 を「3月2日」と出した
 *   - 買い物の範囲を選ぶ欄 (ShoppingRangeModal) は描画のたびに「表示中の週」の範囲 (shoppingRangeDates の currentWeek) を求める。
 *     週の始まりが 9999-12-27 以降だと addDaysToDate が RangeError を投げ、1000 年より前の年は formatLocalDate が 4 桁で書かない
 *     ("100-12-27") ので同じく投げて、欄ごと落ちた (formatLocalDate は #2254 M2 で 4 桁で書くようにした)。範囲の終わりが CALENDAR_DATE_MAX を超える週 (9998-12-28〜) は、欄に日付を出して
 *     選べたが、依頼の API (/api/shopping-list/regenerate) は範囲の外の日を 400 で断る
 *   - 買い物リストの作成 (regenerateShoppingList) は、作成中の表示を出したあとに try の外で範囲を求めていた
 *
 * 直したあと:
 *   - ?date= は isCalendarDate を通ったときだけ使う (通らなければ今日の週のまま開く)。保存の知らせも通ったときだけ日付を出す
 *   - 表示中の週の範囲は、始まりと終わりがどちらも isCalendarDate のときだけ求まり、そうでなければ null (投げない)。
 *     欄はその選択肢を選べなくし (「この週は選べません」)、選んであれば次へ進めない
 *   - 買い物リストの作成は、作成中の表示を出す前に try の中で範囲を求め、求まらなければ知らせて作らない (依頼を送らない)
 *
 * 値ごとに確かめる (どれも直す前の形で赤になる。境界の値は、受け付ける側と断る側の両方を置く)。
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_DATE_MAX, CALENDAR_DATE_MIN, addDaysToDate } from '@homegohan/shared';

/** 時計を止める時刻 (JST 2026-11-04 (水) 12:00。実行環境は UTC で、端末の暦でも 2026-11-04 (水)) */
const FROZEN_NOW = '2026-11-04T03:00:00.000Z';

const navigation = vi.hoisted(() => {
  // ページの週の始まりの初期値はモジュールを読んだときの時計で決まるので、読む前に時計を止める (setTimeout などは止めない)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T03:00:00.000Z'));
  return {
    router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
    searchParams: new URLSearchParams(),
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

/**
 * 買い物リストを作る依頼の範囲の計算 (shoppingRangeRequest) を、throwOnRequest の間だけ投げる形に置き換える
 * (作成中の表示を出す前に try の中で範囲を求めていることを確かめる。ほかの間は元の関数のまま)
 */
const rangeFault = vi.hoisted(() => ({ throwOnRequest: false }));
vi.mock('@/app/(main)/menus/weekly/_state/shoppingRangeDates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/(main)/menus/weekly/_state/shoppingRangeDates')>();
  return {
    ...actual,
    shoppingRangeRequest: (...args: Parameters<typeof actual.shoppingRangeRequest>) => {
      if (rangeFault.throwOnRequest) throw new RangeError('範囲の計算が投げた (検査の置き換え)');
      return actual.shoppingRangeRequest(...args);
    },
  };
});

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
const { useShoppingStore } = await import('@/app/(main)/menus/weekly/_state/shoppingStore');
const {
  SHOPPING_RANGE_CURRENT_WEEK_UNAVAILABLE_LABEL,
  SHOPPING_RANGE_UNAVAILABLE_MESSAGE,
  SHOPPING_RANGE_WEEK_DAYS,
  shoppingRangeDates,
  shoppingRangeRequest,
} = await import('@/app/(main)/menus/weekly/_state/shoppingRangeDates');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
/** ページの API の相対 URL を解く起点 (fetch のモックの中だけで使う) */
const PAGE_ORIGIN = 'http://localhost';
const NOT_FOUND_STATUS = 404;
/** 今日 (FROZEN_NOW の JST の日付) と、今日の週 (月曜始まり) の範囲を選ぶ欄の表示 */
const TODAY = '2026-11-04';
const TODAY_WEEK_LABEL = '表示中の週（11月2日〜11月8日）';
/** 「この週は選べません」のときの表示中の週の選択肢の文 */
const UNAVAILABLE_WEEK_LABEL = `表示中の週（${SHOPPING_RANGE_CURRENT_WEEK_UNAVAILABLE_LABEL}）`;
/** 買い物リストを作る依頼の道 */
const REGENERATE_PATH = '/api/shopping-list/regenerate';

let fetchCalls: { path: string; method: string; range: string | null; body: unknown }[];

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
    fetchCalls.push({
      path: url.pathname,
      method,
      range: startDate !== null && endDate !== null ? `${startDate}..${endDate}` : null,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
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
  vi.setSystemTime(new Date(FROZEN_NOW));
  rangeFault.throwOnRequest = false;
  navigation.searchParams = new URLSearchParams();
  localStorage.clear();
  useShoppingStore.getState().setShoppingList([]);
  useShoppingStore.getState().setActiveShoppingList(null);
  useShoppingStore.getState().setIsRegeneratingShoppingList(false);
  useShoppingStore.getState().setShoppingListProgress(null);
  useShoppingStore.getState().setShoppingRange({ type: 'week', todayMeals: ['breakfast', 'lunch', 'dinner'], daysCount: 3 });
  useShoppingStore.getState().setShoppingRangeStep('range');
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

/** query を URL のクエリにして献立表を開く */
async function renderWeeklyPage(query: Record<string, string>) {
  navigation.searchParams = new URLSearchParams(query);
  await act(async () => {
    root.render(<WeeklyMenuPage />);
  });
  await settle();
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

function requireElement<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) throw new Error(`${what} が無い`);
  return element;
}

/** 買い物リストを開き、「献立から作る」で買い物の範囲を選ぶ欄を開いて、その欄を返す */
async function openShoppingRangeModal(): Promise<HTMLElement> {
  await click(requireElement(container.querySelector<HTMLButtonElement>('button[aria-label="買い物リストを開く"]'), '買い物リストのボタン'));
  await click(requireElement(container.querySelector<HTMLButtonElement>('[data-testid="shopping-regenerate-button"]'), '献立から作るボタン'));
  return requireElement(container.querySelector<HTMLElement>('[role="dialog"][aria-label="買い物の範囲を選択"], [role="dialog"][aria-label="人数を確認"]'), '買い物の範囲を選ぶ欄');
}

/** 範囲を選ぶ欄の「表示中の週」の選択肢 */
function currentWeekOption(modal: HTMLElement): HTMLButtonElement {
  return requireElement(
    [...modal.querySelectorAll<HTMLButtonElement>('button')].find((button) => (button.textContent ?? '').startsWith('表示中の週')),
    '表示中の週の選択肢',
  );
}

/** 範囲を選ぶ欄の「次へ（人数確認）」 */
function nextButton(modal: HTMLElement): HTMLButtonElement {
  return requireElement(
    [...modal.querySelectorAll<HTMLButtonElement>('button')].find((button) => (button.textContent ?? '').includes('次へ')),
    '次へのボタン',
  );
}

/** 献立表が選んでいる日 (AI 相談の 1 日分の献立の既定の日に渡す、表示中の週の選んだ日の日付) */
const selectedDay = () => window.__weeklyCurrentDate;

/** 読んだ献立の範囲 (GET /api/meal-plans の startDate..endDate。表示中の週の 7 日の読み込みはこの中にある) */
const mealPlanRangesRead = () => fetchCalls.filter((call) => call.path === '/api/meal-plans').map((call) => call.range);
/** 今日の週 (月曜始まり) の 7 日の範囲 */
const TODAY_WEEK_RANGE = '2026-11-02..2026-11-08';

/** 正しくない ?date= (どれも今日の週のまま開く。直す前は、その日の週へ移るか、範囲を選ぶ欄が落ちた) */
const REJECTED_DATE_PARAMS: readonly { value: string; why: string }[] = [
  { value: '9999-12-31', why: '暦の計算で扱える最後の日 (直す前は 9999-12-27 の週へ移り、範囲を選ぶ欄が RangeError で落ちた)' },
  { value: addDaysToDate(CALENDAR_DATE_MAX, 1), why: 'CALENDAR_DATE_MAX の翌日 (直す前はその週へ移った)' },
  { value: '2026-02-30', why: '存在しない日 (直す前は 3/2 の週へ繰り上がった)' },
  { value: addDaysToDate(CALENDAR_DATE_MIN, -1), why: 'CALENDAR_DATE_MIN の前の日 (直す前は 101 年の週へ移り、範囲を選ぶ欄が落ちた)' },
];

describe('/menus/weekly の ?date= は isCalendarDate を通ったときだけ使う (#2245 K4)', () => {
  for (const { value, why } of REJECTED_DATE_PARAMS) {
    it(`?date=${value} (${why}) は使わず、今日の週を開く。範囲を選ぶ欄も今日の週を出す`, async () => {
      await renderWeeklyPage({ date: value });
      expect(selectedDay()).toBe(TODAY);
      expect(mealPlanRangesRead()).toContain(TODAY_WEEK_RANGE);
      const modal = await openShoppingRangeModal();
      expect(currentWeekOption(modal).textContent).toBe(TODAY_WEEK_LABEL);
      expect(currentWeekOption(modal).disabled).toBe(false);
    });
  }

  it(`?date=${CALENDAR_DATE_MAX} (CALENDAR_DATE_MAX) は使う。その週の終わりは扱える日付の外なので、範囲を選ぶ欄は「表示中の週」を選べなくする`, async () => {
    await renderWeeklyPage({ date: CALENDAR_DATE_MAX });
    // CALENDAR_DATE_MAX (9998-12-30 (水)) を含む週 (月曜始まり) の 7 日を読む
    expect(mealPlanRangesRead()).toContain('9998-12-28..9999-01-03');
    const modal = await openShoppingRangeModal();
    expect(currentWeekOption(modal).textContent).toBe(UNAVAILABLE_WEEK_LABEL);
    expect(currentWeekOption(modal).disabled).toBe(true);
    // ほかの選択肢 (今日から数える範囲) は選べ、次へ進める
    expect(nextButton(modal).disabled).toBe(false);
  });

  it(`?date=${CALENDAR_DATE_MIN} (CALENDAR_DATE_MIN) は使う。その週の始まり (0100-12-27) は扱える日付の外なので、範囲を選ぶ欄は落ちずに「表示中の週」を選べなくする`, async () => {
    await renderWeeklyPage({ date: CALENDAR_DATE_MIN });
    const modal = await openShoppingRangeModal();
    expect(currentWeekOption(modal).textContent).toBe(UNAVAILABLE_WEEK_LABEL);
    expect(currentWeekOption(modal).disabled).toBe(true);
  });

  it('1000 年より前の正しい ?date= (0101-01-10) はその日の週を YYYY-MM-DD で読み、範囲を選ぶ欄はその週の 7 日を出す (#2254 M2)', async () => {
    // 直す前は formatLocalDate が年を 4 桁で書かず、週の格子の 7 日を "101-01-10".."101-01-16" で読んで /api/meal-plans に断られた
    await renderWeeklyPage({ date: '0101-01-10' });
    expect(mealPlanRangesRead()).toContain('0101-01-10..0101-01-16');
    const modal = await openShoppingRangeModal();
    expect(currentWeekOption(modal).textContent).toBe('表示中の週（1月10日〜1月16日）');
    expect(currentWeekOption(modal).disabled).toBe(false);
  });

  it('正しい ?date= (2026-12-31) はその日の週を開き、範囲を選ぶ欄はその週の 7 日を出す', async () => {
    await renderWeeklyPage({ date: '2026-12-31' });
    expect(mealPlanRangesRead()).toContain('2026-12-28..2027-01-03');
    const modal = await openShoppingRangeModal();
    expect(currentWeekOption(modal).textContent).toBe('表示中の週（12月28日〜1月3日）');
  });

  it('「表示中の週」を選んであっても、その週が扱える日付の外なら次へ進めない', async () => {
    useShoppingStore.getState().setShoppingRange({ type: 'currentWeek', todayMeals: ['breakfast', 'lunch', 'dinner'], daysCount: 3 });
    await renderWeeklyPage({ date: CALENDAR_DATE_MAX });
    const modal = await openShoppingRangeModal();
    expect(nextButton(modal).disabled).toBe(true);
  });

  it('範囲が求まらないまま作成を押しても、作成中の表示を出さず、依頼を送らずに知らせる', async () => {
    // 人数の確認の段に入ったまま「表示中の週」が扱える日付の外になった状態 (欄の外で store に入った値)
    useShoppingStore.getState().setShoppingRange({ type: 'currentWeek', todayMeals: ['breakfast', 'lunch', 'dinner'], daysCount: 3 });
    useShoppingStore.getState().setShoppingRangeStep('servings');
    await renderWeeklyPage({ date: CALENDAR_DATE_MAX });
    const modal = await openShoppingRangeModal();
    await click(requireElement(modal.querySelector<HTMLButtonElement>('[data-testid="generate-shopping-list-button"]'), '作成のボタン'));
    expect(fetchCalls.filter((call) => call.path === REGENERATE_PATH)).toEqual([]);
    expect(useShoppingStore.getState().isRegeneratingShoppingList).toBe(false);
    expect(container.textContent).toContain(SHOPPING_RANGE_UNAVAILABLE_MESSAGE);
  });
});

describe('買い物リストの作成は、作成中の表示を出す前に try の中で範囲を求める (#2245 K4)', () => {
  it('範囲の計算が投げても、作成中の表示を残さず、依頼を送らずに知らせる (直す前は作成中の表示を出したあと try の外で投げた)', async () => {
    useShoppingStore.getState().setShoppingRangeStep('servings');
    await renderWeeklyPage({ date: '2026-12-31' });
    const modal = await openShoppingRangeModal();
    rangeFault.throwOnRequest = true;
    await click(requireElement(modal.querySelector<HTMLButtonElement>('[data-testid="generate-shopping-list-button"]'), '作成のボタン'));
    expect(fetchCalls.filter((call) => call.path === REGENERATE_PATH)).toEqual([]);
    expect(useShoppingStore.getState().isRegeneratingShoppingList).toBe(false);
    expect(useShoppingStore.getState().shoppingListProgress).toBeNull();
    expect(container.textContent).toContain(SHOPPING_RANGE_UNAVAILABLE_MESSAGE);
  });
});

describe('/menus/weekly の保存の知らせ (?saved=1) は、isCalendarDate を通った ?date= だけを日付で出す (#2245 K4)', () => {
  it('?date=2026-02-30 (存在しない日) は日付を出さない (直す前は「3月2日の夕食に保存しました」)', async () => {
    await renderWeeklyPage({ date: '2026-02-30', saved: '1', mealType: 'dinner' });
    expect(container.textContent).toContain('夕食を保存しました');
    expect(container.textContent).not.toContain('3月2日');
  });

  it('正しい ?date= (2026-11-05) は日付を出す', async () => {
    await renderWeeklyPage({ date: '2026-11-05', saved: '1', mealType: 'dinner' });
    expect(container.textContent).toContain('11月5日の夕食に保存しました');
  });
});

describe('shoppingRangeDates の表示中の週は、始まりと終わりが isCalendarDate のときだけ求まり、投げない (#2245 K4)', () => {
  /** 週の始まり (端末の 0 時。UTC の実行環境では、JST の同じ日) → 範囲 (null = 求まらない) */
  const CASES: readonly { weekStart: Date; expected: { startDate: string; endDate: string } | null; why: string }[] = [
    {
      weekStart: new Date(9998, 11, 24),
      expected: { startDate: '9998-12-24', endDate: CALENDAR_DATE_MAX },
      why: '終わりがちょうど CALENDAR_DATE_MAX',
    },
    { weekStart: new Date(9998, 11, 25), expected: null, why: '終わりが CALENDAR_DATE_MAX の翌日 (直す前は範囲を返した)' },
    { weekStart: new Date(9999, 11, 27), expected: null, why: '終わりが暦の計算で扱える範囲の外 (直す前は RangeError)' },
    { weekStart: new Date(1000, 0, 1), expected: { startDate: '1000-01-01', endDate: '1000-01-07' }, why: '1000 年 (#2245 K4 のときに 4 桁で書けた最初の年)' },
    {
      weekStart: new Date(101, 0, 3),
      expected: { startDate: '0101-01-03', endDate: '0101-01-09' },
      why: '101 年の週 (#2254 M2: formatLocalDate は 4 桁で書く。直す前は "101-01-03" と書いて null)',
    },
    { weekStart: new Date(100, 11, 27), expected: null, why: 'CALENDAR_DATE_MIN より前の週 (#2245 K4 の前は RangeError)' },
    { weekStart: new Date(Number.NaN), expected: null, why: '不正な Date (直す前は RangeError)' },
  ];
  for (const { weekStart, expected, why } of CASES) {
    it(`${why}: ${expected === null ? 'null' : `${expected.startDate}〜${expected.endDate}`}`, () => {
      process.env.TZ = 'UTC';
      const now = new Date(FROZEN_NOW);
      expect(shoppingRangeDates('currentWeek', { now, daysCount: 3, currentWeekStart: weekStart })).toEqual(expected);
      const request = shoppingRangeRequest({ type: 'currentWeek', todayMeals: ['lunch'], daysCount: 3 }, { now, currentWeekStart: weekStart });
      expect(request).toEqual(expected === null ? null : { ...expected, mealTypes: ['breakfast', 'lunch', 'dinner'] });
    });
  }

  it('今日から数える範囲は、表示中の週が扱える日付の外でも求まる (表示中の週だけが null)', () => {
    process.env.TZ = 'UTC';
    const now = new Date(FROZEN_NOW);
    const outOfRangeWeek = new Date(9999, 11, 27);
    expect(shoppingRangeDates('week', { now, daysCount: 3, currentWeekStart: outOfRangeWeek })).toEqual({
      startDate: TODAY,
      endDate: addDaysToDate(TODAY, SHOPPING_RANGE_WEEK_DAYS - 1),
    });
    expect(shoppingRangeRequest({ type: 'today', todayMeals: ['lunch'], daysCount: 3 }, { now, currentWeekStart: outOfRangeWeek })).toEqual({
      startDate: TODAY,
      endDate: TODAY,
      mealTypes: ['lunch'],
    });
  });
});

describe('買い物リストを作る範囲は、範囲を選ぶ欄が日付を出した今日で求める (#2254 M2)', () => {
  /** 範囲を選んだ時計 (JST 2026-11-02 (月) 23:59。表示中の週 11/2〜11/8 の初日で、献立はこの日にある) */
  const BEFORE_MIDNIGHT = '2026-11-02T14:59:00.000Z';
  /** 「次へ」と作成を押した時計 (JST 2026-11-03 (火) 00:01) */
  const AFTER_MIDNIGHT = '2026-11-02T15:01:00.000Z';
  const SHOWN_DAY = '2026-11-02';

  it('欄を開いたまま 0 時をまたいで押しても、欄に出した日 (前の日) の範囲を送る (直す前は押した時刻の新しい日で求め、献立が無いと断った)', async () => {
    vi.setSystemTime(new Date(BEFORE_MIDNIGHT));
    useShoppingStore.getState().setShoppingRange({ type: 'today', todayMeals: ['dinner'], daysCount: 3 });
    await renderWeeklyPage({});
    const modal = await openShoppingRangeModal();
    expect(modal.textContent, '欄が前の日を出していない (検査の前提が崩れた)').toContain('今日の分（11月2日）');

    // 欄を描き直さないまま 0 時をまたぐ
    vi.setSystemTime(new Date(AFTER_MIDNIGHT));
    await click(nextButton(modal));
    const servingsModal = requireElement(container.querySelector<HTMLElement>('[role="dialog"][aria-label="人数を確認"]'), '人数の確認の欄');
    await click(requireElement(servingsModal.querySelector<HTMLButtonElement>('[data-testid="generate-shopping-list-button"]'), '作成のボタン'));

    const requests = fetchCalls.filter((call) => call.path === REGENERATE_PATH);
    expect(requests, '買い物リストを作る依頼を送っていない').toHaveLength(1);
    expect(requests[0]!.body).toEqual({ startDate: SHOWN_DAY, endDate: SHOWN_DAY, mealTypes: ['dinner'] });
  });
});
