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
 * #2201 U4: 取り直しは栄養の分析を AI を付けずに読み (GET /api/ai/nutrition-analysis?period=today。点数・課題だけ)、
 * 今日のアドバイスの帯は前のアドバイスを残す (以前は成功のたびに LLM を 1 回呼び、上限に数えない枠の安全弁
 * 'nutrition_advice_auto' を 1 回使い、安全弁に達すると帯を消していた)。分析できなくなったとき (analysis: null) は帯も消す。
 *
 * ホームのページの配線 (useAiConsultationDataRefetch(refetch)) は tests/ai-consultation-data-refetch-2195.test.tsx が確かめる。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Supabase のモック。ログインした人 1 人。表ごとの問い合わせの答えは tableResults (無い表は空。error のある答えは読み取りの失敗)。
 * 答えの data が配列で、問い合わせが single / maybeSingle なら最初の 1 行 (無ければ null) を返す。
 * reads に記録の口があれば、読んだ表 (select を呼んだとき。鍵は tests/helpers/ai-refetch-read-recorder.ts の selectReadKey) と
 * DB の関数 ('rpc:<名前>') を記録する (受け手の読み取りの検査)
 */
const supabaseMock = vi.hoisted(() => ({
  /** error が null でない答えは読み取りの失敗 (supabase-js は通信の失敗でも投げずに { data: null, error } を返す。#2201 U1) */
  tableResults: {} as Record<string, { data: unknown; error: unknown; count?: number | null }>,
  reads: null as null | { record: (key: string | null) => void; recordSelect: (table: string, select: unknown) => void },
  /** DB の関数 (rpc) の応答を、この Promise が解けるまで止める (#2201 U2。食事の完了の切り替えの書き込みの間) */
  rpcHold: null as null | Promise<void>,
  /** 表への書き込み (upsert / insert / update / delete) の応答を、この Promise が解けるまで止める (#2201 U2。今日の気分・活動量の保存の間) */
  writeHold: null as null | Promise<void>,
  /** 置いている間に始めた表の読み取りの応答を、この Promise が解けるまで止める (#2201 U1。開いたときの読み込みの最中) */
  tableHold: null as null | Promise<void>,
  /**
   * 置いている間に始めた、この表 (table) の読み取りの応答だけを、この Promise (hold) が解けるまで止める
   * (#2201 U1。答えは読み取りを始めたときのもの。続けて来た取り直しの応答の順序)
   */
  tableHoldFor: null as null | { table: string; hold: Promise<void> },
  /** true の間に始めた表の読み取りは reject する (#2201 U1。読み取りが投げたとき) */
  tableRejects: false,
  /** ページが auth.onAuthStateChange に渡した関数 (ログインの状態の変化を起こす。#2201 U1) */
  authStateListener: null as null | (() => void),
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  /** 表への書き込みのメソッド (呼んだ問い合わせは supabaseMock.writeHold で止める) */
  const WRITE_METHODS: ReadonlySet<PropertyKey> = new Set(['upsert', 'insert', 'update', 'delete']);
  /** どのメソッドを呼んでも自分を返し、await するとその表の答えになる問い合わせ (writes は書き込みのメソッドを呼んだか) */
  const query = (table: string, single: boolean, recordsSelect: boolean, writes = false): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          const result = supabaseMock.tableResults[table] ?? EMPTY_RESULT;
          const rows = result.data;
          const answer =
            single && Array.isArray(rows) ? { ...result, data: rows[0] ?? null } : Array.isArray(rows) && result.count === undefined ? { ...result, count: rows.length } : result;
          const hold =
            (writes ? supabaseMock.writeHold : null) ??
            supabaseMock.tableHold ??
            (supabaseMock.tableHoldFor?.table === table ? supabaseMock.tableHoldFor.hold : null);
          const rejects = supabaseMock.tableRejects;
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            const settleAnswer = () => (rejects ? reject(new Error(`${table} read failed`)) : resolve(answer));
            if (hold === null) settleAnswer();
            else void hold.then(settleAnswer);
          };
        }
        return (...args: unknown[]) => {
          if (prop === 'select' && recordsSelect) supabaseMock.reads?.recordSelect(table, args[0]);
          return query(table, single || prop === 'single' || prop === 'maybeSingle', recordsSelect, writes || WRITE_METHODS.has(prop));
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
        onAuthStateChange: (listener: () => void) => {
          supabaseMock.authStateListener = listener;
          return { data: { subscription: { unsubscribe: () => undefined } } };
        },
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

const { useHomeData, HOME_NUTRITION_ANALYSIS_WITH_AI_URL, HOME_NUTRITION_ANALYSIS_WITHOUT_AI_URL } = await import('@/hooks/useHomeData');
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

/** ホームが開いたときに読む今日の栄養の分析 (AI のアドバイスと提案つき。useHomeData の fetchNutritionAnalysis) */
const NUTRITION_ANALYSIS_URL = HOME_NUTRITION_ANALYSIS_WITH_AI_URL;
/** 取り直しが読む今日の栄養の分析 (AI を付けない。#2201 U4) */
const NUTRITION_ANALYSIS_WITHOUT_AI_URL = HOME_NUTRITION_ANALYSIS_WITHOUT_AI_URL;
/** 栄養の分析の点数 (分析があるとき) */
const ANALYSIS_SCORE = 72;

/** 分析があるときの GET /api/ai/nutrition-analysis の応答 (アドバイスは advice。null ならアドバイスなし。点数は score) */
function analysisResponse(advice: string | null, score: number = ANALYSIS_SCORE) {
  return {
    success: true,
    analysis: { score, issues: ['タンパク質が不足しています'], comparison: {} },
    advice,
    suggestion: null,
  };
}

/** 今日の完了した食事が無くて分析できないときの応答 (src/app/api/ai/nutrition-analysis/route.ts の analysis: null) */
const NO_MEALS_RESPONSE = { success: true, analysis: null, message: '献立データがありません' };

/** GET /api/ai/nutrition-analysis の今の答え (無ければ 404。ほかの fetch も 404) */
let nutritionAnalysisBody: unknown;

/**
 * 栄養の分析の API の作り物: AI つきの URL には nutritionAnalysisBody をそのまま、AI を付けない URL には AI の部分
 * (advice・suggestion) を空にしたものを返す (src/app/api/ai/nutrition-analysis/route.ts は includeAdvice / includeSuggestion が
 * 無ければ AI を呼ばず、advice・suggestion は null)。どちらでもない・答えが無いときは null (呼び出し側が 404 にする)
 */
function nutritionAnalysisAnswer(input: unknown): unknown {
  if (nutritionAnalysisBody === undefined) return null;
  const url = String(input);
  if (url === NUTRITION_ANALYSIS_URL) return nutritionAnalysisBody;
  if (url !== NUTRITION_ANALYSIS_WITHOUT_AI_URL) return null;
  const body = nutritionAnalysisBody as { analysis?: unknown };
  return body.analysis ? { ...body, advice: null, suggestion: null } : body;
}

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
  supabaseMock.writeHold = null;
  supabaseMock.tableHold = null;
  supabaseMock.tableHoldFor = null;
  supabaseMock.tableRejects = false;
  supabaseMock.authStateListener = null;
  latestRefetch = null;
  nutritionAnalysisBody = undefined;
  // 栄養の分析は nutritionAnalysisBody を返す。お知らせ・パフォーマンスの分析 (fetch) は、この検査では何も返さない
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const answer = nutritionAnalysisAnswer(input);
      if (answer !== null) return { ok: true, status: OK_STATUS, json: async () => answer };
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

  it('続けて来た取り直しの、先の取り直しのベストごはんの応答が後から届いても、あとの取り直しの答えを古い答えで上書きしない (#2201 U1)', async () => {
    supabaseMock.tableResults.planned_meals = { data: [BEST_MEAL_ROW], error: null };
    await renderHome();
    expect(bestMealText()).toBe(BEST_MEAL_ROW.dish_name);

    // 1 回目の取り直しの今週のベストごはんの読み取り (planned_meals) は、前の答えを読んで応答が遅れる
    let releaseFirst: () => void = () => undefined;
    supabaseMock.tableHoldFor = {
      table: 'planned_meals',
      hold: new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    };
    let firstRefetch: Promise<void> | undefined;
    await act(async () => {
      firstRefetch = latestRefetch?.();
    });
    await settle();
    supabaseMock.tableHoldFor = null;

    // 2 回目の取り直し (AI 相談で当てはまる食事が別の食事に変わった) は先に届く
    const NEXT_DISH = '豚汁';
    supabaseMock.tableResults.planned_meals = { data: [{ ...BEST_MEAL_ROW, id: 'meal-next', dish_name: NEXT_DISH }], error: null };
    await refetchHome();
    expect(bestMealText()).toBe(NEXT_DISH);

    await act(async () => {
      releaseFirst();
      await firstRefetch;
    });
    await settle();
    expect(bestMealText(), '先の取り直しの古い応答が、ベストごはんを戻した').toBe(NEXT_DISH);
  });
});

