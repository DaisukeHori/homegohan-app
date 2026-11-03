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
 *     (家族の人数を空にしたときも、前の人数を残していた)
 *
 *   - AI 相談でプロフィールの身長・体重などを入れても、ページの上のプロフィールの帯 (ProfileReminderBanner) が古い
 *     「未入力」の一覧のまま残った (帯は開いたときに 1 回だけ読み、ページの取り直しはその読み取りをしない)
 *
 * 直したあと: ページを開いたときに読むもののうち AI 相談で変わりうるもの (表示中の週の献立と買い物リスト・冷蔵庫・
 * 人数の設定・月のカレンダーの献立のある日・表示中の週の生成中の依頼・プロフィールの帯) を取り直す。
 *
 * 部品を消すモックとログアウトで、受け手の読み取りを隠さない (帯を消すモックとログアウトのせいで、帯の読み取りの抜けが
 * 見えなかった)。ログインした状態で、ページの部品をそのまま描く。消すのは AI が書く表を読まない部品だけ (読み取りのある部品は
 * 理由を AI_CONSULTATION_RENDER_TEST_MOCKED_READERS に書く) で、tests/ai-consultation-refetch-coverage-2195.test.ts がそれを確かめる。
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
// 生成のモーダル・栄養のレーダーチャート (dynamic import) はこの検査に関係しないので描かない。
// レーダーチャートは何も読まない。生成のモーダルは開いたときだけ読み (閉じている間は描かない)、開いている間は
// 取り直しの番兵が止める (モーダル) ので、開いたときと取り直しの読み取りの比べに入らない
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => undefined }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));

/** user_profiles の行のうち、このページ (とプロフィールの帯) が読む列 */
type FakeProfileRow = {
  profile_completeness: number | null;
  height: number | null;
  weight: number | null;
  age: number | null;
  fitness_goals: string[] | null;
  health_conditions: string[] | null;
  /** 週の始まりの日 (null = 月曜) */
  week_start_day: string | null;
  family_id: string | null;
};

/**
 * Supabase のモック。ログインしている (週の始まりは月曜・家族なし)。user_profiles は profile の行を返し、ほかの表は空。
 * Realtime のチャンネルは名前だけ記録し、何も届けない
 */
