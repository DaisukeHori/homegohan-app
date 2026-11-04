/**
 * #2206 G5 健康・プロフィールの画面の、読み込みの失敗のあとの縁の回帰テスト。
 *
 * 問題 (直す前):
 *   1. /health/graphs: 目標 (GET /api/health/goals) の応答が 200 で本文が壊れていると、目標の JSON の解析が投げて記録の線を置かなかった
 *      (開いたときは「データがありません」・期間の切り替えでは前の期間の線が新しい見出しの下に残った)。
 *      同じ型: 記録の本文が壊れていると、期間を切り替えても前の期間の線が残った。目標・記録の fetch そのものが通信の失敗で
 *      投げたときも、Promise.all がまとめて投げて読めたほかの応答を置かず、前の期間の線が残った
 *   2. /profile/nutrition-targets: 栄養目標の再設定 (NutritionTargetPlanner) の保存のあと、ページの見出しの目標値が保存の前の数字のまま
 *      残った。取り直しはプロフィールを置いてから栄養目標を読むので、栄養目標を読めないとプロフィールだけが新しくなり、最後の
 *      setError(null) が開いたときの失敗の文も消した
 *   3. /profile: 開いたときの user_profiles の読み取りが失敗しても編集のモーダルに空の入力欄が出て「変更を保存」が押せた。
 *      auth.getUser() が投げると読み込み中のまま止まった
 *
 * Supabase には接続しない (createClient をモック)。このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '@/lib/date-utils';

const USER_ID = '22060000-0000-4000-8000-0000000000aa';

/** サーバーの答え (テストごとに置き換える) */
const server = vi.hoisted(() => ({
  /** '<メソッド> <道>' → 応答を作る関数 (Promise を返すと、それが決まるまで応答を待たせる)。無い道は 404 */
  fetchHandlers: new Map<string, () => Response | Promise<Response>>(),
  /** 表 → Supabase の読み取りの答え (single なら最初の行) */
  tables: {} as Record<string, { rows: Record<string, unknown>[]; error: unknown }>,
  /** getUser の振る舞い。'ok' はログイン済み、'throw' は投げる */
  getUser: 'ok' as 'ok' | 'throw',
  /** 送った fetch ('<メソッド> <道>') */
  requests: [] as string[],
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/profile',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
// アイコンの部品はこの検査に関係しないので描かない
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
// アニメーションは描かずに中身だけを出す
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
  /** どのメソッドを呼んでも自分を返し、await するとその表の答え (single / maybeSingle なら最初の 1 行) になる問い合わせ */
  const query = (table: string, single: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => {
            const answer = server.tables[table] ?? { rows: [], error: null };
            if (answer.error) {
              resolve({ data: null, error: answer.error });
              return;
            }
            resolve({ data: single ? (answer.rows[0] ?? null) : answer.rows, error: null });
          };
        }
        return () => query(table, single || prop === 'single' || prop === 'maybeSingle');
      },
    });
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  // 本物の createClient (ブラウザではシングルトン) と同じく、毎回同じクライアントを返す
  const client = {
    auth: {
      getUser: async () => {
        if (server.getUser === 'throw') throw new TypeError('Failed to fetch');
        return { data: { user: { id: USER_ID, email: 'g5@example.com', user_metadata: {} } }, error: null };
      },
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      signOut: async () => ({ error: null }),
    },
    from: (table: string) => query(table, false),
    channel: () => channel,
    removeChannel: async () => 'ok',
  };
  return { createClient: () => client };
});

const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');
const { default: HealthGraphsPage } = await import('@/app/(main)/health/graphs/page');
const { default: NutritionTargetsPage } = await import('@/app/(main)/profile/nutrition-targets/page');
const { default: ProfilePage } = await import('@/app/(main)/profile/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 30;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
const SERVER_ERROR_STATUS = 500;
/** fetch の init に method が無いときのメソッド */
const READ_METHOD = 'GET';
/** 道を取り出すための仮の起点 (fetch には相対の道が渡る) */
const URL_ORIGIN = 'http://localhost';
/** 200 で返す、JSON として読めない本文 (途中で切れた応答) */
const BROKEN_JSON = '{"goals": [';

let container: HTMLDivElement;
let root: Root;

const json = (body: unknown, status = OK_STATUS) => () => Response.json(body, { status });
const broken = () => () => new Response(BROKEN_JSON, { status: OK_STATUS, headers: { 'content-type': 'application/json' } });
const failed = () => json({ error: 'down' }, SERVER_ERROR_STATUS);
/** 通信の失敗 (fetch そのものが投げる。応答が無い) */
const rejected = () => (): Response => {
  throw new TypeError('Failed to fetch');
};
/**
 * 応答を待たせる (読み込み中の画面を確かめるため)。handler を fetchHandlers に置き、release で応答 (respond の答え) を返す。
 * 呼ばれる前に release しても、呼ばれたときにすぐ返す
 */
function held(respond: () => Response) {
  let releaseHeld: (() => void) | null = null;
  let released = false;
  const handler = () =>
    new Promise<Response>((resolve) => {
      releaseHeld = () => resolve(respond());
      if (released) releaseHeld();
    });
  const release = () => {
    released = true;
    releaseHeld?.();
  };
  return { handler, release };
}

function installServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), URL_ORIGIN);
      const request = `${(init?.method ?? READ_METHOD).toUpperCase()} ${url.pathname}`;
      server.requests.push(request);
      const handler = server.fetchHandlers.get(request);
      return handler ? handler() : Response.json({}, { status: NOT_FOUND_STATUS });
    }),
  );
}

