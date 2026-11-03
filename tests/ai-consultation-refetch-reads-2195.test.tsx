/**
 * #2195 V1 受け手のページを描画して、AI 相談の成功の取り直しが
 *   - 開いたとき (とユーザーの操作で開いたパネル) に読むもの全部を読み直す (expectRefetchReadsCoverMount)
 *   - 空の応答を前の値を残さずに置く (空の応答で取り直した画面 = 空の応答で開いた画面。expectEmptyRefetchMatchesFreshMount)
 * ことを確かめる。献立表 (/menus/weekly) は tests/ai-consultation-weekly-refetch-2195.test.tsx、ホーム (/home) は
 * tests/ai-consultation-home-refetch-2195.test.tsx が同じ 2 つを確かめる。受け手ごとにどちらもあることは
 * tests/ai-consultation-refetch-coverage-2195.test.ts が数える。
 *
 * 問題 (直す前):
 *   - /health の選んだ日のパネル (週間カレンダーで過去の日を押すと出る) は、取り直し (fetchData) の範囲に入っていなかった。
 *     AI 相談で過去の日の記録を書くと、カレンダーの印だけが「記録あり」になり、パネルは古い値のまま残った
 *   - /health の記録の欄の体重・/profile のプロフィールと栄養目標・/badges のお祝いは、応答が空のときに前の値を残していた
 *     (`if (x) set(...)`。読み込み直すと消える)
 *
 *   - 家族の画面 (/family/members・/family/dashboard・/family/members/[id]) と譲渡の承諾の画面は、自分の名前 (user_profiles.nickname。
 *     AI 相談の update_profile_preferences が書く) を出すのに除外で、AI 相談で名前を変えても古い名前のまま残った (#2195 V1 R3)。
 *     血液検査・健康診断の詳細は、基準値と判定を選ぶ性別 (gender。同じく AI 相談が書く) が古いまま残った
 *
 * 書き込みのある受け手 (家族のメンバー・メンバーの詳細・譲渡の承諾) は、書き込みの応答を待つあいだは取り直さず、取り直しの応答を
 * 待つあいだは書き込みを送らない (読み直しの応答があとから届いて、先に済んだ書き込みの結果を古い値で上書きしないため) ことも確かめる。
 * 除外の alwaysBlockedWhileShown のページ (/family/representative-transfer) は、AI が書く値を出している間に番兵が止めることを確かめる。
 *
 * #2201 U1 + U2 (受け手の共通の hook src/hooks/useAiConsultationDataRefetch.ts の決まり) も受け手ごとに確かめる:
 *   - 取り直しの失敗 (500・通信の失敗・Supabase の error) では今の表示を残す (以前は「読み込めませんでした」・「見つかりませんでした」・
 *     「名前未設定」に置き換え、/health は読み込み中のまま止まった)
 *   - 取り直しの応答を待つあいだも、画面全体を読み込み中の表示に置き換えない
 *   - 先に始めた取り直しの応答が後から届いても、あとの取り直しの表示を上書きしない (世代番号)
 *   - 書き込みの間に来た成功は捨てずに、書き込みが終わったら 1 回取り直す
 *
 * 「空の応答」は、AI が書く表から読む応答を空にしたもの (AI が書かない表の応答は中身のあるままにする)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReadRecorder,
  expectEmptyRefetchMatchesFreshMount,
  expectRefetchAlwaysBlockedWhileShown,
  expectRefetchReadsCoverMount,
  fetchReadKey,
  screenSignature,
  READ_KEY_ORIGIN,
} from './helpers/ai-refetch-read-recorder';

/** サーバーの答え (テストごとに置き換える)。fetch は道 ('*' は 1 つの区切り) → 応答の本文、Supabase は表 → 行 */
const server = vi.hoisted(() => ({
  fetchBodies: {} as Record<string, unknown>,
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** 読み取りの記録の口。表は select を呼んだとき (鍵は tests/helpers/ai-refetch-read-recorder.ts の selectReadKey) */
  reads: null as null | { record: (key: string | null) => void; recordSelect: (table: string, select: unknown) => void },
  /** 応答を止めておく fetch ('<メソッド> <道>') と Supabase の表 (止めた応答は、その Promise が解けてから返す) */
  fetchHolds: new Map<string, Promise<void>>(),
  tableHolds: new Map<string, Promise<void>>(),
  /** 送った fetch ('<メソッド> <道>')。書き込みを送ったかを見る */
  requests: [] as string[],
  /**
   * 読み取りを失敗させる (#2201 U1)。'http' は fetch が 500・Supabase の表と getUser が error を返す、'network' は fetch が reject し、
   * Supabase の表と getUser が error を返す。null は失敗させない
   */
  failure: null as null | 'http' | 'network',
  /** この fetch ('<メソッド> <道>') だけ 500 を返す (#2201 U1。名前の API だけの失敗など) */
  failedRequests: new Set<string>(),
  /**
   * 置いている間に始めた読み取り (fetch と Supabase の表) の応答を、この Promise が解けるまで止める (#2201 U1)。
   * 応答の中身は読み取りを始めたときのサーバーの答え (止めたあとに答えを変えても、止めた読み取りは前の答えを返す)
   */
  holdAll: null as null | Promise<void>,
}));

