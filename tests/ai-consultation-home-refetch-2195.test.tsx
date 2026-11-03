/**
 * #2195 V1 ホーム (/home) のデータ (useHomeData) の取り直し (refetch。ホームは AI 相談の成功でこれを呼ぶ) が、
 * サーバーで無くなったものを前の値のまま残さないこと
 *
 * 問題 (直す前):
 *   - 「今週のベストごはん」(完了した・写真のある食事のうち 1 つ) は、当てはまる食事があるときだけ置いていた。
 *     AI 相談でその食事を消す (delete_meal)・完了を外す (complete_meal の isCompleted: false) と、取り直しても
 *     消した食事を出したまま (読み込み直すまで) だった (押すと消えた食事の詳細へ移る)
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
  const { bestMealThisWeek, refetch } = useHomeData();
  latestRefetch = refetch;
  return <p data-testid="best-meal">{bestMealThisWeek?.dishName ?? ''}</p>;
}

beforeEach(() => {
  supabaseMock.tableResults = {};
  latestRefetch = null;
  // お知らせ・栄養の分析・パフォーマンスの分析 (fetch) は、この検査では何も返さない
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
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

const bestMealText = () => container.querySelector('[data-testid="best-meal"]')?.textContent;

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
