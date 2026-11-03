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
 *   - 家族に入っている人が AI 相談で自分の名前 (user_profiles.nickname) を変えても、家族の切り替え (FamilyViewSwitcher) の
 *     名前が前のまま残った (名前は GET /api/family/members/names が display_name の無いメンバーにプロフィールの名前を当てたもので、
 *     家族の一覧と名前は開いたときと切り替えの適用のときにだけ読んでいた)
 *
 * 直したあと: ページを開いたときに読むもののうち AI 相談で変わりうるもの (表示中の週の献立と買い物リスト・冷蔵庫・
 * 人数の設定・月のカレンダーの献立のある日・表示中の週の生成中の依頼・プロフィールの帯・家族の一覧と名前) を取り直す。
 *
 * 部品を消すモックとログアウトで、受け手の読み取りを隠さない (帯を消すモックとログアウトのせいで、帯の読み取りの抜けが
 * 見えなかった)。ログインした状態で、ページの部品をそのまま描く。消すのは AI が書く表を読まない部品だけ (読み取りのある部品は
 * 理由を AI_CONSULTATION_RENDER_TEST_MOCKED_READERS に書く) で、tests/ai-consultation-refetch-coverage-2195.test.ts がそれを確かめる。
 * 応答の作りでも読み取りを隠さない: 描画の検査 (下の 2 つ目の describe) は家族に入っている人 (自分ともう 1 人) で開き、
 * 前の答えで決まる読み取り (家族の一覧 → 名前の API・家族の献立) も開いたときの読み取りに出す (家族の一覧を空の答えにしていたせいで、
 * 名前の API の読み取りの抜けが見えなかった)。
 * 検査の限界: 生成中の依頼の監視の読み取り (状態の確認・Realtime) は、生成中の依頼の無い状態で比べる。監視は開いたときと同じ関数
 * (checkPendingRequests) を取り直しでも走らせ、生成中の流れは 1 つ目の describe の最初のテストが確かめる。
 *
 * サーバーは表 (server) で真似る。AI 相談の提案の実行は、表を書き換えてから AIChatBubble と同じ形で mealPlanUpdated を投げる。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateJa, formatLocalDate } from '@homegohan/shared';

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
 * Supabase のモック。ログインしている (週の始まりは月曜)。user_profiles は profile の行、family_members は familyMembers の行
 * (家族の active なメンバー) を返し、ほかの表は空。Realtime のチャンネルは名前だけ記録し、何も届けない
 */