const navigation = vi.hoisted(() => ({
  router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
  searchParams: new URLSearchParams(),
  /** useParams の答え (動的な区切りのページのテストが置く) */
  params: {} as Record<string, string>,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
  useParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/image', () => ({ default: () => null }));
// アイコンの部品はこの検査に関係しないので描かない (tests/ai-consultation-data-refetch-2195.test.tsx と同じ)
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));
// アニメーションは描かずに中身だけを出す (消えるアニメーションの途中の要素が残って、画面の比べに混ざらないように)
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
  const USER = { id: '21950000-0000-4000-8000-0000000000aa', user_metadata: {} };
  /**
   * どのメソッドを呼んでも自分を返し、await するとその表の行 (single / maybeSingle なら最初の 1 行) になる問い合わせ
   * (eq・neq などの絞り込みは見ない)。tableHolds に表があれば、その Promise が解けてから返す
   */
  const query = (table: string, single: boolean, recordsSelect: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => {
            const failure = server.failure;
            const holdAll = server.holdAll;
            // 止めた読み取りは、始めたときの答えを返す
            const startedRows = holdAll ? (server.tables[table] ?? []) : null;
            const answer = () => {
              if (failure !== null) {
                resolve({ data: null, error: TABLE_READ_FAILURE, count: null });
                return;
              }
              const rows = startedRows ?? server.tables[table] ?? [];
              const data = single ? (rows[0] ?? null) : rows;
              resolve({ data, error: null, count: rows.length });
            };
            const hold = server.tableHolds.get(table);
            const afterHoldAll = holdAll ?? Promise.resolve();
            void afterHoldAll.then(() => {
              if (hold) void hold.then(answer);
              else answer();
            });
          };
        }
        return (...args: unknown[]) => {
          if (prop === 'select' && recordsSelect) server.reads?.recordSelect(table, args[0]);
          return query(table, single || prop === 'single' || prop === 'maybeSingle', recordsSelect);
        };
      },
    });
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  // 本物の createClient (ブラウザではシングルトン) と同じく、毎回同じクライアントを返す (client を依存に持つ useCallback が
  // 描画のたびに作り直されて、開いたときの読み込みが繰り返し走らないように)
  /** 読み取りの失敗 (server.failure) のときに Supabase の表が返す error (行が無い PGRST116 ではない、通信・サーバーの失敗) */
  const TABLE_READ_FAILURE = { code: '08006', message: 'connection failure', details: null, hint: null };
  /** 読み取りの失敗 (server.failure) のときに getUser が返す error (ログインが切れたのではない、通信の失敗) */
  const AUTH_READ_FAILURE = { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 };
  const client = {
    auth: {
      getUser: async () =>
        server.failure !== null ? { data: { user: null }, error: AUTH_READ_FAILURE } : { data: { user: USER }, error: null },
      getSession: async () => ({ data: { session: { user: USER } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
    from: (table: string) => query(table, false, true),
    rpc: (name: string) => {
      server.reads?.record(`rpc:${name}`);
      return query(`rpc:${name}`, false, false);
    },
    channel: () => channel,
    removeChannel: async () => 'ok',
  };
  return { createClient: () => client };
});

const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');
const { default: ComparisonPage } = await import('@/app/(main)/comparison/page');
const { default: PantryPage } = await import('@/app/(main)/pantry/page');
const { default: HealthPage } = await import('@/app/(main)/health/page');
const { default: HealthGoalsPage } = await import('@/app/(main)/health/goals/page');
const { default: HealthGraphsPage } = await import('@/app/(main)/health/graphs/page');
const { default: StreaksPage } = await import('@/app/(main)/health/streaks/page');
const { default: BadgesPage } = await import('@/app/(main)/badges/page');
const { default: MealDetailPage } = await import('@/app/(main)/meals/[id]/page');
const { default: ProfilePage } = await import('@/app/(main)/profile/page');
const { default: NutritionTargetsPage } = await import('@/app/(main)/profile/nutrition-targets/page');
const { default: FamilyMembersPage } = await import('@/app/(main)/family/members/page');
const { default: FamilyDashboardPage } = await import('@/app/(main)/family/dashboard/page');
const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');
const { default: FamilyTransferAcceptPage } = await import('@/app/(main)/family/transfer-accept/[proposal_id]/page');
const { default: OrgTransferAcceptPage } = await import('@/app/(main)/org/transfer-accept/[proposal_id]/page');
const { default: BloodTestsPage } = await import('@/app/(main)/health/blood-tests/page');
// /health/checkups/[id] の page.tsx はサーバーの部品 (async) で、id を確かめて CheckupDetailClient を描くだけ。中身の部品を描く
const { default: CheckupDetailClient } = await import('@/app/(main)/health/checkups/[id]/CheckupDetailClient');
const { default: RepresentativeTransferPage } = await import('@/app/(main)/family/representative-transfer/page');
const { isAiConsultationRefetchBlocked } = await import('@/lib/ai/consultation-data-refetch');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 30;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
/** 読み取りの失敗 (server.failure = 'http'・failedRequests) のときの status */
const SERVER_ERROR_STATUS = 500;
const PATH_WILDCARD = '*';
/** fetch の init に method が無いときのメソッド */
const READ_METHOD = 'GET';

let container: HTMLDivElement;
let root: Root;
let recorder: ReadRecorder;

/** 道の型 ('*' は 1 つの区切り) が道に当たるか */
function pathMatches(pattern: string, pathname: string): boolean {
  const a = pattern.split('/');
  const b = pathname.split('/');
  return a.length === b.length && a.every((seg, i) => seg === PATH_WILDCARD || seg === b[i]);
}

function installServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      recorder.record(fetchReadKey(input, init));
      const url = new URL(String(input), READ_KEY_ORIGIN);
      const request = `${(init?.method ?? READ_METHOD).toUpperCase()} ${url.pathname}`;
      server.requests.push(request);
      const failure = server.failure;
      const failedRequest = server.failedRequests.has(request);
      const holdAll = server.holdAll;
      const bodyOf = () => {
        const exact = server.fetchBodies[`${url.pathname}${url.search}`] ?? server.fetchBodies[url.pathname];
        const pattern = Object.keys(server.fetchBodies).find((key) => key.includes(PATH_WILDCARD) && pathMatches(key, url.pathname));
        return exact ?? (pattern === undefined ? undefined : server.fetchBodies[pattern]);
      };
      // 止めた読み取りは、始めたときの答えを返す
      const startedBody = holdAll ? { value: bodyOf() } : null;
      if (holdAll) await holdAll;
      const hold = server.fetchHolds.get(request);
      if (hold) await hold;
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'http' || failedRequest) return Response.json({ error: 'down' }, { status: SERVER_ERROR_STATUS });
      const body = startedBody ? startedBody.value : bodyOf();
      if (body === undefined) return Response.json({}, { status: NOT_FOUND_STATUS });
      return Response.json(body, { status: OK_STATUS });
    }),
  );
}

