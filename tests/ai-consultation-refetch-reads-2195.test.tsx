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
 * 「空の応答」は、AI が書く表から読む応答を空にしたもの (AI が書かない表の応答は中身のあるままにする)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReadRecorder,
  expectEmptyRefetchMatchesFreshMount,
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
}));

const navigation = vi.hoisted(() => ({
  router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
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
  /** どのメソッドを呼んでも自分を返し、await するとその表の行 (single / maybeSingle なら最初の 1 行) になる問い合わせ */
  const query = (table: string, single: boolean, recordsSelect: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          const rows = server.tables[table] ?? [];
          const data = single ? (rows[0] ?? null) : rows;
          return (resolve: (value: unknown) => void) => resolve({ data, error: null, count: rows.length });
        }
        return (...args: unknown[]) => {
          if (prop === 'select' && recordsSelect) server.reads?.recordSelect(table, args[0]);
          return query(table, single || prop === 'single' || prop === 'maybeSingle', recordsSelect);
        };
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
      from: (table: string) => query(table, false, true),
      rpc: (name: string) => {
        server.reads?.record(`rpc:${name}`);
        return query(`rpc:${name}`, false, false);
      },
      channel: () => channel,
      removeChannel: async () => 'ok',
    }),
  };
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 30;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
const PATH_WILDCARD = '*';

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
      const exact = server.fetchBodies[`${url.pathname}${url.search}`] ?? server.fetchBodies[url.pathname];
      const pattern = Object.keys(server.fetchBodies).find((key) => key.includes(PATH_WILDCARD) && pathMatches(key, url.pathname));
      const body = exact ?? (pattern === undefined ? undefined : server.fetchBodies[pattern]);
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

/** AI 相談の成功を知らせる (AIChatBubble と同じ形) */
async function notifyAiConsultationSucceeded() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
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
  await notifyAiConsultationSucceeded();
  const refetchReads = recorder.take();
  expectRefetchReadsCoverMount(c.page, mountReads, refetchReads);
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
        },
        '/api/profile': { servings_config: null },
      },
    },
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
];

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

