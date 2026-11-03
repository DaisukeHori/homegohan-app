/**
 * #2195 V1 ホーム (/home) のデータ (useHomeData) の取り直し (refetch。ホームは AI 相談の成功でこれを呼ぶ) が、
 * サーバーで無くなったものを前の値のまま残さないこと
 *
 * 問題 (直す前):
 *   - 「今週のベストごはん」(完了した・写真のある食事のうち 1 つ) は、当てはまる食事があるときだけ置いていた。
 *     AI 相談でその食事を消す (delete_meal)・完了を外す (complete_meal の isCompleted: false) と、取り直しても
 *     消した食事を出したまま (読み込み直すまで) だった (押すと消えた食事の詳細へ移る)
 *   - 「今日のアドバイス」の帯 (suggestion) は、帯に何も出ていないときだけ分析のアドバイスを置いていた。取り直すと
 *     分析 (点数・課題) は新しくなるのに、帯は最初に読んだときのアドバイスのまま (読み込み直すと新しいアドバイスになる・無ければ消える)
 *   - 今日の完了した食事が無くなって分析できない (GET /api/ai/nutrition-analysis が analysis: null を返す) と、前の分析
 *     (点数・課題・アドバイス) をそのまま残していた (読み込み直すと点数は出ない)
 *
 * ホームのページの配線 (useAiConsultationDataRefetch(refetch)) は tests/ai-consultation-data-refetch-2195.test.tsx が確かめる。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Supabase のモック。ログインした人 1 人。表ごとの問い合わせの答えは tableResults (無い表は空)。
 * 答えの data が配列で、問い合わせが single / maybeSingle なら最初の 1 行 (無ければ null) を返す。
 * reads に記録の口があれば、読んだ表 (select を呼んだとき。鍵は tests/helpers/ai-refetch-read-recorder.ts の selectReadKey) と
 * DB の関数 ('rpc:<名前>') を記録する (受け手の読み取りの検査)
 */
const supabaseMock = vi.hoisted(() => ({
  tableResults: {} as Record<string, { data: unknown; error: null; count?: number }>,
  reads: null as null | { record: (key: string | null) => void; recordSelect: (table: string, select: unknown) => void },
  /** DB の関数 (rpc) の応答を、この Promise が解けるまで止める (#2201 U2。食事の完了の切り替えの書き込みの間) */
  rpcHold: null as null | Promise<void>,
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  /** どのメソッドを呼んでも自分を返し、await するとその表の答えになる問い合わせ */
  const query = (table: string, single: boolean, recordsSelect: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          const result = supabaseMock.tableResults[table] ?? EMPTY_RESULT;
          const rows = result.data;
          const answer =
            single && Array.isArray(rows) ? { ...result, data: rows[0] ?? null } : Array.isArray(rows) && result.count === undefined ? { ...result, count: rows.length } : result;
          return (resolve: (value: unknown) => void) => resolve(answer);
        }
        return (...args: unknown[]) => {
          if (prop === 'select' && recordsSelect) supabaseMock.reads?.recordSelect(table, args[0]);
          return query(table, single || prop === 'single' || prop === 'maybeSingle', recordsSelect);
        };
      },
    });
  const user = { id: 'user-1', user_metadata: {} };
  return {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user } }, error: null }),
        getUser: async () => ({ data: { user }, error: null }),
        refreshSession: async () => ({ data: { session: { user } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: (table: string) => query(table, false, true),
      rpc: (name: string) => {
        supabaseMock.reads?.record(`rpc:${name}`);
        const hold = supabaseMock.rpcHold;
        if (hold === null) return query('rpc', false, false);
        return { then: (resolve: (value: unknown) => void) => void hold.then(() => resolve({ data: null, error: null })) };
      },
      channel: () => {
        const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
        return channel;
      },
      removeChannel: async () => 'ok',
    }),
  };
});

// ホームのページ (HomePage) を描くための部品のモック (受け手の読み取りの検査だけが描く)
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