describe('useHomeData の取り直しは、栄養の分析を AI を呼ばずに読み直し、今日のアドバイスの帯を残す (#2201 U4)', () => {
  const ADVICE_BEFORE = '夕食のタンパク質が不足しています';
  const ADVICE_AFTER = '野菜を一品足しましょう';
  /** 取り直しのあとの点数 (分析の点数が変わったことを見る) */
  const SCORE_AFTER = 85;

  /** fetch に渡った URL のうち、引数と同じものの数 */
  const fetchCallsTo = (url: string) => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === url).length;

  it('取り直しは AI を付けない URL で読み、AI つきの URL (LLM を呼び安全弁を使う) を読まない', async () => {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await renderHome();
    expect(fetchCallsTo(NUTRITION_ANALYSIS_URL)).toBe(1);
    expect(fetchCallsTo(NUTRITION_ANALYSIS_WITHOUT_AI_URL)).toBe(0);

    await refetchHome();
    await refetchHome();
    // AI つきは開いたときの 1 回だけ。取り直しは 2 回とも AI を付けない
    expect(fetchCallsTo(NUTRITION_ANALYSIS_URL)).toBe(1);
    expect(fetchCallsTo(NUTRITION_ANALYSIS_WITHOUT_AI_URL)).toBe(2);
  });

  it('取り直しで点数は新しくなり、今日のアドバイスの帯は前のアドバイスを残す', async () => {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await renderHome();
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);

    // AI 相談で夕食を足した (update_meal・generate_single_meal) あと、ホームが取り直す。AI を付ければ別のアドバイスになる状態
    nutritionAnalysisBody = { ...analysisResponse(ADVICE_AFTER), analysis: { score: SCORE_AFTER, issues: [], comparison: {} } };
    await refetchHome();
    expect(analysisScoreText()).toBe(String(SCORE_AFTER));
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);
  });

  it('今日の完了した食事が無くなって分析できなくなったら、取り直しで点数と帯を消す (読み込み直したときと同じ。#2195 V1)', async () => {
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

describe('useHomeData: 続けて来た 2 回の成功の取り直しの栄養の分析の応答が逆の順に届いても、古い分析で上書きしない (#2201 U1)', () => {
  const ADVICE_BEFORE = '夕食のタンパク質が不足しています';
  /**
   * 1 回目の取り直し (受付の通知) の分析 (先に始めた読み取りの古い答え): 今日の完了した食事が無くて分析できない。
   * 取り直しは AI を付けずに読み、帯は分析できなくなったときだけ消す (#2201 U4) ので、古い答えを置くと点数と帯の両方が消える
   */
  const FIRST_RESPONSE = NO_MEALS_RESPONSE;
  /** 2 回目の取り直し (完了の通知) の分析 (あとに始めた読み取りの新しい答え) */
  const SECOND_SCORE = 85;
  const SECOND_ADVICE = '野菜を一品足しましょう';

  /** 止めた栄養の分析の応答 (始めた順。release で届ける) */
  let heldAnalyses: { release: () => void }[];
  /** true の間に始めた栄養の分析の読み取りは、応答を止める */
  let holdAnalyses: boolean;

  function HomeNutritionProbe() {
    const { nutritionAnalysis, suggestion, refetch, aiConsultationWrites } = useHomeData();
    // ホームのページと同じく、通知のたびに hook が渡す札を refetch に渡す
    useAiConsultationDataRefetch((ticket) => refetch(ticket), { writeInFlightRef: aiConsultationWrites });
    return (
      <div>
        <p data-testid="advice-banner">{suggestion ?? ''}</p>
        <p data-testid="analysis-score">{nutritionAnalysis.score}</p>
        <p data-testid="analysis-loading">{String(nutritionAnalysis.loading)}</p>
      </div>
    );
  }
  const analysisLoadingText = () => container.querySelector('[data-testid="analysis-loading"]')?.textContent;

  beforeEach(() => {
    heldAnalyses = [];
    holdAnalyses = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        // 答えは読み取りを始めたときのもの (止めたあとに答えを変えても、止めた読み取りは前の答えを返す)。
        // 開いたときは AI つきの URL、取り直しは AI を付けない URL (#2201 U4) で読む
        const body = nutritionAnalysisAnswer(input);
        if (body !== null) {
          if (holdAnalyses) await new Promise<void>((resolve) => heldAnalyses.push({ release: resolve }));
          return { ok: true, status: OK_STATUS, json: async () => body };
        }
        return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
      }),
    );
  });

  async function notifyAiConsultationSucceeded() {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
    });
    await settle();
  }

  async function release(held: { release: () => void } | undefined) {
    if (held === undefined) throw new Error('止めた栄養の分析の応答が無い');
    await act(async () => {
      held.release();
    });
    await settle();
  }

  /** 開いてから 2 回の成功を届け、どちらの取り直しの栄養の分析の応答も止める */
  async function startTwoRefetches() {
    nutritionAnalysisBody = analysisResponse(ADVICE_BEFORE);
    await act(async () => {
      root.render(<HomeNutritionProbe />);
    });
    await settle();
    expect(analysisScoreText()).toBe(String(ANALYSIS_SCORE));
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);

    holdAnalyses = true;
    nutritionAnalysisBody = FIRST_RESPONSE;
    await notifyAiConsultationSucceeded();
    nutritionAnalysisBody = analysisResponse(SECOND_ADVICE, SECOND_SCORE);
    await notifyAiConsultationSucceeded();
    expect(heldAnalyses, '2 回の取り直しの栄養の分析を止められていない (検査が空振りしている)').toHaveLength(2);
    expect(analysisLoadingText()).toBe('true');
    return { first: heldAnalyses[0], second: heldAnalyses[1] };
  }

  it('あとの取り直しの分析が先に届き、先の取り直しの分析が後から届いても、あとの点数と今日のアドバイスの帯を残す', async () => {
    const { first, second } = await startTwoRefetches();
    await release(second);
    expect(analysisScoreText()).toBe(String(SECOND_SCORE));
    // 取り直しは AI を付けずに読むので、帯は前のアドバイスを残す (#2201 U4)
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);
    expect(analysisLoadingText()).toBe('false');

    await release(first);
    expect(analysisScoreText(), '先の取り直しの古い分析が、あとの分析を上書きした').toBe(String(SECOND_SCORE));
    expect(adviceBannerText(), '先の取り直しの古い分析 (分析できない) が、今日のアドバイスの帯を消した').toBe(ADVICE_BEFORE);
    expect(analysisLoadingText()).toBe('false');
  });

  it('先の取り直しの分析が先に届いても置かず、読み込み中の印も下ろさない (あとの取り直しの分析が届いたら置いて下ろす)', async () => {
    const { first, second } = await startTwoRefetches();
    await release(first);
    expect(analysisScoreText(), '先の取り直しの古い分析を置いた').toBe(String(ANALYSIS_SCORE));
    expect(adviceBannerText(), '先の取り直しの古い分析 (分析できない) が、今日のアドバイスの帯を消した').toBe(ADVICE_BEFORE);
    expect(analysisLoadingText(), '先の取り直しの応答が、あとの取り直しの途中で読み込み中の印を下ろした').toBe('true');

    await release(second);
    expect(analysisScoreText()).toBe(String(SECOND_SCORE));
    expect(adviceBannerText()).toBe(ADVICE_BEFORE);
    expect(analysisLoadingText()).toBe('false');
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
        const answer = nutritionAnalysisAnswer(input);
        if (answer !== null) return { ok: true, status: OK_STATUS, json: async () => answer };
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
      // 開いたときの AI つきの栄養の分析 (表の mountReadsNotRefetched の nutritionAnalysisWithAi)。取り直しは AI を付けずに読む (#2201 U4)
      nutritionAnalysisWithAi: [fetchReadKey(NUTRITION_ANALYSIS_URL) ?? ''],
      orgChallenges: [fetchReadKey('/api/org/my-challenges') ?? ''],
    });
    // 取り直しも栄養の分析 (点数・課題) は読む。AI を付けない URL で
    expect(refetchReads.has(fetchReadKey(NUTRITION_ANALYSIS_WITHOUT_AI_URL) ?? '')).toBe(true);
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
        const answer = nutritionAnalysisAnswer(input);
        if (answer !== null) return { ok: true, status: OK_STATUS, json: async () => answer };
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

  it('取り直しの応答を待つあいだに始めた完了の切り替えを、切り替えの前に読んだ今日の献立で戻さず、終わったら 1 回取り直す (#2201 U1 + U2)', async () => {
    /** 完了の切り替えの待ち (useHomeData の toggleMealCompletion の 250ms) より長い待ち */
    const TOGGLE_DEBOUNCE_WAIT_MS = 300;
    let refetchCalls = 0;
    let toggle: ((mealId: string, currentStatus: boolean) => Promise<void>) | null = null;
    function HomeToggleProbe() {
      const { todayPlan, toggleMealCompletion, refetch, aiConsultationWrites } = useHomeData();
      // ホームのページと同じく、hook が渡す札を refetch に渡す
      useAiConsultationDataRefetch(
        (ticket) => {
          refetchCalls += 1;
          return refetch(ticket);
        },
        { writeInFlightRef: aiConsultationWrites },
      );
      toggle = toggleMealCompletion;
      return <p data-testid="today-completed">{String(todayPlan?.meals[0]?.isCompleted)}</p>;
    }
    const completedText = () => container.querySelector('[data-testid="today-completed"]')?.textContent;
    const holdOf = () => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    useServer(FULL_TABLES, null);
    await act(async () => {
      root.render(<HomeToggleProbe />);
    });
    await settle();
    expect(completedText()).toBe('true');

    // 取り直しの表の読み取りを止める (その間はページに今日の献立が出ていて、完了を切り替えられる)
    const refetchRead = holdOf();
    supabaseMock.tableHold = refetchRead.promise;
    await notifyAiConsultationSucceeded();
    supabaseMock.tableHold = null;
    expect(refetchCalls).toBe(1);

    // 応答を待つあいだに完了を外す (RPC の応答は止める)
    const rpc = holdOf();
    supabaseMock.rpcHold = rpc.promise;
    let toggling: Promise<void> | null = null;
    await act(async () => {
      toggling = toggle!(TODAY_MEAL.id, true);
      await new Promise((resolve) => setTimeout(resolve, TOGGLE_DEBOUNCE_WAIT_MS));
    });
    expect(completedText(), '楽観的な更新をしていない (検査が空振りしている)').toBe('false');

    // 取り直しの応答が届く (今日の献立はまだ完了済みのまま読む)
    await act(async () => {
      refetchRead.release();
    });
    await settle();
    expect(completedText(), '切り替えの前に読んだ取り直しの応答が、楽観的な表示を戻した').toBe('false');
    expect(refetchCalls, '切り替えの途中に取り直した').toBe(1);

    // サーバーが完了を外し終えた: 置かなかった応答のぶん 1 回取り直す
    supabaseMock.tableResults = {
      ...supabaseMock.tableResults,
      user_daily_meals: { data: [{ id: 'day-today', day_date: TODAY, planned_meals: [{ ...TODAY_MEAL, is_completed: false }] }], error: null },
    };
    await act(async () => {
      rpc.release();
      await toggling;
    });
    await settle();
    expect(refetchCalls, '置かなかった応答のぶん取り直していない').toBe(2);
    expect(completedText()).toBe('false');
  });

  describe('今日の気分・活動量の保存 (updateActivityLevel。楽観的な更新 → daily_activity_logs の upsert) と取り直し (#2201 U2)', () => {
    /** 今日の気分・活動量の、保存済みの値と押す値 (daily_activity_logs の feeling) */
    const SAVED_FEELING = 'rest';
    const PRESSED_FEELING = 'active';
    const activityLogTable = (feeling: string) => ({ data: [{ user_id: 'user-1', date: TODAY, feeling }], error: null });
    let refetchCalls: number;
    let updateActivity: ((level: string) => Promise<void>) | null;
    function HomeActivityProbe() {
      const { activityLevel, updateActivityLevel, refetch, aiConsultationWrites } = useHomeData();
      // ホームのページと同じく、hook が渡す札を refetch に渡し、書き込みの印を渡す
      useAiConsultationDataRefetch(
        (ticket) => {
          refetchCalls += 1;
          return refetch(ticket);
        },
        { writeInFlightRef: aiConsultationWrites },
      );
      updateActivity = updateActivityLevel;
      return <p data-testid="activity-level">{activityLevel ?? ''}</p>;
    }
    const activityText = () => container.querySelector('[data-testid="activity-level"]')?.textContent;
    const holdOf = () => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };

    beforeEach(() => {
      refetchCalls = 0;
      updateActivity = null;
    });

    async function renderWithSavedFeeling() {
      useServer({ ...FULL_TABLES, daily_activity_logs: activityLogTable(SAVED_FEELING) }, null);
      await act(async () => {
        root.render(<HomeActivityProbe />);
      });
      await settle();
      expect(activityText(), '保存済みの気分・活動量を出していない (検査の前提が崩れた)').toBe(SAVED_FEELING);
    }

    /** 気分・活動量を押す (upsert の応答は upsert が解けるまで止める)。押す処理の Promise を返す */
    async function pressFeelingHoldingUpsert(upsert: { promise: Promise<void> }): Promise<Promise<void>> {
      supabaseMock.writeHold = upsert.promise;
      let saving: Promise<void> = Promise.resolve();
      await act(async () => {
        saving = updateActivity!(PRESSED_FEELING);
      });
      supabaseMock.writeHold = null;
      expect(activityText(), '楽観的な更新をしていない (検査が空振りしている)').toBe(PRESSED_FEELING);
      return saving;
    }

    /** サーバーが押した値を保存し終え、upsert の応答が届く */
    async function finishUpsert(upsert: { release: () => void }, saving: Promise<void>) {
      supabaseMock.tableResults = { ...supabaseMock.tableResults, daily_activity_logs: activityLogTable(PRESSED_FEELING) };
      await act(async () => {
        upsert.release();
        await saving;
      });
      await settle();
    }

    it('保存の応答を待つあいだに来た成功では取り直さず (押した値を保存の前の値に戻さない)、終わったら 1 回取り直す', async () => {
      await renderWithSavedFeeling();
      const upsert = holdOf();
      const saving = await pressFeelingHoldingUpsert(upsert);

      // 保存の前の値 (rest) のまま読む取り直しが走ると、押した値が戻る
      await notifyAiConsultationSucceeded();
      await notifyAiConsultationSucceeded();
      expect(refetchCalls, '保存の途中に取り直した').toBe(0);
      expect(activityText()).toBe(PRESSED_FEELING);

      await finishUpsert(upsert, saving);
      expect(refetchCalls, '止めた成功のぶん 1 回取り直していない').toBe(1);
      expect(activityText()).toBe(PRESSED_FEELING);
    });

    it('取り直しの応答を待つあいだに押した (保存の前の値を読んだ応答) ときは、その応答の値を置かず、保存が終わったら 1 回取り直す', async () => {
      await renderWithSavedFeeling();

      // 取り直しの表の読み取りを止める (その間はページに気分・活動量のボタンが出ていて、押せる)
      const refetchRead = holdOf();
      supabaseMock.tableHold = refetchRead.promise;
      await notifyAiConsultationSucceeded();
      supabaseMock.tableHold = null;
      expect(refetchCalls).toBe(1);

      // 応答を待つあいだに押す (upsert の応答は止める)
      const upsert = holdOf();
      const saving = await pressFeelingHoldingUpsert(upsert);

      // 取り直しの応答が届く (気分・活動量は保存の前の値 rest のまま読む)
      await act(async () => {
        refetchRead.release();
      });
      await settle();
      expect(activityText(), '押す前に読んだ取り直しの応答が、押した値を戻した').toBe(PRESSED_FEELING);
      expect(refetchCalls, '保存の途中に取り直した').toBe(1);

      // サーバーが押した値を保存し終えた: 置かなかった応答のぶん 1 回取り直す
      await finishUpsert(upsert, saving);
      expect(refetchCalls, '置かなかった応答のぶん取り直していない').toBe(2);
      expect(activityText()).toBe(PRESSED_FEELING);
    });
  });
});

