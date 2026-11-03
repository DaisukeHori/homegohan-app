/**
 * #2195 V1 献立表 (/menus/weekly) が AI 相談の成功で取り直すもの (ページを描画して確かめる)
 *
 * 問題 (直す前):
 *   - AI 相談が始めた献立の生成 (generate_week_menu など) は、依頼を受けた時点 (status: processing) で成功を知らせる。
 *     献立表は表示中の週を 1 回取り直すだけで、生成中の依頼を確かめない (生成中の依頼の確認は週を開いたときだけ) ので、
 *     生成が終わっても献立表は古い表示のまま (読み込み直すまで) だった
 *   - AI 相談で買い物リストの最後の品目を消すと、取り直しの応答の空のリストを置かず、ヘッダーのバッジに消した品目が数えられたままだった
 *   - AI 相談で食事を消すと、月のカレンダーの献立のある日の印が残った (カレンダーの取得は足すだけで、取り直しもしない)
 *   - AI 相談で家族の人数を変えても、人数の設定の無い人の既定の人数 (人数の設定のモーダルが出す値) が前のままだった
 *
 * 直したあと: ページを開いたときに読むもののうち AI 相談で変わりうるもの (表示中の週の献立と買い物リスト・冷蔵庫・
 * 人数の設定・月のカレンダーの献立のある日・表示中の週の生成中の依頼) を取り直す。
 *
 * サーバーは表 (server) で真似る。AI 相談の提案の実行は、表を書き換えてから AIChatBubble と同じ形で mealPlanUpdated を投げる。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLocalDate } from '@homegohan/shared';

/** 描画のたびに同じものを返す (ページの useEffect の依存に入っても、描画のたびに走り直さないように) */
const navigation = vi.hoisted(() => ({
  router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/menus/weekly',
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// 画像 (料理の写真) はこの検査に関係しないので描かない
vi.mock('next/image', () => ({ default: () => null }));
// 生成のモーダル・栄養のレーダーチャート (dynamic import) はこの検査に関係しないので描かない
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => undefined }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));
vi.mock('@/components/ProfileReminderBanner', () => ({ ProfileReminderBanner: () => null }));

/** Supabase のモック。ログインしていない (週の始まりは月曜)。Realtime のチャンネルは名前だけ記録し、何も届けない */
const supabaseMock = vi.hoisted(() => ({ channelNames: [] as string[] }));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  /** どのメソッドを呼んでも自分を返し、await すると空の結果になる問い合わせ */
  const emptyQuery = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(EMPTY_RESULT);
        return () => emptyQuery();
      },
    });
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    unsubscribe: async () => 'ok',
  };
  return {
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: () => emptyQuery(),
      rpc: () => emptyQuery(),
      channel: (name: string) => {
        supabaseMock.channelNames.push(name);
        return channel;
      },
      removeChannel: async () => 'ok',
    }),
  };
});

const { default: WeeklyMenuPage } = await import('@/app/(main)/menus/weekly/page');
// 献立表の store (ページは ./_state の index から同じファイルを読む)
const { useShoppingStore } = await import('@/app/(main)/menus/weekly/_state/shoppingStore');
const { usePantryStore } = await import('@/app/(main)/menus/weekly/_state/pantryStore');
const { useServingsConfigStore } = await import('@/app/(main)/menus/weekly/_state/servingsConfigStore');
const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
/** 1 週間の日数 */
const DAYS_IN_WEEK = 7;
/** 月の中で、次の週の月曜も同じ月に入る週の始まりの日の上限 (どの月も 28 日はある) */
const LAST_DAY_WITH_NEXT_WEEK_IN_SAME_MONTH = 21;