beforeEach(() => {
  recorder = new ReadRecorder();
  server.reads = recorder;
  server.fetchBodies = {};
  server.tables = {};
  server.fetchHolds = new Map();
  server.tableHolds = new Map();
  server.requests = [];
  server.failure = null;
  server.failedRequests = new Set();
  server.holdAll = null;
  navigation.params = {};
  installServer();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
  server.reads = null;
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

/** AI 相談の成功の知らせを投げる (AIChatBubble と同じ形)。待たない (act の中で、再描画の前に続けて操作するテストが使う) */
function dispatchAiConsultationSucceeded() {
  window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
}

/** AI 相談の成功を知らせて、取り直しを流しきる */
async function notifyAiConsultationSucceeded() {
  await act(async () => {
    dispatchAiConsultationSucceeded();
  });
  await settle();
}

interface ServerState {
  fetchBodies: Record<string, unknown>;
  tables?: Record<string, Record<string, unknown>[]>;
}

function setServer(state: ServerState) {
  server.fetchBodies = { ...state.fetchBodies };
  server.tables = { ...(state.tables ?? {}) };
}

interface PageCase {
  /** AI_CONSULTATION_REFETCH_PAGES のキー */
  page: string;
  render: () => React.ReactElement;
  /** 中身のある応答 */
  full: ServerState;
  /** AI が書く表から読む応答を空にしたもの */
  empty: ServerState;
  /** ユーザーの操作で開くパネル (開いたまま取り直しが走るもの) */
  openPanels?: () => Promise<void>;
  /**
   * 前の答えの中身で決まる読み取り (中身のある応答で開いたときに必ず出るもの)。応答の作りで読み取りが隠れて、
   * 取り直しとの比べが空振りしていないことを確かめる (#2195 V1 R2: 家族の一覧を空の答えにしていて、名前の API の読み取りの抜けが見えなかった)
   */
  gatedMountReads?: readonly string[];
  /** 表の mountReadsNotRefetched の名前 → 今の読み取りの鍵 (expectRefetchReadsCoverMount の excludedKeys) */
  mountReadsNotRefetched?: Readonly<Record<string, readonly string[]>>;
}

async function mount(c: PageCase) {
  await act(async () => {
    root.render(c.render());
  });
  await settle();
  if (c.openPanels) {
    await c.openPanels();
    await settle();
  }
}

async function remount(c: PageCase) {
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await mount(c);
}

/** 開いたとき・パネルの読み取りを、取り直しが全部読む */
async function checkRefetchCoversMount(c: PageCase) {
  setServer(c.full);
  recorder.take();
  await mount(c);
  const mountReads = recorder.take();
  expect([...mountReads], `${c.page} の前の答えで決まる読み取りが、開いたときの読み取りに無い`).toEqual(
    expect.arrayContaining([...(c.gatedMountReads ?? [])]),
  );
  await notifyAiConsultationSucceeded();
  const refetchReads = recorder.take();
  expectRefetchReadsCoverMount(c.page, mountReads, refetchReads, c.mountReadsNotRefetched);
}

/** 空の応答の取り直しは、空の応答で開いたときと同じ画面 */
async function checkEmptyRefetch(c: PageCase) {
  setServer(c.full);
  await mount(c);
  const full = screenSignature(container);
  setServer(c.empty);
  await notifyAiConsultationSucceeded();
  const refetchedToEmpty = screenSignature(container);
  await remount(c);
  const freshEmpty = screenSignature(container);
  expectEmptyRefetchMatchesFreshMount(c.page, { full, refetchedToEmpty, freshEmpty });
}

// ─── ページごとの応答 ───────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TODAY = localDate(new Date());

const HEALTH_RECORD = (date: string, weight: number) => ({ id: `rec-${date}`, record_date: date, weight, mood_score: 4, sleep_hours: 7 });
const STREAK = { current_streak: 3, longest_streak: 5, achieved_badges: [], total_records: 8, streak_type: 'daily_record' };
const WEIGHT_GOAL = {
  id: 'goal-1',
  goal_type: 'weight',
  target_value: 60,
  target_unit: 'kg',
  current_value: 64,
  start_value: 66,
  progress_percentage: 33,
  status: 'active',
  milestones: [],
};

/** /health で週間カレンダーの今日でない日 (パネルを出す日) を押す */
async function openHealthDayPanel() {
  const day = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]')][0];
  if (!day) throw new Error('今日でない日のボタンが無い');
  await act(async () => {
    day.click();
  });
}

const MEAL_ID = 'meal-2195-reads';
/** 食事に紐づく市販品 (食事の詳細は catalog_product_id があるときだけ GET /api/catalog/products/<id> を読む) */
const CATALOG_PRODUCT_ID = 'catalog-2195-reads';
const BADGE_ROW = (earned: boolean) => ({
  id: 'badge-2195',
  code: 'first_bite',
  name: 'はじめの一口',
  description: '食事を 1 回記録する',
  earned,
  obtainedAt: earned ? '2026-11-03T00:00:00Z' : undefined,
  periodAwards: null,
});
const TARGETS_BODY = {
  targets: {
    id: 'nt-2195',
    dailyCalories: 2000,
    proteinG: 60,
    fatG: 60,
    carbsG: 250,
    fiberG: 20,
    autoCalculate: true,
    calculationBasis: null,
    lastCalculatedAt: '2026-11-01T00:00:00Z',
  },
};
const PROFILE_ROW = {
  id: '21950000-0000-4000-8000-0000000000aa',
  nickname: 'ほり',
  age: 30,
  gender: 'male',
  height: 170,
  weight: 70,
  target_weight: 65,
};
const PROFILE_ROW_EMPTY = { id: '21950000-0000-4000-8000-0000000000aa' };

/** 自分 (Supabase のモックの getUser の利用者) と、家族・組織のほかの人 */
const SELF_USER_ID = '21950000-0000-4000-8000-0000000000aa';
const OTHER_USER_ID = '21950000-0000-4000-8000-0000000000bb';
const FAMILY_ID = '21950000-0000-4000-8000-0000000000f1';
const SELF_MEMBER_ID = '21950000-0000-4000-8000-0000000000c1';
const OTHER_MEMBER_ID = '21950000-0000-4000-8000-0000000000c2';
const PROPOSAL_ID = '21950000-0000-4000-8000-0000000000d1';
const ORG_ID = '21950000-0000-4000-8000-0000000000e1';
const CHECKUP_ID = '21950000-0000-4000-8000-0000000000e2';
/** 自分の名前 (AI 相談の update_profile_preferences が書く user_profiles.nickname) の、AI 相談の前と後 */
const SELF_NAME = 'ほりだいすけ';
const SELF_NAME_AFTER_AI = 'たろうさん';
/** 家族のもう 1 人の名前 (family_members.display_name。AI 相談が書かない) */
const OTHER_MEMBER_NAME = 'はなこさん';
/** 名前が決まらないメンバーに家族の画面が出す語 */
const NO_NAME = '名前未設定';
const FAMILY_NAMES_API = '/api/family/members/names';
/** 譲渡の提案の期限 (期限内の pending の提案にする) */
const PROPOSAL_EXPIRES_AT = '2099-12-31T00:00:00Z';

function familyMemberRow(id: string, userId: string, role: 'representative' | 'adult', displayName: string | null) {
  return {
    id,
    role,
    display_name: displayName,
    user_id: userId,
    child_profile: null,
    birth_date: null,
    status: 'active',
    share_meals: true,
    share_health: false,
    share_menu: true,
    joined_at: '2026-10-01T00:00:00Z',
  };
}

/** 家族に入っている (自分は代表で display_name が無い。もう 1 人は display_name のある大人) */
const FAMILY_TABLES = {
  user_profiles: [{ id: SELF_USER_ID, family_id: FAMILY_ID }],
  family_groups: [{ id: FAMILY_ID, name: '取り直しの家族', member_limit: 6, status: 'active' }],
  family_members: [
    familyMemberRow(SELF_MEMBER_ID, SELF_USER_ID, 'representative', null),
    familyMemberRow(OTHER_MEMBER_ID, OTHER_USER_ID, 'adult', OTHER_MEMBER_NAME),
  ],
};

/** 名前の API の答え。自分の行は display_name が無いので、名前の API が自分のプロフィールの名前 (無ければ null) を当てる */
const familyNamesBody = (selfName: string | null) => ({
  data: {
    members: [
      { id: SELF_MEMBER_ID, name: selfName },
      { id: OTHER_MEMBER_ID, name: OTHER_MEMBER_NAME },
    ],
  },
});

/** 譲渡の提案 (from → to)。自分が申し出た提案を自分で開くと、提案者の名前に自分の名前が出る */
function transferProposalRow(fromUserId: string, toUserId: string, scope: 'family' | 'organization', scopeId: string) {
  return {
    id: PROPOSAL_ID,
    scope,
    scope_id: scopeId,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    status: 'pending',
    proposed_at: '2026-11-01T00:00:00Z',
    expires_at: PROPOSAL_EXPIRES_AT,
  };
}

/** 血液検査の結果・健康診断の結果 (AI 相談が書かない表)。基準値と判定はプロフィールの性別で選ぶ */
const BLOOD_TEST_RESULT = { id: 'blood-2195', test_date: '2026-10-01', hemoglobin: 12.5 };
const CHECKUP = { id: CHECKUP_ID, checkup_date: '2026-10-01', hemoglobin: 12.5 };
/** 性別が無いときに血液検査・健康診断の詳細が出す注記 */
const SEX_UNSET_NOTE = '性別未設定のため一般基準で判定しています';

/** 家族の画面の応答。空の応答は、AI 相談が書く自分の名前が無い (名前の API が自分の行に名前を当てない) */
const FAMILY_NAME_STATES: Pick<PageCase, 'full' | 'empty'> = {
  full: { fetchBodies: { [FAMILY_NAMES_API]: familyNamesBody(SELF_NAME) }, tables: FAMILY_TABLES },
  empty: { fetchBodies: { [FAMILY_NAMES_API]: familyNamesBody(null) }, tables: FAMILY_TABLES },
};

const CASES: PageCase[] = [
  {
    page: '/comparison',
    render: () => <ComparisonPage />,
    full: {
      fetchBodies: {
        '/api/comparison/rankings': {
          rankings: [],
          highlights: [{ type: 'streak', message: '7 日続けて記録しています', metric: 'streak', icon: '🔥' }],
          userMetrics: [],
          periodType: 'weekly',
          periodStart: '2026-11-01',
          periodEnd: '2026-11-07',
        },
      },
    },
    empty: {
      fetchBodies: {
        '/api/comparison/rankings': {
          rankings: [],
          highlights: [],
          userMetrics: [],
          periodType: 'weekly',
          periodStart: '2026-11-01',
          periodEnd: '2026-11-07',
        },
      },
    },
  },
  {
    page: '/pantry',
    render: () => <PantryPage />,
    full: {
      fetchBodies: {
        '/api/pantry': {
          items: [{ id: 'p-1', name: 'にんじん', amount: '2本', category: 'vegetable', expirationDate: null, addedAt: '2026-11-01' }],
        },
      },
    },
    empty: { fetchBodies: { '/api/pantry': { items: [] } } },
  },
  {
    page: '/health',
    render: () => <HealthPage />,
    full: {
      fetchBodies: {
        [`/api/health/records/${TODAY}`]: { record: HEALTH_RECORD(TODAY, 65), previous: null },
        '/api/health/records/*': { record: HEALTH_RECORD('2026-01-01', 64), previous: null },
        '/api/health/streaks': { streak: STREAK, weeklyRecords: [TODAY] },
        '/api/health/goals': { goals: [WEIGHT_GOAL] },
      },
    },
    empty: {
      fetchBodies: {
        '/api/health/records/*': { record: null, previous: null },
        '/api/health/streaks': { streak: null, weeklyRecords: [] },
        '/api/health/goals': { goals: [] },
      },
    },
    openPanels: openHealthDayPanel,
  },
  {
    page: '/health/goals',
    render: () => <HealthGoalsPage />,
    full: { fetchBodies: { '/api/health/goals': { goals: [WEIGHT_GOAL] } } },
    empty: { fetchBodies: { '/api/health/goals': { goals: [] } } },
  },
  {
    page: '/health/graphs',
    render: () => <HealthGraphsPage />,
    full: {
      fetchBodies: {
        '/api/health/records': { records: [{ record_date: TODAY, weight: 65 }] },
        '/api/health/checkups': { checkups: [] },
        '/api/health/goals': { goals: [WEIGHT_GOAL] },
      },
    },
    empty: {
      fetchBodies: {
        '/api/health/records': { records: [] },
        '/api/health/checkups': { checkups: [] },
        '/api/health/goals': { goals: [] },
      },
    },
  },
  {
    page: '/health/streaks',
    render: () => <StreaksPage />,
    full: { fetchBodies: { '/api/health/streaks': { streak: STREAK, nextBadge: 7, daysToNextBadge: 4, weeklyRecords: [TODAY] } } },
    empty: { fetchBodies: { '/api/health/streaks': { streak: null, nextBadge: null, daysToNextBadge: null, weeklyRecords: [] } } },
  },
  {
    page: '/badges',
    render: () => <BadgesPage />,
    full: { fetchBodies: { '/api/badges': { badges: [BADGE_ROW(true)], newEarnedCount: 1, newEarnedBadgeCodes: ['first_bite'] } } },
    empty: { fetchBodies: { '/api/badges': { badges: [BADGE_ROW(false)], newEarnedCount: 0, newEarnedBadgeCodes: [] } } },
  },
  {
    page: '/meals/[id]',
    render: () => <MealDetailPage params={Promise.resolve({ id: MEAL_ID })} />,
    full: {
      fetchBodies: {
        [`/api/meals/${MEAL_ID}`]: {
          id: MEAL_ID,
          daily_meal_id: 'day-2195',
          meal_type: 'dinner',
          mode: 'cook',
          dish_name: '取り直しの検査の料理',
          is_completed: true,
          completed_at: '2026-11-03T12:00:00Z',
          user_daily_meals: { day_date: '2026-11-03' },
          catalog_product_id: CATALOG_PRODUCT_ID,
        },
        '/api/profile': { servings_config: null },
      },
    },
    // 市販品の詳細は、食事の答えに catalog_product_id があるときだけ読む (食事の取得と同じ useEffect の中。取り直しも読む)
    gatedMountReads: [`GET /api/catalog/products/${CATALOG_PRODUCT_ID}`],
    // AI 相談で食事が消された (delete_meal): 詳細は 404
    empty: { fetchBodies: { '/api/profile': { servings_config: null } } },
  },
  {
    page: '/profile',
    render: () => <ProfilePage />,
    full: {
      fetchBodies: { '/api/badges': { badges: [BADGE_ROW(true)] }, '/api/nutrition/targets': TARGETS_BODY },
      tables: { user_profiles: [PROFILE_ROW] },
    },
    empty: {
      fetchBodies: { '/api/badges': { badges: [] }, '/api/nutrition/targets': { targets: null } },
      tables: { user_profiles: [PROFILE_ROW_EMPTY] },
    },
  },
  {
    page: '/profile/nutrition-targets',
    render: () => <NutritionTargetsPage />,
    full: {
      fetchBodies: { '/api/nutrition/targets': TARGETS_BODY, '/api/profile': PROFILE_ROW },
      tables: { user_profiles: [PROFILE_ROW] },
    },
    empty: {
      fetchBodies: { '/api/nutrition/targets': { targets: null }, '/api/profile': PROFILE_ROW_EMPTY },
      tables: { user_profiles: [PROFILE_ROW_EMPTY] },
    },
  },
  { page: '/family/members', render: () => <FamilyMembersPage />, ...FAMILY_NAME_STATES },
  { page: '/family/dashboard', render: () => <FamilyDashboardPage />, ...FAMILY_NAME_STATES },
  {
    // 自分の詳細 (自分の名前と共有の設定を出す)
    page: '/family/members/[id]',
    render: () => {
      navigation.params = { id: SELF_MEMBER_ID };
      return <FamilyMemberDetailPage />;
    },
    ...FAMILY_NAME_STATES,
  },
  {
    // 自分が申し出た提案を自分で開く (提案者の名前 = 自分の名前。ほかの人の user_profiles は RLS で読めない)
    page: '/family/transfer-accept/[proposal_id]',
    render: () => {
      navigation.params = { proposal_id: PROPOSAL_ID };
      return <FamilyTransferAcceptPage />;
    },
    full: {
      fetchBodies: {},
      tables: {
        ownership_transfer_proposals: [transferProposalRow(SELF_USER_ID, OTHER_USER_ID, 'family', FAMILY_ID)],
        user_profiles: [{ nickname: SELF_NAME }],
        family_groups: [{ name: '取り直しの家族' }],
      },
    },
    empty: {
      fetchBodies: {},
      tables: {
        ownership_transfer_proposals: [transferProposalRow(SELF_USER_ID, OTHER_USER_ID, 'family', FAMILY_ID)],
        user_profiles: [],
        family_groups: [{ name: '取り直しの家族' }],
      },
    },
  },
  {
    page: '/org/transfer-accept/[proposal_id]',
    render: () => {
      navigation.params = { proposal_id: PROPOSAL_ID };
      return <OrgTransferAcceptPage />;
    },
    full: {
      fetchBodies: {},
      tables: {
        ownership_transfer_proposals: [transferProposalRow(SELF_USER_ID, OTHER_USER_ID, 'organization', ORG_ID)],
        organizations: [{ name: '取り直しの組織' }],
        user_profiles: [{ nickname: SELF_NAME }],
      },
    },
    empty: {
      fetchBodies: {},
      tables: {
        ownership_transfer_proposals: [transferProposalRow(SELF_USER_ID, OTHER_USER_ID, 'organization', ORG_ID)],
        organizations: [{ name: '取り直しの組織' }],
        user_profiles: [],
      },
    },
  },
  {
    page: '/health/blood-tests',
    render: () => <BloodTestsPage />,
    full: { fetchBodies: { '/api/health/blood-tests': { results: [BLOOD_TEST_RESULT] }, '/api/profile': { gender: 'female' } } },
    empty: { fetchBodies: { '/api/health/blood-tests': { results: [BLOOD_TEST_RESULT] }, '/api/profile': {} } },
    mountReadsNotRefetched: { bloodTestResults: ['GET /api/health/blood-tests?limit=20'] },
  },
  {
    page: '/health/checkups/[id]',
    render: () => <CheckupDetailClient id={CHECKUP_ID} />,
    full: { fetchBodies: { [`/api/health/checkups/${CHECKUP_ID}`]: { checkup: CHECKUP }, '/api/profile': { gender: 'female' } } },
    empty: { fetchBodies: { [`/api/health/checkups/${CHECKUP_ID}`]: { checkup: CHECKUP }, '/api/profile': {} } },
    mountReadsNotRefetched: { checkup: [`GET /api/health/checkups/${CHECKUP_ID}`] },
  },
];

const caseOf = (page: string): PageCase => {
  const c = CASES.find((x) => x.page === page);
  if (!c) throw new Error(`${page} の描画のテストの応答が無い`);
  return c;
};

describe('受け手のページの取り直しは、開いたとき・パネルが読むもの全部を読み直す (#2195 V1)', () => {
  for (const c of CASES) {
    it(`${c.page}`, async () => {
      await checkRefetchCoversMount(c);
    });
  }
});

describe('受け手のページの空の応答の取り直しは、空の応答で開いたときと同じ (前の値を残さない。#2195 V1)', () => {
  for (const c of CASES) {
    it(`${c.page}`, async () => {
      await checkEmptyRefetch(c);
    });
  }
});

describe('/health の選んだ日のパネルは、AI 相談で書いた過去の日の記録を出す (#2195 V1 R4)', () => {
  it('パネルを開いたまま AI 相談でその日の体重を書くと、パネルが新しい体重を出す', async () => {
    const PANEL_BEFORE = 64;
    const PANEL_AFTER = 63.5;
    setServer({
      fetchBodies: {
        [`/api/health/records/${TODAY}`]: { record: null, previous: null },
        '/api/health/records/*': { record: HEALTH_RECORD('2026-01-01', PANEL_BEFORE), previous: null },
        '/api/health/streaks': { streak: STREAK, weeklyRecords: [] },
        '/api/health/goals': { goals: [] },
      },
    });
    await mount({ ...CASES.find((c) => c.page === '/health')!, openPanels: openHealthDayPanel });
    expect(container.textContent).toContain(String(PANEL_BEFORE));

    // AI 相談の update_health_record (その日の体重)
    server.fetchBodies['/api/health/records/*'] = { record: HEALTH_RECORD('2026-01-01', PANEL_AFTER), previous: null };
    await notifyAiConsultationSucceeded();
    expect(container.textContent).toContain(String(PANEL_AFTER));
    expect(container.textContent).not.toContain(String(PANEL_BEFORE));
  });

  it('今日の記録が無くなった取り直しのあと、記録の欄の体重は前の体重を残さない (読み込み直したときと同じ空)', async () => {
    const TODAY_WEIGHT = 65;
    setServer({
      fetchBodies: {
        [`/api/health/records/${TODAY}`]: { record: HEALTH_RECORD(TODAY, TODAY_WEIGHT), previous: null },
        '/api/health/streaks': { streak: STREAK, weeklyRecords: [TODAY] },
        '/api/health/goals': { goals: [] },
      },
    });
    await mount(CASES.find((c) => c.page === '/health')!);
    server.fetchBodies[`/api/health/records/${TODAY}`] = { record: null, previous: null };
    await notifyAiConsultationSucceeded();

    const openQuickRecord = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('今日の記録をつける'));
    expect(openQuickRecord).toBeDefined();
    await act(async () => {
      openQuickRecord!.click();
    });
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('');
  });

  it('パネルを閉じた後は、その日の記録を取り直さない', async () => {
    setServer(CASES.find((c) => c.page === '/health')!.full);
    await mount({ ...CASES.find((c) => c.page === '/health')!, openPanels: openHealthDayPanel });
    const pressed = container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    await act(async () => {
      pressed!.click();
    });
    recorder.take();
    await notifyAiConsultationSucceeded();
    const reads = [...recorder.take()].filter((key) => key.startsWith('GET /api/health/records/'));
    expect(reads).toEqual([`GET /api/health/records/${TODAY}`]);
  });
});