const { useHomeData } = await import('@/hooks/useHomeData');
const { useAiConsultationDataRefetch } = await import('@/hooks/useAiConsultationDataRefetch');
const { default: HomePage } = await import('@/app/(main)/home/page');
const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');
const { AI_CONSULTATION_GENERATION_STATUS_PATH, AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS } = await import('@/lib/ai/consultation-generation-watch');
const {
  ReadRecorder,
  expectEmptyRefetchMatchesFreshMount,
  expectRefetchReadsCoverMount,
  fetchReadKey,
  screenSignature,
} = await import('./helpers/ai-refetch-read-recorder');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 取得の連鎖 (Promise.all の中の問い合わせ・setState) を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
const NOT_FOUND_STATUS = 404;
const OK_STATUS = 200;

/** ホームが読む今日の栄養の分析 (useHomeData の fetchNutritionAnalysis と同じ URL) */
const NUTRITION_ANALYSIS_URL = '/api/ai/nutrition-analysis?period=today&includeAdvice=true&includeSuggestion=true';
/** 栄養の分析の点数 (分析があるとき) */
const ANALYSIS_SCORE = 72;

/** 分析があるときの GET /api/ai/nutrition-analysis の応答 (アドバイスは advice。null ならアドバイスなし) */
function analysisResponse(advice: string | null) {
  return {
    success: true,
    analysis: { score: ANALYSIS_SCORE, issues: ['タンパク質が不足しています'], comparison: {} },
    advice,
    suggestion: null,
  };
}

/** 今日の完了した食事が無くて分析できないときの応答 (src/app/api/ai/nutrition-analysis/route.ts の analysis: null) */
const NO_MEALS_RESPONSE = { success: true, analysis: null, message: '献立データがありません' };

/** GET /api/ai/nutrition-analysis の今の答え (無ければ 404。ほかの fetch も 404) */
let nutritionAnalysisBody: unknown;

/** 今週の完了した・写真のある食事 (planned_meals の行) */
const BEST_MEAL_ROW = {
  id: 'meal-best',
  daily_meal_id: 'day-1',
  meal_type: 'dinner',
  dish_name: '鮭のムニエル',
  image_url: 'https://example.com/meal.jpg',
  is_completed: true,
  mode: 'cook',
};

let container: HTMLDivElement;
let root: Root;
let latestRefetch: (() => Promise<void>) | null;

function HomeDataProbe() {
  const { bestMealThisWeek, suggestion, nutritionAnalysis, refetch } = useHomeData();
  latestRefetch = refetch;
  return (
    <div>
      <p data-testid="best-meal">{bestMealThisWeek?.dishName ?? ''}</p>
      {/* ホームの「今日のアドバイス」の帯は suggestion の文を出す (src/app/(main)/home/page.tsx) */}
      <p data-testid="advice-banner">{suggestion ?? ''}</p>
      <p data-testid="analysis-score">{nutritionAnalysis.score}</p>
    </div>
  );
}