describe('useHomeData: 開いたときの読み込みの最中に始まった取り直し (#2201 U1)', () => {
  it('取り直しの読み取りが投げても、読み込み中の表示のまま止まらない (開いたときの読み込みの応答が後から届いても)', async () => {
    let refetch: (() => Promise<void>) | null = null;
    function HomeLoadingProbe() {
      const home = useHomeData();
      refetch = home.refetch;
      return <p data-testid="home-loading">{String(home.loading)}</p>;
    }
    const loadingText = () => container.querySelector('[data-testid="home-loading"]')?.textContent;

    // 開いたときの読み込みの表の読み取りを止める
    const mountHold = (() => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    supabaseMock.tableHold = mountHold.promise;
    await act(async () => {
      root.render(<HomeLoadingProbe />);
    });
    await settle();
    expect(loadingText(), '開いたときの読み込みを止められていない (検査が空振りしている)').toBe('true');

    // その間に AI 相談の成功の取り直しが始まり、表の読み取りが投げる
    supabaseMock.tableHold = null;
    supabaseMock.tableRejects = true;
    let refetchError: unknown = null;
    await act(async () => {
      await refetch!().catch((error: unknown) => {
        refetchError = error;
      });
    });
    supabaseMock.tableRejects = false;
    expect(refetchError, '取り直しの読み取りが投げていない (検査が空振りしている)').not.toBeNull();
    expect(loadingText(), '取り直しが投げたあと読み込み中の表示のまま').toBe('false');

    // 先に始めた開いたときの読み込みの応答が後から届いても、読み込み中の表示に戻らない
    await act(async () => {
      mountHold.release();
    });
    await settle();
    expect(loadingText()).toBe('false');
  });

  it('開いたときの読み込みの役を引き継いだ取り直しは、栄養の分析を AI つきで読み、今日のアドバイスの帯を出す (#2201 U1 + U4)', async () => {
    const ADVICE = '夕食のタンパク質が不足しています';
    nutritionAnalysisBody = analysisResponse(ADVICE);
    let refetch: (() => Promise<void>) | null = null;
    function HomeMountProbe() {
      const home = useHomeData();
      refetch = home.refetch;
      return (
        <div>
          <p data-testid="home-loading">{String(home.loading)}</p>
          <p data-testid="advice-banner">{home.suggestion ?? ''}</p>
        </div>
      );
    }
    const loadingText = () => container.querySelector('[data-testid="home-loading"]')?.textContent;
    const fetchCallsTo = (url: string) => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === url).length;

    // 開いたときの読み込みの fetch (AI つきの栄養の分析・お知らせ) の応答を止める (読み込み中の表示のまま、栄養の分析は始めている)
    const heldMountFetches: (() => void)[] = [];
    let holdFetches = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const answer = nutritionAnalysisAnswer(input);
        if (holdFetches) await new Promise<void>((resolve) => heldMountFetches.push(resolve));
        if (answer !== null) return { ok: true, status: OK_STATUS, json: async () => answer };
        return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
      }),
    );
    await act(async () => {
      root.render(<HomeMountProbe />);
    });
    await settle();
    expect(loadingText(), '開いたときの読み込みを止められていない (検査が空振りしている)').toBe('true');
    expect(fetchCallsTo(NUTRITION_ANALYSIS_URL), '開いたときの栄養の分析を始めていない (検査が空振りしている)').toBe(1);

    // その間に AI 相談の成功の取り直しが始まる: 開いたときの読み込みの役 (栄養の分析も) を引き継ぐ
    holdFetches = false;
    await act(async () => {
      await refetch!();
    });
    await settle();
    expect(loadingText()).toBe('false');
    expect(fetchCallsTo(NUTRITION_ANALYSIS_WITHOUT_AI_URL), '引き継いだ取り直しが AI を付けない栄養の分析を読んだ').toBe(0);
    expect(adviceBannerText(), '開いたときの栄養の分析を引き継いだ取り直しが、今日のアドバイスの帯を出さなかった').toBe(ADVICE);

    // 先に始めた開いたときの読み込みの応答が後から届いても、帯はそのまま
    await act(async () => {
      for (const release of heldMountFetches) release();
    });
    await settle();
    expect(adviceBannerText()).toBe(ADVICE);
    expect(loadingText()).toBe('false');
  });
});

