/**
 * #2245 K2 ホーム (/home・useHomeData) を JST の 0 時をまたいで開いたままにしたときの「今日」の回帰テスト。
 *
 * 問題 (直す前):
 *   - useHomeData の今日 (todayStr) は描画ごとの値で、ログインの状態の変化の購読 (useEffect([])) は最初の描画の fetchHomeData を
 *     呼んでいた。0 時をまたいで開いたままにすると、SIGNED_OUT・USER_UPDATED・別の利用者の SIGNED_IN の読み直しが前の日
 *     (最初の描画の今日) の献立・記録・チェックインを読んだ (描き直したあとでも、購読は最初の描画の閉包のまま)
 *   - AI 相談の成功の取り直し・チェックインの保存・今日の気分の保存も、最後の描画の今日 (描き直しが無ければ前の日) で読み書きした
 *   - ホームの見出しの日付は開いたときに 1 回だけ決めていたので、読み直しが新しい今日を読んでも前の日のまま
 *
 * 直したあと:
 *   - 読み取り (readHomeData)・チェックイン・今日の気分の保存は、始めに todayLocal() を 1 回だけ読み、その中では同じ今日を使う
 *   - 購読は ref 経由で最新の fetchHomeData を呼ぶ
 *   - ホームの見出しの日付は、今日の献立を置いた読み取りの今日 (useHomeData の today) に合わせる
 *
 * 時計は JST 2026-11-04 (水) 23:59 から始め、0 時をまたいだ 2026-11-05 (木) 00:01 へ vi.setSystemTime で進める。
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** モックの Supabase がログイン済みとして返す利用者 */
const MOCK_AUTH_USER_ID = vi.hoisted(() => 'user-2245-k2');

/**
 * Supabase のモック。どの表も空の答え (エラーなし) を返す。問い合わせごとに、表・絞り込み (eq / lte / gte) の引数・書き込み
 * (upsert) の値を queries に記録する。authStateListener はホームが onAuthStateChange に渡した関数
 */
const supabaseMock = vi.hoisted(() => ({
  queries: [] as { table: string; filters: { method: string; args: unknown[] }[]; upserts: unknown[] }[],
  authStateListener: null as null | ((event: string, session?: { user: { id: string } } | null) => void),
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  /** 記録する絞り込み・書き込みのメソッド */
  const FILTER_METHODS: ReadonlySet<PropertyKey> = new Set(['eq', 'lte', 'gte', 'lt', 'gt']);
  const query = (record: { table: string; filters: { method: string; args: unknown[] }[]; upserts: unknown[] }): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(EMPTY_RESULT);
        return (...args: unknown[]) => {
          if (FILTER_METHODS.has(prop)) record.filters.push({ method: String(prop), args });
          if (prop === 'upsert') record.upserts.push(args[0]);
          return query(record);
        };
      },
    });
  const user = { id: MOCK_AUTH_USER_ID, user_metadata: {} };
  return {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user } }, error: null }),
        getUser: async () => ({ data: { user }, error: null }),
        refreshSession: async () => ({ data: { session: { user } }, error: null }),
        onAuthStateChange: (listener: (event: string, session?: { user: { id: string } } | null) => void) => {
          supabaseMock.authStateListener = listener;
          return { data: { subscription: { unsubscribe: () => undefined } } };
        },
      },
      from: (table: string) => {
        const record = { table, filters: [] as { method: string; args: unknown[] }[], upserts: [] as unknown[] };
        supabaseMock.queries.push(record);
        return query(record);
      },
      rpc: () => query({ table: 'rpc', filters: [], upserts: [] }),
      channel: () => {
        const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
        return channel;
      },
      removeChannel: async () => 'ok',
    }),
  };
});

// ホームのページ (HomePage) を描くための部品のモック (tests/ai-consultation-home-refetch-2195.test.tsx と同じ)
vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
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

const { useHomeData } = await import('@/hooks/useHomeData');
const { default: HomePage } = await import('@/app/(main)/home/page');
const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 取得の連鎖 (Promise.all の中の問い合わせ・setState) を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
const NOT_FOUND_STATUS = 404;

/** 開いたときの時計 (JST 2026-11-04 (水) 23:59:00) と、その日 */
const BEFORE_MIDNIGHT = '2026-11-04T14:59:00.000Z';
const DAY_BEFORE = '2026-11-04';
/** 0 時をまたいだあとの時計 (JST 2026-11-05 (木) 00:01:00) と、その日 */
const AFTER_MIDNIGHT = '2026-11-04T15:01:00.000Z';
const DAY_AFTER = '2026-11-05';
/** ホームの見出しの日付 (Asia/Tokyo の ja-JP の long の書き方) */
const DAY_BEFORE_LABEL = '2026年11月4日水曜日';
const DAY_AFTER_LABEL = '2026年11月5日木曜日';