beforeEach(() => {
  server.fetchHandlers = new Map();
  server.tables = {};
  server.getUser = 'ok';
  server.requests = [];
  installServer();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

async function mount(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await settle();
}

/** AI 相談の成功を知らせて、取り直しを流しきる (AIChatBubble と同じ形) */
async function notifyAiConsultationSucceeded() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
  });
  await settle();
}

/** 文字に text を含むボタン (scope の中) */
function buttonContaining(text: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
}

async function click(button: HTMLButtonElement | undefined, what: string) {
  if (!button) throw new Error(`「${what}」のボタンが無い`);
  await act(async () => {
    button.click();
  });
  await settle();
}

/**
 * /health/graphs の今日 (グラフの最後の日)。ページと同じく JST の暦日にする (#2227 H6: 実行環境の暦日で作ると、JST より東の
 * タイムゾーンでは JST の明日になり、期間から外れる)。流している間に JST の日付が変わっても、前の日は期間の中
 */
const TODAY = todayLocal();

// ─── /health/graphs ─────────────────────────────────────────────

describe('/health/graphs: 1 つの応答を読めなくても (本文の壊れ・通信の失敗)、読めた本文を置く (#2206 G5)', () => {
  const RECORDS = 'GET /api/health/records';
  const CHECKUPS = 'GET /api/health/checkups';
  const GOALS = 'GET /api/health/goals';
  const MONTH_WEIGHT = 65;
  const WEEK_WEIGHT = 70.4;
  const NO_DATA = 'データがありません';
  /** 記録か健診を読めなかったページの読み取りの知らせ (#2227 H3) */
  const LOAD_FAILED = '記録を読み込めませんでした';
  const WEEK_LABEL = '1週間';
  const WEIGHT_GOAL = { id: 'goal-g5', goal_type: 'weight', target_value: 60 };

  /** グラフの見出しの最新値 (体重) */
  const shownWeight = (weight: number) => weight.toFixed(1);

  beforeEach(() => {
    server.fetchHandlers.set(RECORDS, json({ records: [{ record_date: TODAY, weight: MONTH_WEIGHT }] }));
    server.fetchHandlers.set(CHECKUPS, json({ checkups: [] }));
    server.fetchHandlers.set(GOALS, json({ goals: [WEIGHT_GOAL] }));
  });

  it('開いたときに目標の本文が壊れていても、記録の線を出す', async () => {
    server.fetchHandlers.set(GOALS, broken());
    await mount(<HealthGraphsPage />);
    expect(server.requests, '目標を読んでいない (検査が空振りしている)').toContain(GOALS);
    expect(container.textContent, '目標の本文が壊れて、読めた記録の線を出さなかった').toContain(shownWeight(MONTH_WEIGHT));
    expect(container.textContent).not.toContain(NO_DATA);
    expect(container.textContent, '目標だけを読めなかったのに、記録を読み込めなかったと知らせた').not.toContain(LOAD_FAILED);
  });

  it('期間を切り替えたときに目標の本文が壊れていても、前の期間の線を残さず新しい期間の線を出す', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent, '前の期間の線が出ていない (検査が空振りしている)').toContain(shownWeight(MONTH_WEIGHT));

    server.fetchHandlers.set(RECORDS, json({ records: [{ record_date: TODAY, weight: WEEK_WEIGHT }] }));
    server.fetchHandlers.set(GOALS, broken());
    await click(buttonContaining(WEEK_LABEL), WEEK_LABEL);
    expect(container.textContent, '目標の本文が壊れて、新しい期間の線を置かなかった').toContain(shownWeight(WEEK_WEIGHT));
    expect(container.textContent, '前の期間の線が新しい見出しの下に残った').not.toContain(shownWeight(MONTH_WEIGHT));
  });

  it('期間を切り替えたときに記録の本文が壊れていると、前の期間の線を残さず読み込めなかったと知らせる (#2227 H3: 記録が無いのと区別する)', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(shownWeight(MONTH_WEIGHT));

    server.fetchHandlers.set(RECORDS, broken());
    await click(buttonContaining(WEEK_LABEL), WEEK_LABEL);
    expect(container.textContent, '記録の本文が壊れて、前の期間の線が新しい見出しの下に残った').not.toContain(shownWeight(MONTH_WEIGHT));
    expect(container.textContent, '読めなかった記録を「データがありません」として出した').not.toContain(NO_DATA);
    expect(container.textContent).toContain(LOAD_FAILED);
  });

  it('取り直しで記録の本文が壊れていると、今の線を残す (記録を読めなかった取り直しと同じ)', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(shownWeight(MONTH_WEIGHT));

    server.fetchHandlers.set(RECORDS, broken());
    server.requests = [];
    await notifyAiConsultationSucceeded();
    expect(server.requests, '取り直していない (検査が空振りしている)').toContain(RECORDS);
    expect(container.textContent, '取り直しの記録の本文が壊れて、今の線を消した').toContain(shownWeight(MONTH_WEIGHT));
    expect(container.textContent).not.toContain(NO_DATA);
  });

  // 同じ型: 本文が壊れているときだけでなく、fetch そのものが投げた (通信の失敗) ときも、読めたほかの応答を置く。
  // 以前は Promise.all がまとめて投げて catch に入り、読めた記録も置かなかった
  it('期間を切り替えたときに目標の取得が通信の失敗で投げても、前の期間の線を残さず新しい期間の線を出す', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent, '前の期間の線が出ていない (検査が空振りしている)').toContain(shownWeight(MONTH_WEIGHT));

    server.fetchHandlers.set(RECORDS, json({ records: [{ record_date: TODAY, weight: WEEK_WEIGHT }] }));
    server.fetchHandlers.set(GOALS, rejected());
    server.requests = [];
    await click(buttonContaining(WEEK_LABEL), WEEK_LABEL);
    expect(server.requests, '目標を読みに行っていない (検査が空振りしている)').toContain(GOALS);
    expect(container.textContent, '目標の通信の失敗で、新しい期間の線を置かなかった').toContain(shownWeight(WEEK_WEIGHT));
    expect(container.textContent, '前の期間の線が新しい見出しの下に残った').not.toContain(shownWeight(MONTH_WEIGHT));
  });

  it('期間を切り替えたときに記録の取得が通信の失敗で投げると、前の期間の線を残さず読み込めなかったと知らせる (#2227 H3)', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(shownWeight(MONTH_WEIGHT));

    server.fetchHandlers.set(RECORDS, rejected());
    server.requests = [];
    await click(buttonContaining(WEEK_LABEL), WEEK_LABEL);
    expect(server.requests, '記録を読みに行っていない (検査が空振りしている)').toContain(RECORDS);
    expect(container.textContent, '記録の通信の失敗で、前の期間の線が新しい見出しの下に残った').not.toContain(shownWeight(MONTH_WEIGHT));
    expect(container.textContent, '読めなかった記録を「データがありません」として出した').not.toContain(NO_DATA);
    expect(container.textContent).toContain(LOAD_FAILED);
  });

  it('取り直しで記録の取得が通信の失敗で投げると、今の線を残す', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(shownWeight(MONTH_WEIGHT));

    server.fetchHandlers.set(RECORDS, rejected());
    server.requests = [];
    await notifyAiConsultationSucceeded();
    expect(server.requests, '取り直していない (検査が空振りしている)').toContain(RECORDS);
    expect(container.textContent, '取り直しの記録の通信の失敗で、今の線を消した').toContain(shownWeight(MONTH_WEIGHT));
    expect(container.textContent).not.toContain(NO_DATA);
  });
});