describe('useHomeData: 開いたときの AI つきの栄養の分析の応答を待つあいだの取り直し (#2201 U1 + U4)', () => {
  const ADVICE = '夕食のタンパク質が不足しています';
  const ADVICE_AFTER = '野菜を一品足しましょう';
  /** 取り直し (AI 相談の成功のあと) の点数 */
  const SCORE_AFTER = 85;
  /** 献立の変更の提案の文 (栄養の分析の suggestion。AI つきの読み取りだけが置く) */
  const SUGGESTION_ISSUE = '野菜が不足しています';

  /** 止めた AI つきの栄養の分析の応答 (始めた順) */
  let heldAiAnalyses: (() => void)[];
  /** true の間に始めた AI つきの栄養の分析の読み取りは応答を止める (AI を付けない読み取りは止めない) */
  let holdAiAnalyses: boolean;
  /** POST /api/ai/nutrition-analysis (献立の変更の実行) の数 */
  let executeCalls: number;

  let home: ReturnType<typeof useHomeData> | null;
  function HomeAnalysisProbe() {
    const data = useHomeData();
    home = data;
    // ホームのページと同じく、通知のたびに hook が渡す札を refetch に渡す
    useAiConsultationDataRefetch((ticket) => data.refetch(ticket), { writeInFlightRef: data.aiConsultationWrites });
    return (
      <div>
        <p data-testid="home-loading">{String(data.loading)}</p>
        <p data-testid="advice-banner">{data.suggestion ?? ''}</p>
        <p data-testid="analysis-score">{data.nutritionAnalysis.score}</p>
        <p data-testid="analysis-advice">{data.nutritionAnalysis.advice ?? ''}</p>
        <p data-testid="analysis-suggestion">{data.nutritionAnalysis.suggestion?.currentIssue ?? ''}</p>
        <p data-testid="analysis-loading">{String(data.nutritionAnalysis.loading)}</p>
      </div>
    );
  }
  const textOf = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent;
  const fetchCallsTo = (url: string) => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === url).length;

  /** 分析があり、献立の変更の提案 (suggestion) も付いた応答 */
  function analysisWithSuggestion(advice: string, score: number = ANALYSIS_SCORE) {
    return { ...analysisResponse(advice, score), suggestion: { currentIssue: SUGGESTION_ISSUE, suggestedDishes: [] } };
  }

  beforeEach(() => {
    home = null;
    heldAiAnalyses = [];
    holdAiAnalyses = false;
    executeCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST' && String(input) === '/api/ai/nutrition-analysis') {
          executeCalls += 1;
          return { ok: true, status: OK_STATUS, json: async () => ({ success: true }) };
        }
        // 答えは読み取りを始めたときのもの (止めたあとに答えを変えても、止めた読み取りは前の答えを返す)
        const body = nutritionAnalysisAnswer(input);
        if (body !== null) {
          if (holdAiAnalyses && String(input) === NUTRITION_ANALYSIS_URL) await new Promise<void>((resolve) => heldAiAnalyses.push(resolve));
          return { ok: true, status: OK_STATUS, json: async () => body };
        }
        return { ok: false, status: NOT_FOUND_STATUS, json: async () => ({}) };
      }),
    );
  });

  async function notifyAiConsultationSucceeded() {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType: 'update_meal', result: {} } }));
    });
    await settle();
  }

  async function releaseAiAnalysis(index: number) {
    const release = heldAiAnalyses[index];
    if (release === undefined) throw new Error('止めた AI つきの栄養の分析の応答が無い');
    await act(async () => {
      release();
    });
    await settle();
  }

  it('読み込み中の表示が下りたあとに来た取り直し (AI を付けない) の分析が先に届いても、あとから届いた開いたときの分析のアドバイス・提案と帯を置く (点数は取り直しの点数)', async () => {
    nutritionAnalysisBody = analysisWithSuggestion(ADVICE);
    holdAiAnalyses = true;
    await act(async () => {
      root.render(<HomeAnalysisProbe />);
    });
    await settle();
    expect(textOf('home-loading'), '読み込み中の表示が下りていない (検査の前提が崩れた)').toBe('false');
    expect(heldAiAnalyses, '開いたときの AI つきの栄養の分析を止められていない (検査が空振りしている)').toHaveLength(1);
    expect(textOf('advice-banner')).toBe('');

    // 開いたときの AI つきの分析の応答 (LLM を呼ぶので数秒) を待つあいだに AI 相談が成功し、取り直しは AI を付けずに読む (#2201 U4)
    nutritionAnalysisBody = analysisWithSuggestion(ADVICE_AFTER, SCORE_AFTER);
    await notifyAiConsultationSucceeded();
    expect(fetchCallsTo(NUTRITION_ANALYSIS_WITHOUT_AI_URL), '取り直しが AI を付けない栄養の分析を読んでいない (検査が空振りしている)').toBe(1);
    expect(textOf('analysis-score')).toBe(String(SCORE_AFTER));

    // 開いたときの AI つきの分析の応答が後から届く
    await releaseAiAnalysis(0);
    expect(textOf('advice-banner'), '開いたときの AI つきの分析のアドバイスを帯に出さなかった').toBe(ADVICE);
    expect(textOf('analysis-advice')).toBe(ADVICE);
    expect(textOf('analysis-suggestion'), '献立の変更の提案を置かなかった').toBe(SUGGESTION_ISSUE);
    expect(textOf('analysis-score'), '先に始めた開いたときの読み取りの古い点数で、取り直しの点数を上書きした').toBe(String(SCORE_AFTER));
    expect(textOf('analysis-loading')).toBe('false');
  });

  it('取り直しの応答を待つあいだに献立の変更の実行 (AI つきの読み込み) が追い越しても、古い取り直しは栄養の分析を読み始めず、変更のあとのアドバイスを置く', async () => {
    nutritionAnalysisBody = analysisWithSuggestion(ADVICE);
    await act(async () => {
      root.render(<HomeAnalysisProbe />);
    });
    await settle();
    expect(textOf('analysis-advice')).toBe(ADVICE);

    // 1 回目の取り直し (AI を付けない) の表の読み取りを止める
    const refetchHold = (() => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    supabaseMock.tableHold = refetchHold.promise;
    let refetching: Promise<void> | undefined;
    await act(async () => {
      refetching = home!.refetch();
    });
    await settle();
    supabaseMock.tableHold = null;

    // その間に献立の変更を実行する: 変更のあとの読み込み (AI つき) の栄養の分析の応答は LLM を待つ (止める)
    nutritionAnalysisBody = analysisWithSuggestion(ADVICE_AFTER, SCORE_AFTER);
    holdAiAnalyses = true;
    await act(async () => {
      await home!.executeNutritionSuggestion();
    });
    await settle();
    expect(executeCalls, '献立の変更を実行していない (検査が空振りしている)').toBe(1);
    expect(heldAiAnalyses, '変更のあとの AI つきの栄養の分析を止められていない (検査が空振りしている)').toHaveLength(1);

    // 追い越された取り直しの表の読み取りが届く
    await act(async () => {
      refetchHold.release();
      await refetching;
    });
    await settle();
    expect(fetchCallsTo(NUTRITION_ANALYSIS_WITHOUT_AI_URL), '追い越された取り直しが、変更のあとの読み取りより後に栄養の分析を読み始めた').toBe(0);

    await releaseAiAnalysis(0);
    expect(textOf('analysis-advice'), '献立の変更のあとのアドバイスを置かなかった').toBe(ADVICE_AFTER);
    expect(textOf('analysis-score')).toBe(String(SCORE_AFTER));
    expect(textOf('analysis-loading')).toBe('false');
  });

  it('取り直し (AI を付けない) で分析できなくなったら、分析のアドバイス・提案と帯も消す (読み込み直したときと同じ。#2195 V1)', async () => {
    nutritionAnalysisBody = analysisWithSuggestion(ADVICE);
    await act(async () => {
      root.render(<HomeAnalysisProbe />);
    });
    await settle();
    expect(textOf('analysis-advice')).toBe(ADVICE);
    expect(textOf('analysis-suggestion')).toBe(SUGGESTION_ISSUE);
    expect(textOf('advice-banner')).toBe(ADVICE);

    // AI 相談で今日の食事を消した (delete_meal) あとの取り直し: 分析できない
    nutritionAnalysisBody = NO_MEALS_RESPONSE;
    await notifyAiConsultationSucceeded();
    expect(textOf('analysis-score')).toBe('0');
    expect(textOf('analysis-advice'), '分析できなくなったのに、前のアドバイスを残した').toBe('');
    expect(textOf('analysis-suggestion'), '分析できなくなったのに、前の献立の変更の提案を残した').toBe('');
    expect(textOf('advice-banner')).toBe('');
    expect(textOf('analysis-loading')).toBe('false');
  });

  it('取り直しで今日の完了した食事が無くなって分析できなくなったら、先に始めた AI つきの分析の古いアドバイスを後から置かない', async () => {
    nutritionAnalysisBody = analysisWithSuggestion(ADVICE);
    holdAiAnalyses = true;
    await act(async () => {
      root.render(<HomeAnalysisProbe />);
    });
    await settle();
    expect(heldAiAnalyses, '開いたときの AI つきの栄養の分析を止められていない (検査が空振りしている)').toHaveLength(1);

    // AI 相談で今日の食事を消した (delete_meal) あとの取り直し: 分析できない
    nutritionAnalysisBody = NO_MEALS_RESPONSE;
    await notifyAiConsultationSucceeded();
    expect(textOf('analysis-score')).toBe('0');

    // 先に始めた (食事があったときの) AI つきの分析の応答が後から届く
    await releaseAiAnalysis(0);
    expect(textOf('advice-banner'), '分析できなくなったあとに、先に始めた読み取りの古いアドバイスを帯に出した').toBe('');
    expect(textOf('analysis-advice')).toBe('');
    expect(textOf('analysis-suggestion')).toBe('');
    expect(textOf('analysis-score')).toBe('0');
  });
});

