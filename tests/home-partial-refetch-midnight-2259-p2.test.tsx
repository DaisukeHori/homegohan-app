/**
 * #2259 P2 ホーム (/home) の期限までの日数と週の棒の今日の印を、0 時をまたいだ取り直しで期限の近い食材 (または週の集計) の
 * 読み取りだけが失敗したときの回帰テスト (#2254 M2 の逆の順。M2 の順は tests/home-partial-refetch-midnight-2254-m2.test.tsx)。
 *
 * 問題 (直す前): 期限までの日数は食材を置いた読み取りの今日 (expiringItemsToday) から、週の棒の今日の印は週の集計を置いた読み取りの
 *   今日 (weeklyStatsToday) から求めていた (#2254 M2)。それぞれの値は読み取りが成功して置けたときだけ新しい日になるので、0 時をまたいだ
 *   取り直しで今日の献立は読めたが食材 (週の集計) を読めなかったとき、見出しは新しい日なのに、期限までの日数を前の日から数えて 1 日多く
 *   出し (本当は『あと2日』が『あと3日』)、週の棒の最後 (前の日) に今日の印を付けた
 * 直したあと: 期限までの日数は食材を読んだ今日と見出しの今日の遅い方から数える。週の棒は、週の集計を読んだ今日が見出しの今日より前なら
 *   今日の印を付けない (前の日で終わる 7 日に今日の棒は無い)
 *
 * 時計は JST 2026-11-04 (水) 23:59 から始め、0 時をまたいだ 2026-11-05 (木) 00:01 へ vi.setSystemTime で進める。
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** モックの Supabase がログイン済みとして返す利用者 */
const MOCK_AUTH_USER_ID = vi.hoisted(() => 'user-2259-p2');

/**
 * Supabase のモック。問い合わせの答えは await された時点で決める (respond)。週の集計の読み取り (user_daily_meals を day_date の
 * order (向きの指定なし) で読む) は failWeeklyStats の間だけ、期限の近い食材 (pantry_items) の読み取りは failPantry の間だけエラーを返す。
 * 今日の献立 (user_daily_meals を day_date の eq で 1 日だけ読む) は空、ほかの日ごとの行の一覧は空の一覧。期限の近い食材は pantryRows を返す。
 * ほかの表は空
 */
const supabaseMock = vi.hoisted(() => ({
  failWeeklyStats: false,
  failPantry: false,
  pantryRows: [] as Record<string, unknown>[],
  authStateListener: null as null | ((event: string, session?: { user: { id: string } } | null) => void),
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  const READ_ERROR = { data: null, error: { message: '読み取りの失敗 (検査の置き換え)' }, count: 0 };
  type Filter = { method: string; args: unknown[] };
  /** 献立の日ごとの行の一覧 (週の集計・連続自炊・月の集計が読む) は空の一覧 (週の集計は 7 日を 0 件で置く) */
  const EMPTY_LIST_RESULT = { data: [], error: null, count: 0 };
  const respond = (table: string, filters: Filter[]) => {
    if (table === 'user_daily_meals') {
      const readsOneDay = filters.some((f) => f.method === 'eq' && f.args[0] === 'day_date');
      if (readsOneDay) return EMPTY_RESULT;
      // 週の集計は day_date の古い順 (向きの指定なし) で読む (連続自炊は新しい順の指定つき、月の集計は並べない)
      const readsWeeklyStats = filters.some((f) => f.method === 'order' && f.args[0] === 'day_date' && f.args.length === 1);
      return readsWeeklyStats && supabaseMock.failWeeklyStats ? READ_ERROR : EMPTY_LIST_RESULT;
    }
    if (table === 'pantry_items') {
      if (supabaseMock.failPantry) return READ_ERROR;
      return { data: supabaseMock.pantryRows, error: null, count: supabaseMock.pantryRows.length };
    }
    return EMPTY_RESULT;
  };
  const query = (table: string, filters: Filter[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(respond(table, filters));
        return (...args: unknown[]) => {
          filters.push({ method: String(prop), args });
          return query(table, filters);
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
      from: (table: string) => query(table, []),
      rpc: () => query('rpc', []),
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

const { default: HomePage } = await import('@/app/(main)/home/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 取得の連鎖 (Promise.all の中の問い合わせ・setState) を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
const NOT_FOUND_STATUS = 404;

/** 開いたときの時計 (JST 2026-11-04 (水) 23:59:00) */
const BEFORE_MIDNIGHT = '2026-11-04T14:59:00.000Z';
/** 0 時をまたいだあとの時計 (JST 2026-11-05 (木) 00:01:00) */
const AFTER_MIDNIGHT = '2026-11-04T15:01:00.000Z';
/** ホームの見出しの日付 (Asia/Tokyo の ja-JP の long の書き方) */
const DAY_BEFORE_LABEL = '2026年11月4日水曜日';
const DAY_AFTER_LABEL = '2026年11月5日木曜日';
/** 週の棒の曜日 (開いた日 = 水・0 時をまたいだ日 = 木) */
const DAY_BEFORE_WEEKDAY = '水';
const DAY_AFTER_WEEKDAY = '木';
/** 期限の近い食材 (期限 2026-11-07。開いた日からは 3 日、0 時をまたいだ日からは 2 日) */
const PANTRY_ITEM_NAME = '豆腐';
const PANTRY_EXPIRATION = '2026-11-07';
const DAYS_LEFT_FROM_DAY_BEFORE = 'あと3日';
const DAYS_LEFT_FROM_DAY_AFTER = 'あと2日';
/** 週の棒の曜日の文字の今日の印 (src/app/(main)/home/page.tsx の棒の下の曜日) */
const TODAY_BAR_CLASS = 'text-green-600';
const WEEKDAY_LABELS = new Set(['日', '月', '火', '水', '木', '金', '土']);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  supabaseMock.failWeeklyStats = false;
  supabaseMock.failPantry = false;
  supabaseMock.authStateListener = null;
  supabaseMock.pantryRows = [
    {
      id: 'pantry-1',
      user_id: MOCK_AUTH_USER_ID,
      name: PANTRY_ITEM_NAME,
      amount: '1丁',
      category: 'other',
      expiration_date: PANTRY_EXPIRATION,
      added_at: '2026-11-01',
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
    },
  ];
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: new Date(BEFORE_MIDNIGHT) });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) })));
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