describe('自分の名前を出す家族・譲渡の画面は、AI 相談で変えた名前を出す (#2195 V1 R3)', () => {
  // 名前の API が自分の行に当てる名前 (家族の画面) / 提案者の名前 (譲渡の承諾の画面) を、AI 相談の update_profile_preferences で変える
  const renameViaNamesApi = () => {
    server.fetchBodies[FAMILY_NAMES_API] = familyNamesBody(SELF_NAME_AFTER_AI);
  };
  const renameViaProfileRow = () => {
    server.tables.user_profiles = [{ nickname: SELF_NAME_AFTER_AI }];
  };
  const RENAMES: { page: string; rename: () => void }[] = [
    { page: '/family/members', rename: renameViaNamesApi },
    { page: '/family/dashboard', rename: renameViaNamesApi },
    { page: '/family/members/[id]', rename: renameViaNamesApi },
    { page: '/family/transfer-accept/[proposal_id]', rename: renameViaProfileRow },
    { page: '/org/transfer-accept/[proposal_id]', rename: renameViaProfileRow },
  ];
  for (const { page, rename } of RENAMES) {
    it(`${page}: 開いたまま AI 相談で自分の名前を変えると、新しい名前を出す`, async () => {
      const c = caseOf(page);
      setServer(c.full);
      await mount(c);
      expect(container.textContent).toContain(SELF_NAME);

      rename();
      await notifyAiConsultationSucceeded();
      expect(container.textContent).toContain(SELF_NAME_AFTER_AI);
      expect(container.textContent).not.toContain(SELF_NAME);
    });
  }

  it('/family/members: 名前が無くなった取り直しは「名前未設定」を出す (前の名前を残さない)', async () => {
    const c = caseOf('/family/members');
    setServer(c.full);
    await mount(c);
    server.fetchBodies[FAMILY_NAMES_API] = familyNamesBody(null);
    await notifyAiConsultationSucceeded();
    expect(container.textContent).toContain(NO_NAME);
    expect(container.textContent).not.toContain(SELF_NAME);
  });
});