const supabaseMock = vi.hoisted(() => ({
  channelNames: [] as string[],
  /** ログインしている人の user_profiles の行 (テストごとに置き換える) */
  profile: null as null | Record<string, unknown>,
  /**
   * 記録の口があれば、読んだ表 (select を呼んだとき。鍵は tests/helpers/ai-refetch-read-recorder.ts の selectReadKey) と
   * DB の関数 ('rpc:<名前>') を記録する (受け手の読み取りの検査)
   */
  reads: null as null | { record: (key: string | null) => void; recordSelect: (table: string, select: unknown) => void },
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  const USER = { id: '21950000-0000-4000-8000-0000000000b1', user_metadata: {} };
  /** その表の答え (user_profiles は profile の行。single / maybeSingle なら行、そうでなければ行の配列。ほかの表は空) */
  const resultOf = (table: string | null, single: boolean) => {
    if (table !== 'user_profiles') return EMPTY_RESULT;
    const row = supabaseMock.profile;
    if (single) return { data: row, error: null, count: row ? 1 : 0 };
    return { data: row ? [row] : [], error: null, count: row ? 1 : 0 };
  };
  /** どのメソッドを呼んでも自分を返し、await するとその表の答えになる問い合わせ。select を呼んだら読み取りを記録する */
  const query = (table: string | null, single: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(resultOf(table, single));
        return (...args: unknown[]) => {
          if (prop === 'select' && table !== null) supabaseMock.reads?.recordSelect(table, args[0]);
          return query(table, single || prop === 'single' || prop === 'maybeSingle');
        };
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
        getUser: async () => ({ data: { user: USER }, error: null }),
        getSession: async () => ({ data: { session: { user: USER } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: (table: string) => query(table, false),
      rpc: (name: string) => {
        supabaseMock.reads?.record(`rpc:${name}`);
        return query(null, false);
      },
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
const { AI_CONSULTATION_WRITTEN_COLUMNS, AI_CONSULTATION_WRITTEN_TABLE_NAMES } = await import('@/lib/ai/consultation-refetch-coverage');
const {
  ReadRecorder,
  expectEmptyRefetchMatchesFreshMount,
  expectRefetchReadsCoverMount,
  fetchReadKey,
  screenSignature,
  selectReadKey,
} = await import('./helpers/ai-refetch-read-recorder');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
/** 1 週間の日数 */
const DAYS_IN_WEEK = 7;
/** 月の中で、次の週の月曜も同じ月に入る週の始まりの日の上限 (どの月も 28 日はある) */
const LAST_DAY_WITH_NEXT_WEEK_IN_SAME_MONTH = 21;
/** プロフィールの帯を出す完成度 (src/components/ProfileReminderBanner.tsx の COMPLETENESS_THRESHOLD = 50 の下と上) */
const INCOMPLETE_PROFILE_COMPLETENESS = 20;
const COMPLETE_PROFILE_COMPLETENESS = 100;
/** プロフィールの帯の見出し */
const PROFILE_BANNER_HEADING = '栄養目標を設定しましょう';
/** 家族に入っている人の家族 (家族の一覧の読み取りを開いたときの読み取りに出す) */
const FAMILY_ID = '21950000-0000-4000-8000-0000000000f1';

/** 身長・体重が未入力のプロフィール (完成度が帯を出す値) */
function incompleteProfile(): FakeProfileRow {
  return {
    profile_completeness: INCOMPLETE_PROFILE_COMPLETENESS,
    height: null,
    weight: null,
    age: 35,
    fitness_goals: ['健康維持'],
    health_conditions: ['なし'],
    week_start_day: null,
    family_id: null,
  };
}

/** 全部入れたプロフィール (帯を出さない) */
function completeProfile(): FakeProfileRow {
  return { ...incompleteProfile(), profile_completeness: COMPLETE_PROFILE_COMPLETENESS, height: 170, weight: 65 };
}

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
  /** 家族の人数 (人数の設定 servings_config は無い)。null = 空 (AI 相談の update_profile_preferences は null も書ける) */
  familySize: number | null;
  /** 生成中の依頼 (weekly_menu_requests の processing の行)。状態を読まれたら生成を終える */
  pendingRequest: { id: string; startDate: string; generate: () => void } | null;
};
let server: FakeServer;
let fetchCalls: string[];
/** 受け手の読み取りの記録 (GET の fetch と Supabase の読み取り) */
let recorder: InstanceType<typeof ReadRecorder>;

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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: { method?: string }) => {
    const raw = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(raw);
    recorder.record(fetchReadKey(raw, init));
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
  // 既定は帯を出さないプロフィール (帯の検査は incompleteProfile に置き換える)
  supabaseMock.profile = completeProfile();
  recorder = new ReadRecorder();
  supabaseMock.reads = recorder;
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
  supabaseMock.reads = null;
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

/** プロフィールの帯 (無ければ null) */
function profileBanner(): HTMLElement | null {
  const heading = [...container.querySelectorAll('h3')].find((el) => el.textContent === PROFILE_BANNER_HEADING);
  return heading?.closest<HTMLElement>('div.rounded-2xl') ?? null;
}

/** プロフィールの帯に出ている未入力の欄の名前 */
function profileBannerMissingLabels(): string[] {
  const banner = profileBanner();
  if (!banner) throw new Error('プロフィールの帯が無い');
  return [...banner.querySelectorAll('span.rounded-full')].map((el) => (el.textContent ?? '').trim());
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

  it('AI 相談で家族の人数を空にしたら (人数の設定も無い)、前の既定の人数を残さない', async () => {
    server.familySize = 2;
    await renderWeeklyPage();
    expect(useServingsConfigStore.getState().servingsConfig?.default).toBe(2);

    server.familySize = null;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['family_size'] });

    expect(useServingsConfigStore.getState().servingsConfig).toBeNull();
  });

  it('AI 相談でプロフィールの身長・体重を入れたら、プロフィールの帯の未入力の一覧から消える', async () => {
    supabaseMock.profile = incompleteProfile();
    await renderWeeklyPage();
    expect(profileBannerMissingLabels()).toEqual(['身長', '体重']);

    // AI 相談の update_profile_preferences (height・weight)。完成度 (profile_completeness) は AI 相談が書かないので変わらない
    supabaseMock.profile = { ...incompleteProfile(), height: 170, weight: 65 };
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['height', 'weight'] });

    expect(profileBanner()).not.toBeNull();
    expect(profileBannerMissingLabels()).toEqual([]);
  });

  it('AI 相談のあとプロフィールの完成度が帯を出す値を超えていたら、帯を消す (前の帯を残さない)', async () => {
    supabaseMock.profile = incompleteProfile();
    await renderWeeklyPage();
    expect(profileBanner()).not.toBeNull();

    supabaseMock.profile = completeProfile();
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['height', 'weight'] });

    expect(profileBanner()).toBeNull();
  });

  it('プロフィールの帯を閉じたあとは、AI 相談の取り直しでも帯を出さない', async () => {
    supabaseMock.profile = incompleteProfile();
    await renderWeeklyPage();
    const closeButton = profileBanner()?.querySelector<HTMLButtonElement>('button');
    if (!closeButton) throw new Error('プロフィールの帯の閉じるボタンが無い');
    await act(async () => {
      closeButton.click();
    });
    await settle();
    expect(profileBanner()).toBeNull();

    supabaseMock.profile = { ...incompleteProfile(), height: 170 };
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['height'] });

    expect(profileBanner()).toBeNull();
  });
});