describe('/health/graphs: 開いたときに記録か健診を読めなければ、空のグラフでなく読み込めなかったと知らせる (#2227 H3)', () => {
  const RECORDS = 'GET /api/health/records';
  const CHECKUPS = 'GET /api/health/checkups';
  const GOALS = 'GET /api/health/goals';
  const MONTH_WEIGHT = 65;
  const RELOADED_WEIGHT = 66.2;
  const NO_DATA = 'データがありません';
  const LOAD_FAILED = '記録を読み込めませんでした';
  const RELOAD_LABEL = '再読み込み';
  const WEIGHT_GOAL = { id: 'goal-h3', goal_type: 'weight', target_value: 60 };
  /** 目標との比較のカードの文 (最新の値が無いときに出すと、目標の値そのものを「あと」として出す) */
  const TARGET_COMPARISON = '目標まであと';
  /** 目標との比較のカードの見出し (目標の値)。目標は読めているので、カードを出せばこの文が出る */
  const TARGET_LABEL = `目標体重: ${WEIGHT_GOAL.target_value}kg`;

  const shownWeight = (weight: number) => weight.toFixed(1);
  const recordsOf = (weight: number) => json({ records: [{ record_date: TODAY, weight }] });

  beforeEach(() => {
    server.fetchHandlers.set(RECORDS, recordsOf(MONTH_WEIGHT));
    server.fetchHandlers.set(CHECKUPS, json({ checkups: [] }));
    server.fetchHandlers.set(GOALS, json({ goals: [WEIGHT_GOAL] }));
  });

  /** 読めなかった応答の形 (通信の失敗・非 2xx・本文の壊れ) × 読めなかった読み取り (記録・健診) */
  const FAILURES: ReadonlyArray<{ name: string; respond: () => () => Response }> = [
    { name: '通信の失敗', respond: rejected },
    { name: '500', respond: failed },
    { name: '本文の壊れ', respond: broken },
  ];
  const UNREAD_TARGETS: ReadonlyArray<{ name: string; request: string }> = [
    { name: '記録', request: RECORDS },
    { name: '健診', request: CHECKUPS },
  ];

  for (const target of UNREAD_TARGETS) {
    for (const failure of FAILURES) {
      it(`開いたときに${target.name}を読めない (${failure.name}) と、「データがありません」でなく読み込めなかったと知らせ、再読み込みのボタンを出す`, async () => {
        server.fetchHandlers.set(target.request, failure.respond());
        await mount(<HealthGraphsPage />);
        expect(server.requests, `${target.name}を読みに行っていない (検査が空振りしている)`).toContain(target.request);
        expect(container.textContent, '読めなかった記録を「データがありません」として出した (記録が無いのと区別がつかない)').not.toContain(NO_DATA);
        expect(container.textContent).toContain(LOAD_FAILED);
        expect(container.querySelector('[role="alert"]')?.textContent, '知らせが role="alert" で読み上げられない').toContain(LOAD_FAILED);
        expect(buttonContaining(RELOAD_LABEL), '再読み込みのボタンが無い').toBeDefined();
        expect(container.textContent, '最新の値が無いのに目標との比較を出した').not.toContain(TARGET_COMPARISON);
        expect(server.requests, '目標を読みに行っていない (カードが出ないことを確かめられていない)').toContain(GOALS);
        expect(container.textContent, '読めなかったのに目標との比較のカードを出した').not.toContain(TARGET_LABEL);
      });
    }
  }

  it('再読み込みのボタンで読み直し、読めたら知らせを消して記録の線を出す', async () => {
    server.fetchHandlers.set(RECORDS, failed());
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(LOAD_FAILED);

    server.fetchHandlers.set(RECORDS, recordsOf(RELOADED_WEIGHT));
    server.requests = [];
    await click(buttonContaining(RELOAD_LABEL), RELOAD_LABEL);
    expect(server.requests, '再読み込みのボタンで記録を読み直していない').toContain(RECORDS);
    expect(container.textContent, '読み直せたのに、読み込めなかった知らせが残った').not.toContain(LOAD_FAILED);
    expect(container.textContent).toContain(shownWeight(RELOADED_WEIGHT));
    expect(container.textContent, '読み直せたのに、目標との比較のカードを出さない').toContain(TARGET_LABEL);
  });

  it('再読み込みでもまた読めなければ、知らせを出したまま (空のグラフにしない)', async () => {
    server.fetchHandlers.set(RECORDS, failed());
    await mount(<HealthGraphsPage />);
    server.requests = [];
    await click(buttonContaining(RELOAD_LABEL), RELOAD_LABEL);
    expect(server.requests, '再読み込みのボタンで記録を読み直していない (検査が空振りしている)').toContain(RECORDS);
    expect(container.textContent).toContain(LOAD_FAILED);
    expect(container.textContent).not.toContain(NO_DATA);
    expect(container.textContent, '再読み込みでも読めなかったのに目標との比較のカードを出した').not.toContain(TARGET_LABEL);
  });

  it('知らせを出しているときに取り直しが記録を読めたら、知らせを消して線を出す', async () => {
    server.fetchHandlers.set(RECORDS, failed());
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(LOAD_FAILED);

    server.fetchHandlers.set(RECORDS, recordsOf(RELOADED_WEIGHT));
    server.requests = [];
    await notifyAiConsultationSucceeded();
    expect(server.requests, '取り直していない (検査が空振りしている)').toContain(RECORDS);
    expect(container.textContent, '取り直しで読めたのに、読み込めなかった知らせが残った').not.toContain(LOAD_FAILED);
    expect(container.textContent).toContain(shownWeight(RELOADED_WEIGHT));
  });

  it('知らせを出しているときの取り直しも記録を読めなければ、知らせを残す (取り直しの失敗は今の表示を残す)', async () => {
    server.fetchHandlers.set(RECORDS, failed());
    await mount(<HealthGraphsPage />);
    server.requests = [];
    await notifyAiConsultationSucceeded();
    expect(server.requests, '取り直していない (検査が空振りしている)').toContain(RECORDS);
    expect(container.textContent).toContain(LOAD_FAILED);
    expect(container.textContent, '取り直しでも読めなかったのに目標との比較のカードを出した').not.toContain(TARGET_LABEL);
  });

  it('記録が本当に無い (読めて 0 件) ときは、これまでどおり「データがありません」を出す (読み込めなかった知らせは出さない)', async () => {
    server.fetchHandlers.set(RECORDS, json({ records: [] }));
    await mount(<HealthGraphsPage />);
    expect(server.requests).toContain(RECORDS);
    expect(container.textContent).toContain(NO_DATA);
    expect(container.textContent).not.toContain(LOAD_FAILED);
  });
});