describe('基準値を性別で選ぶ血液検査・健康診断の詳細は、AI 相談で変えた性別で出し直す (#2195 V1 R3)', () => {
  for (const page of ['/health/blood-tests', '/health/checkups/[id]']) {
    it(`${page}: 開いたまま AI 相談で性別を設定すると、「性別未設定」の注記が消える`, async () => {
      const c = caseOf(page);
      setServer(c.empty);
      await mount(c);
      expect(container.textContent).toContain(SEX_UNSET_NOTE);

      // AI 相談の update_profile_preferences (gender)
      server.fetchBodies['/api/profile'] = { gender: 'female' };
      await notifyAiConsultationSucceeded();
      expect(container.textContent).not.toContain(SEX_UNSET_NOTE);
    });
  }
});

/** 外から解ける Promise (応答を止めておくのに使う) */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 文字がちょうど text のボタン */
function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`「${text}」のボタンが無い`);
  return button;
}

interface WriteGuardCase {
  name: string;
  /** 開く画面 (中身のある応答で開く。書き込みは失敗の応答 (404) を返し、ボタンは残る) */
  page: PageCase;
  /** 書き込みを送るボタン */
  writeButton: () => HTMLButtonElement;
  /** 書き込みの fetch ('<メソッド> <道>') */
  writeRequest: string;
  /** 取り直しが必ず読むもの (読み取りの鍵) */
  refetchRead: string;
  /** 取り直しの応答を、hold が解けるまで止める */
  holdRefetch: (hold: Promise<void>) => void;
}