const supabaseMock = vi.hoisted(() => ({
  /** ログインしている人の id (家族のメンバーの行の user_id にも使う) */
  userId: '21950000-0000-4000-8000-0000000000b1',
  channelNames: [] as string[],
  /** ログインしている人の user_profiles の行 (テストごとに置き換える) */
  profile: null as null | Record<string, unknown>,
  /** 家族の active なメンバーの family_members の行 (家族に入っていなければ空) */
  familyMembers: [] as Record<string, unknown>[],
  /**
   * 記録の口があれば、読んだ表 (select を呼んだとき。鍵は tests/helpers/ai-refetch-read-recorder.ts の selectReadKey) と
   * DB の関数 ('rpc:<名前>') を記録する (受け手の読み取りの検査)
   */
  reads: null as null | { record: (key: string | null) => void; recordSelect: (table: string, select: unknown) => void },
  /** true なら user_profiles の読み取りが error を返す (#2201 U1。通信・サーバーの失敗。行が無いのとは別) */
  profileFails: false,
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  const USER = { id: supabaseMock.userId, user_metadata: {} };
  /**
   * その表の答え (user_profiles は profile の行。single / maybeSingle なら行、そうでなければ行の配列。
   * family_members は familyMembers の行の配列。ほかの表は空)
   */
  const resultOf = (table: string | null, single: boolean) => {
    if (table === 'family_members') {
      const rows = supabaseMock.familyMembers;
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
    }
    if (table !== 'user_profiles') return EMPTY_RESULT;
    if (supabaseMock.profileFails) return { data: null, error: { code: '08006', message: 'connection failure' }, count: null };
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
const { AI_CONSULTATION_WRITTEN_COLUMNS } = await import('@/lib/ai/consultation-refetch-coverage');
const { AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS } = await import('@/lib/ai/consultation-generation-watch');
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
/** プロフィールの帯を出す完成度 (src/components/ProfileReminderBanner.tsx の COMPLETENESS_THRESHOLD = 50 の未満と以上) */
const INCOMPLETE_PROFILE_COMPLETENESS = 20;
const COMPLETE_PROFILE_COMPLETENESS = 100;
/** プロフィールの帯の見出し */
const PROFILE_BANNER_HEADING = '栄養目標を設定しましょう';
/** 家族に入っている人の家族 (家族の一覧の読み取りを開いたときの読み取りに出す) */
const FAMILY_ID = '21950000-0000-4000-8000-0000000000f1';
/** 家族の中の自分 (display_name が無い = 名前の API がプロフィールの名前を当てる) と、献立を共有するもう 1 人 */
const SELF_MEMBER_ID = '21950000-0000-4000-8000-0000000000c1';
const OTHER_MEMBER_ID = '21950000-0000-4000-8000-0000000000c2';
const OTHER_USER_ID = '21950000-0000-4000-8000-0000000000b2';
/** 自分のプロフィールの名前 (AI 相談の前と後) と、もう 1 人の家族の中の呼び名 (display_name) */
const SELF_NAME_BEFORE = 'ほり';
const SELF_NAME_AFTER = '太郎';
const OTHER_MEMBER_NAME = '花子';

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
  /**
   * GET /api/family/members/names の答え (member id → 画面に出す名前。display_name か、display_name の無いメンバーの
   * プロフィールの名前 user_profiles.nickname。null = 決まらない)
   */
  familyMemberNames: { id: string; name: string | null }[];
  /** 置いている間に始めた GET /api/meal-plans の応答を、この Promise が解けるまで止める (#2201 U1) */
  mealPlansHold: Promise<void> | null;
  /** true なら GET /api/family/members/names が 500 を返す (#2201 U1) */
  namesFail: boolean;
};
let server: FakeServer;
let fetchCalls: string[];
/** 受け手の読み取りの記録 (GET の fetch と Supabase の読み取り) */
let recorder: InstanceType<typeof ReadRecorder>;

/** family_members の active な行 (ページの loadFamilyData が読む列)。avatar_color が空なら一覧の順の色 */
function familyMemberRow(id: string, userId: string, role: 'representative' | 'adult', displayName: string | null) {
  return {
    id,
    family_id: FAMILY_ID,
    user_id: userId,
    role,
    display_name: displayName,
    relationship: null,
    tags: [],
    share_meals: true,
    share_health: false,
    share_menu: true,
    child_profile: null,
    avatar_color: '',
    status: 'active',
    joined_at: '2026-10-01T00:00:00.000Z',
    removed_at: null,
  };
}

/**
 * 家族に入っている (自分と、献立を共有するもう 1 人)。プロフィールの family_id は呼ぶ側が置く。
 * selfName は名前の API が display_name の無い自分に当てるプロフィールの名前 (null = 決まらない)
 */
function joinFamily(selfName: string | null) {
  supabaseMock.familyMembers = [
    familyMemberRow(SELF_MEMBER_ID, supabaseMock.userId, 'representative', null),
    familyMemberRow(OTHER_MEMBER_ID, OTHER_USER_ID, 'adult', OTHER_MEMBER_NAME),
  ];
  server.familyMemberNames = [
    { id: SELF_MEMBER_ID, name: selfName },
    { id: OTHER_MEMBER_ID, name: OTHER_MEMBER_NAME },
  ];
}

/** GET /api/family/menu の答えのメンバー (自分以外で献立を共有するメンバー。この検査では献立なし) */
function familyMenuMembersJson() {
  return supabaseMock.familyMembers
    .filter((member) => member.user_id !== supabaseMock.userId && member.share_menu === true)
    .map((member) => ({ member_id: String(member.id), user_id: String(member.user_id), days: [] }));
}

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
/** 読み取りの失敗 (server.namesFail) のときの status */
const SERVER_ERROR_STATUS = 500;
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
      case '/api/meal-plans': {
        // 答えは読み取りを始めたときのもの。止めていれば、止めが解けてから返す
        const body = mealPlansJson(url.searchParams.get('startDate') ?? '', url.searchParams.get('endDate') ?? '');
        const hold = server.mealPlansHold;
        if (hold) await hold;
        return jsonResponse(body);
      }
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
      case '/api/family/members/names':
        if (server.namesFail) return jsonResponse({ error: 'down' }, SERVER_ERROR_STATUS);
        return jsonResponse({ data: { members: server.familyMemberNames } });
      case '/api/family/menu':
        return jsonResponse({
          data: {
            family_id: FAMILY_ID,
            start_date: url.searchParams.get('startDate') ?? '',
            end_date: url.searchParams.get('endDate') ?? '',
            members: familyMenuMembersJson(),
          },
        });
      default:
        return jsonResponse({}, NOT_FOUND_STATUS);
    }
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  server = {
    days: new Map(),
    shoppingItems: [],
    familySize: 2,
    pendingRequest: null,
    familyMemberNames: [],
    mealPlansHold: null,
    namesFail: false,
  };
  supabaseMock.profileFails = false;
  supabaseMock.channelNames.length = 0;
  // 既定は帯を出さないプロフィール (帯の検査は incompleteProfile に置き換える)・家族なし (家族の検査は joinFamily)
  supabaseMock.profile = completeProfile();
  supabaseMock.familyMembers = [];
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

/** 家族の切り替え (FamilyViewSwitcher) のチップに出ているメンバーの名前 (チップの title。一覧の順) */
function familySwitcherNames(): string[] {
  const bar = container.querySelector('[aria-label="ビューを切替"]');
  if (!bar) throw new Error('家族の切り替えが無い');
  return [...bar.querySelectorAll('span[title]')].map((el) => el.getAttribute('title') ?? '');
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

  it('家族に入っている人が AI 相談で自分の名前を変えたら、家族の切り替えの名前も取り直す (#2195 V1 R2)', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    await renderWeeklyPage();
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);

    // AI 相談の update_profile_preferences (nickname)。自分の family_members の行に display_name は無いので、
    // 名前の API は自分にプロフィールの今の名前を当てる
    server.familyMemberNames = [
      { id: SELF_MEMBER_ID, name: SELF_NAME_AFTER },
      { id: OTHER_MEMBER_ID, name: OTHER_MEMBER_NAME },
    ];
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });

    expect(familySwitcherNames()).toEqual([SELF_NAME_AFTER, OTHER_MEMBER_NAME]);
  });
});