describe('useHomeData: 取り直しの読み取りの失敗では、記録の集計の今の表示を残す (#2201 U1)', () => {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const TODAY = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  /** 読み取りの失敗 (supabase-js が通信・サーバーの失敗で返す形) */
  const READ_FAILURE = { data: null, error: { code: '08006', message: 'connection failure' }, count: null };
  const BADGE_ROW = { obtained_at: `${TODAY}T00:00:00.000Z`, badges: { name: '初めての自炊', code: 'first-cook' } };
  const LATEST_WEIGHT = 65;
  const TARGET_WEIGHT = 60;
  const HEALTH_STREAK = 3;
  /** 開いたときの表 (どれも中身がある) */
  const TABLES: Record<string, { data: unknown; error: unknown; count?: number | null }> = {
    user_profiles: { data: [{ nickname: 'ほり', organization_id: null }], error: null },
    user_daily_meals: {
      data: [{ id: 'day-today', day_date: TODAY, planned_meals: [{ ...BEST_MEAL_ROW, id: 'meal-today', calories_kcal: 520 }] }],
      error: null,
    },
    planned_meals: { data: [BEST_MEAL_ROW], error: null },
    pantry_items: { data: [{ id: 'p-1', user_id: 'user-1', name: 'にんじん', amount: '2本', category: 'vegetable', expiration_date: TODAY }], error: null },
    shopping_lists: { data: [{ id: 'sl-1' }], error: null },
    shopping_list_items: { data: [{ id: 'i-1' }, { id: 'i-2' }], error: null },
    user_badges: { data: [BADGE_ROW, BADGE_ROW, BADGE_ROW], error: null },
    health_records: { data: [{ record_date: TODAY, weight: LATEST_WEIGHT }], error: null },
    health_streaks: { data: [{ current_streak: HEALTH_STREAK }], error: null },
    health_goals: { data: [{ target_value: TARGET_WEIGHT }], error: null },
    health_insights: { data: [{ id: 'insight-1' }], error: null },
    user_performance_checkins: { data: [{ id: 'checkin-1', checkin_date: TODAY }], error: null },
  };

  let refetch: (() => Promise<void>) | null;
  function HomeSummaryProbe() {
    const data = useHomeData();
    refetch = data.refetch;
    const { healthSummary } = data;
    return (
      <dl>
        <dd data-testid="best-meal">{data.bestMealThisWeek?.dishName ?? ''}</dd>
        <dd data-testid="badge-count">{data.badgeCount}</dd>
        <dd data-testid="latest-badge">{data.latestBadge?.name ?? ''}</dd>
        <dd data-testid="today-record">{String(healthSummary.todayRecord !== null)}</dd>
        <dd data-testid="health-streak">{healthSummary.healthStreak}</dd>
        <dd data-testid="latest-weight">{String(healthSummary.latestWeight)}</dd>
        <dd data-testid="target-weight">{String(healthSummary.targetWeight)}</dd>
        <dd data-testid="has-alert">{String(healthSummary.hasAlert)}</dd>
        <dd data-testid="shopping-remaining">{data.shoppingRemaining}</dd>
        <dd data-testid="cooking-streak">{data.cookingStreak}</dd>
        <dd data-testid="weekly-meals">{data.weeklyStats.totalMealCount}</dd>
        <dd data-testid="monthly-meals">{data.monthlyStats.totalMeals}</dd>
        <dd data-testid="expiring-items">{data.expiringItems.length}</dd>
        <dd data-testid="today-checkin">{String(Boolean(data.performanceAnalysis.todayCheckin))}</dd>
      </dl>
    );
  }
  /** 画面に出している記録の集計 (testid → 文字) */
  const summaryShown = () =>
    Object.fromEntries([...container.querySelectorAll('[data-testid]')].map((el) => [el.getAttribute('data-testid'), el.textContent]));

  beforeEach(() => {
    refetch = null;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('取り直しで今週のベストごはん・バッジの数・健康記録・買い物リストの残り・チェックイン・記録の集計の読み取りが失敗しても、前の表示を残す', async () => {
    supabaseMock.tableResults = { ...TABLES };
    await act(async () => {
      root.render(<HomeSummaryProbe />);
    });
    await settle();
    const before = summaryShown();
    // 開いたときに中身を出している (検査の前提)
    expect(before).toMatchObject({
      'best-meal': BEST_MEAL_ROW.dish_name,
      'badge-count': '3',
      'latest-badge': BADGE_ROW.badges.name,
      'today-record': 'true',
      'health-streak': String(HEALTH_STREAK),
      'latest-weight': String(LATEST_WEIGHT),
      'target-weight': String(TARGET_WEIGHT),
      'has-alert': 'true',
      'shopping-remaining': '2',
      'cooking-streak': '1',
      'weekly-meals': '1',
      'monthly-meals': '1',
      'expiring-items': '1',
      'today-checkin': 'true',
    });

    // AI 相談の成功の直後に通信が切れた: 使っている買い物リスト (shopping_lists) だけ読め、ほかの表の読み取りは失敗する
    supabaseMock.tableResults = Object.fromEntries(
      Object.keys(TABLES).map((table) => [table, table === 'shopping_lists' ? TABLES.shopping_lists : READ_FAILURE]),
    );
    await act(async () => {
      await refetch!();
    });
    await settle();
    expect(summaryShown(), '取り直しの読み取りの失敗で、前の表示を空・0 で上書きした').toEqual(before);
  });

  it('開いたときと同じ扱いの読み込み (ログインの状態の変化) の失敗は、これまでどおり読めなかった値を空・0 にする (取り直しの扱いだけが今の表示を残す)', async () => {
    supabaseMock.tableResults = { ...TABLES };
    await act(async () => {
      root.render(<HomeSummaryProbe />);
    });
    await settle();
    expect(summaryShown()).toMatchObject({ 'best-meal': BEST_MEAL_ROW.dish_name, 'badge-count': '3', 'today-checkin': 'true' });

    supabaseMock.tableResults = Object.fromEntries(
      Object.keys(TABLES).map((table) => [table, table === 'shopping_lists' ? TABLES.shopping_lists : READ_FAILURE]),
    );
    expect(supabaseMock.authStateListener, 'ログインの状態の変化を受け取る関数が無い (検査の前提が崩れた)').not.toBeNull();
    await act(async () => {
      supabaseMock.authStateListener!();
    });
    await settle();
    expect(summaryShown()).toMatchObject({
      'best-meal': '',
      'badge-count': '0',
      'today-record': 'false',
      'health-streak': '0',
      'latest-weight': 'null',
      'has-alert': 'false',
      'shopping-remaining': '0',
      'today-checkin': 'false',
    });
  });

  it('開いたときの読み取りの失敗は、これまでどおり空・0 を出す (取り直しだけが前の表示を残す)', async () => {
    supabaseMock.tableResults = Object.fromEntries(
      Object.keys(TABLES).map((table) => [table, table === 'shopping_lists' ? TABLES.shopping_lists : READ_FAILURE]),
    );
    await act(async () => {
      root.render(<HomeSummaryProbe />);
    });
    await settle();
    expect(summaryShown()).toMatchObject({
      'best-meal': '',
      'badge-count': '0',
      'today-record': 'false',
      'health-streak': '0',
      'latest-weight': 'null',
      'has-alert': 'false',
      'shopping-remaining': '0',
      'today-checkin': 'false',
    });
  });
});
