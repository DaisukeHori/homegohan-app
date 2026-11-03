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

/** Supabase のモック。ログインした人 1 人。表ごとの問い合わせの答えは tableResults (無い表は空) */
const supabaseMock = vi.hoisted(() => ({
  tableResults: {} as Record<string, { data: unknown; error: null; count?: number }>,
}));
vi.mock('@/lib/supabase/client', () => {
  const EMPTY_RESULT = { data: null, error: null, count: 0 };
  /** どのメソッドを呼んでも自分を返し、await するとその表の答えになる問い合わせ */
  const query = (table: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => resolve(supabaseMock.tableResults[table] ?? EMPTY_RESULT);
        }
        return () => query(table);
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
      from: (table: string) => query(table),
      rpc: () => query('rpc'),
    }),
  };
});

const { useHomeData } = await import('@/hooks/useHomeData');

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