describe('献立表 (/menus/weekly) の取り直しの順序と失敗 (#2201 U1)', () => {
  it('取り直しの応答を待つあいだに週を移ったら、前の週の献立を新しい週の見出しの下に出さない', async () => {
    const THIS_WEEK_DISH = '今週の肉じゃが';
    const NEXT_WEEK_DISH = '翌週のカレーライス';
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      server.days.set(dateFromWeekStart(i), [{ id: `meal-this-${i}`, dishName: THIS_WEEK_DISH }]);
      server.days.set(dateFromWeekStart(DAYS_IN_WEEK + i), [{ id: `meal-next-${i}`, dishName: NEXT_WEEK_DISH }]);
    }
    await renderWeeklyPage();
    expect(container.textContent).toContain(THIS_WEEK_DISH);

    // AI 相談の成功の取り直し (表示中の週の献立) の応答が遅れる
    let release: () => void = () => undefined;
    server.mealPlansHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await notifyAiConsultationSucceeded('update_meal', { updated: true });
    server.mealPlansHold = null;

    // 応答を待つあいだに翌週へ移る
    const nextWeek = container.querySelector<HTMLButtonElement>('button[aria-label="翌週"]');
    expect(nextWeek, '「翌週」のボタンが無い').not.toBeNull();
    await act(async () => {
      nextWeek!.click();
    });
    await settle();
    expect(container.textContent).toContain(NEXT_WEEK_DISH);

    // 前の週の取り直しの応答が後から届いても、翌週の献立のまま
    await act(async () => {
      release();
    });
    await settle();
    expect(container.textContent).toContain(NEXT_WEEK_DISH);
    expect(container.textContent).not.toContain(THIS_WEEK_DISH);
  });

  it('取り直しで名前の API を読めなかったら、家族の切り替えの名前を残す', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    await renderWeeklyPage();
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);

    server.namesFail = true;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);
  });

  it('取り直しで自分のプロフィールを読めなかったら、家族の切り替えを消さない', async () => {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    await renderWeeklyPage();
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);

    supabaseMock.profileFails = true;
    await notifyAiConsultationSucceeded('update_profile_preferences', { updated: true, fields: ['nickname'] });
    expect(familySwitcherNames()).toEqual([SELF_NAME_BEFORE, OTHER_MEMBER_NAME]);
  });
});