/** 今日で絞る表と列 (読み取りの今日 1 つで読む。useHomeData の readHomeData・fetchHealthSummary・fetchPerformanceAnalysis) */
const TODAY_EQ_COLUMNS: readonly { table: string; column: string }[] = [
  { table: 'daily_activity_logs', column: 'date' },
  { table: 'user_daily_meals', column: 'day_date' },
  { table: 'health_records', column: 'record_date' },
  { table: 'user_performance_checkins', column: 'checkin_date' },
];
/** パフォーマンスの分析の API (今日を date で渡す) */
const PERFORMANCE_ANALYZE_PATH = '/api/performance/analyze';
/** チェックインの睡眠の同期の API (今日を record_date で渡す) */
const HEALTH_QUICK_PATH = '/api/health/records/quick';

let fetchCalls: { url: string; body: unknown }[];
let container: HTMLDivElement;
let root: Root;
/** プローブが描くたびに useHomeData の戻り値を写す (操作を呼ぶ・today を見る) */
let latestHome: ReturnType<typeof useHomeData> | null;
/** プローブの描画の数 (描き直しが起きたかを確かめる) */
let probeRenders: number;

function HomeDataProbe() {
  latestHome = useHomeData();
  probeRenders += 1;
  return <p data-testid="home-today">{latestHome.today ?? ''}</p>;
}

/** 時計 (Date だけ) を at から実時間で進める */
function startClock(at: string) {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: new Date(at) });
}

beforeEach(() => {
  supabaseMock.queries = [];
  supabaseMock.authStateListener = null;
  latestHome = null;
  probeRenders = 0;
  fetchCalls = [];
  startClock(BEFORE_MIDNIGHT);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      fetchCalls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
    }),
  );
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
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** queries の from 番目から後の、表 table の列 column の eq の値 (重ねずに) */
function eqValuesSince(from: number, table: string, column: string): string[] {
  const values = new Set<string>();
  for (const q of supabaseMock.queries.slice(from)) {
    if (q.table !== table) continue;
    for (const f of q.filters) if (f.method === 'eq' && f.args[0] === column) values.add(String(f.args[1]));
  }
  return [...values];
}

/** fetchCalls の from 番目から後の、パフォーマンスの分析の API の date の値 */
function analyzeDatesSince(from: number): string[] {
  return fetchCalls
    .slice(from)
    .map((c) => new URL(c.url, 'http://localhost'))
    .filter((u) => u.pathname === PERFORMANCE_ANALYZE_PATH)
    .map((u) => u.searchParams.get('date') ?? '');
}

/** 今日で絞る全部の表・列と分析の API が、from 番目から後でどれも day だけを読んだこと */
function expectReadAllOn(fromQuery: number, fromFetch: number, day: string, when: string) {
  for (const { table, column } of TODAY_EQ_COLUMNS) {
    expect(eqValuesSince(fromQuery, table, column), `${when}: ${table}.${column} を ${day} で読んでいない`).toEqual([day]);
  }
  expect(analyzeDatesSince(fromFetch), `${when}: パフォーマンスの分析を ${day} で読んでいない`).toEqual([day]);
}

async function renderProbe() {
  await act(async () => {
    root.render(<HomeDataProbe />);
  });
  await settle();
}

/** 0 時をまたいだ時刻へ時計を進める (描き直しは起こさない) */
function crossMidnight() {
  vi.setSystemTime(new Date(AFTER_MIDNIGHT));
}