describe('献立表 (/menus/weekly) を描画して、AI 相談の成功の取り直しを確かめる (#2195 V1)', () => {
  /** AI が書く表に中身のある答え (表示中の週と別の週の献立・買い物リスト・家族の人数・プロフィールの未入力の欄) */
  function fillServer() {
    supabaseMock.profile = { ...incompleteProfile(), family_id: FAMILY_ID };
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other', dishName: 'カレー' }]);
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    server.familySize = 3;
  }
  /** AI 相談で消した・空にしたあと (プロフィールは未入力の欄が無くなり、帯を出さない) */
  function emptyServer() {
    supabaseMock.profile = completeProfile();
    server.days = new Map();
    server.shoppingItems = [];
    server.familySize = null;
  }

  it('開いたとき・月のカレンダーのパネル・プロフィールの帯が読むもの全部を、取り直しも読む', async () => {
    fillServer();
    recorder.take();
    await renderWeeklyPage();
    await calendarMealDotCount();
    await settle();
    // 帯が出ている (帯の読み取りが開いたときの読み取りに入っている)
    expect(profileBanner()).not.toBeNull();
    const mountReads = recorder.take();
    await notifyAiConsultationSucceeded('update_meal', { mealId: 'meal-1' });
    const refetchReads = recorder.take();
    // 前後の週の先読み (表の mountReadsNotRefetched の adjacentWeekPrefetch)
    const weekRangeKey = (from: number) =>
      fetchReadKey(`/api/meal-plans?startDate=${dateFromWeekStart(from)}&endDate=${dateFromWeekStart(from + DAYS_IN_WEEK - 1)}`) ?? '';
    // 週の始まりの日・家族の所属と家族の一覧 (表の mountReadsNotRefetched の weekStartDay・familyMembership)。どれも AI 相談が書かない列と表
    const WEEK_START_DAY_COLUMN = 'week_start_day';
    const FAMILY_ID_COLUMN = 'family_id';
    expect(AI_CONSULTATION_WRITTEN_COLUMNS.user_profiles).not.toContain(WEEK_START_DAY_COLUMN);
    expect(AI_CONSULTATION_WRITTEN_COLUMNS.user_profiles).not.toContain(FAMILY_ID_COLUMN);
    expect(AI_CONSULTATION_WRITTEN_TABLE_NAMES).not.toContain('family_members');
    expectRefetchReadsCoverMount('/menus/weekly', mountReads, refetchReads, {
      adjacentWeekPrefetch: [weekRangeKey(-DAYS_IN_WEEK), weekRangeKey(DAYS_IN_WEEK)],
      weekStartDay: [selectReadKey('user_profiles', WEEK_START_DAY_COLUMN)],
      familyMembership: [selectReadKey('user_profiles', FAMILY_ID_COLUMN), selectReadKey('family_members', '*')],
    });
  });

  it('AI が書く表の答えが空になった取り直しは、空の答えで開いたときと同じ画面 (前の値を残さない)', async () => {
    fillServer();
    await renderWeeklyPage();
    await calendarMealDotCount();
    const full = screenSignature(container);

    emptyServer();
    await notifyAiConsultationSucceeded('delete_meal', { mealId: 'meal-1', deleted: true });
    const refetchedToEmpty = screenSignature(container);

    await act(async () => {
      root.unmount();
    });
    // 献立表の store はモジュールに 1 つなので、読み込み直したとき (新しいページ) と同じく空に戻してから開く
    useShoppingStore.getState().setShoppingList([]);
    usePantryStore.getState().setFridgeItems([]);
    useServingsConfigStore.getState().setServingsConfig(null);
    root = createRoot(container);
    await renderWeeklyPage();
    await calendarMealDotCount();
    const freshEmpty = screenSignature(container);
    expectEmptyRefetchMatchesFreshMount('/menus/weekly', { full, refetchedToEmpty, freshEmpty });
  });
});