/**
 * 書き込みと AI 相談の成功の取り直しを重ねない:
 *   1. 書き込みを始めた直後 (ボタンが止まる再描画の前) に AI 相談が成功しても取り直さない
 *   2. 書き込みが済んだら、止めた成功のぶん 1 回取り直す (#2201 U2)。そのあとの成功でも取り直す
 *   3. 取り直しを始めた直後 (再描画の前) に押しても書き込みを送らず、取り直しの応答を待つあいだはボタンを止める
 *   4. 取り直しが済んだあとは書き込みを送れる
 */
async function checkWriteAndRefetchDoNotOverlap(w: WriteGuardCase) {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('alert', vi.fn());
  setServer(w.page.full);
  await mount(w.page);

  const write = deferred();
  server.fetchHolds.set(w.writeRequest, write.promise);
  recorder.take();
  await act(async () => {
    w.writeButton().click();
    dispatchAiConsultationSucceeded();
  });
  await settle();
  expect(server.requests, '書き込みを送っていない (検査が空振りしている)').toContain(w.writeRequest);
  expect([...recorder.take()], '書き込みの応答を待つあいだに取り直した').not.toContain(w.refetchRead);
  write.resolve();
  server.fetchHolds.delete(w.writeRequest);
  await settle();
  // 書き込みの間に止めた成功は、書き込みが終わったら (新しい成功を待たずに) 1 回取り直す (#2201 U2)
  expect([...recorder.take()], '書き込みの間に止めた成功を、書き込みが終わっても取り直さない').toContain(w.refetchRead);

  await notifyAiConsultationSucceeded();
  expect([...recorder.take()], '書き込みが済んだあとに取り直さない').toContain(w.refetchRead);

  const refetch = deferred();
  w.holdRefetch(refetch.promise);
  server.requests = [];
  await act(async () => {
    dispatchAiConsultationSucceeded();
    w.writeButton().click();
  });
  await settle();
  expect(server.requests, '取り直しの応答を待つあいだに書き込みを送った').not.toContain(w.writeRequest);
  expect(w.writeButton().disabled, '取り直しの応答を待つあいだに書き込みのボタンが止まっていない').toBe(true);
  refetch.resolve();
  await settle();

  expect(w.writeButton().disabled, '取り直しが済んだあとも書き込みのボタンが止まったまま').toBe(false);
  await act(async () => {
    w.writeButton().click();
  });
  await settle();
  expect(server.requests, '取り直しが済んだあとに書き込みを送れない').toContain(w.writeRequest);
}

const holdNamesApi = (hold: Promise<void>) => {
  server.fetchHolds.set(`GET ${FAMILY_NAMES_API}`, hold);
};
const holdProposal = (hold: Promise<void>) => {
  server.tableHolds.set('ownership_transfer_proposals', hold);
};
/** ほかの人 (大人) の詳細を開く (除名のボタンを出す。モックは絞り込みを見ないので、family_members はその 1 行にする) */
const OTHER_MEMBER_DETAIL_CASE: PageCase = {
  ...caseOf('/family/members/[id]'),
  render: () => {
    navigation.params = { id: OTHER_MEMBER_ID };
    return <FamilyMemberDetailPage />;
  },
  full: {
    fetchBodies: { [FAMILY_NAMES_API]: familyNamesBody(SELF_NAME) },
    tables: { ...FAMILY_TABLES, family_members: [familyMemberRow(OTHER_MEMBER_ID, OTHER_USER_ID, 'adult', OTHER_MEMBER_NAME)] },
  },
};
/** 自分あての提案を開く (承諾・拒否のボタンを出す) */
const proposalToSelfCase = (page: string, scope: 'family' | 'organization', scopeId: string): PageCase => {
  const c = caseOf(page);
  return {
    ...c,
    full: {
      ...c.full,
      tables: { ...c.full.tables, ownership_transfer_proposals: [transferProposalRow(OTHER_USER_ID, SELF_USER_ID, scope, scopeId)] },
    },
  };
};

/** 自分が大人 (代表でない) で家族に入っている (脱退のボタンを出す) */
const FAMILY_SELF_ADULT_CASE: PageCase = {
  ...caseOf('/family/members'),
  full: {
    fetchBodies: { [FAMILY_NAMES_API]: familyNamesBody(SELF_NAME) },
    tables: {
      ...FAMILY_TABLES,
      family_members: [
        familyMemberRow(SELF_MEMBER_ID, SELF_USER_ID, 'adult', null),
        familyMemberRow(OTHER_MEMBER_ID, OTHER_USER_ID, 'representative', OTHER_MEMBER_NAME),
      ],
    },
  },
};