describe('/health/graphs: 目標との比較のカードは、読み込み中・読めなかったときは出さず、最新の値が無いときは「目標まであと」を出さない (#2235 I4)', () => {
  const RECORDS = 'GET /api/health/records';
  const CHECKUPS = 'GET /api/health/checkups';
  const GOALS = 'GET /api/health/goals';
  const MONTH_WEIGHT = 65;
  const RELOADED_WEIGHT = 66.2;
  const WEEK_WEIGHT = 70.4;
  const TARGET_WEIGHT = 60;
  const NO_DATA = 'データがありません';
  const LOAD_FAILED = '記録を読み込めませんでした';
  const RELOAD_LABEL = '再読み込み';
  const WEEK_LABEL = '1週間';
  const WEIGHT_GOAL = { id: 'goal-i4', goal_type: 'weight', target_value: TARGET_WEIGHT };
  /** 目標との比較のカードの見出し (目標の値)。カードそのものが出ているかはこの文で見る (「目標まであと」は最新の値が無いと出ないので、カードの有無を見張れない) */
  const TARGET_LABEL = `目標体重: ${TARGET_WEIGHT}kg`;
  /** 目標との比較のカードの「あと」の文 (最新の値が無いときに出すと、目標の値そのものを「あと」として出す) */
  const TARGET_COMPARISON = '目標まであと';
  /** 最新の値 weight のときの「あと」の文 (ページと同じく小数 1 桁) */
  const remainingOf = (weight: number) => `${TARGET_COMPARISON} ${Math.abs(weight - TARGET_WEIGHT).toFixed(1)}kg`;
  /** 最新の値が無いまま 0 との差で出した「あと」の文 (直す前の形) */
  const REMAINING_FROM_ZERO = `${TARGET_COMPARISON} ${TARGET_WEIGHT.toFixed(1)}kg`;

  const recordsOf = (weight: number) => json({ records: [{ record_date: TODAY, weight }] });
  /** グラフの読み込み中の印 (スピナー) */
  const spinner = () => container.querySelector('.animate-spin');

  beforeEach(() => {
    server.fetchHandlers.set(RECORDS, recordsOf(MONTH_WEIGHT));
    server.fetchHandlers.set(CHECKUPS, json({ checkups: [] }));
    server.fetchHandlers.set(GOALS, json({ goals: [WEIGHT_GOAL] }));
  });

  it('記録を読めた後は、最新の値との差で「目標まであと」を出す (出さなくしすぎていない)', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent).toContain(TARGET_LABEL);
    expect(container.textContent).toContain(remainingOf(MONTH_WEIGHT));
  });

  it('読めなかった後に再読み込みを押した読み込み中は、目標の値そのものを「目標まであと」として出さない', async () => {
    server.fetchHandlers.set(RECORDS, failed());
    await mount(<HealthGraphsPage />);
    expect(container.textContent, '読めなかった知らせが出ていない (検査が空振りしている)').toContain(LOAD_FAILED);
    expect(container.textContent, '読めなかったのに目標との比較のカードを出した').not.toContain(TARGET_LABEL);

    const reload = held(recordsOf(RELOADED_WEIGHT));
    server.fetchHandlers.set(RECORDS, reload.handler);
    server.requests = [];
    await click(buttonContaining(RELOAD_LABEL), RELOAD_LABEL);
    expect(server.requests, '再読み込みのボタンで記録を読み直していない (検査が空振りしている)').toContain(RECORDS);
    expect(spinner(), '読み込み中の印が出ていない (読み込み中を確かめられていない)').not.toBeNull();
    expect(container.textContent, '再読み込みの読み込み中に、最新の値が無いまま目標の値を「目標まであと」として出した').not.toContain(TARGET_COMPARISON);
    expect(container.textContent).not.toContain(REMAINING_FROM_ZERO);
    expect(container.textContent, '再読み込みの読み込み中に目標との比較のカードを出した').not.toContain(TARGET_LABEL);

    reload.release();
    await settle();
    expect(spinner(), '読み終わったのに読み込み中の印が残った').toBeNull();
    expect(container.textContent, '読み直せたのに、最新の値との差を出さない').toContain(remainingOf(RELOADED_WEIGHT));
  });

  it('再読み込みの読み込み中に、もう一度読めなくても「目標まであと」を出さない (知らせに戻る)', async () => {
    server.fetchHandlers.set(RECORDS, failed());
    await mount(<HealthGraphsPage />);
    expect(container.textContent, '読めなかった知らせが出ていない (検査が空振りしている)').toContain(LOAD_FAILED);
    expect(container.textContent, '読めなかったのに目標との比較のカードを出した').not.toContain(TARGET_LABEL);

    const reload = held(failed());
    server.fetchHandlers.set(RECORDS, reload.handler);
    await click(buttonContaining(RELOAD_LABEL), RELOAD_LABEL);
    expect(spinner(), '読み込み中の印が出ていない (検査が空振りしている)').not.toBeNull();
    expect(container.textContent).not.toContain(TARGET_COMPARISON);
    expect(container.textContent, '再読み込みの読み込み中に目標との比較のカードを出した').not.toContain(TARGET_LABEL);

    reload.release();
    await settle();
    expect(container.textContent).toContain(LOAD_FAILED);
    expect(container.textContent).not.toContain(TARGET_COMPARISON);
    expect(container.textContent, 'もう一度読めなかったのに目標との比較のカードを出した').not.toContain(TARGET_LABEL);
  });

  it('期間を切り替えた読み込み中は、前の期間の最新の値で「目標まであと」を出さない', async () => {
    await mount(<HealthGraphsPage />);
    expect(container.textContent, '前の期間の差が出ていない (検査が空振りしている)').toContain(remainingOf(MONTH_WEIGHT));

    const week = held(recordsOf(WEEK_WEIGHT));
    server.fetchHandlers.set(RECORDS, week.handler);
    await click(buttonContaining(WEEK_LABEL), WEEK_LABEL);
    expect(spinner(), '読み込み中の印が出ていない (検査が空振りしている)').not.toBeNull();
    expect(container.textContent, '期間を切り替えた読み込み中に、前の期間の値で「目標まであと」を出した').not.toContain(TARGET_COMPARISON);
    expect(container.textContent, '期間を切り替えた読み込み中に目標との比較のカードを出した').not.toContain(TARGET_LABEL);

    week.release();
    await settle();
    expect(container.textContent).toContain(remainingOf(WEEK_WEIGHT));
  });

  it('記録が本当に無い (読めて 0 件) ときは、目標体重は出しても、目標の値そのものを「目標まであと」として出さない', async () => {
    server.fetchHandlers.set(RECORDS, json({ records: [] }));
    await mount(<HealthGraphsPage />);
    expect(container.textContent, '「データがありません」が出ていない (検査が空振りしている)').toContain(NO_DATA);
    expect(container.textContent, '記録が無くても、目標体重は出す').toContain(TARGET_LABEL);
    expect(container.textContent, '最新の値が無いのに、目標の値そのものを「目標まであと」として出した').not.toContain(TARGET_COMPARISON);
  });
});