/** ページと同じ週の始まり (月曜・その日の 0 時。ページの getWeekStart と同じ作り方) */
function displayedWeekStart(): Date {
  const start = new Date();
  const fromMonday = (start.getDay() + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK;
  start.setDate(start.getDate() - fromMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** 週の始まりから offset 日の日付 (ページの weekDates と同じ作り方) */
function dateFromWeekStart(offset: number): string {
  const start = displayedWeekStart();
  const day = new Date(start);
  day.setDate(start.getDate() + offset);
  return formatLocalDate(day);
}

/** 表示中の週の 7 日 */
function displayedWeekDates(): string[] {
  return Array.from({ length: DAYS_IN_WEEK }, (_, i) => dateFromWeekStart(i));
}

/** 表示中の月 (= 週の始まりの月) の、表示中の週の外の日 (次の週か前の週の月曜) */
function otherWeekDateInDisplayedMonth(): string {
  return displayedWeekStart().getDate() <= LAST_DAY_WITH_NEXT_WEEK_IN_SAME_MONTH
    ? dateFromWeekStart(DAYS_IN_WEEK)
    : dateFromWeekStart(-DAYS_IN_WEEK);
}

type FakeMeal = { id: string; dishName: string };
type FakeShoppingItem = { id: string; itemName: string; isChecked: boolean };

/** サーバーの表 (テストごとに作り直す) */
type FakeServer = {
  /** 日付 → その日の食事 (user_daily_meals の行があって食事が 0 の日は空の配列) */
  days: Map<string, FakeMeal[]>;
  /** 使っている買い物リストの品目 */
  shoppingItems: FakeShoppingItem[];
  /** 家族の人数 (人数の設定 servings_config は無い) */
  familySize: number;
  /** 生成中の依頼 (weekly_menu_requests の processing の行)。状態を読まれたら生成を終える */
  pendingRequest: { id: string; startDate: string; generate: () => void } | null;
};
let server: FakeServer;
let fetchCalls: string[];

function plannedMealJson(date: string, meal: FakeMeal) {
  return {
    id: meal.id,
    dailyMealId: `day-${date}`,
    mealType: 'dinner',
    dishName: meal.dishName,
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
  };
}

function mealPlansJson(startDate: string, endDate: string) {
  const dailyMeals = [...server.days.entries()]
    .filter(([date]) => date >= startDate && date <= endDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, meals]) => ({
      id: `day-${date}`,
      dayDate: date,
      theme: null,
      nutritionalFocus: null,
      isCheatDay: false,
      meals: meals.map((meal) => plannedMealJson(date, meal)),
    }));
  return {
    dailyMeals,
    startDate,
    endDate,
    shoppingList: {
      id: 'shopping-list-1',
      status: 'active',
      items: server.shoppingItems.map((item) => ({
        id: item.id,
        shoppingListId: 'shopping-list-1',
        category: 'その他',
        itemName: item.itemName,
        quantity: null,
        isChecked: item.isChecked,
        source: 'manual',
        normalizedName: null,
        quantityVariants: [],
        selectedVariantIndex: 0,
      })),
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const NOT_FOUND_STATUS = 404;
/** ページの API の相対 URL を解く起点 (fetch のモックの中だけで使う) */
const PAGE_ORIGIN = 'http://localhost';

function installFakeServer() {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(raw);
    const url = new URL(raw, PAGE_ORIGIN);
    // 祝日の一覧 (外の API) は、この検査では祝日なし
    if (url.origin !== PAGE_ORIGIN) return jsonResponse({});
    switch (url.pathname) {
      case '/api/meal-plans':
        return jsonResponse(mealPlansJson(url.searchParams.get('startDate') ?? '', url.searchParams.get('endDate') ?? ''));
      case '/api/ai/menu/weekly/pending': {
        const pending = server.pendingRequest;
        if (pending && pending.startDate === url.searchParams.get('date')) {
          return jsonResponse({ hasPending: true, requestId: pending.id, status: 'processing', ultimateMode: false, startDate: pending.startDate });
        }
        return jsonResponse({ hasPending: false });
      }
      case '/api/ai/menu/weekly/status': {
        const pending = server.pendingRequest;
        if (pending && pending.id === url.searchParams.get('requestId')) {
          // 生成が終わった (献立を書いてから completed にする)
          pending.generate();
          server.pendingRequest = null;
        }
        return jsonResponse({ status: 'completed', progress: null });
      }
      case '/api/ai/menu/weekly/cleanup':
        return jsonResponse({ cleaned: 0 });
      case '/api/ai/menu/meal/pending':
        return jsonResponse({ hasPending: false, requests: [] });
      case '/api/pantry':
        return jsonResponse({ items: [] });
      case '/api/profile':
        return jsonResponse({ family_size: server.familySize, servings_config: null, radar_chart_nutrients: null });
      default:
        return jsonResponse({}, NOT_FOUND_STATUS);
    }
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  server = { days: new Map(), shoppingItems: [], familySize: 2, pendingRequest: null };
  supabaseMock.channelNames.length = 0;
  localStorage.clear();
  // 献立表の store はモジュールに 1 つなので、前の検査の値を消す
  useShoppingStore.getState().setShoppingList([]);
  usePantryStore.getState().setFridgeItems([]);
  useServingsConfigStore.getState().setServingsConfig(null);
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

/** AI 相談の提案の実行が成功したことを、AIChatBubble と同じ形で知らせる */
async function notifyAiConsultationSucceeded(actionType: string, result: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType, result } }));
  });
  await settle();
}

const callsTo = (pathname: string) => fetchCalls.filter((raw) => new URL(raw, PAGE_ORIGIN).pathname === pathname).length;

/** ヘッダーの買い物リストのボタン (バッジの数字はこの中に出る) */
function shoppingListButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="買い物リストを開く"]');
  if (!button) throw new Error('買い物リストのボタンが無い');
  return button;
}

/** 月のカレンダーを開き、日付のマスに出ている献立のある日の印の数を返す */
async function calendarMealDotCount(): Promise<number> {
  const CALENDAR_DOT = '.w-1.h-1.rounded-full';
  const monthBar = [...container.querySelectorAll<HTMLElement>('div.cursor-pointer')].find((el) => /\d+年\d+月/.test(el.textContent ?? ''));
  if (!monthBar) throw new Error('月のカレンダーを開く帯が無い');
  if (container.querySelector('.gap-y-0\\.5') === null) {
    await act(async () => {
      monthBar.click();
    });
  }
  const grid = container.querySelector('.gap-y-0\\.5');
  if (!grid) throw new Error('月のカレンダーが開かない');
  return grid.querySelectorAll(CALENDAR_DOT).length;
}