describe('献立表 (/menus/weekly) を描画して、AI 相談の成功の取り直しを確かめる (#2195 V1)', () => {
  /**
   * AI が書く表に中身のある答え (表示中の週と別の週の献立・買い物リスト・家族の人数・プロフィールの未入力の欄・自分の名前)。
   * 家族に入っている (自分ともう 1 人): 家族の一覧の答えで決まる読み取り (名前の API・家族の献立) を開いたときの読み取りに出す
   */
  function fillServer() {
    supabaseMock.profile = { ...incompleteProfile(), family_id: FAMILY_ID };
    joinFamily(SELF_NAME_BEFORE);
    const week = displayedWeekDates();
    server.days.set(week[0], [{ id: 'meal-1', dishName: '鮭の塩焼き' }]);
    server.days.set(otherWeekDateInDisplayedMonth(), [{ id: 'meal-other', dishName: 'カレー' }]);
    server.shoppingItems = [{ id: 'item-1', itemName: 'にんじん', isChecked: false }];
    server.familySize = 3;
  }
  /**
   * AI 相談で消した・空にしたあと (プロフィールは未入力の欄が無くなり、帯を出さない。自分の名前は決まらない)。
   * 家族の所属と一覧は AI 相談が書かないので変えない
   */
  function emptyServer() {
    supabaseMock.profile = { ...completeProfile(), family_id: FAMILY_ID };
    joinFamily(null);
    server.days = new Map();
    server.shoppingItems = [];
    server.familySize = null;
  }

  it('開いたとき・月のカレンダーのパネル・プロフィールの帯・家族の切り替えが読むもの全部を、取り直しも読む', async () => {
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
    // 週の始まりの日 (表の mountReadsNotRefetched の weekStartDay)。AI 相談が書かない列
    const WEEK_START_DAY_COLUMN = 'week_start_day';
    expect(AI_CONSULTATION_WRITTEN_COLUMNS.user_profiles).not.toContain(WEEK_START_DAY_COLUMN);
    // 家族の献立 (表の mountReadsNotRefetched の familyMenu。自分以外のメンバーの献立)
    const familyMenuKey =
      fetchReadKey(`/api/family/menu?startDate=${dateFromWeekStart(0)}&endDate=${dateFromWeekStart(DAYS_IN_WEEK - 1)}`) ?? '';
    // 家族の一覧の答えで決まる読み取りが、開いたときの読み取りに出ている (応答の作りで隠れていない)。
    // 家族の所属・一覧・名前の API は取り直しも読む (名前の API はプロフィールの名前 = AI 相談が書く nickname を当てる)
    const familyReads = [
      selectReadKey('user_profiles', 'family_id'),
      selectReadKey('family_members', '*'),
      fetchReadKey('/api/family/members/names') ?? '',
    ];
    expect([...mountReads]).toEqual(expect.arrayContaining([...familyReads, familyMenuKey]));
    expect([...refetchReads]).toEqual(expect.arrayContaining(familyReads));
    expectRefetchReadsCoverMount('/menus/weekly', mountReads, refetchReads, {
      adjacentWeekPrefetch: [weekRangeKey(-DAYS_IN_WEEK), weekRangeKey(DAYS_IN_WEEK)],
      weekStartDay: [selectReadKey('user_profiles', WEEK_START_DAY_COLUMN)],
      familyMenu: [familyMenuKey],
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

describe('献立表 (/menus/weekly) は、AI 相談が始めた献立の生成が終わったときにも取り直す (#2195 V1 の整合ゲートの是正)', () => {
  /** 表示中の週の初日でない日 (水曜。週の初日から始めた生成だけを見つけるページの生成中の依頼の確認では見つからない日) */
  const NOT_WEEK_START_OFFSET = 2;
  /** 1 食の生成の日 (木曜。週の初日でない日) */
  const SINGLE_MEAL_OFFSET = 3;

  /** 日付のタブを押してその日を出す */
  async function selectDay(date: string) {
    const tab = container.querySelector<HTMLButtonElement>(`button[aria-label^="${formatDateJa(date)} "]`);
    if (!tab) throw new Error(`日付のタブが無い: ${date}`);
    await act(async () => {
      tab.click();
    });
    await settle();
  }

  /** 生成の状態を確かめる間隔だけ時計を進める (setInterval だけ偽の時計) */
  async function advanceGenerationWatch() {
    await act(async () => {
      vi.advanceTimersByTime(AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS);
    });
    await settle();
  }

  /**
   * AI 相談の生成の受付を知らせ (献立はまだ無い)、生成の状態の確認で終わらせて、作った献立が出るかを返す。
   * 生成中の依頼の確認 (GET /api/ai/menu/weekly/pending) は、開始日が表示中の週の初日の依頼しか返さない (この日では見つからない)
   */
  async function generateAndComplete(params: { actionType: string; date: string; dish: string; result: Record<string, unknown>; requestId: string }) {
    server.pendingRequest = {
      id: params.requestId,
      startDate: params.date,
      generate: () => server.days.set(params.date, [{ id: `meal-${params.date}`, dishName: params.dish }]),
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await notifyAiConsultationSucceeded(params.actionType, params.result);
      // 受付の取り直しでは、献立はまだ無い
      expect(container.textContent).not.toContain(params.dish);
      expect(fetchCalls).not.toContain(`/api/ai/menu/weekly/status?requestId=${params.requestId}`);
      // 生成の状態を確かめると、生成が終わっている (献立を書いてから completed)
      await advanceGenerationWatch();
      expect(fetchCalls).toContain(`/api/ai/menu/weekly/status?requestId=${params.requestId}`);
    } finally {
      vi.useRealTimers();
    }
    await settle();
  }

  it('表示中の週の初日でない日の generate_day_menu は、生成が終わったら作った献立を出す', async () => {
    const date = dateFromWeekStart(NOT_WEEK_START_OFFSET);
    const dish = 'AI が作った水曜の鯖の味噌煮';
    const requestId = '21950000-0000-4000-8000-0000000000d1';
    await renderWeeklyPage();
    await selectDay(date);
    await generateAndComplete({ actionType: 'generate_day_menu', date, dish, requestId, result: { date, requestId, status: 'processing' } });
    expect(container.textContent).toContain(dish);
  });

  it('generate_single_meal (表示中の週の初日でない日の 1 食) は、生成が終わったら作った献立を出す', async () => {
    const date = dateFromWeekStart(SINGLE_MEAL_OFFSET);
    const dish = 'AI が作った木曜の親子丼';
    const requestId = '21950000-0000-4000-8000-0000000000d2';
    await renderWeeklyPage();
    await selectDay(date);
    await generateAndComplete({
      actionType: 'generate_single_meal',
      date,
      dish,
      requestId,
      result: { requestId, status: 'processing', message: '木曜の夕食を作っています' },
    });
    expect(container.textContent).toContain(dish);
  });
});