// ─── /profile/nutrition-targets ───────────────────────────────────────

describe('/profile/nutrition-targets: 再設定の保存のあとの値と、取り直しの失敗の文 (#2206 G5)', () => {
  const PLANNER_PROFILE = 'GET /api/profile';
  const TARGETS = 'GET /api/nutrition/targets';
  const RECALCULATE = 'POST /api/nutrition-targets/calculate';
  const CALORIES_BEFORE = 2000;
  const CALORIES_AFTER_SAVE = 1800;
  const AGE_BEFORE = 30;
  const AGE_AFTER_AI = 31;
  /** 再設定の保存のボタン (自動計算のとき) */
  const SAVE_AUTO = '自動計算に戻す';
  /** このページの失敗の文 */
  const PAGE_LOAD_ERROR = 'データの取得に失敗しました';
  const SUMMARY_TITLE = '目標サマリー';

  const PROFILE_ROW = { id: USER_ID, nickname: 'ほり', age: AGE_BEFORE, gender: 'male', height: 170, weight: 70, target_weight: 65 };
  const targetsBody = (dailyCalories: number) => ({
    targets: {
      id: 'nt-g5',
      dailyCalories,
      proteinG: 60,
      fatG: 60,
      carbsG: 250,
      fiberG: 20,
      autoCalculate: true,
      calculationBasis: null,
      lastCalculatedAt: '2026-11-01T00:00:00Z',
    },
  });

  /** ページの見出し (目標サマリー) の目標カロリー */
  const headerCalories = (): string | null => {
    const label = [...container.querySelectorAll('p')].find((p) => p.textContent === '目標カロリー (kcal)');
    return label?.previousElementSibling?.textContent ?? null;
  };
  /** 「計算に使用した入力値」の年齢 */
  const shownAge = (): string | null => {
    const label = [...container.querySelectorAll('span')].find((s) => s.textContent === '年齢');
    return label?.nextElementSibling?.textContent ?? null;
  };

  beforeEach(() => {
    server.tables.user_profiles = { rows: [PROFILE_ROW], error: null };
    server.fetchHandlers.set(PLANNER_PROFILE, json(PROFILE_ROW));
    server.fetchHandlers.set(TARGETS, json(targetsBody(CALORIES_BEFORE)));
    server.fetchHandlers.set(RECALCULATE, json({ success: true }));
  });

  it('再設定の保存のあと、ページの見出しの目標値も保存のあとの値にする', async () => {
    await mount(<NutritionTargetsPage />);
    expect(headerCalories(), '見出しの目標値が出ていない (検査が空振りしている)').toBe(String(CALORIES_BEFORE));

    server.fetchHandlers.set(TARGETS, json(targetsBody(CALORIES_AFTER_SAVE)));
    server.requests = [];
    await click(buttonContaining(SAVE_AUTO), SAVE_AUTO);
    expect(server.requests, '保存を送っていない (検査が空振りしている)').toContain(RECALCULATE);
    expect(container.textContent, '保存が済んでいない (検査が空振りしている)').toContain('自動計算の目標に戻しました。');
    expect(headerCalories(), '再設定の保存のあとも、ページの見出しが保存の前の目標値のまま').toBe(String(CALORIES_AFTER_SAVE));
  });

  it('再設定の保存のあとの読み直しが失敗しても、失敗の画面に切り替えずに今の表示を残す', async () => {
    await mount(<NutritionTargetsPage />);
    server.fetchHandlers.set(TARGETS, failed());
    server.tables.user_profiles = { rows: [{ ...PROFILE_ROW, age: AGE_AFTER_AI }], error: null };
    await click(buttonContaining(SAVE_AUTO), SAVE_AUTO);
    expect(container.textContent, '保存のあとの読み直しの失敗で、失敗の画面に切り替えた').not.toContain(PAGE_LOAD_ERROR);
    expect(container.textContent).toContain(SUMMARY_TITLE);
    expect(headerCalories()).toBe(String(CALORIES_BEFORE));
    // 片方 (栄養目標) を読めなかったので、もう片方 (プロフィール) も置かない
    expect(shownAge()).toBe(`${AGE_BEFORE}歳`);
  });

  it('取り直しで栄養目標を読めなかったら、プロフィールだけを新しくしない', async () => {
    await mount(<NutritionTargetsPage />);
    expect(shownAge(), '年齢が出ていない (検査が空振りしている)').toBe(`${AGE_BEFORE}歳`);

    server.tables.user_profiles = { rows: [{ ...PROFILE_ROW, age: AGE_AFTER_AI }], error: null };
    server.fetchHandlers.set(TARGETS, failed());
    server.requests = [];
    await notifyAiConsultationSucceeded();
    expect(server.requests, 'ページが取り直していない (検査が空振りしている)').toContain(TARGETS);
    expect(shownAge(), '栄養目標を読めなかった取り直しで、プロフィールだけが新しくなった').toBe(`${AGE_BEFORE}歳`);
    expect(headerCalories()).toBe(String(CALORIES_BEFORE));

    // 両方を読めた取り直しは、両方を置く
    server.fetchHandlers.set(TARGETS, json(targetsBody(CALORIES_AFTER_SAVE)));
    await notifyAiConsultationSucceeded();
    expect(shownAge()).toBe(`${AGE_AFTER_AI}歳`);
    expect(headerCalories()).toBe(String(CALORIES_AFTER_SAVE));
  });

  it('開いたときに読めなかった失敗の文は、栄養目標を読めなかった取り直しでは消さない。両方を読めたら消す', async () => {
    // 開いたときの栄養目標の読み取りの通信が失敗する (失敗の文を出す)
    server.fetchHandlers.set(TARGETS, () => {
      throw new TypeError('Failed to fetch');
    });
    await mount(<NutritionTargetsPage />);
    expect(container.textContent, '開いたときの失敗の文が出ていない (検査が空振りしている)').toContain(PAGE_LOAD_ERROR);

    // AI 相談の成功の取り直し: プロフィールは読めるが、栄養目標は 500
    server.fetchHandlers.set(TARGETS, failed());
    await notifyAiConsultationSucceeded();
    expect(container.textContent, '栄養目標を読めなかった取り直しが、開いたときの失敗の文を消した').toContain(PAGE_LOAD_ERROR);
    expect(container.textContent).not.toContain(SUMMARY_TITLE);

    server.fetchHandlers.set(TARGETS, json(targetsBody(CALORIES_BEFORE)));
    await notifyAiConsultationSucceeded();
    expect(container.textContent, '両方を読めた取り直しで失敗の文が消えない').not.toContain(PAGE_LOAD_ERROR);
    expect(headerCalories()).toBe(String(CALORIES_BEFORE));
  });
});