describe('ホームの読み直しは、0 時をまたいだら新しい今日を読む (#2245 K2)', () => {
  it('開いたときは開いた日を読む (検査の前提)', async () => {
    await renderProbe();
    expectReadAllOn(0, 0, DAY_BEFORE, '開いたとき');
    expect(latestHome?.today).toBe(DAY_BEFORE);
  });

  it('0 時をまたいだあとのログインの状態の変化 (USER_UPDATED) の読み直しは、新しい今日を読む (描き直しが無くても)', async () => {
    await renderProbe();
    crossMidnight();
    const fromQuery = supabaseMock.queries.length;
    const fromFetch = fetchCalls.length;
    expect(supabaseMock.authStateListener, 'ログインの状態の変化を受け取る関数が無い (検査の前提が崩れた)').not.toBeNull();
    await act(async () => {
      supabaseMock.authStateListener!('USER_UPDATED');
    });
    await settle();
    expectReadAllOn(fromQuery, fromFetch, DAY_AFTER, 'USER_UPDATED の読み直し');
    expect(latestHome?.today, '読み直しの今日を返していない').toBe(DAY_AFTER);
  });

  it('0 時をまたいで描き直したあとのログインの状態の変化も、最初の描画の今日でなく新しい今日を読む (購読は最新の fetchHomeData を呼ぶ)', async () => {
    await renderProbe();
    crossMidnight();
    // 描き直す (親が描き直した。描画ごとの値は新しい今日になる)
    const rendersBefore = probeRenders;
    await act(async () => {
      root.render(<HomeDataProbe />);
    });
    expect(probeRenders, '描き直していない (検査の前提が崩れた)').toBeGreaterThan(rendersBefore);
    const fromQuery = supabaseMock.queries.length;
    const fromFetch = fetchCalls.length;
    await act(async () => {
      supabaseMock.authStateListener!('SIGNED_OUT');
    });
    await settle();
    // SIGNED_OUT の読み直しでも、モックはログインしたまま (読み直しが今日で絞るのを確かめる)
    expectReadAllOn(fromQuery, fromFetch, DAY_AFTER, '描き直したあとの SIGNED_OUT の読み直し');
  });

  it('0 時をまたいだあとの AI 相談の成功の取り直しは、新しい今日を読む (描き直しが無くても)', async () => {
    await renderProbe();
    crossMidnight();
    const fromQuery = supabaseMock.queries.length;
    const fromFetch = fetchCalls.length;
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
    });
    await settle();
    expectReadAllOn(fromQuery, fromFetch, DAY_AFTER, '取り直し');
  });

  it('1 回の読み取りの途中で 0 時をまたいでも、その読み取りは始めに読んだ今日 1 つで読む', async () => {
    await renderProbe();
    const fromQuery = supabaseMock.queries.length;
    const fromFetch = fetchCalls.length;
    // 読み取りが最初の表 (user_profiles) を読んだら、時計を 0 時の後へ進める (読み取りの途中で日付が変わる)
    const originalFrom = supabaseMock.queries.push.bind(supabaseMock.queries);
    let crossed = false;
    supabaseMock.queries.push = (...items) => {
      const length = originalFrom(...items);
      if (!crossed && items.some((q) => q.table === 'user_profiles')) {
        crossed = true;
        crossMidnight();
      }
      return length;
    };
    try {
      await act(async () => {
        supabaseMock.authStateListener!('USER_UPDATED');
      });
      await settle();
    } finally {
      supabaseMock.queries.push = originalFrom;
    }
    expect(crossed, '読み取りの途中で時計を進められていない (検査が空振りしている)').toBe(true);
    expectReadAllOn(fromQuery, fromFetch, DAY_BEFORE, '途中で 0 時をまたいだ読み取り');
    expect(latestHome?.today).toBe(DAY_BEFORE);
  });
});

describe('ホームの書き込みは、押したときの今日を 1 回だけ読む (#2245 K2)', () => {
  it('0 時をまたいだあとのチェックインの保存は、新しい今日に保存し、健康記録への同期・保存のあとの分析も同じ今日で行う', async () => {
    await renderProbe();
    crossMidnight();
    const fromQuery = supabaseMock.queries.length;
    const fromFetch = fetchCalls.length;
    await act(async () => {
      await latestHome!.submitPerformanceCheckin({ sleepHours: 7 });
    });
    await settle();
    const checkinUpserts = supabaseMock.queries
      .slice(fromQuery)
      .filter((q) => q.table === 'user_performance_checkins')
      .flatMap((q) => q.upserts) as { checkin_date?: string }[];
    expect(checkinUpserts.map((u) => u.checkin_date), 'チェックインを新しい今日に保存していない').toEqual([DAY_AFTER]);
    const quickBodies = fetchCalls.slice(fromFetch).filter((c) => c.url === HEALTH_QUICK_PATH).map((c) => (c.body as { record_date?: string }).record_date);
    expect(quickBodies, '健康記録への同期を新しい今日で送っていない').toEqual([DAY_AFTER]);
    expect(analyzeDatesSince(fromFetch), '保存のあとの分析を新しい今日で読んでいない').toEqual([DAY_AFTER]);
  });

  it('0 時をまたいだあとの今日の気分の保存は、新しい今日に保存する', async () => {
    await renderProbe();
    expect(latestHome?.user, 'ログインした人を置いていない (検査の前提が崩れた)').not.toBeNull();
    crossMidnight();
    const fromQuery = supabaseMock.queries.length;
    await act(async () => {
      await latestHome!.updateActivityLevel('active');
    });
    const activityUpserts = supabaseMock.queries
      .slice(fromQuery)
      .filter((q) => q.table === 'daily_activity_logs')
      .flatMap((q) => q.upserts) as { date?: string }[];
    expect(activityUpserts.map((u) => u.date), '今日の気分を新しい今日に保存していない').toEqual([DAY_AFTER]);
  });
});

describe('ホームの見出しの日付は、読み取りの今日に合わせる (#2245 K2)', () => {
  const headingText = () => container.textContent ?? '';

  it('0 時をまたいだあとの読み直しが新しい今日を読んだら、見出しの日付も新しい今日になる', async () => {
    await act(async () => {
      root.render(<HomePage />);
    });
    await settle();
    expect(headingText(), '開いたときの見出しの日付が開いた日でない (検査の前提が崩れた)').toContain(DAY_BEFORE_LABEL);

    crossMidnight();
    await act(async () => {
      supabaseMock.authStateListener!('USER_UPDATED');
    });
    await settle();
    expect(headingText(), '見出しの日付が読み直しの今日になっていない').toContain(DAY_AFTER_LABEL);
    expect(headingText(), '見出しに前の日の日付が残っている').not.toContain(DAY_BEFORE_LABEL);
  });
});