const WRITE_GUARDS: WriteGuardCase[] = [
  {
    // #2201 U2: 以前は脱退の守りを外す変異が生き残っていた (検査が無かった)
    name: '/family/members の脱退',
    page: FAMILY_SELF_ADULT_CASE,
    writeButton: () => {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('家族グループから脱退'));
      if (!button) throw new Error('「家族グループから脱退」のボタンが無い');
      return button;
    },
    writeRequest: 'POST /api/family/leave',
    refetchRead: `GET ${FAMILY_NAMES_API}`,
    holdRefetch: holdNamesApi,
  },
  {
    name: '/family/members の除名',
    page: caseOf('/family/members'),
    writeButton: () => buttonByText('除名'),
    writeRequest: `POST /api/family/members/${OTHER_MEMBER_ID}/remove`,
    refetchRead: `GET ${FAMILY_NAMES_API}`,
    holdRefetch: holdNamesApi,
  },
  {
    name: '/family/members/[id] の共有の設定の切り替え',
    page: caseOf('/family/members/[id]'),
    writeButton: () => {
      const button = container.querySelector<HTMLButtonElement>('button[role="switch"]');
      if (!button) throw new Error('共有の設定の切り替えが無い');
      return button;
    },
    writeRequest: 'PATCH /api/family/members/me/share',
    refetchRead: `GET ${FAMILY_NAMES_API}`,
    holdRefetch: holdNamesApi,
  },
  {
    name: '/family/members/[id] の除名',
    page: OTHER_MEMBER_DETAIL_CASE,
    writeButton: () => {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('家族から外す'));
      if (!button) throw new Error('「家族から外す」のボタンが無い');
      return button;
    },
    writeRequest: `POST /api/family/members/${OTHER_MEMBER_ID}/remove`,
    refetchRead: `GET ${FAMILY_NAMES_API}`,
    holdRefetch: holdNamesApi,
  },
  {
    name: '/family/transfer-accept/[proposal_id] の承諾',
    page: proposalToSelfCase('/family/transfer-accept/[proposal_id]', 'family', FAMILY_ID),
    writeButton: () => buttonByText('承諾する (代表者になる)'),
    writeRequest: `POST /api/family/representative-transfer/${PROPOSAL_ID}/accept`,
    refetchRead: 'from:ownership_transfer_proposals',
    holdRefetch: holdProposal,
  },
  {
    name: '/family/transfer-accept/[proposal_id] の拒否',
    page: proposalToSelfCase('/family/transfer-accept/[proposal_id]', 'family', FAMILY_ID),
    writeButton: () => buttonByText('拒否する'),
    writeRequest: `POST /api/family/representative-transfer/${PROPOSAL_ID}/decline`,
    refetchRead: 'from:ownership_transfer_proposals',
    holdRefetch: holdProposal,
  },
  {
    name: '/org/transfer-accept/[proposal_id] の承諾',
    page: proposalToSelfCase('/org/transfer-accept/[proposal_id]', 'organization', ORG_ID),
    writeButton: () => buttonByText('承諾'),
    writeRequest: `POST /api/org/owner-transfer/${PROPOSAL_ID}/accept`,
    refetchRead: 'from:ownership_transfer_proposals',
    holdRefetch: holdProposal,
  },
  {
    name: '/org/transfer-accept/[proposal_id] の拒否',
    page: proposalToSelfCase('/org/transfer-accept/[proposal_id]', 'organization', ORG_ID),
    writeButton: () => buttonByText('拒否'),
    writeRequest: `POST /api/org/owner-transfer/${PROPOSAL_ID}/decline`,
    refetchRead: 'from:ownership_transfer_proposals',
    holdRefetch: holdProposal,
  },
];

describe('書き込みのある受け手は、書き込みと AI 相談の成功の取り直しを重ねない (#2195 V1)', () => {
  for (const w of WRITE_GUARDS) {
    it(w.name, async () => {
      await checkWriteAndRefetchDoNotOverlap(w);
    });
  }
});

describe('除外の alwaysBlockedWhileShown のページは、AI が書く値を出している間、取り直しの番兵が止める (#2195 V1)', () => {
  it('/family/representative-transfer: 候補の名前 (名前の API が当てたプロフィールの名前) を出している間、候補の選択と理由の入力欄が番兵を止める', async () => {
    const CANDIDATE_PROFILE_NAME = 'じろうさん';
    // 自分は代表。候補 (大人) は display_name が無く、名前の API がプロフィールの名前を当てる
    // (モックは .neq('user_id', 自分) を見ないので、候補の一覧に自分の行も出る。検査には関係しない)
    setServer({
      fetchBodies: { [FAMILY_NAMES_API]: { data: { members: [{ id: OTHER_MEMBER_ID, name: CANDIDATE_PROFILE_NAME }] } } },
      tables: {
        ...FAMILY_TABLES,
        family_members: [
          familyMemberRow(SELF_MEMBER_ID, SELF_USER_ID, 'representative', null),
          familyMemberRow(OTHER_MEMBER_ID, OTHER_USER_ID, 'adult', null),
        ],
      },
    });
    await act(async () => {
      root.render(<RepresentativeTransferPage />);
    });
    await settle();
    expectRefetchAlwaysBlockedWhileShown('/family/representative-transfer', document, container, CANDIDATE_PROFILE_NAME);
  });

  it('見分けの空振りを防ぐ: 入力の部品の無い画面では番兵が止めない', async () => {
    const c = caseOf('/family/dashboard');
    setServer(c.full);
    await mount(c);
    expect(container.textContent).toContain(SELF_NAME);
    expect(isAiConsultationRefetchBlocked(document)).toBe(false);
  });
});

// ─── #2201 U1 + U2 ───────────────────────────────────────────────

describe('取り直しの失敗では今の表示を残す (#2201 U1)', () => {
  const FAILURES = ['http', 'network'] as const;
  for (const c of CASES) {
    for (const failure of FAILURES) {
      it(`${c.page}: ${failure === 'http' ? '500・Supabase の error' : '通信の失敗 (fetch の reject)'}`, async () => {
        setServer(c.full);
        await mount(c);
        const shown = screenSignature(container);

        server.failure = failure;
        await notifyAiConsultationSucceeded();
        expect(screenSignature(container), `${c.page} の取り直しの失敗で、出ていた表示が変わった`).toBe(shown);

        // 失敗のあとも受け手は止まっていない: 次の成功で読み直せる
        server.failure = null;
        setServer(c.empty);
        await notifyAiConsultationSucceeded();
        await remount(c);
        const freshEmpty = screenSignature(container);
        expect(freshEmpty, `${c.page} の空の応答が中身のある応答と同じ画面 (検査が空振りしている)`).not.toBe(shown);
      });
    }
  }
});

describe('取り直しの応答を待つあいだも、画面全体を読み込み中の表示に置き換えない (#2201 U1)', () => {
  for (const c of CASES) {
    it(`${c.page}`, async () => {
      setServer(c.full);
      await mount(c);
      const shown = screenSignature(container);

      const hold = deferred();
      server.holdAll = hold.promise;
      await act(async () => {
        dispatchAiConsultationSucceeded();
      });
      await settle();
      expect(screenSignature(container), `${c.page} の取り直しの応答を待つあいだに表示が変わった (読み込み中の表示に置き換えた)`).toBe(shown);

      server.holdAll = null;
      hold.resolve();
      await settle();
      expect(screenSignature(container)).toBe(shown);
    });
  }
});

describe('先に始めた取り直しの応答が後から届いても、あとの取り直しの表示を上書きしない (#2201 U1)', () => {
  for (const c of CASES) {
    it(`${c.page}`, async () => {
      setServer(c.full);
      await mount(c);
      const shown = screenSignature(container);

      // 1 回目の取り直しは空の答え (AI 相談の前の古い答え) を読み、応答が遅れる
      setServer(c.empty);
      const slow = deferred();
      server.holdAll = slow.promise;
      await act(async () => {
        dispatchAiConsultationSucceeded();
      });
      // 2 回目の取り直しは中身のある答え (新しい答え) を読み、先に届く
      server.holdAll = null;
      setServer(c.full);
      await act(async () => {
        dispatchAiConsultationSucceeded();
      });
      await settle();

      slow.resolve();
      await settle();
      expect(screenSignature(container), `${c.page} の古い取り直しの応答が、新しい取り直しの表示を上書きした`).toBe(shown);
    });
  }
});

describe('名前の API だけを読めなかった取り直しは、出ている名前を残す (#2201 U1)', () => {
  for (const page of ['/family/members', '/family/dashboard', '/family/members/[id]']) {
    it(`${page}: 「名前未設定」に落とさない`, async () => {
      const c = caseOf(page);
      setServer(c.full);
      await mount(c);
      expect(container.textContent).toContain(SELF_NAME);

      server.failedRequests.add(`GET ${FAMILY_NAMES_API}`);
      await notifyAiConsultationSucceeded();
      expect(server.requests, '名前の API を読み直していない (検査が空振りしている)').toContain(`GET ${FAMILY_NAMES_API}`);
      expect(container.textContent).toContain(SELF_NAME);
      expect(container.textContent).not.toContain(NO_NAME);
    });
  }

  it('/family/members: 開いたときに名前の API を読めなければ、これまでどおり display_name のまま (「名前未設定」)', async () => {
    const c = caseOf('/family/members');
    setServer(c.full);
    server.failedRequests.add(`GET ${FAMILY_NAMES_API}`);
    await mount(c);
    expect(container.textContent).toContain(NO_NAME);
  });
});