// ─── /profile ─────────────────────────────────────────────

describe('/profile: 開いたときの読み込みの失敗のあと、空の編集を保存させない・読み込み中のまま止めない (#2206 G5)', () => {
  const NICKNAME = 'ほりG5';
  const PROFILE_ROW = { id: USER_ID, nickname: NICKNAME, age: 30, gender: 'male', height: 170, weight: 70 };
  /** Supabase の読み取りの失敗 (行が無い PGRST116 ではない、通信・サーバーの失敗) */
  const TABLE_READ_FAILURE = { code: '08006', message: 'connection failure', details: null, hint: null };
  const OPEN_BASIC = '基本情報';
  const SAVE = '変更を保存';
  const RELOAD = '再読み込み';
  const LOADING = 'プロフィールを読み込み中...';
  const PROFILE_PUT = 'PUT /api/profile';

  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
  const nicknameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: たろう"]');
  const saveButton = () => {
    const scope = dialog();
    return scope ? buttonContaining(SAVE, scope) : undefined;
  };

  beforeEach(() => {
    server.tables.user_profiles = { rows: [PROFILE_ROW], error: null };
  });

  it('プロフィールを読めなかったら、編集のモーダルに入力欄を出さず保存を止め、再読み込みで読めたら入力欄に保存した値を出す', async () => {
    server.tables.user_profiles = { rows: [], error: TABLE_READ_FAILURE };
    await mount(<ProfilePage />);
    await click(buttonContaining(OPEN_BASIC), OPEN_BASIC);
    expect(dialog(), '編集のモーダルが開かない').not.toBeNull();
    expect(nicknameInput(), '読めなかったのに、保存した値の無い空の入力欄を出した').toBeNull();
    expect(saveButton()?.disabled, '読めなかったのに「変更を保存」を押せる').toBe(true);

    // 押せないボタンを押しても (押せたとしても) 空の本文を送らない
    server.requests = [];
    await click(saveButton(), SAVE);
    expect(server.requests, '読めなかったまま空の本文を送った').not.toContain(PROFILE_PUT);

    server.tables.user_profiles = { rows: [PROFILE_ROW], error: null };
    await click(buttonContaining(RELOAD, dialog()!), RELOAD);
    expect(nicknameInput()?.value, '再読み込みで読めたのに、保存した値を入力欄に出さない').toBe(NICKNAME);
    expect(saveButton()?.disabled, '再読み込みで読めたのに「変更を保存」を押せない').toBe(false);
    expect(container.textContent).not.toContain(RELOAD);
  });

  it('ログインの確かめが投げても、読み込み中のまま止めずに再読み込みを出す', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      server.getUser = 'throw';
      await mount(<ProfilePage />);
      await click(buttonContaining(OPEN_BASIC), OPEN_BASIC);
      expect(container.textContent, 'ログインの確かめが投げて、読み込み中のまま止まった').not.toContain(LOADING);
      expect(nicknameInput()).toBeNull();
      expect(saveButton()?.disabled).toBe(true);
      expect(unhandled, '読み込みの失敗が未処理の Promise 拒否になった').not.toHaveBeenCalled();

      server.getUser = 'ok';
      await click(buttonContaining(RELOAD, dialog()!), RELOAD);
      expect(nicknameInput()?.value).toBe(NICKNAME);
      expect(saveButton()?.disabled).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('開いたときに読めていれば、取り直しの失敗では保存を止めず、今の入力欄を残す', async () => {
    await mount(<ProfilePage />);
    server.tables.user_profiles = { rows: [], error: TABLE_READ_FAILURE };
    await notifyAiConsultationSucceeded();
    await click(buttonContaining(OPEN_BASIC), OPEN_BASIC);
    expect(nicknameInput()?.value, '取り直しの失敗で入力欄を消した').toBe(NICKNAME);
    expect(saveButton()?.disabled, '取り直しの失敗で保存を止めた').toBe(false);
    expect(container.textContent).not.toContain(RELOAD);
  });

  it('開いたときに読めなかったあと、AI 相談の成功の取り直しで読めたら、知らせを消して保存できる', async () => {
    server.tables.user_profiles = { rows: [], error: TABLE_READ_FAILURE };
    await mount(<ProfilePage />);
    expect(container.textContent, '開いたときの失敗の知らせが出ていない (検査が空振りしている)').toContain(RELOAD);

    server.tables.user_profiles = { rows: [PROFILE_ROW], error: null };
    await notifyAiConsultationSucceeded();
    expect(container.textContent, '取り直しで読めたのに失敗の知らせが残った').not.toContain(RELOAD);
    await click(buttonContaining(OPEN_BASIC), OPEN_BASIC);
    expect(nicknameInput()?.value).toBe(NICKNAME);
    expect(saveButton()?.disabled).toBe(false);
  });
});