beforeEach(() => {
  supabaseMock.tableResults = {};
  supabaseMock.rpcHold = null;
  latestRefetch = null;
  nutritionAnalysisBody = undefined;
  // 栄養の分析は nutritionAnalysisBody を返す。お知らせ・パフォーマンスの分析 (fetch) は、この検査では何も返さない
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      if (String(input) === NUTRITION_ANALYSIS_URL && nutritionAnalysisBody !== undefined) {
        return { ok: true, status: OK_STATUS, json: async () => nutritionAnalysisBody };
      }
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
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

const bestMealText = () => container.querySelector('[data-testid="best-meal"]')?.textContent;
const adviceBannerText = () => container.querySelector('[data-testid="advice-banner"]')?.textContent;
const analysisScoreText = () => container.querySelector('[data-testid="analysis-score"]')?.textContent;

/** 描画して、最初の取得を流しきる */
async function renderHome() {
  await act(async () => {
    root.render(<HomeDataProbe />);
  });
  await settle();
}

/** 取り直し (AI 相談の成功のあとにホームが呼ぶ refetch) を呼んで流しきる */
async function refetchHome() {
  await act(async () => {
    await latestRefetch?.();
  });
  await settle();
}

describe('useHomeData の取り直しは、サーバーで無くなったものを残さない (#2195 V1)', () => {
  it('今週のベストごはんの食事が無くなったら (AI 相談で消した・完了を外した)、取り直しで消える', async () => {
    supabaseMock.tableResults.planned_meals = { data: [BEST_MEAL_ROW], error: null };
    await act(async () => {
      root.render(<HomeDataProbe />);
    });
    await settle();
    expect(bestMealText()).toBe(BEST_MEAL_ROW.dish_name);

    // AI 相談の delete_meal のあと、ホームが取り直す
    supabaseMock.tableResults.planned_meals = { data: [], error: null };
    await act(async () => {
      await latestRefetch?.();
    });
    await settle();
    expect(bestMealText()).toBe('');
  });

  it('当てはまる食事が別の食事に変わったら、取り直しでその食事を出す', async () => {
    supabaseMock.tableResults.planned_meals = { data: [BEST_MEAL_ROW], error: null };
    await act(async () => {
      root.render(<HomeDataProbe />);
    });
    await settle();

    const NEXT_DISH = '豚汁';
    supabaseMock.tableResults.planned_meals = { data: [{ ...BEST_MEAL_ROW, id: 'meal-next', dish_name: NEXT_DISH }], error: null };
    await act(async () => {
      await latestRefetch?.();
    });
    await settle();
    expect(bestMealText()).toBe(NEXT_DISH);
  });
});

describe('useHomeData の取り直しは、今日のアドバイスの帯と栄養の分析を読み込み直したときと同じにする (#2195 V1)', () => {
  const ADVICE_BEFORE = '夕食のタンパク質が不足しています';
  const ADVICE_AFTER = '野菜を一品足しましょう';

  it('分析のアドバイスが変わったら、取り直しで帯を新しいアドバイスにする', async () => {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await renderHome();
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);

    // AI 相談で夕食を足した (update_meal・generate_single_meal) あと、ホームが取り直す
    nutritionAnalysisBody = analysisResponse(ADVICE_AFTER);
    await refetchHome();
    expect(adviceBannerText()).toBe(ADVICE_AFTER);
  });

  it('分析のアドバイスが無くなったら、取り直しで帯を消す', async () => {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await renderHome();
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);

    nutritionAnalysisBody = analysisResponse(null);
    await refetchHome();
    expect(adviceBannerText()).toBe('');
    // 分析そのものは新しい答え
    expect(analysisScoreText()).toBe(String(ANALYSIS_SCORE));
  });

  it('今日の完了した食事が無くなって分析できなくなったら、取り直しで点数と帯を消す', async () => {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await renderHome();
    expect(analysisScoreText()).toBe(String(ANALYSIS_SCORE));

    // AI 相談で今日の食事を消した (delete_meal)・完了を外した (complete_meal) あと
    nutritionAnalysisBody = NO_MEALS_RESPONSE;
    await refetchHome();
    expect(analysisScoreText()).toBe('0');
    expect(adviceBannerText()).toBe('');
  });

  it('分析の取得に失敗したら、取り直しでも前の分析と帯を残す (失敗で表示を消さない)', async () => {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await renderHome();

    nutritionAnalysisBody = undefined; // 404
    await refetchHome();
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);
    expect(analysisScoreText()).toBe(String(ANALYSIS_SCORE));
  });
});