const pageText = () => container.textContent ?? '';

/** 期限の近い食材の行の残りの日数の文 */
function daysLeftText(): string | null {
  const row = [...container.querySelectorAll('div')].find(
    (div) => div.children.length === 2 && div.children[0]?.textContent === PANTRY_ITEM_NAME,
  );
  return row?.children[1]?.textContent ?? null;
}

/** 週の棒で今日の印が付いた曜日 */
function todayMarkedWeekdays(): string[] {
  return [...container.querySelectorAll('span')]
    .filter((span) => span.className.includes(TODAY_BAR_CLASS) && WEEKDAY_LABELS.has(span.textContent ?? ''))
    .map((span) => span.textContent ?? '');
}

/** 取り直しで失敗させる読み取り */
type FailedRead = 'pantry' | 'weeklyStats' | 'none';

/**
 * ホームを開き (開いた日の表示を確かめる)、0 時をまたいでから USER_UPDATED の取り直しを走らせる。
 * failed の読み取りだけが失敗する (今日の献立の読み取りは成功する)
 */
async function openAndRefetchAfterMidnight(failed: FailedRead) {
  await act(async () => {
    root.render(<HomePage />);
  });
  await settle();
  expect(pageText(), '開いたときの見出しの日付が開いた日でない (検査の前提が崩れた)').toContain(DAY_BEFORE_LABEL);
  expect(daysLeftText(), '開いたときの期限までの日数 (検査の前提が崩れた)').toBe(DAYS_LEFT_FROM_DAY_BEFORE);
  expect(todayMarkedWeekdays(), '開いたときの週の棒の今日の印 (検査の前提が崩れた)').toEqual([DAY_BEFORE_WEEKDAY]);

  supabaseMock.failPantry = failed === 'pantry';
  supabaseMock.failWeeklyStats = failed === 'weeklyStats';
  vi.setSystemTime(new Date(AFTER_MIDNIGHT));
  expect(supabaseMock.authStateListener, 'ログインの状態の変化を受け取る関数が無い (検査の前提が崩れた)').not.toBeNull();
  await act(async () => {
    supabaseMock.authStateListener!('USER_UPDATED');
  });
  await settle();
  expect(pageText(), '今日の献立の読み取りが成功したのに見出しが新しい日にならない (検査の前提が崩れた)').toContain(DAY_AFTER_LABEL);
}

/** 週の棒の曜日 (前の日で終わる 7 日 = 木〜水) */
function weekBarWeekdays(): string[] {
  return [...container.querySelectorAll('span')]
    .filter((span) => span.className.includes('text-[10px]') && WEEKDAY_LABELS.has(span.textContent ?? ''))
    .map((span) => span.textContent ?? '');
}

describe('0 時をまたいだ取り直しで食材・週の集計の読み取りだけが失敗しても、期限までの日数と週の棒の今日の印は見出しの新しい日に合わせる (#2259 P2)', () => {
  it('期限までの日数は、食材を読んだ今日 (前の日) と見出しの今日 (新しい日) の遅い方から数える (直す前は前の日から数え、1 日多かった)', async () => {
    await openAndRefetchAfterMidnight('pantry');
    expect(daysLeftText(), '期限までの日数を、新しい日から数えていない').toBe(DAYS_LEFT_FROM_DAY_AFTER);
  });

  it('週の集計を読んだ今日が見出しの今日より前なら、週の棒に今日の印を付けない (直す前は最後の棒 = 前の日に付いた)', async () => {
    await openAndRefetchAfterMidnight('weeklyStats');
    expect(weekBarWeekdays(), '週の棒が前の日で終わる 7 日のままでない (検査の前提が崩れた)').toEqual(['木', '金', '土', '日', '月', '火', '水']);
    expect(todayMarkedWeekdays(), '前の日で終わる 7 日の棒に今日の印が付いた').toEqual([]);
  });

  it('食材の読み取りだけが失敗しても、週の棒の今日の印は新しい日 (週の集計は新しい日で置けた)', async () => {
    await openAndRefetchAfterMidnight('pantry');
    expect(todayMarkedWeekdays()).toEqual([DAY_AFTER_WEEKDAY]);
  });

  it('週の集計の読み取りだけが失敗しても、期限までの日数は新しい日から数える (食材は新しい日で置けた)', async () => {
    await openAndRefetchAfterMidnight('weeklyStats');
    expect(daysLeftText()).toBe(DAYS_LEFT_FROM_DAY_AFTER);
  });

  it('どの読み取りも成功した取り直しでは、見出し・期限までの日数・週の棒の今日の印がどれも新しい日 (対照)', async () => {
    await openAndRefetchAfterMidnight('none');
    expect(daysLeftText()).toBe(DAYS_LEFT_FROM_DAY_AFTER);
    expect(todayMarkedWeekdays()).toEqual([DAY_AFTER_WEEKDAY]);
  });
});