describe('献立表 (/menus/weekly) が AI 相談の成功で取り直すもの (#2195 V1)', () => {
  it('AI 相談が始めた表示中の週の献立の生成を見つけて監視し、終わったら作った献立を出す', async () => {
    const week = displayedWeekDates();
    const GENERATED_DISH = 'AI が作った肉じゃが';
    const REQUEST_ID = 'req-ai-week-1';
    await renderWeeklyPage();
    expect(container.textContent).not.toContain(GENERATED_DISH);
    const pendingChecksBefore = fetchCalls.filter((raw) => raw === `/api/ai/menu/weekly/pending?date=${week[0]}`).length;

    // AI 相談の generate_week_menu: 依頼の行 (processing) を作った時点で成功を知らせる。献立はまだ無い
    server.pendingRequest = {
      id: REQUEST_ID,
      startDate: week[0],
      generate: () => {
        for (const date of week) server.days.set(date, [{ id: `meal-${date}`, dishName: GENERATED_DISH }]);
      },
    };
    await notifyAiConsultationSucceeded('generate_week_menu', { startDate: week[0], requestId: REQUEST_ID, status: 'processing' });

    // 表示中の週の生成中の依頼をもう一度確かめ (週を開いたときの確認とは別に)、見つけた依頼を監視する (Realtime の購読と状態の確認)
    expect(fetchCalls.filter((raw) => raw === `/api/ai/menu/weekly/pending?date=${week[0]}`).length).toBeGreaterThan(pendingChecksBefore);
    expect(supabaseMock.channelNames).toContain(`menu-request-${REQUEST_ID}`);
    expect(fetchCalls).toContain(`/api/ai/menu/weekly/status?requestId=${REQUEST_ID}`);
    // 生成が終わったら、監視の側が献立を取り直して出す (読み込み直さなくてよい)
    expect(container.textContent).toContain(GENERATED_DISH);
  });

  it('AI 相談で買い物リストの最後の品目を消したら、バッジから消える (空のリストも置く)', async () => {
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    await renderWeeklyPage();
    expect(shoppingListButton().textContent).toBe('1');

    // AI 相談の delete_shopping_item
    server.shoppingItems = [];
    await notifyAiConsultationSucceeded('delete_shopping_item', { itemId: 'item-1', deleted: true });

    expect(shoppingListButton().textContent).toBe('');
    expect(useShoppingStore.getState().shoppingList).toEqual([]);
  });

  it('献立の無い週を出していても、AI 相談で買い物リストが変わったら置く', async () => {
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    await renderWeeklyPage();

    // AI 相談の add_to_shopping_list
    server.shoppingItems = [
      { id: 'item-1', itemName: 'にんじん', isChecked: false },
      { id: 'item-2', itemName: 'たまねぎ', isChecked: false },
    ];
    await notifyAiConsultationSucceeded('add_to_shopping_list', { added: 1 });

    expect(shoppingListButton().textContent).toBe('2');
  });

  it('AI 相談で食事を消して献立が無くなった日は、月のカレンダーの印が消える', async () => {
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.days.set(week[1], [{ id: 'meal-2', dishName: '豚の生姜焼き' }]);
    await renderWeeklyPage();
    expect(await calendarMealDotCount()).toBe(2);

    // AI 相談の delete_meal: 食事の行だけを消す (その日の user_daily_meals の行は残る)
    server.days.set(week[1], []);
    await notifyAiConsultationSucceeded('delete_meal', { mealId: 'meal-2', deleted: true });

    expect(await calendarMealDotCount()).toBe(1);
  });

  it('AI 相談で表示中の月の別の週に献立を作ったら、月のカレンダーに印が出る (取得済みの範囲も読み直す)', async () => {
    await renderWeeklyPage();
    expect(await calendarMealDotCount()).toBe(0);
    const mealPlansCallsBefore = callsTo('/api/meal-plans');

    // AI 相談の generate_single_meal (表示中の週の外。月のカレンダーの範囲にだけ入る日) と update_meal (表示中の週) のあと
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other-week', dishName: 'カレー' }]);
    server.days.set(dateFromWeekStart(2), [{ id: 'meal-3', dishName: '親子丼' }]);
    await notifyAiConsultationSucceeded('update_meal', { mealId: 'meal-3' });

    // 表示中の週 + カレンダーの 2 つの範囲 (表示中の週の前後・表示中の月) を読み直す
    expect(callsTo('/api/meal-plans') - mealPlansCallsBefore).toBe(3);
    expect(await calendarMealDotCount()).toBe(2);
  });

  it('AI 相談で家族の人数が変わったら、人数の設定の無い人の既定の人数を取り直す', async () => {
    server.familySize = 2;
    await renderWeeklyPage();
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(2);

    // AI 相談の update_profile_preferences (family_size)
    server.familySize = 4;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['family_size'] });

    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(4);
  });
});