describe('ホーム (/home) を描画して、AI 相談の成功の取り直しを確かめる (#2195 V1)', () => {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const TODAY = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const TODAY_MEAL = { ...BEST_MEAL_ROW, id: 'meal-today', dish_name: '肉じゃが', calories_kcal: 520 };
  /**
   * 組織に入っている人の組織 (組織のチャレンジの入り口 OrgChallengeEntry は組織に入っている人にだけ描くので、
   * その読み取り GET /api/org/my-challenges を開いたときの読み取りに出す。応答の作りで読み取りを隠さない)
   */
  const ORGANIZATION_ID = '21950000-0000-4000-8000-0000000000e1';
  /** AI が書く表に中身のある答え */
  const FULL_TABLES: Record<string, { data: unknown; error: null; count?: number }> = {
    user_profiles: { data: [{ nickname: 'ほり', organization_id: ORGANIZATION_ID }], error: null },
    user_daily_meals: { data: [{ id: 'day-today', day_date: TODAY, planned_meals: [TODAY_MEAL] }], error: null },
    planned_meals: { data: [BEST_MEAL_ROW], error: null },
    pantry_items: { data: [{ id: 'p-1', user_id: 'user-1', name: 'にんじん', amount: '2本', category: 'vegetable', expiration_date: TODAY }], error: null },
    shopping_lists: { data: [{ id: 'sl-1' }], error: null },
    shopping_list_items: { data: [{ id: 'i-1' }, { id: 'i-2' }], error: null },
    health_records: { data: [{ record_date: TODAY, weight: 65 }], error: null },
    health_streaks: { data: [{ current_streak: 3 }], error: null },
    health_goals: { data: [{ target_value: 60 }], error: null },
  };
  /** AI が書く表の答えを空にしたもの (AI 相談で消した・外したあと) */
  const EMPTY_TABLES: Record<string, { data: unknown; error: null; count?: number }> = {
    ...Object.fromEntries(Object.keys(FULL_TABLES).map((table) => [table, { data: [], error: null }])),
    // 組織の所属 (organization_id) は AI 相談が書かない列なので変えない。名前 (nickname) は空
    user_profiles: { data: [{ nickname: null, organization_id: ORGANIZATION_ID }], error: null },
  };
  let recorder: InstanceType<typeof ReadRecorder>;

  function useServer(tables: Record<string, { data: unknown; error: null; count?: number }>, analysis: unknown) {
    supabaseMock.tableResults = { ...tables };
    nutritionAnalysisBody = analysis;
  }

  beforeEach(() => {
    recorder = new ReadRecorder();
    supabaseMock.reads = recorder;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        recorder.record(fetchReadKey(input, init));
        if (String(input) === NUTRITION_ANALYSIS_URL && nutritionAnalysisBody !== undefined) {
          return { ok: true, status: OK_STATUS, json: async () => nutritionAnalysisBody };
        }
        return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    supabaseMock.reads = null;
    vi.restoreAllMocks();
  });

  async function renderHomePage() {
    await act(async () => {
      root.render(<HomePage />);
    });
    await settle();
  }

  async function notifyAiConsultationSucceeded() {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'delete_meal', result: {} } }));
    });
    await settle();
  }

  it('開いたときに読むもの全部を、取り直しも読む', async () => {
    useServer(FULL_TABLES, analysisResponse('野菜を一品足しましょう'));
    recorder.take();
    await renderHomePage();
    const mountReads = recorder.take();
    await notifyAiConsultationSucceeded();
    const refetchReads = recorder.take();
    // 組織のチャレンジの入り口の読み取り (表の mountReadsNotRefetched の orgChallenges。AI 相談が書かない表)。
    // 組織に入っている人で開いたので、開いたときの読み取りに出ている (除外が今も当たっていることは expectRefetchReadsCoverMount が確かめる)
    expectRefetchReadsCoverMount('/home', mountReads, refetchReads, {
      orgChallenges: [fetchReadKey('/api/org/my-challenges') ?? ''],
    });
  });

  it('AI が書く表の答えが空になった取り直しは、空の答えで開いたときと同じ画面 (前の値を残さない)', async () => {
    useServer(FULL_TABLES, analysisResponse('野菜を一品足しましょう'));
    await renderHomePage();
    const full = screenSignature(container);

    useServer(EMPTY_TABLES, NO_MEALS_RESPONSE);
    await notifyAiConsultationSucceeded();
    const refetchedToEmpty = screenSignature(container);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderHomePage();
    const freshEmpty = screenSignature(container);
    expectEmptyRefetchMatchesFreshMount('/home', { full, refetchedToEmpty, freshEmpty });
  });
  it('AI 相談の今日の generate_day_menu は、受付ではまだ無い献立を、生成が終わったら出す (#2195 V1 の整合ゲートの是正)', async () => {
    const REQUEST_ID = '21950000-0000-4000-8000-0000000000d3';
    /** ページの API の相対 URL を解く起点 (fetch のモックの中だけで使う) */
    const PAGE_ORIGIN = 'http://localhost';
    // 今日の献立が無い状態で開く
    useServer(EMPTY_TABLES, NO_MEALS_RESPONSE);
    let statusChecks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input) === NUTRITION_ANALYSIS_URL && nutritionAnalysisBody !== undefined) {
          return { ok: true, status: OK_STATUS, json: async () => nutritionAnalysisBody };
        }
        const url = new URL(String(input), PAGE_ORIGIN);
        if (url.pathname === AI_CONSULTATION_GENERATION_STATUS_PATH && url.searchParams.get('requestId') === REQUEST_ID) {
          // 生成が終わった (今日の献立を書いてから completed にする)
          statusChecks += 1;
          useServer(FULL_TABLES, analysisResponse('野菜を一品足しましょう'));
          return { ok: true, status: OK_STATUS, json: async () => ({ status: 'completed' }) };
        }
        return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
      }),
    );
    await renderHomePage();
    expect(container.textContent).not.toContain(TODAY_MEAL.dish_name);

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, {
            detail: { actionType: 'generate_day_menu', result: { date: TODAY, requestId: REQUEST_ID, status: 'processing' } },
          }),
        );
      });
      await settle();
      // 受付の取り直しでは、献立はまだ無い
      expect(statusChecks).toBe(0);
      expect(container.textContent).not.toContain(TODAY_MEAL.dish_name);

      await act(async () => {
        vi.advanceTimersByTime(AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS);
      });
      await settle();
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(statusChecks).toBe(1);
    expect(container.textContent).toContain(TODAY_MEAL.dish_name);
  });
  it('食事の完了の切り替えの応答を待つあいだに来た成功では取り直さず (楽観的な表示を戻さない)、終わったら 1 回取り直す (#2201 U2)', async () => {
    /** 完了の切り替えの待ち (useHomeData の toggleMealCompletion の 250ms) より長い待ち */
    const TOGGLE_DEBOUNCE_WAIT_MS = 300;
    let refetchCalls = 0;
    let toggle: ((mealId: string, currentStatus: boolean) => Promise<void>) | null = null;
    function HomeToggleProbe() {
      const { todayPlan, toggleMealCompletion, refetch, aiConsultationWrites } = useHomeData();
      useAiConsultationDataRefetch(
        () => {
          refetchCalls += 1;
          return refetch();
        },
        { writeInFlightRef: aiConsultationWrites },
      );
      toggle = toggleMealCompletion;
      return <p data-testid="today-completed">{String(todayPlan?.meals[0]?.isCompleted)}</p>;
    }
    const completedText = () => container.querySelector('[data-testid="today-completed"]')?.textContent;
    useServer(FULL_TABLES, null);
    await act(async () => {
      root.render(<HomeToggleProbe />);
    });
    await settle();
    expect(completedText()).toBe('true');

    const rpc = (() => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    supabaseMock.rpcHold = rpc.promise;
    let toggling: Promise<void> | null = null;
    await act(async () => {
      toggling = toggle!(TODAY_MEAL.id, true);
      await new Promise((resolve) => setTimeout(resolve, TOGGLE_DEBOUNCE_WAIT_MS));
    });
    expect(completedText(), '楽観的な更新をしていない (検査が空振りしている)').toBe('false');

    // 書き込みの前の献立 (完了済み) のまま読む取り直しが走ると、楽観的な表示が戻る
    await notifyAiConsultationSucceeded();
    await notifyAiConsultationSucceeded();
    expect(refetchCalls).toBe(0);
    expect(completedText()).toBe('false');

    // サーバーが完了を外し終えた
    supabaseMock.tableResults = {
      ...supabaseMock.tableResults,
      user_daily_meals: { data: [{ id: 'day-today', day_date: TODAY, planned_meals: [{ ...TODAY_MEAL, is_completed: false }] }], error: null },
    };
    await act(async () => {
      rpc.release();
      await toggling;
    });
    await settle();
    expect(refetchCalls, '止めた成功のぶん 1 回取り直していない').toBe(1);
    expect(completedText()).toBe('false');
  });
});