interface DeferredWriteCase {
  name: string;
  page: PageCase;
  /** 書き込みを始める (ボタンを押す。確認のモーダルがあれば確かめるところまで) */
  startWrite: () => Promise<void>;
  /** 書き込みの fetch ('<メソッド> <道>') */
  writeRequest: string;
  /** 取り直しが必ず読むもの (読み取りの鍵) */
  refetchRead: string;
}

/** aria-label がちょうど label のボタン */
function buttonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`aria-label が「${label}」のボタンが無い`);
  return button;
}

/**
 * 楽観的な更新 / 書き込みの応答を待つあいだに来た AI 相談の成功では取り直さず (書き込みの前の値を読んだ応答で表示を戻さない)、
 * 書き込みが終わったら、新しい成功を待たずに 1 回取り直す (#2201 U2)
 */
async function checkRefetchDeferredUntilWriteSettles(w: DeferredWriteCase) {
  vi.stubGlobal('alert', vi.fn());
  setServer(w.page.full);
  await mount(w.page);

  const write = deferred();
  server.fetchHolds.set(w.writeRequest, write.promise);
  await w.startWrite();
  await settle();
  expect(server.requests, '書き込みを送っていない (検査が空振りしている)').toContain(w.writeRequest);
  recorder.take();

  await notifyAiConsultationSucceeded();
  await notifyAiConsultationSucceeded();
  expect([...recorder.take()], '書き込みの応答を待つあいだに取り直した').not.toContain(w.refetchRead);

  server.requests = [];
  write.resolve();
  server.fetchHolds.delete(w.writeRequest);
  await settle();
  expect([...recorder.take()], '書き込みが終わっても、止めた成功を取り直さない').toContain(w.refetchRead);
  // 止めている間に 2 回来ても、取り直しは 1 回
  const refetchRequest = w.refetchRead.split('?')[0];
  expect(server.requests.filter((r) => r === refetchRequest), '止めた成功の取り直しが 1 回でない').toHaveLength(1);
}

const DEFERRED_WRITES: DeferredWriteCase[] = [
  {
    name: '/pantry の食材の削除',
    page: caseOf('/pantry'),
    startWrite: async () => {
      await act(async () => {
        buttonByLabel('削除').click();
      });
    },
    writeRequest: 'DELETE /api/pantry/p-1',
    refetchRead: 'GET /api/pantry',
  },
  {
    name: '/health/goals の目標の削除',
    page: caseOf('/health/goals'),
    startWrite: async () => {
      await act(async () => {
        buttonByLabel('目標を削除').click();
      });
      await act(async () => {
        buttonByText('削除する').click();
      });
    },
    writeRequest: `DELETE /api/health/goals/${WEIGHT_GOAL.id}`,
    refetchRead: 'GET /api/health/goals?status=all',
  },
  {
    name: '/meals/[id] の完了の切り替え (楽観的な更新)',
    page: caseOf('/meals/[id]'),
    startWrite: async () => {
      await act(async () => {
        buttonByText('完了済み（タップで取り消し）').click();
      });
    },
    writeRequest: `PATCH /api/meals/${MEAL_ID}`,
    refetchRead: `GET /api/meals/${MEAL_ID}`,
  },
];

describe('書き込みの間に来た AI 相談の成功は、書き込みが終わったら 1 回取り直す (#2201 U2)', () => {
  for (const w of DEFERRED_WRITES) {
    it(w.name, async () => {
      await checkRefetchDeferredUntilWriteSettles(w);
    });
  }

  it('/meals/[id]: 完了の切り替えの応答を待つあいだに成功が来ても、楽観的な表示を書き込みの前の値に戻さない', async () => {
    const c = caseOf('/meals/[id]');
    setServer(c.full);
    await mount(c);
    const write = deferred();
    server.fetchHolds.set(`PATCH /api/meals/${MEAL_ID}`, write.promise);
    await act(async () => {
      buttonByText('完了済み（タップで取り消し）').click();
    });
    expect(container.textContent).toContain('食べた！');

    // 取り直しが書き込みの前の値 (完了済み) を読んでも、楽観的な表示 (未完了) を戻さない
    await notifyAiConsultationSucceeded();
    expect(container.textContent).toContain('食べた！');
    write.resolve();
    server.fetchHolds.delete(`PATCH /api/meals/${MEAL_ID}`);
    await settle();
  });
});

describe('/profile: 取り直しの応答を待つあいだに開いた編集の入力を、届いた応答で上書きしない (#2201 U1)', () => {
  it('取り直しの途中で編集を開いて打った名前が残る', async () => {
    const TYPED_NICKNAME = 'ほり (打ちかけ)';
    const c = caseOf('/profile');
    setServer(c.full);
    await mount(c);

    // 取り直しのプロフィールの応答を止め、その間に AI 相談の名前が届く
    const profileRead = deferred();
    server.tableHolds.set('user_profiles', profileRead.promise);
    await act(async () => {
      dispatchAiConsultationSucceeded();
    });
    await settle();
    server.tables.user_profiles = [{ ...PROFILE_ROW, nickname: SELF_NAME_AFTER_AI }];

    // 応答を待つあいだに編集を開いて名前を打つ
    const editBasic = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('基本情報'));
    if (!editBasic) throw new Error('「基本情報」のボタンが無い');
    await act(async () => {
      editBasic.click();
    });
    const nicknameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: たろう"]');
    expect(nicknameInput(), '編集のモーダルが開かない').not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(nicknameInput()!, TYPED_NICKNAME);
      nicknameInput()!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    profileRead.resolve();
    server.tableHolds.delete('user_profiles');
    await settle();
    expect(nicknameInput()!.value, '取り直しの応答が打ちかけの名前を上書きした').toBe(TYPED_NICKNAME);
  });
});

describe('/health: 日を選び直したら、前に選んだ日の記録をパネルに置かない (#2201 U1)', () => {
  it('先に選んだ日の応答が後から届いても、あとで選んだ日の記録を出す', async () => {
    const FIRST_DAY_WEIGHT = 61.5;
    const SECOND_DAY_WEIGHT = 62.5;
    const c = caseOf('/health');
    setServer(c.full);
    await mount({ ...c, openPanels: undefined });
    const [firstDay, secondDay] = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="false"]')];
    if (!firstDay || !secondDay) throw new Error('今日でない日のボタンが 2 つ無い');

    const firstRead = deferred();
    server.holdAll = firstRead.promise;
    server.fetchBodies['/api/health/records/*'] = { record: HEALTH_RECORD('2026-01-01', FIRST_DAY_WEIGHT), previous: null };
    await act(async () => {
      firstDay.click();
    });
    server.holdAll = null;
    server.fetchBodies['/api/health/records/*'] = { record: HEALTH_RECORD('2026-01-02', SECOND_DAY_WEIGHT), previous: null };
    await act(async () => {
      secondDay.click();
    });
    await settle();
    expect(container.textContent).toContain(String(SECOND_DAY_WEIGHT));

    firstRead.resolve();
    await settle();
    expect(container.textContent).toContain(String(SECOND_DAY_WEIGHT));
    expect(container.textContent).not.toContain(String(FIRST_DAY_WEIGHT));
  });
});
